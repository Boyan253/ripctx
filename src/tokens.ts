/**
 * Approximate token count. GPT/Claude tokenizers average ~4 chars per token
 * for English/code. This is intentionally conservative (slightly over-counts)
 * so bundles fit within real budgets.
 */
export function estimateTokens(text: string): number {
  // ~3.5 chars per token for code (conservative)
  return Math.ceil(text.length / 3.5);
}
