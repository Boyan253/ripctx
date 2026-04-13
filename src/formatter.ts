import * as path from "path";
import { AnalysisResult } from "./analyzer";

export function formatMarkdown(result: AnalysisResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ripctx — Context Bundle`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Target** | \`${result.targetPath}\`${result.symbolName ? ` → \`${result.symbolName}\`` : ""} |`);
  lines.push(`| **Mode** | ${result.mode} |`);
  lines.push(`| **Project** | \`${result.projectRoot}\` |`);
  lines.push(`| **Tokens** | ${result.totalTokens.toLocaleString()} / ${result.budget.toLocaleString()} |`);
  lines.push(`| **Files** | ${result.included.length + 1} included, ${result.omitted.length} omitted |`);
  lines.push(``);

  // Why included
  lines.push(`## Why included`);
  lines.push(``);
  lines.push(`| # | File | Symbol | Score | Reason | Tokens |`);
  lines.push(`|---|------|--------|-------|--------|--------|`);
  lines.push(`| 0 | \`${result.target.relativePath}\` | ${result.target.symbolName ? `\`${result.target.symbolName}\`` : "—"} | ${result.target.score} | ${result.target.reason} | ${result.target.tokens.toLocaleString()} |`);

  result.included.forEach((s, i) => {
    lines.push(`| ${i + 1} | \`${s.relativePath}\` | ${s.symbolName ? `\`${s.symbolName}\`` : "—"} | ${s.score} | ${s.reason} | ${s.tokens.toLocaleString()} |`);
  });
  lines.push(``);

  // Bundle
  lines.push(`## Bundle`);
  lines.push(``);

  // Target first
  const targetExt = path.extname(result.target.filePath).replace(".", "");
  const langHint = getLangHint(targetExt);
  lines.push(`### \`${result.target.relativePath}\`${result.target.symbolName ? ` → \`${result.target.symbolName}\`` : ""}`);
  lines.push(`> ${result.target.reason} (${result.target.tokens.toLocaleString()} tokens)`);
  lines.push(``);
  lines.push(`\`\`\`${langHint}`);
  lines.push(result.target.content);
  lines.push(`\`\`\``);
  lines.push(``);

  // Included snippets
  for (const s of result.included) {
    const ext = path.extname(s.filePath).replace(".", "");
    const lang = getLangHint(ext);
    lines.push(`### \`${s.relativePath}\`${s.symbolName ? ` → \`${s.symbolName}\`` : ""}`);
    lines.push(`> ${s.reason} (${s.tokens.toLocaleString()} tokens)`);
    lines.push(``);
    lines.push(`\`\`\`${lang}`);
    lines.push(s.content);
    lines.push(`\`\`\``);
    lines.push(``);
  }

  // Omitted
  if (result.omitted.length > 0) {
    lines.push(`## Omitted (budget exceeded)`);
    lines.push(``);
    for (const s of result.omitted) {
      lines.push(`- \`${s.relativePath}\`${s.symbolName ? ` → \`${s.symbolName}\`` : ""} — ${s.reason} (${s.tokens.toLocaleString()} tokens, score ${s.score})`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export function formatJson(result: AnalysisResult): string {
  return JSON.stringify({
    meta: {
      target: result.targetPath,
      symbol: result.symbolName,
      mode: result.mode,
      projectRoot: result.projectRoot,
      totalTokens: result.totalTokens,
      budget: result.budget,
      includedCount: result.included.length + 1,
      omittedCount: result.omitted.length,
    },
    bundle: [
      {
        file: result.target.relativePath,
        symbol: result.target.symbolName,
        kind: result.target.kind,
        score: result.target.score,
        reason: result.target.reason,
        tokens: result.target.tokens,
        lines: [result.target.startLine, result.target.endLine],
        content: result.target.content,
      },
      ...result.included.map(s => ({
        file: s.relativePath,
        symbol: s.symbolName,
        kind: s.kind,
        score: s.score,
        reason: s.reason,
        tokens: s.tokens,
        lines: [s.startLine, s.endLine],
        content: s.content,
      })),
    ],
    omitted: result.omitted.map(s => ({
      file: s.relativePath,
      symbol: s.symbolName,
      kind: s.kind,
      score: s.score,
      reason: s.reason,
      tokens: s.tokens,
    })),
  }, null, 2);
}

function getLangHint(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    pyi: "python",
  };
  return map[ext] || ext;
}
