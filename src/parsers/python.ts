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

export function parsePyFile(filePath: string, allFiles: string[]): PyParseResult {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const dir = path.dirname(filePath);

  const imports = parsePyImports(content, dir, allFiles);
  const symbols = parsePySymbols(content, lines);

  return { imports, symbols };
}

function parsePyImports(content: string, dir: string, allFiles: string[]): PyImportInfo[] {
  const imports: PyImportInfo[] = [];

  // from X import Y, Z
  const fromImportRegex = /^from\s+([\w.]+)\s+import\s+(.+)/gm;
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
    const resolved = resolvePyImport(source, dir, allFiles);
    imports.push({ source, resolved, symbols, line });
  }

  // import X, import X.Y
  const importRegex = /^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
  while ((match = importRegex.exec(content)) !== null) {
    for (const part of match[1].split(",")) {
      const modulePath = part.trim().split(/\s+as\s+/)[0].trim();
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim() || modulePath;
      const line = content.substring(0, match.index).split("\n").length;
      const resolved = resolvePyImport(modulePath, dir, allFiles);
      imports.push({ source: modulePath, resolved, symbols: [alias], line });
    }
  }

  return imports;
}

function resolvePyImport(source: string, fromDir: string, allFiles: string[]): string | null {
  // Convert dotted path to file path
  const parts = source.split(".");

  // Try relative resolution
  const relCandidates = [
    path.join(fromDir, ...parts) + ".py",
    path.join(fromDir, ...parts, "__init__.py"),
  ];

  for (const candidate of relCandidates) {
    const normalized = path.normalize(candidate);
    if (allFiles.includes(normalized) || fs.existsSync(normalized)) {
      return normalized;
    }
  }

  // Try from project root (handled by caller via allFiles matching)
  for (const file of allFiles) {
    const fileParts = file.replace(/\\/g, "/").split("/");
    const fileName = fileParts[fileParts.length - 1].replace(/\.py$/, "");
    if (fileName === parts[parts.length - 1]) {
      // Check if path segments match
      const moduleEnd = parts.join("/");
      if (file.replace(/\\/g, "/").includes(moduleEnd.replace(".py", "") )) {
        return file;
      }
    }
  }

  return null;
}

function parsePySymbols(content: string, lines: string[]): PySymbolDef[] {
  const symbols: PySymbolDef[] = [];

  // def function_name(...):
  const funcRegex = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const indent = match[1].length;
    const name = match[3];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPyBlockEnd(lines, startLine - 1, indent);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const exported = !name.startsWith("_");
    symbols.push({ name, kind: "function", startLine, endLine, exported, body });
  }

  // class ClassName:
  const classRegex = /^(\s*)class\s+(\w+)[\s(]/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const indent = match[1].length;
    const name = match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findPyBlockEnd(lines, startLine - 1, indent);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const exported = !name.startsWith("_");
    symbols.push({ name, kind: "class", startLine, endLine, exported, body });
  }

  return symbols;
}

function findPyBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  // Python blocks end when indentation returns to base level
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // skip blank lines
    if (line.trim().startsWith("#")) continue; // skip comments

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= baseIndent) {
      return i;
    }
  }
  return lines.length;
}
