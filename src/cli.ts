import * as fs from "fs";
import * as path from "path";

export interface CliArgs {
  target: string | null;
  symbol: string | null;
  file: string | null;
  budget: number;
  format: "md" | "json";
  root: string | null;
  help: boolean;
  version: boolean;
}

const KNOWN_FLAGS = new Set([
  "--help", "-h", "--version", "-v",
  "--symbol", "-s", "--file", "-f",
  "--budget", "-b", "--format", "--root",
]);

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    target: null,
    symbol: null,
    file: null,
    budget: 12000,
    format: "md",
    root: null,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
    } else if (arg === "--symbol" || arg === "-s") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) throw new Error("--symbol requires a value");
      args.symbol = val;
    } else if (arg === "--file" || arg === "-f") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) throw new Error("--file requires a value");
      args.file = val;
    } else if (arg === "--budget" || arg === "-b") {
      const raw = argv[++i];
      const val = parseInt(raw, 10);
      if (isNaN(val) || val <= 0) throw new Error(`--budget requires a positive number, got "${raw}"`);
      args.budget = val;
    } else if (arg === "--format") {
      const val = argv[++i];
      if (val !== "json" && val !== "md") throw new Error(`--format must be "md" or "json", got "${val}"`);
      args.format = val;
    } else if (arg === "--root") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) throw new Error("--root requires a value");
      args.root = val;
    } else if (arg.startsWith("-")) {
      if (!KNOWN_FLAGS.has(arg)) throw new Error(`Unknown flag: ${arg}`);
    } else if (!args.target) {
      args.target = arg;
    }

    i++;
  }

  // Validate --file exists
  if (args.file) {
    const resolved = path.resolve(args.file);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
  }

  return args;
}
