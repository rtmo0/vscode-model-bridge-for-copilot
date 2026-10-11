import { stableSerialize } from './convertMessages';
import type { ProviderConfig } from './config';
import { normalizeBaseURL } from './responsesClient';
import { CODEX_CLI_COMPATIBLE_VERSION } from './codexRequestIdentity';

export type ModelAliasResolution =
  | { kind: 'none' }
  | { kind: 'target'; targetModel: string }
  | { kind: 'cycle' };

export const TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS = 10 * 60_000;
export const BACKEND_REJECTED_MODEL_TTL_MS = 7 * 24 * 60 * 60_000;
const BACKEND_REJECTED_MODELS_KEY = 'modelBridge.codex.backendRejectedModels';
const MAX_BACKEND_REJECTED_MODELS = 64;

interface ModelAvailabilityMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface BackendRejectedModelEntry {
  expiresAt: number;
  clientVersion: string;
}

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

  constructor(private readonly memento?: ModelAvailabilityMemento) {}

  markTemporarilyUnavailable(model: string, config: ProviderConfig, authIdentity: string): void {
    this.evictExpiredEntries();
    this.temporarilyUnavailableModels.set(
      this.getScopeKey(model, config, authIdentity),
      Date.now() + TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS
    );
  }

  /** Persists a backend rejection that will repeat until the declared Codex version or the account changes. */
  markRejectedByBackend(model: string, config: ProviderConfig, authIdentity: string): void {
    this.markTemporarilyUnavailable(model, config, authIdentity);
    if (!this.memento) {
      return;
    }
    const entries = Object.entries(this.readBackendRejectedModels())
      .filter(([key]) => key !== this.getScopeKey(model, config, authIdentity));
    entries.push([
      this.getScopeKey(model, config, authIdentity),
      { expiresAt: Date.now() + BACKEND_REJECTED_MODEL_TTL_MS, clientVersion: CODEX_CLI_COMPATIBLE_VERSION }
    ]);
    void this.memento.update(BACKEND_REJECTED_MODELS_KEY, Object.fromEntries(entries.slice(-MAX_BACKEND_REJECTED_MODELS)));
  }

  getTemporarilyUnavailableModels(config: ProviderConfig, authIdentity: string): string[] {
    this.evictExpiredEntries();
    const scopePrefix = this.getScopePrefix(config, authIdentity);
    const keys = new Set([...this.temporarilyUnavailableModels.keys(), ...Object.keys(this.readBackendRejectedModels())]);
    return [...keys]
      .filter((entry) => entry.startsWith(scopePrefix))
      .map((entry) => entry.slice(scopePrefix.length));
  }

  private readBackendRejectedModels(): Record<string, BackendRejectedModelEntry> {
    const stored = this.memento?.get<Record<string, BackendRejectedModelEntry>>(BACKEND_REJECTED_MODELS_KEY);
    if (!stored || typeof stored !== 'object') {
      return {};
    }
    const now = Date.now();
    return Object.fromEntries(Object.entries(stored).filter(([, entry]) => (
      typeof entry?.expiresAt === 'number'
      && entry.expiresAt > now
      && entry.clientVersion === CODEX_CLI_COMPATIBLE_VERSION
    )));
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

export type BackendModelRejectionReason = 'client-version' | 'account';

const BACKEND_MODEL_REJECTIONS: readonly { reason: BackendModelRejectionReason; pattern: RegExp }[] = [
  // Gate for models whose minimal_client_version exceeds the declared client version.
  { reason: 'client-version', pattern: /(?:The '([^']+)' model )?requires a newer version of Codex/i },
  { reason: 'account', pattern: /(?:The '([^']+)' model )?is not supported when using Codex with a ChatGPT account/i }
];

/** Models whose catalog minimum exceeds the declared Codex version are rejected by the backend. */
export function isClientVersionSupported(minimalClientVersion: unknown, declaredVersion: string | undefined): boolean {
  const minimum = parseVersion(minimalClientVersion);
  const declared = parseVersion(declaredVersion);
  if (!minimum || !declared) {
    return true;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (declared[index] !== minimum[index]) {
      return declared[index] > minimum[index];
    }
  }
  return true;
}

function parseVersion(value: unknown): number[] | undefined {
  const match = typeof value === 'string' ? /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(value) : null;
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** Backend rejections that will repeat for this model until the client or account changes. */
export function getBackendModelRejection(
  error: unknown,
  expectedModel: string
): { model: string; reason: BackendModelRejectionReason } | undefined {
  for (const message of collectErrorMessages(error)) {
    for (const { reason, pattern } of BACKEND_MODEL_REJECTIONS) {
      const match = pattern.exec(message);
      if (match && (!match[1] || match[1].trim() === expectedModel)) {
        return { model: expectedModel, reason };
      }
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

export function createBackendRejectedModelError(model: string, reason: BackendModelRejectionReason, cause: unknown): Error {
  const detail = reason === 'client-version'
    ? 'requires a newer Codex client than Model Bridge supports'
    : 'is not available to ChatGPT accounts through Codex';
  const error = new Error(`Model ${model} ${detail}, so the Codex backend rejected the request. It has been hidden temporarily from the model picker. Choose another model and retry.`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
