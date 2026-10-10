export interface LatestRequestUsage {
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

/** One tooltip line shared by the Claude and Codex account-limit status bars. */
export function formatLatestRequestLine(usage: LatestRequestUsage): string {
  const parts = [
    `${formatTokens(usage.inputTokens)} input`,
    usage.cachedInputTokens > 0 ? `${formatTokens(usage.cachedInputTokens)} cached` : undefined,
    `${formatTokens(usage.outputTokens)} output`,
    usage.reasoningTokens ? `${formatTokens(usage.reasoningTokens)} reasoning` : undefined
  ].filter(Boolean).join(' · ');
  return `Latest request${usage.model ? ` (${usage.model})` : ''}: ${parts}`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
