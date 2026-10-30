import type { ReasoningCapability } from '../openaiCompatible/chatCompletions';

/** DeepSeek's `/models` lists only IDs, so capabilities and prices come from its published model table. */

export interface DeepSeekModel {
  id: string;
  displayName: string;
  contextLength: number;
  toolCalling: boolean;
  vision: boolean;
  reasoning?: ReasoningCapability;
}

interface DeepSeekPricing {
  /** Off-peak USD per million tokens; peak hours cost twice as much. */
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

const CATALOG: Record<string, { displayName: string; contextLength: number; vision: boolean; pricing: DeepSeekPricing }> = {
  'deepseek-flash': {
    displayName: 'DeepSeek Flash',
    contextLength: 1_000_000,
    vision: true,
    pricing: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
  },
  'deepseek-v4-pro': {
    displayName: 'DeepSeek V4 Pro',
    contextLength: 1_000_000,
    vision: false,
    pricing: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
  }
};
// Retired names that DeepSeek still serves with `deepseek-flash`.
const RETIRED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
// `none` (Off) disables thinking; the default effort is `high`.
export const DEEPSEEK_REASONING: ReasoningCapability = { options: ['off', 'low', 'high', 'max'], default: 'high' };
// Models missing from the table are offered as text-only with this context.
const UNKNOWN_MODEL_CONTEXT = 131_072;

export function toDeepSeekModels(ids: readonly string[]): DeepSeekModel[] {
  return ids.flatMap((id): DeepSeekModel[] => {
    if (RETIRED_MODELS.has(id)) return [];
    const known = CATALOG[id];
    return known
      ? [{ id, displayName: known.displayName, contextLength: known.contextLength, toolCalling: true, vision: known.vision, reasoning: DEEPSEEK_REASONING }]
      : [{ id, displayName: id, contextLength: UNKNOWN_MODEL_CONTEXT, toolCalling: false, vision: false }];
  });
}

export function readModelIds(payload: unknown): string[] {
  const data = typeof payload === 'object' && payload !== null ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new Error('DeepSeek returned an invalid model list.');
  }
  return data.flatMap((entry) => {
    const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  });
}

/** Estimated USD cost at DeepSeek's list price; unknown models have none. Chinese public holidays are not modeled. */
export function estimateDeepSeekCostUsd(
  model: string,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  at = new Date()
): number | undefined {
  const pricing = CATALOG[model]?.pricing;
  if (!pricing) return undefined;
  const multiplier = isDeepSeekPeak(at) ? 2 : 1;
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  return multiplier * (
    cached * pricing.cacheHit
    + (tokens.inputTokens - cached) * pricing.cacheMiss
    + tokens.outputTokens * pricing.output
  ) / 1_000_000;
}

/** Peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}
