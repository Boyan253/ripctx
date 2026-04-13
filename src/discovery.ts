import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__",
  ".next", ".nuxt", "coverage", ".venv", "venv", "env",
  ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".turbo", ".cache", ".parcel-cache", "out",
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
  // Prefer git ls-files for .gitignore awareness and speed
  const gitFiles = tryGitLsFiles(root);
  if (gitFiles) return gitFiles;

  // Fallback: manual walk
  const files: string[] = [];
  walk(root, files);
  return files;
}

function tryGitLsFiles(root: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files: string[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ext = path.extname(trimmed);
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        files.push(path.resolve(root, trimmed));
      }
    }
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
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
  // Use execFileSync (no shell) for cross-platform compatibility
  try {
    const output = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseGitOutput(output, root);
  } catch {
    // Fall back to unstaged diff
    try {
      const output = execFileSync("git", ["diff", "--name-only"], {
        cwd: root,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseGitOutput(output, root);
    } catch {
      return new Set();
    }
  }
}

function parseGitOutput(output: string, root: string): Set<string> {
  const modified = new Set<string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      modified.add(path.resolve(root, trimmed));
    }
  }
  return modified;
}

export function getLanguage(filePath: string): "typescript" | "python" | null {
  const ext = path.extname(filePath);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  return null;
}
