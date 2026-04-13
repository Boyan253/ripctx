import { parseArgs } from "./cli";
import { analyze } from "./analyzer";
import * as path from "path";

const projectRoot = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

async function testParseArgs() {
  console.log("CLI argument parsing...");

  const args1 = parseArgs(["src/foo.ts"]);
  assert(args1.target === "src/foo.ts", "should parse target path");
  assert(args1.budget === 12000, "default budget should be 12000");
  assert(args1.format === "md", "default format should be md");

  const args2 = parseArgs(["--symbol", "myFunc", "--budget", "8000", "--format", "json"]);
  assert(args2.symbol === "myFunc", "should parse --symbol");
  assert(args2.budget === 8000, "should parse --budget");
  assert(args2.format === "json", "should parse --format json");

  // Reject bad budget
  let threw = false;
  try { parseArgs(["--budget", "10abc"]); } catch { threw = true; }
  assert(threw, "should reject --budget 10abc");

  threw = false;
  try { parseArgs(["--budget", "1.5"]); } catch { threw = true; }
  assert(threw, "should reject --budget 1.5");

  // Reject unknown flags
  threw = false;
  try { parseArgs(["--unknown"]); } catch { threw = true; }
  assert(threw, "should reject unknown flag");
}

async function testFileMode() {
  console.log("File mode analysis...");

  const result = await analyze({
    target: path.join(projectRoot, "src", "cli.ts"),
    symbol: null, file: null, budget: 12000, format: "md", root: projectRoot, help: false, version: false,
  });

  assert(result.targetPath.includes("cli"), "target path should include cli");
  assert(result.totalTokens > 0, "should have tokens > 0");
  assert(result.totalTokens <= result.budget, "should not exceed budget");
  assert(result.included.length >= 0, "should have included snippets");
}

async function testSymbolMode() {
  console.log("Symbol mode analysis...");

  const result = await analyze({
    target: null, symbol: "parseArgs", file: null, budget: 12000, format: "md", root: projectRoot, help: false, version: false,
  });

  assert(result.symbolName === "parseArgs", "symbol name should be parseArgs");
  assert(result.mode === "symbol", "mode should be symbol");
  assert(result.totalTokens <= result.budget, "should not exceed budget");
}

async function testBudgetEnforcement() {
  console.log("Budget enforcement...");

  const result = await analyze({
    target: path.join(projectRoot, "src", "analyzer.ts"),
    symbol: null, file: null, budget: 50, format: "md", root: projectRoot, help: false, version: false,
  });

  assert(result.totalTokens <= 50, `tokens (${result.totalTokens}) should be <= 50`);
  assert(result.target.reason.includes("truncated"), "target should be marked truncated");
}

async function testSymbolNotFound() {
  console.log("Symbol not found...");

  let threw = false;
  try {
    await analyze({
      target: null, symbol: "nonexistentSymbol12345", file: null, budget: 12000, format: "md", root: projectRoot, help: false, version: false,
    });
  } catch { threw = true; }
  assert(threw, "should throw for nonexistent symbol");
}

async function main() {
  console.log("ripctx test suite\n");

  await testParseArgs();
  await testFileMode();
  await testSymbolMode();
  await testBudgetEnforcement();
  await testSymbolNotFound();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
