import * as fs from "fs";
import * as path from "path";

export interface PyImportInfo {
  source: string;
  resolved: string | null;
  symbols: string[];
  line: number;
}

export interface PySymbolDef {
  name: string;
  kind: "function" | "class" | "variable";
  startLine: number;
  endLine: number;
  exported: boolean;
  body: string;
}

export interface PyParseResult {
  imports: PyImportInfo[];
  symbols: PySymbolDef[];
}

// Cache to avoid re-parsing
const parseCache = new Map<string, PyParseResult>();

export function parsePyFile(filePath: string, allFileSet: Set<string> | string[]): PyParseResult {
  const cached = parseCache.get(filePath);
  if (cached) return cached;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const dir = path.dirname(filePath);
  const fileSet = allFileSet instanceof Set ? allFileSet : new Set(allFileSet);

  const imports = parsePyImports(content, dir, fileSet);
  const symbols = parsePySymbols(content, lines);

  const result = { imports, symbols };
  parseCache.set(filePath, result);
  return result;
}

export function clearPyParseCache(): void {
  parseCache.clear();
}

function parsePyImports(content: string, dir: string, allFileSet: Set<string>): PyImportInfo[] {
  const imports: PyImportInfo[] = [];

  // from X import Y, Z  (including relative: from .X, from ..X.Y)
  const fromImportRegex = /^from\s+(\.{0,3}[\w.]*)\s+import\s+(.+)/gm;
  let match;
  while ((match = fromImportRegex.exec(content)) !== null) {
    const source = match[1];
    const importedStr = match[2].replace(/\([\s\S]*?\)/, (m) => m.replace(/\n/g, ""));
    const symbols: string[] = [];
    for (const s of importedStr.split(",")) {
      const name = s.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("#")) symbols.push(name);
    }
    const line = content.substring(0, match.index).split("\n").length;
    const resolved = resolvePyImport(source, dir, allFileSet);
    imports.push({ source, resolved, symbols, line });
  }

  // import X, import X.Y
  const importRegex = /^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
  while ((match = importRegex.exec(content)) !== null) {
    for (const part of match[1].split(",")) {
      const modulePath = part.trim().split(/\s+as\s+/)[0].trim();
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim() || modulePath;
      const line = content.substring(0, match.index).split("\n").length;
      const resolved = resolvePyImport(modulePath, dir, allFileSet);
      imports.push({ source: modulePath, resolved, symbols: [alias], line });
    }
  }

  return imports;
}

function resolvePyImport(source: string, fromDir: string, allFileSet: Set<string>): string | null {
  // Handle relative imports (leading dots)
  const dotMatch = source.match(/^(\.+)(.*)/);
  if (dotMatch) {
    const dots = dotMatch[1].length;
    const rest = dotMatch[2];

    // Go up (dots - 1) directories from fromDir
    let baseDir = fromDir;
    for (let i = 1; i < dots; i++) {
      baseDir = path.dirname(baseDir);
    }

    const parts = rest ? rest.split(".") : [];
    const candidates = [
      path.join(baseDir, ...parts) + ".py",
      path.join(baseDir, ...parts, "__init__.py"),
    ];

    for (const candidate of candidates) {
      const normalized = path.normalize(candidate);
      if (allFileSet.has(normalized) || fs.existsSync(normalized)) {
        return normalized;
      }
    }
    return null;
  }

  // Absolute import
  const parts = source.split(".");

  // Try relative to current dir first
  const relCandidates = [
    path.join(fromDir, ...parts) + ".py",
    path.join(fromDir, ...parts, "__init__.py"),
  ];

  for (const candidate of relCandidates) {
    const normalized = path.normalize(candidate);
    if (allFileSet.has(normalized) || fs.existsSync(normalized)) {
      return normalized;
    }
  }

  // Try matching against known files by module name
  const targetFileName = parts[parts.length - 1] + ".py";
  const modulePathSuffix = parts.join(path.sep) + ".py";
  const moduleInitSuffix = parts.join(path.sep) + path.sep + "__init__.py";

  for (const file of allFileSet) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.endsWith(modulePathSuffix.replace(/\\/g, "/")) ||
        normalized.endsWith(moduleInitSuffix.replace(/\\/g, "/"))) {
      return file;
    }
  }

  return null;
}

function parsePySymbols(content: string, lines: string[]): PySymbolDef[] {
  const symbols: PySymbolDef[] = [];

  // def function_name(...): — top-level only (no leading whitespace)
  const funcRegex = /^(async\s+)?def\s+(\w+)\s*\(/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPyBlockEnd(lines, startLine - 1, 0);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const exported = !name.startsWith("_");
    symbols.push({ name, kind: "function", startLine, endLine, exported, body });
  }

  // class ClassName: — top-level only
  const classRegex = /^class\s+(\w+)[\s(:]/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[1];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPyBlockEnd(lines, startLine - 1, 0);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const exported = !name.startsWith("_");
    symbols.push({ name, kind: "class", startLine, endLine, exported, body });
  }

  // Module-level variable assignments: NAME = ...
  const varRegex = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?\s*=/gm;
  while ((match = varRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip if it's a known keyword or dunder
    if (["if", "else", "elif", "for", "while", "with", "try", "except", "finally", "return", "yield"].includes(name)) continue;
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = startLine; // Variables are single-line for simplicity
    const body = lines[startLine - 1];
    const exported = !name.startsWith("_");
    symbols.push({ name, kind: "variable", startLine, endLine, exported, body });
  }

  return symbols;
}

function findPyBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.trim().startsWith("#")) continue;

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= baseIndent) {
      return i;
    }
  }
  return lines.length;
}
