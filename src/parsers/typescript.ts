import * as fs from "fs";
import * as path from "path";

export interface ImportInfo {
  source: string;
  resolved: string | null;
  symbols: string[];
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

// Cache to avoid re-parsing the same file
const parseCache = new Map<string, TSParseResult>();

export function parseTSFile(filePath: string, allFileSet: Set<string> | string[]): TSParseResult {
  const cached = parseCache.get(filePath);
  if (cached) return cached;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const dir = path.dirname(filePath);
  const fileSet = allFileSet instanceof Set ? allFileSet : new Set(allFileSet);

  const imports = parseImports(content, dir, fileSet);
  const symbols = parseSymbols(content, lines);
  const exports = parseExports(content);

  const result = { imports, symbols, exports };
  parseCache.set(filePath, result);
  return result;
}

export function clearParseCache(): void {
  parseCache.clear();
}

function parseImports(content: string, dir: string, allFileSet: Set<string>): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // Handle all ES import variants:
  // import X from "source"
  // import { X, Y } from "source"
  // import * as X from "source"
  // import X, { Y, Z } from "source"
  // import "source"
  const importRegex = /import\s+(?:(?:(\w+)\s*,\s*)?\{([^}]+)\}\s+from\s+|(\*\s+as\s+\w+)\s+from\s+|(\w+)\s+from\s+)?["']([^"']+)["']/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const defaultWithNamed = match[1];  // import Default, { ... }
    const namedImports = match[2];       // { X, Y }
    const namespaceImport = match[3];    // * as X
    const defaultImport = match[4];      // import X from
    const source = match[5];

    const symbols: string[] = [];
    let isDefault = false;
    let isNamespace = false;

    if (defaultWithNamed) {
      symbols.push(defaultWithNamed);
      isDefault = true;
    }
    if (namedImports) {
      for (const s of namedImports.split(",")) {
        const name = s.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) symbols.push(name);
      }
    }
    if (namespaceImport) {
      const nsName = namespaceImport.replace(/\*\s+as\s+/, "").trim();
      symbols.push(nsName);
      isNamespace = true;
    }
    if (defaultImport) {
      symbols.push(defaultImport);
      isDefault = true;
    }

    const lineNum = content.substring(0, match.index).split("\n").length;
    const resolved = resolveImport(source, dir, allFileSet);

    imports.push({ source, resolved, symbols, isDefault, isNamespace, line: lineNum });
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
    const resolved = resolveImport(source, dir, allFileSet);
    imports.push({ source, resolved, symbols, isDefault: !!defaultName, isNamespace: false, line: lineNum });
  }

  return imports;
}

function resolveImport(source: string, fromDir: string, allFileSet: Set<string>): string | null {
  if (!source.startsWith(".") && !source.startsWith("/")) return null;

  const base = path.resolve(fromDir, source);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    base + ".mjs",
    base + ".cjs",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
    path.join(base, "index.cjs"),
  ];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (allFileSet.has(normalized) || fs.existsSync(normalized)) {
      return normalized;
    }
  }
  return null;
}

function parseSymbols(content: string, lines: string[]): SymbolDef[] {
  const symbols: SymbolDef[] = [];

  // Function declarations (top-level only: no leading whitespace)
  const funcRegex = /^(export\s+)?(export\s+default\s+)?(async\s+)?function\s+(\w+)/gm;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[4];
    const exported = !!(match[1] || match[2]);
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "function", startLine, endLine, exported, body });
  }

  // Arrow functions and const declarations (top-level only)
  const arrowRegex = /^(export\s+)?(const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm;
  while ((match = arrowRegex.exec(content)) !== null) {
    const name = match[3];
    const exported = !!match[1];
    const startLine = content.substring(0, match.index).split("\n").length;
    const restOfLine = lines[startLine - 1] || "";
    const isArrow = restOfLine.includes("=>") || restOfLine.includes("function");
    const kind = isArrow ? "function" as const : "const" as const;
    const endLine = findStatementEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind, startLine, endLine, exported, body });
  }

  // Class declarations (top-level only)
  const classRegex = /^(export\s+)?(export\s+default\s+)?(abstract\s+)?class\s+(\w+)/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[4];
    const exported = !!(match[1] || match[2]);
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "class", startLine, endLine, exported, body });
  }

  // Interface declarations (top-level only)
  const interfaceRegex = /^(export\s+)?interface\s+(\w+)/gm;
  while ((match = interfaceRegex.exec(content)) !== null) {
    const name = match[2];
    const exported = !!match[1];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "interface", startLine, endLine, exported, body });
  }

  // Type declarations (top-level only)
  const typeRegex = /^(export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[2];
    const exported = !!match[1];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findStatementEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "type", startLine, endLine, exported, body });
  }

  // Enum declarations (top-level only)
  const enumRegex = /^(export\s+)?(const\s+)?enum\s+(\w+)/gm;
  while ((match = enumRegex.exec(content)) !== null) {
    const name = match[3];
    const exported = !!match[1];
    const startLine = content.substring(0, match.index).split("\n").length;
    const endLine = findBlockEnd(lines, startLine - 1);
    const body = lines.slice(startLine - 1, endLine).join("\n");
    symbols.push({ name, kind: "enum", startLine, endLine, exported, body });
  }

  return symbols;
}

function parseExports(content: string): string[] {
  const exports: string[] = [];

  const reExportRegex = /export\s+\{([^}]+)\}/g;
  let match;
  while ((match = reExportRegex.exec(content)) !== null) {
    for (const s of match[1].split(",")) {
      const parts = s.trim().split(/\s+as\s+/);
      const name = parts[parts.length - 1].trim();
      if (name) exports.push(name);
    }
  }

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
  let braceDepth = 0;
  let parenDepth = 0;
  let openedBrace = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { braceDepth++; openedBrace = true; }
      if (ch === "}") braceDepth--;
      if (ch === "(") parenDepth++;
      if (ch === ")") parenDepth--;
    }
    // If we opened and closed braces, we're done
    if (openedBrace && braceDepth === 0 && parenDepth === 0) {
      return i + 1;
    }
    // Simple statement ending with semicolon
    if (!openedBrace && braceDepth === 0 && parenDepth === 0 && lines[i].trimEnd().endsWith(";")) {
      return i + 1;
    }
  }
  return Math.min(startIdx + 50, lines.length);
}
