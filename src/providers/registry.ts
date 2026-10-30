import type * as vscode from 'vscode';

export const PROVIDER_IDS = ['claude', 'codex', 'deepseek', 'lmstudio', 'openaiCompatible'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

/** Account status a combo reads before calling a provider, so it can skip one that is known to be out of quota. */
export interface ProviderAvailability {
  /** When `modelId` cannot be served now, the time (epoch ms) it is expected to recover; otherwise undefined. */
  exhaustedUntil(modelId: string, now: number): number | undefined;
}

/** What each provider's activation returns: the provider itself, and its account status when it has one. */
export interface ActivatedProvider {
  provider: vscode.LanguageModelChatProvider;
  availability?: ProviderAvailability;
}

export type ProviderRegistry = ReadonlyMap<ProviderId, ActivatedProvider>;
