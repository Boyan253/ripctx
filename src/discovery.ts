import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__",
  ".next", ".nuxt", "coverage", ".venv", "venv", "env",
  ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
]);

export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "pyproject.toml")) ||
      fs.existsSync(path.join(dir, "setup.py"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function discoverFiles(root: string): string[] {
  const files: string[] = [];
  walk(root, files);
  return files;
}

function walk(dir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walk(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
}

export function getModifiedFiles(root: string): Set<string> {
  try {
    const output = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null || echo \"\"", {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const modified = new Set<string>();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        modified.add(path.resolve(root, trimmed));
      }
    }
    return modified;
  } catch {
    return new Set();
  }
}

export function getLanguage(filePath: string): "typescript" | "python" | null {
  const ext = path.extname(filePath);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  return null;
}
