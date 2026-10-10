import { stableSerialize } from './convertMessages';
import type { ProviderConfig } from './config';
import { normalizeBaseURL } from './responsesClient';

export type ModelAliasResolution =
  | { kind: 'none' }
  | { kind: 'target'; targetModel: string }
  | { kind: 'cycle' };

export const TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS = 10 * 60_000;

export function resolveModelAliasTarget(model: string, modelAliases: Record<string, string>): ModelAliasResolution {
  const firstTarget = modelAliases[model];
  if (!firstTarget) {
    return { kind: 'none' };
  }

  const visitedModels = new Set([model]);
  let targetModel = firstTarget;
  while (true) {
    if (visitedModels.has(targetModel)) {
      return { kind: 'cycle' };
    }
    visitedModels.add(targetModel);

    const nextTarget = modelAliases[targetModel];
    if (!nextTarget) {
      return { kind: 'target', targetModel };
    }
    targetModel = nextTarget;
  }
}

export class RuntimeModelAvailability {
  private readonly temporarilyUnavailableModels = new Map<string, number>();

  markTemporarilyUnavailable(model: string, config: ProviderConfig, authIdentity: string): void {
    this.evictExpiredEntries();
    this.temporarilyUnavailableModels.set(
      this.getScopeKey(model, config, authIdentity),
      Date.now() + TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS
    );
  }

  getTemporarilyUnavailableModels(config: ProviderConfig, authIdentity: string): string[] {
    this.evictExpiredEntries();
    const scopePrefix = this.getScopePrefix(config, authIdentity);
    return [...this.temporarilyUnavailableModels.keys()]
      .filter((entry) => entry.startsWith(scopePrefix))
      .map((entry) => entry.slice(scopePrefix.length));
  }

  private evictExpiredEntries(): void {
    const now = Date.now();
    for (const [modelKey, expiresAt] of this.temporarilyUnavailableModels.entries()) {
      if (expiresAt <= now) {
        this.temporarilyUnavailableModels.delete(modelKey);
      }
    }
  }

  private getScopeKey(model: string, config: ProviderConfig, authIdentity: string): string {
    return `${this.getScopePrefix(config, authIdentity)}${model}`;
  }

  private getScopePrefix(config: ProviderConfig, authIdentity: string): string {
    return `${normalizeBaseURL(config.baseURL)}|${authIdentity}|${config.transport}|`;
  }
}

export function getExactModelNotFoundName(error: unknown, expectedModel: string): string | undefined {
  const message = getModelNotFoundMessage(error);
  if (message !== expectedModel) {
    return undefined;
  }

  return message;
}

export function getModelNotFoundMessage(error: unknown): string | undefined {
  for (const message of collectErrorMessages(error)) {
    const match = /Model not found\s+([^"\s:}]+)/i.exec(message);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

export function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      messages.push(value);
      return;
    }

    if (value instanceof Error) {
      messages.push(value.message);
      visit((value as Error & { cause?: unknown }).cause);
      return;
    }

    if (typeof value === 'object') {
      const record = value as { message?: unknown; cause?: unknown; error?: unknown };
      if (typeof record.message === 'string') {
        messages.push(record.message);
      }
      visit(record.cause);
      visit(record.error);
    }
  };

  visit(error);
  return messages;
}

export function buildModelCacheKey(
  config: ProviderConfig,
  credentialSource: string,
  credentialKind: string,
  authIdentity: string
): string {
  return [
    config.baseURL,
    config.clientVersion,
    config.credentialsSource,
    config.transport,
    config.model,
    config.includeHiddenModels,
    config.disabledModels.join(','),
    stableSerialize(config.modelAliases),
    config.defaultServiceTier ?? 'auto',
    config.defaultReasoningEffort ?? 'auto',
    config.maxOutputTokens,
    credentialSource,
    credentialKind,
    authIdentity
  ].join('|');
}

export function getRequestServiceTier(serviceTier: ProviderConfig['defaultServiceTier']): 'default' | 'priority' | undefined {
  switch (serviceTier) {
    case 'default':
      return 'default';
    case 'fast':
      return 'priority';
    default:
      return undefined;
  }
}

export function createTemporarilyUnavailableModelError(model: string, cause: unknown): Error {
  const error = new Error(`Model ${model} is listed by discovery but is not currently callable through the configured Codex Responses backend. It has been hidden temporarily from the model picker. Choose another model and retry.`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
