import * as fs from "fs";
import * as path from "path";

export interface ImportInfo {
  source: string;        // raw import path
  resolved: string | null; // resolved file path
  symbols: string[];     // imported symbol names
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "variable" | "interface" | "type" | "enum" | "const";
  startLine: number;
  endLine: number;
  exported: boolean;
  body: string;
}

export interface TSParseResult {
  imports: ImportInfo[];
  symbols: SymbolDef[];
  exports: string[];
}

/**
 * Parse TypeScript/JavaScript file for imports, exports, and symbol definitions.
 * Uses regex-based parsing for speed and zero dependencies.
 */
export function parseTSFile(filePath: string, allFiles: string[]): TSParseResult {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const dir = path.dirname(filePath);

  const imports = parseImports(content, dir, allFiles);
  const symbols = parseSymbols(content, lines);
  const exports = parseExports(content);

  return { imports, symbols, exports };
}

function parseImports(content: string, dir: string, allFiles: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // import { X, Y } from "source"
  // import X from "source"
  // import * as X from "source"
  // import "source"
  const importRegex = /import\s+(?:(?:(\*\s+as\s+\w+)|(\w+)|\{([^}]+)\})\s+from\s+)?["']([^"']+)["']/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const isNamespace = !!match[1];
    const defaultImport = match[2];
    const namedImports = match[3];
    const source = match[4];

    const symbols: string[] = [];
    if (defaultImport) symbols.push(defaultImport);
    if (namedImports) {
      for (const s of namedImports.split(",")) {
        const name = s.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) symbols.push(name);
      }
    }
    if (isNamespace) {
      const nsName = match[1]!.replace(/\*\s+as\s+/, "").trim();
      symbols.push(nsName);
    }

    const lineNum = content.substring(0, match.index).split("\n").length;
    const resolved = resolveImport(source, dir, allFiles);

    imports.push({
      source,
      resolved,
      symbols,
      isDefault: !!defaultImport,
      isNamespace,
      line: lineNum,
    });
  }

  // require("source")
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const defaultName = match[1];
    const destructured = match[2];
    const source = match[3];
    const symbols: string[] = [];
    if (defaultName) symbols.push(defaultName);
    if (destructured) {
      for (const s of destructured.split(",")) {
        const name = s.trim().split(/\s*:\s*/).shift()?.trim();
        if (name) symbols.push(name);
      }
    }
    const lineNum = content.substring(0, match.index).split("\n").length;
    const resolved = resolveImport(source, path.dirname(""), allFiles);
    imports.push({ source, resolved, symbols, isDefault: !!defaultName, isNamespace: false, line: lineNum });
  }

  return imports;
}

function resolveImport(source: string, fromDir: string, allFiles: string[]): string | null {
  // Skip node_modules / external packages
  if (!source.startsWith(".") && !source.startsWith("/")) return null;

  const base = path.resolve(fromDir, source);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    base + ".mjs",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (allFiles.includes(normalized) || fs.existsSync(normalized)) {
      return normalized;
    }
  }
  return null;
}

function parseSymbols(content: string, lines: string[]): SymbolDef[] {
  const symbols: SymbolDef[] = [];

  // Function declarations
  const funcRegex = /^(\s*)(export\s+)?(export\s+default\s+)?(async\s+)?function\s+(\w+)/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[5];
    const exported = !!(match[2] || match[3]);
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "function", startLine, endLine, exported, body });
  }

  // Arrow functions and const declarations
  const arrowRegex = /^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*/gm;
  while ((match = arrowRegex.exec(content)) !== null) {
    const name = match[4];
    const exported = !!match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const restOfLine = lines[startLine - 1] || "";
    const isArrow = restOfLine.includes("=>") || restOfLine.includes("function");
    const kind = isArrow ? "function" as const : "const" as const;
    const endLine = findStatementEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind, startLine, endLine, exported, body });
  }

  // Class declarations
  const classRegex = /^(\s*)(export\s+)?(export\s+default\s+)?(abstract\s+)?class\s+(\w+)/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[5];
    const exported = !!(match[2] || match[3]);
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "class", startLine, endLine, exported, body });
  }

  // Interface declarations
  const interfaceRegex = /^(\s*)(export\s+)?interface\s+(\w+)/gm;
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[3];
    const exported = !!match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "interface", startLine, endLine, exported, body });
  }

  // Type declarations
  const typeRegex = /^(\s*)(export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[3];
    const exported = !!match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findStatementEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "type", startLine, endLine, exported, body });
  }

  // Enum declarations
  const enumRegex = /^(\s*)(export\s+)?(const\s+)?enum\s+(\w+)/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    const name = match[4];
    const exported = !!match[2];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "enum", startLine, endLine, exported, body });
  }

  return symbols;
}

function parseExports(content: string): string[] {
  const exports: string[] = [];

  // export { X, Y } from "..."  or  export { X, Y }
  const reExportRegex = /export\s+\{([^}]+)\}/g;
  let match;
  while ((match = reExportRegex.exec(content)) !== null) {
    for (const s of match[1].split(",")) {
      const parts = s.trim().split(/\s+as\s+/);
      const name = parts[parts.length - 1].trim();
      if (name) exports.push(name);
    }
  }

  // export default X
  const defaultExportRegex = /export\s+default\s+(\w+)/g;
  while ((match = defaultExportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  return exports;
}

function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") { depth--; }
      if (foundOpen && depth === 0) return i + 1;
    }
  }
  return Math.min(startIdx + 50, lines.length);
}

function findStatementEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let parenDepth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (ch === "(") parenDepth++;
      if (ch === ")") parenDepth--;
    }
    if (depth === 0 && parenDepth === 0 && (lines[i].trimEnd().endsWith(";") || lines[i].trimEnd().endsWith(","))) {
      return i + 1;
    }
    if (depth > 0 && depth === 0) return i + 1;
  }
  // If we opened braces, wait for them to close
  if (depth === 0) return startIdx + 1;
  return Math.min(startIdx + 50, lines.length);
}
