import * as fs from "fs";
import * as path from "path";
import { CliArgs } from "./cli";
import { discoverFiles, findProjectRoot, getModifiedFiles, getLanguage } from "./discovery";
import { parseTSFile, clearParseCache, type TSParseResult } from "./parsers/typescript";
import { parsePyFile, clearPyParseCache, type PyParseResult } from "./parsers/python";
import { rankAndPack, type Snippet, SCORES } from "./ranker";
import { estimateTokens } from "./tokens";

export interface AnalysisResult {
  target: Snippet;
  included: Snippet[];
  omitted: Snippet[];
  totalTokens: number;
  budget: number;
  projectRoot: string;
  mode: "file" | "symbol";
  targetPath: string;
  symbolName: string | null;
}

export async function analyze(args: CliArgs): Promise<AnalysisResult> {
  // Clear caches for fresh analysis
  clearParseCache();
  clearPyParseCache();

  // Determine project root
  const startDir = args.target
    ? path.dirname(path.resolve(args.target))
    : args.file
      ? path.dirname(path.resolve(args.file))
      : process.cwd();
  const projectRoot = args.root ? path.resolve(args.root) : findProjectRoot(startDir);

  // Discover all source files (as array and Set for O(1) lookups)
  const allFiles = discoverFiles(projectRoot);
  if (allFiles.length === 0) {
    throw new Error(`No supported source files found in ${projectRoot}`);
  }
  const allFileSet = new Set(allFiles);

  // Get modified files for scoring boost
  const modifiedFiles = getModifiedFiles(projectRoot);

  let targetFile: string;
  let targetSymbol: string | null = args.symbol || null;
  let mode: "file" | "symbol" = args.target ? "file" : "symbol";

  if (args.target) {
    targetFile = path.resolve(args.target);
    if (!fs.existsSync(targetFile)) {
      throw new Error(`File not found: ${targetFile}`);
    }
  } else if (args.symbol) {
    const found = findSymbolInProject(args.symbol, args.file ? path.resolve(args.file) : null, allFiles, allFileSet);
    if (!found) {
      throw new Error(`Symbol "${args.symbol}" not found in project`);
    }
    if (found.length > 1 && !args.file) {
      const locations = found.map(f => `  ${path.relative(projectRoot, f.file)}:${f.line} (${f.kind})`).join("\n");
      throw new Error(`Symbol "${args.symbol}" found in multiple locations. Use --file to disambiguate:\n${locations}`);
    }
    targetFile = found[0].file;
    targetSymbol = args.symbol;
    mode = "symbol";
  } else {
    throw new Error("Provide a file path or --symbol <name>");
  }

  const lang = getLanguage(targetFile);
  if (!lang) {
    throw new Error(`Unsupported file type: ${path.extname(targetFile)}`);
  }

  // Build target snippet
  const targetSnippet = buildTargetSnippet(targetFile, targetSymbol, projectRoot, lang, allFileSet);

  // Build candidate snippets
  const candidates = buildCandidates(targetFile, targetSymbol, projectRoot, lang, allFiles, allFileSet);

  // Rank and pack
  const result = rankAndPack(targetSnippet, candidates, modifiedFiles, args.budget);

  return {
    target: result.target,
    included: result.included,
    omitted: result.omitted,
    totalTokens: result.totalTokens,
    budget: result.budget,
    projectRoot,
    mode,
    targetPath: path.relative(projectRoot, targetFile),
    symbolName: targetSymbol,
  };
}

function buildTargetSnippet(
  filePath: string,
  symbolName: string | null,
  root: string,
  lang: "typescript" | "python",
  allFileSet: Set<string>
): Snippet {
  const content = fs.readFileSync(filePath, "utf-8");
  const relativePath = path.relative(root, filePath);

  if (symbolName) {
    if (lang === "typescript") {
      const parsed = parseTSFile(filePath, allFileSet);
      const sym = parsed.symbols.find(s => s.name === symbolName);
      if (sym) {
        const imports = extractImportBlock(content, lang);
        const symbolContent = imports ? `${imports}\n\n${sym.body}` : sym.body;
        return {
          filePath, relativePath, symbolName, kind: sym.kind,
          startLine: sym.startLine, endLine: sym.endLine,
          content: symbolContent, score: SCORES.TARGET,
          reason: "Target symbol", tokens: estimateTokens(symbolContent),
        };
      }
    } else {
      const parsed = parsePyFile(filePath, allFileSet);
      const sym = parsed.symbols.find(s => s.name === symbolName);
      if (sym) {
        const imports = extractImportBlock(content, lang);
        const symbolContent = imports ? `${imports}\n\n${sym.body}` : sym.body;
        return {
          filePath, relativePath, symbolName, kind: sym.kind,
          startLine: sym.startLine, endLine: sym.endLine,
          content: symbolContent, score: SCORES.TARGET,
          reason: "Target symbol", tokens: estimateTokens(symbolContent),
        };
      }
    }
  }

  // Whole file as target
  return {
    filePath, relativePath, symbolName: null, kind: "file",
    startLine: 1, endLine: content.split("\n").length,
    content, score: SCORES.TARGET,
    reason: "Target file", tokens: estimateTokens(content),
  };
}

function buildCandidates(
  targetFile: string,
  targetSymbol: string | null,
  root: string,
  lang: "typescript" | "python",
  allFiles: string[],
  allFileSet: Set<string>
): Snippet[] {
  const candidates: Snippet[] = [];

  if (lang === "typescript") {
    buildTSCandidates(targetFile, targetSymbol, root, allFiles, allFileSet, candidates);
  } else {
    buildPyCandidates(targetFile, targetSymbol, root, allFiles, allFileSet, candidates);
  }

  // Related test files
  const testFiles = findRelatedTests(targetFile, allFiles);
  for (const testFile of testFiles) {
    const content = safeReadFile(testFile);
    if (!content) continue;

    if (targetSymbol) {
      const testSnippet = extractRelevantTest(content, targetSymbol, getLanguage(testFile));
      if (testSnippet) {
        candidates.push({
          filePath: testFile, relativePath: path.relative(root, testFile),
          symbolName: null, kind: "test",
          startLine: 1, endLine: testSnippet.split("\n").length,
          content: testSnippet, score: SCORES.TEST_FILE,
          reason: "Test file for target", tokens: estimateTokens(testSnippet),
        });
        continue;
      }
    }

    candidates.push({
      filePath: testFile, relativePath: path.relative(root, testFile),
      symbolName: null, kind: "test",
      startLine: 1, endLine: content.split("\n").length,
      content: trimFile(content, 100, lang), score: SCORES.TEST_FILE,
      reason: "Test file for target", tokens: 0,
    });
  }

  // Barrel/re-export file
  const barrelFile = findBarrelFile(targetFile, allFileSet);
  if (barrelFile) {
    const content = safeReadFile(barrelFile);
    if (content) {
      candidates.push({
        filePath: barrelFile, relativePath: path.relative(root, barrelFile),
        symbolName: null, kind: "barrel",
        startLine: 1, endLine: content.split("\n").length,
        content, score: SCORES.BARREL_REEXPORT,
        reason: "Barrel/re-export file", tokens: estimateTokens(content),
      });
    }
  }

  return candidates;
}

function buildTSCandidates(
  targetFile: string, targetSymbol: string | null, root: string,
  allFiles: string[], allFileSet: Set<string>, candidates: Snippet[]
): void {
  const parsed = parseTSFile(targetFile, allFileSet);

  // 1. Direct imports (files the target depends on)
  for (const imp of parsed.imports) {
    if (!imp.resolved || imp.resolved === targetFile) continue;

    const depParsed = safeParseTSFile(imp.resolved, allFileSet);
    if (!depParsed) continue;

    let foundSpecificSymbol = false;
    for (const symName of imp.symbols) {
      const sym = depParsed.symbols.find(s => s.name === symName);
      if (sym) {
        foundSpecificSymbol = true;
        candidates.push({
          filePath: imp.resolved, relativePath: path.relative(root, imp.resolved),
          symbolName: sym.name, kind: sym.kind,
          startLine: sym.startLine, endLine: sym.endLine,
          content: sym.body, score: SCORES.REFERENCED_SYMBOL,
          reason: `Referenced by target (imported as ${symName})`,
          tokens: estimateTokens(sym.body),
        });
      }
    }

    // Fallback: include file summary if no specific symbols matched
    if (!foundSpecificSymbol) {
      const content = safeReadFile(imp.resolved);
      if (content) {
        candidates.push({
          filePath: imp.resolved, relativePath: path.relative(root, imp.resolved),
          symbolName: null, kind: "file",
          startLine: 1, endLine: content.split("\n").length,
          content: trimToExports(content), score: SCORES.DIRECT_IMPORT,
          reason: `Imported by target (${imp.source})`, tokens: 0,
        });
      }
    }
  }

  // 2. Files that import the target (callers/importers)
  for (const file of allFiles) {
    if (file === targetFile || getLanguage(file) !== "typescript") continue;

    const fileParsed = safeParseTSFile(file, allFileSet);
    if (!fileParsed) continue;

    for (const imp of fileParsed.imports) {
      if (imp.resolved !== targetFile) continue;

      const relevantSymbols = targetSymbol
        ? fileParsed.symbols.filter(s => s.body.includes(targetSymbol))
        : fileParsed.symbols.filter(s => imp.symbols.some(is => s.body.includes(is)));

      if (relevantSymbols.length > 0) {
        for (const sym of relevantSymbols.slice(0, 3)) {
          candidates.push({
            filePath: file, relativePath: path.relative(root, file),
            symbolName: sym.name, kind: sym.kind,
            startLine: sym.startLine, endLine: sym.endLine,
            content: sym.body, score: SCORES.DIRECT_IMPORTER,
            reason: "Imports and uses target",
            tokens: estimateTokens(sym.body),
          });
        }
      } else {
        const content = safeReadFile(file);
        if (content) {
          candidates.push({
            filePath: file, relativePath: path.relative(root, file),
            symbolName: null, kind: "file",
            startLine: 1, endLine: content.split("\n").length,
            content: trimToExports(content), score: SCORES.DIRECT_IMPORTER,
            reason: "Imports target", tokens: 0,
          });
        }
      }
      break;
    }
  }
}

function buildPyCandidates(
  targetFile: string, targetSymbol: string | null, root: string,
  allFiles: string[], allFileSet: Set<string>, candidates: Snippet[]
): void {
  const parsed = parsePyFile(targetFile, allFileSet);

  // 1. Direct imports
  for (const imp of parsed.imports) {
    if (!imp.resolved || imp.resolved === targetFile) continue;

    const depParsed = safeParsePyFile(imp.resolved, allFileSet);
    if (!depParsed) continue;

    let foundSpecificSymbol = false;
    for (const symName of imp.symbols) {
      const sym = depParsed.symbols.find(s => s.name === symName);
      if (sym) {
        foundSpecificSymbol = true;
        candidates.push({
          filePath: imp.resolved, relativePath: path.relative(root, imp.resolved),
          symbolName: sym.name, kind: sym.kind,
          startLine: sym.startLine, endLine: sym.endLine,
          content: sym.body, score: SCORES.REFERENCED_SYMBOL,
          reason: `Referenced by target (imported as ${symName})`,
          tokens: estimateTokens(sym.body),
        });
      }
    }

    // Fallback: include file summary when no specific symbol matched
    if (!foundSpecificSymbol) {
      const content = safeReadFile(imp.resolved);
      if (content) {
        candidates.push({
          filePath: imp.resolved, relativePath: path.relative(root, imp.resolved),
          symbolName: null, kind: "file",
          startLine: 1, endLine: content.split("\n").length,
          content: trimFile(content, 50, "python"), score: SCORES.DIRECT_IMPORT,
          reason: `Imported by target (${imp.source})`, tokens: 0,
        });
      }
    }
  }

  // 2. Python importers
  for (const file of allFiles) {
    if (file === targetFile || getLanguage(file) !== "python") continue;

    const fileParsed = safeParsePyFile(file, allFileSet);
    if (!fileParsed) continue;

    for (const imp of fileParsed.imports) {
      if (imp.resolved !== targetFile) continue;

      const relevantSymbols = targetSymbol
        ? fileParsed.symbols.filter(s => s.body.includes(targetSymbol))
        : fileParsed.symbols.slice(0, 3);

      for (const sym of relevantSymbols.slice(0, 3)) {
        candidates.push({
          filePath: file, relativePath: path.relative(root, file),
          symbolName: sym.name, kind: sym.kind,
          startLine: sym.startLine, endLine: sym.endLine,
          content: sym.body, score: SCORES.DIRECT_IMPORTER,
          reason: "Imports and uses target",
          tokens: estimateTokens(sym.body),
        });
      }
      break;
    }
  }
}

interface SymbolLocation {
  file: string;
  line: number;
  kind: string;
}

function findSymbolInProject(name: string, constrainFile: string | null, allFiles: string[], allFileSet: Set<string>): SymbolLocation[] | null {
  const results: SymbolLocation[] = [];
  const files = constrainFile ? [constrainFile] : allFiles;

  for (const file of files) {
    const lang = getLanguage(file);
    if (!lang) continue;

    try {
      if (lang === "typescript") {
        const parsed = parseTSFile(file, allFileSet);
        for (const sym of parsed.symbols) {
          if (sym.name === name) {
            results.push({ file, line: sym.startLine, kind: sym.kind });
          }
        }
      } else {
        const parsed = parsePyFile(file, allFileSet);
        for (const sym of parsed.symbols) {
          if (sym.name === name) {
            results.push({ file, line: sym.startLine, kind: sym.kind });
          }
        }
      }
    } catch {
      continue;
    }
  }

  return results.length > 0 ? results : null;
}

function findRelatedTests(filePath: string, allFiles: string[]): string[] {
  const baseName = path.basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|pyi)$/, "");
  const tests: string[] = [];

  const testPatterns = [
    `${baseName}.test.`,
    `${baseName}.spec.`,
    `${baseName}_test.`,
    `test_${baseName}.`,
    `${baseName}.tests.`,
  ];

  for (const file of allFiles) {
    const fileName = path.basename(file);
    for (const pattern of testPatterns) {
      if (fileName.startsWith(pattern)) {
        tests.push(file);
        break;
      }
    }
  }

  return tests;
}

function findBarrelFile(filePath: string, allFileSet: Set<string>): string | null {
  const dir = path.dirname(filePath);
  const barrelCandidates = [
    path.join(dir, "index.ts"),
    path.join(dir, "index.tsx"),
    path.join(dir, "index.js"),
    path.join(dir, "__init__.py"),
  ];

  for (const candidate of barrelCandidates) {
    if (candidate !== filePath && allFileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractImportBlock(content: string, lang: "typescript" | "python" | null): string {
  const lines = content.split("\n");
  const importLines: string[] = [];

  if (lang === "python") {
    for (const line of lines) {
      if (line.match(/^(from|import)\s/)) {
        importLines.push(line);
      }
    }
  } else {
    let inImport = false;
    for (const line of lines) {
      if (line.match(/^import\s/) || line.match(/^import\{/)) {
        inImport = true;
      }
      if (inImport) {
        importLines.push(line);
        if (line.includes("from") && (line.includes("'") || line.includes('"'))) {
          inImport = false;
        }
      }
      // Also capture require statements
      if (line.match(/require\s*\(/)) {
        importLines.push(line);
      }
    }
  }

  return importLines.join("\n");
}

function trimToExports(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let inExport = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (line.match(/^import\s/) || line.match(/^from\s.*import/) || line.match(/require\s*\(/)) {
      kept.push(line);
      continue;
    }
    if (line.match(/^export\s/)) {
      inExport = true;
    }
    if (inExport) {
      kept.push(line);
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0 && (line.trimEnd().endsWith(";") || line.trimEnd().endsWith("}"))) {
        inExport = false;
        braceDepth = 0;
      }
    }
  }

  return kept.length > 0 ? kept.join("\n") : trimFile(content, 50, "typescript");
}

function trimFile(content: string, maxLines: number, lang: "typescript" | "python" | null): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const marker = lang === "python" ? "# ..." : "// ...";
  return lines.slice(0, maxLines).join("\n") + `\n${marker} ${lines.length - maxLines} more lines ...`;
}

function extractRelevantTest(content: string, symbolName: string, lang: "typescript" | "python" | null): string | null {
  const lines = content.split("\n");
  const results: string[] = [];

  if (lang === "python") {
    // Python test functions: def test_xxx
    let inRelevantBlock = false;
    let baseIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*def\s+test_/) &&
          (line.includes(symbolName) || (i + 5 < lines.length && lines.slice(i, i + 5).some(l => l.includes(symbolName))))) {
        inRelevantBlock = true;
        baseIndent = line.length - line.trimStart().length;
      }
      if (inRelevantBlock) {
        results.push(line);
        // Check if block ended
        if (results.length > 1 && line.trim() !== "" && !line.trim().startsWith("#")) {
          const lineIndent = line.length - line.trimStart().length;
          if (lineIndent <= baseIndent && !line.match(/^\s*def\s+test_/)) {
            inRelevantBlock = false;
          }
        }
      }
    }
  } else {
    // JS/TS test blocks: describe/it/test
    let inRelevantBlock = false;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/\b(describe|it|test)\s*\(/) &&
          (line.includes(symbolName) || (i + 5 < lines.length && lines.slice(i, i + 5).some(l => l.includes(symbolName))))) {
        inRelevantBlock = true;
        depth = 0;
      }
      if (inRelevantBlock) {
        results.push(line);
        for (const ch of line) {
          if (ch === "{" || ch === "(") depth++;
          if (ch === "}" || ch === ")") depth--;
        }
        if (depth <= 0 && results.length > 1) {
          inRelevantBlock = false;
        }
      }
    }
  }

  return results.length > 0 ? results.join("\n") : null;
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function safeParseTSFile(filePath: string, allFileSet: Set<string>): TSParseResult | null {
  try {
    return parseTSFile(filePath, allFileSet);
  } catch {
    return null;
  }
}

function safeParsePyFile(filePath: string, allFileSet: Set<string>): PyParseResult | null {
  try {
    return parsePyFile(filePath, allFileSet);
  } catch {
    return null;
  }
}
