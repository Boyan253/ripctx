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
      args.symbol = argv[++i] ?? null;
    } else if (arg === "--file" || arg === "-f") {
      args.file = argv[++i] ?? null;
    } else if (arg === "--budget" || arg === "-b") {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val > 0) args.budget = val;
    } else if (arg === "--format") {
      const val = argv[++i];
      if (val === "json" || val === "md") args.format = val;
    } else if (arg === "--root") {
      args.root = argv[++i] ?? null;
    } else if (!arg.startsWith("-") && !args.target) {
      args.target = arg;
    }

    i++;
  }

  return args;
}
