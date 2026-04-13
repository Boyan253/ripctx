import { estimateTokens } from "./tokens";

export interface Snippet {
  filePath: string;
  relativePath: string;
  symbolName: string | null;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reason: string;
  tokens: number;
}

export interface RankedResult {
  included: Snippet[];
  omitted: Snippet[];
  target: Snippet;
  totalTokens: number;
  budget: number;
}

const SCORES = {
  TARGET: 100,
  REFERENCED_SYMBOL: 60,
  DIRECT_IMPORT: 45,
  DIRECT_IMPORTER: 35,
  TEST_FILE: 30,
  BARREL_REEXPORT: 20,
  MODIFIED_BONUS: 10,
};

export function rankAndPack(
  target: Snippet,
  candidates: Snippet[],
  modifiedFiles: Set<string>,
  budget: number
): RankedResult {
  // Enforce budget on target
  const targetTokens = estimateTokens(target.content);
  target.tokens = targetTokens;

  if (targetTokens > budget) {
    // Truncate target to fit exactly within budget
    const banner = "\n// ... TARGET_TRUNCATED (use --symbol or increase --budget) ...";
    const bannerTokens = estimateTokens(banner);
    const availableTokens = Math.max(1, budget - bannerTokens);
    const maxChars = Math.floor(availableTokens * 3.5);
    const lines = target.content.split("\n");
    let result = "";
    for (const line of lines) {
      if (result.length + line.length + 1 > maxChars) {
        break;
      }
      result += (result ? "\n" : "") + line;
    }
    result += banner;
    target.content = result;
    target.tokens = estimateTokens(result);
    // Ensure we never exceed budget
    if (target.tokens > budget) {
      target.content = banner.trim();
      target.tokens = bannerTokens;
    }
    target.reason += " [truncated to fit budget]";
  }

  // Apply modified bonus
  for (const c of candidates) {
    if (modifiedFiles.has(c.filePath)) {
      c.score += SCORES.MODIFIED_BONUS;
      c.reason += " [modified in working tree]";
    }
  }

  // Apply size penalty: prefer smaller snippets
  for (const c of candidates) {
    const sizePenalty = Math.min(15, Math.floor(c.tokens / 500));
    c.score -= sizePenalty;
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Deduplicate: if same file + same symbol, keep highest score
  const seen = new Set<string>();
  const deduped: Snippet[] = [];
  for (const c of candidates) {
    const key = `${c.filePath}:${c.symbolName || "file"}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }

  // Greedy packing
  let remaining = budget - target.tokens;
  const included: Snippet[] = [];
  const omitted: Snippet[] = [];

  for (const c of deduped) {
    c.tokens = estimateTokens(c.content);
    if (c.tokens <= remaining) {
      included.push(c);
      remaining -= c.tokens;
    } else if (remaining > 200) {
      // Try truncating to fit
      const truncatedContent = truncateSnippet(c.content, remaining);
      const truncTokens = estimateTokens(truncatedContent);
      if (truncTokens <= remaining && truncTokens > 100) {
        c.content = truncatedContent;
        c.tokens = truncTokens;
        c.reason += " [truncated to fit budget]";
        included.push(c);
        remaining -= truncTokens;
      } else {
        omitted.push(c);
      }
    } else {
      omitted.push(c);
    }
  }

  const totalTokens = target.tokens + included.reduce((sum, s) => sum + s.tokens, 0);

  return { included, omitted, target, totalTokens, budget };
}

function truncateSnippet(content: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.5);
  if (content.length <= maxChars) return content;

  const lines = content.split("\n");
  let result = "";
  for (const line of lines) {
    if (result.length + line.length + 1 > maxChars - 30) {
      result += "\n// ... truncated ...";
      break;
    }
    result += (result ? "\n" : "") + line;
  }
  return result;
}

export { SCORES };
