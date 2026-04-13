#!/usr/bin/env node

import { parseArgs } from "./cli";
import { analyze } from "./analyzer";
import { formatMarkdown, formatJson } from "./formatter";

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    console.error('Run "ripctx --help" for usage.');
    process.exit(1);
  }

  if (args.help) {
    console.log(`ripctx — Build the smallest safe context bundle for an AI code edit

Usage:
  ripctx <path>                          Build context bundle for a file
  ripctx --symbol <name>                 Find symbol and build context bundle
  ripctx --symbol <name> --file <path>   Build context for symbol in specific file
  ripctx <path> --budget 12000           Set token budget (default: 12000)
  ripctx <path> --format json            Output as JSON instead of Markdown

Options:
  --symbol, -s <name>    Target symbol name (function, class, variable)
  --file, -f <path>      File to search for symbol in
  --budget, -b <number>  Max token budget (default: 12000)
  --format <md|json>     Output format (default: md)
  --root <path>          Project root (default: git root or cwd)
  --help, -h             Show this help
  --version, -v          Show version

Examples:
  ripctx src/auth/login.ts
  ripctx --symbol refreshSession
  ripctx --symbol handleAuth --budget 8000 --format json
  ripctx src/api/routes.py --budget 16000`);
    process.exit(0);
  }

  if (args.version) {
    console.log("ripctx 0.1.0");
    process.exit(0);
  }

  if (!args.target && !args.symbol) {
    console.error('Error: provide a file path or --symbol <name>');
    console.error('Run "ripctx --help" for usage.');
    process.exit(1);
  }

  try {
    const result = await analyze(args);
    if (args.format === "json") {
      console.log(formatJson(result));
    } else {
      console.log(formatMarkdown(result));
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
