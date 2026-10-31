import { getRetryAfterMs, ProviderHttpError } from '../providerError';
import { PROVIDER_IDS, type ProviderId } from '../registry';

/**
 * Combo routing without VS Code: settings, target resolution, error classification, cooldown, and sticky routes.
 * Everything here stays in memory; conversation keys are never persisted or logged.
 */

export interface ComboTarget {
  provider: ProviderId;
  model: string;
  /** `provider:model` as normalized from the setting; also the cooldown key, shared by every combo. */
  label: string;
}

export interface FallbackCombo {
  name: string;
  strategy: 'fallback';
  targets: ComboTarget[];
}

/**
 * The planner writes a short plan for each new prompt; the first available executor does the tool steps, and the
 * others take over in order when it fails before answering.
 */
export interface PlanExecuteCombo {
  name: string;
  strategy: 'planExecute';
  planner: ComboTarget;
  executors: ComboTarget[];
}

export type Combo = FallbackCombo | PlanExecuteCombo;

export interface ParsedCombos {
  combos: Combo[];
  /** Entries or targets skipped because they are invalid, for the Doctor. */
  invalid: string[];
}

export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_MAX_MS = 15 * 60_000;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const ROUTE_LIMIT = 256;

export function parseCombos(value: unknown): ParsedCombos {
  const combos: Combo[] = [];
  const invalid: string[] = [];
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) {
      invalid.push(`#${index + 1} (needs a name)`);
      continue;
    }
    const name = entry.name.trim();
    const strategy = entry.strategy ?? 'fallback';
    if (combos.some((combo) => combo.name === name)) {
      invalid.push(`${name} (duplicate name)`);
    } else if (strategy === 'planExecute') {
      const planner = typeof entry.planner === 'string' ? parseTarget(entry.planner) : undefined;
      // One executor as a string, or several in order.
      const rawExecutors = Array.isArray(entry.executor) ? entry.executor : entry.executor === undefined ? [] : [entry.executor];
      const executors: ComboTarget[] = [];
      for (const raw of rawExecutors) {
        const executor = typeof raw === 'string' ? parseTarget(raw) : undefined;
        if (!executor) {
          invalid.push(`${name}: executor ${JSON.stringify(raw)} (use provider:model, provider one of ${PROVIDER_IDS.join(', ')})`);
        } else if (executor.label === planner?.label) {
          invalid.push(`${name}: executor ${executor.label} (the planner cannot also be an executor)`);
        } else if (!executors.some((existing) => existing.label === executor.label)) {
          executors.push(executor);
        }
      }
      if (!planner || executors.length === 0) {
        invalid.push(`${name} (planExecute needs a planner and at least one executor as provider:model)`);
      } else {
        combos.push({ name, strategy, planner, executors });
      }
    } else if (strategy !== 'fallback') {
      invalid.push(`${name} (strategy ${JSON.stringify(strategy)} is not supported; use "fallback" or "planExecute")`);
    } else {
      const targets: ComboTarget[] = [];
      for (const raw of Array.isArray(entry.targets) ? entry.targets : []) {
        const target = typeof raw === 'string' ? parseTarget(raw) : undefined;
        if (!target) {
          invalid.push(`${name}: target ${JSON.stringify(raw)} (use provider:model, provider one of ${PROVIDER_IDS.join(', ')})`);
        } else if (!targets.some((existing) => existing.label === target.label)) {
          targets.push(target);
        }
      }
      if (targets.length > 0) {
        combos.push({ name, strategy, targets });
      } else {
        invalid.push(`${name} (no valid targets)`);
      }
    }
  }
  return { combos, invalid };
}

/** Every target of a combo; a plan → execute combo lists the planner first. */
export function comboTargets(combo: Combo): ComboTarget[] {
  return combo.strategy === 'fallback' ? combo.targets : [combo.planner, ...combo.executors];
}

/** The `provider:model` a setting should hold for a listed model: readable, and matched back by `findTargetModel`. */
export function toTargetSetting(provider: ProviderId, modelId: string): string {
  const parts = modelId.split('::');
  if (provider === 'openaiCompatible' && parts.length === 3) {
    return `${provider}:${safeDecode(parts[1])}/${safeDecode(parts[2])}`;
  }
  return `${provider}:${parts.length > 1 ? parts.slice(1).join('::') : modelId}`;
}

export function parseTarget(value: string): ComboTarget | undefined {
  const match = /^\s*([A-Za-z]+)\s*:(.+)$/.exec(value);
  const provider = PROVIDER_IDS.find((id) => id.toLowerCase() === match?.[1].toLowerCase());
  const model = match?.[2].trim();
  return provider && model ? { provider, model, label: `${provider}:${model}` } : undefined;
}

/** Matches a model's `id` (with or without the provider's `prefix::`), then its `name`, case-insensitively. */
export function findTargetModel<T extends { id: string; name: string }>(target: ComboTarget, models: readonly T[]): T | undefined {
  const wanted = target.model.toLowerCase();
  return models.find((model) => modelIdKeys(target.provider, model.id).includes(wanted))
    ?? models.find((model) => model.name.toLowerCase() === wanted);
}

function modelIdKeys(provider: ProviderId, id: string): string[] {
  const keys = [id];
  const separator = id.indexOf('::');
  if (separator > 0) keys.push(id.slice(separator + 2));
  // OpenAI-Compatible ids are `oai::<endpoint>::<model>`, URI-encoded; `<endpoint>/<model>` is easier to write.
  const [, endpoint, model] = id.split('::');
  if (provider === 'openaiCompatible' && endpoint !== undefined && model !== undefined) {
    keys.push(`${safeDecode(endpoint)}/${safeDecode(model)}`, `${safeDecode(endpoint)}::${safeDecode(model)}`);
  }
  return keys.map((key) => key.toLowerCase());
}

export interface TargetWindow {
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities?: { toolCalling?: boolean | number; imageInput?: boolean };
}

/** A combo can promise only what every target supports, and a fallback must never overflow a smaller window. */
export function combineTargetWindows(targets: readonly TargetWindow[]): {
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean | number;
  imageInput: boolean;
} {
  const toolCalling = targets.map((target) => target.capabilities?.toolCalling ?? false);
  const toolLimits = toolCalling.filter((value): value is number => typeof value === 'number');
  return {
    maxInputTokens: Math.min(...targets.map((target) => target.maxInputTokens)),
    maxOutputTokens: Math.min(...targets.map((target) => target.maxOutputTokens)),
    toolCalling: !toolCalling.every(Boolean) ? false : toolLimits.length > 0 ? Math.min(...toolLimits) : true,
    imageInput: targets.every((target) => target.capabilities?.imageInput === true)
  };
}

export type FailureReason = 'rate-limit' | 'quota' | 'server' | 'network' | 'timeout' | 'auth' | 'unavailable';

export interface Failure {
  reason: FailureReason;
  retryAfterMs?: number;
}

const CONTEXT_PATTERN = /context (?:size|length|window)|maximum context|prompt.+too long|too many tokens/i;
const QUOTA_PATTERN = /quota|usage limit|insufficient (?:balance|credits?|funds)|credit balance|billing/i;
const MESSAGE_PATTERNS: ReadonlyArray<[FailureReason, RegExp]> = [
  ['quota', QUOTA_PATTERN],
  ['rate-limit', /rate.?limit|too many requests|\b429\b/i],
  ['auth', /not signed in|sign(?:-| )in (?:again|is required)|authentication|unauthori[sz]ed|forbidden|api key is (?:not set|invalid)|invalid api key/i],
  ['unavailable', /was not found at|is not available|unavailable for this account|temporarily unavailable|no longer configured|hidden from the model picker/i],
  ['timeout', /timed? ?out|did not finish within|ETIMEDOUT/i],
  ['network', /cannot reach|connection failure|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i],
  ['server', /server error|service unavailable|bad gateway|gateway timeout|overloaded|\bstatus:? 5\d\d\b/i]
];

/**
 * Failures that the next target can fix: limits, outages, and a target that is unusable (signed out, missing
 * model). Anything else, such as a context overflow or a rejected request, would fail on every target.
 */
export function classifyFailure(error: unknown): Failure | undefined {
  const retryAfterMs = getRetryAfterMs(error);
  const withRetry = (reason: FailureReason): Failure => retryAfterMs === undefined ? { reason } : { reason, retryAfterMs };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderHttpError) {
    const status = error.status;
    if (status === 429) return withRetry(QUOTA_PATTERN.test(message) ? 'quota' : 'rate-limit');
    if (status === 402) return withRetry('quota');
    if (status === 401 || status === 403) return withRetry('auth');
    if (status === 404) return withRetry('unavailable');
    if (status === 408) return withRetry('timeout');
    return status >= 500 ? withRetry('server') : undefined;
  }
  // Codex keeps its limit classification in the error name.
  if (error instanceof Error && error.name === 'ChatQuotaExceeded') return withRetry('quota');
  if (error instanceof Error && error.name === 'ChatRateLimited') return withRetry('rate-limit');
  if (CONTEXT_PATTERN.test(message)) return undefined;
  const match = MESSAGE_PATTERNS.find(([, pattern]) => pattern.test(message));
  return match ? withRetry(match[0]) : undefined;
}

/** Cooldown per target: 60 s after the first failure, doubling up to 15 min, reset on success. */
export class TargetHealth {
  private readonly entries = new Map<string, { failures: number; until: number; reason: FailureReason }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the cooldown in milliseconds; a `Retry-After` from the backend replaces the backoff. */
  recordFailure(target: string, failure: Failure): number {
    const failures = (this.entries.get(target)?.failures ?? 0) + 1;
    const cooldown = failure.retryAfterMs !== undefined
      ? Math.min(failure.retryAfterMs, RETRY_AFTER_MAX_MS)
      : Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), COOLDOWN_MAX_MS);
    this.entries.set(target, { failures, until: this.now() + cooldown, reason: failure.reason });
    return cooldown;
  }

  recordSuccess(target: string): void {
    this.entries.delete(target);
  }

  /** The cooldown that is still running, if any. */
  cooldown(target: string): { until: number; reason: FailureReason } | undefined {
    const entry = this.entries.get(target);
    return entry && entry.until > this.now() ? { until: entry.until, reason: entry.reason } : undefined;
  }
}

/** Bounded LRU of the target each conversation uses. */
export class RouteMemory {
  private readonly routes = new Map<string, string>();

  constructor(private readonly limit = ROUTE_LIMIT) {}

  get(key: string): string | undefined {
    const target = this.routes.get(key);
    if (target !== undefined) {
      this.routes.delete(key);
      this.routes.set(key, target);
    }
    return target;
  }

  set(key: string, target: string): void {
    this.routes.delete(key);
    this.routes.set(key, target);
    while (this.routes.size > this.limit) {
      this.routes.delete(this.routes.keys().next().value as string);
    }
  }

  get size(): number {
    return this.routes.size;
  }
}

export class ComboRouter {
  readonly health: TargetHealth;
  private readonly routes = new RouteMemory();

  constructor(private readonly now: () => number = Date.now) {
    this.health = new TargetHealth(now);
  }

  /**
   * Order of targets for one request: the conversation's own target first while it is healthy, then the other
   * healthy targets as configured, then unavailable targets by recovery time, so a request never fails only
   * because every target is cooling down. `exhaustedUntil` adds what the targets' own account status reports.
   */
  plan(
    combo: string,
    conversation: string,
    targets: readonly string[],
    exhaustedUntil: (target: string) => number | undefined = () => undefined
  ): string[] {
    const now = this.now();
    const blockedUntil = new Map<string, number>();
    for (const target of targets) {
      const until = Math.max(this.health.cooldown(target)?.until ?? 0, exhaustedUntil(target) ?? 0);
      if (until > now) blockedUntil.set(target, until);
    }
    const sticky = this.routes.get(routeKey(combo, conversation));
    const healthy = targets.filter((target) => !blockedUntil.has(target));
    const blocked = targets.filter((target) => blockedUntil.has(target))
      .sort((left, right) => blockedUntil.get(left)! - blockedUntil.get(right)!);
    const ordered = sticky && healthy.includes(sticky)
      ? [sticky, ...healthy.filter((target) => target !== sticky)]
      : healthy;
    return [...ordered, ...blocked];
  }


  /** Switching breaks prompt caches and continuation, so a conversation stays on the target that answered. */
  succeeded(combo: string, conversation: string, target: string): void {
    this.health.recordSuccess(target);
    this.routes.set(routeKey(combo, conversation), target);
  }

  failed(target: string, failure: Failure): number {
    return this.health.recordFailure(target, failure);
  }
}

function routeKey(combo: string, conversation: string): string {
  return `${combo}\n${conversation}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
