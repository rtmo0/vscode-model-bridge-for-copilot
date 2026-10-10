import type { ClaudeRateLimitWindow, ClaudeUsageUpdate } from './protocol';
import { formatLatestRequestLine } from '../usageSummary';

const STALE_AFTER_MS = 15 * 60_000;

export type ClaudeLimitKind = '5h' | 'weekly' | 'weekly-model' | 'other';

export interface ClaudeLimitWindow {
  kind: ClaudeLimitKind;
  label: string;
  usedPercent: number;
  /** Epoch seconds, when Claude Code reports it in the stream. */
  resetsAt?: number;
  /** Human-readable reset text from `/usage`, when no epoch value is available. */
  resetsText?: string;
}

export interface ClaudeLatestRequestUsage {
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  contextWindow?: number;
  totalCostUsd?: number;
}

export interface ClaudeAccountUsageSnapshot {
  account?: string;
  plan?: string;
  limits: ClaudeLimitWindow[];
  isUsingOverage?: boolean;
  latestRequest?: ClaudeLatestRequestUsage;
  fetchedAt: number;
}

export interface ClaudeAccountUsageDisplay {
  compactText?: string;
  tooltip: string;
  isStale: boolean;
}

// Matches the limit lines printed by `claude -p /usage`, for example
// "Current session: 26% used · resets Oct 11 at 12:19am (Europe/Moscow)".
const USAGE_LINE = /^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i;

export function parseClaudeUsageReport(text: string): ClaudeLimitWindow[] {
  const limits: ClaudeLimitWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = USAGE_LINE.exec(line);
    if (!match) continue;
    const label = match[1].trim();
    const usedPercent = clampPercent(Number(match[2]));
    limits.push({
      ...classifyLimit(label),
      usedPercent,
      ...(match[3] ? { resetsText: match[3].trim() } : {})
    });
  }
  return limits;
}

/** Merges streamed rate-limit windows into the known limits, keeping `/usage`-only windows. */
export function mergeRateLimitUpdate(limits: readonly ClaudeLimitWindow[], update: ClaudeUsageUpdate): ClaudeLimitWindow[] {
  const merged = [...limits];
  const apply = (kind: '5h' | 'weekly', label: string, window: ClaudeRateLimitWindow | undefined) => {
    if (!window) return;
    const next: ClaudeLimitWindow = {
      kind,
      label,
      usedPercent: clampPercent(window.utilization * 100),
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {})
    };
    const index = merged.findIndex((limit) => limit.kind === kind);
    if (index >= 0) merged[index] = next;
    else merged.push(next);
  };
  apply('5h', 'Current session', update.fiveHour);
  apply('weekly', 'Current week (all models)', update.sevenDay);
  return sortLimits(merged);
}

export function toLatestRequestUsage(update: ClaudeUsageUpdate): ClaudeLatestRequestUsage | undefined {
  if (update.inputTokens === undefined && update.outputTokens === undefined) {
    return undefined;
  }
  return {
    model: update.model,
    inputTokens: (update.inputTokens ?? 0) + (update.cacheCreationInputTokens ?? 0) + (update.cacheReadInputTokens ?? 0),
    cachedInputTokens: update.cacheReadInputTokens ?? 0,
    outputTokens: update.outputTokens ?? 0,
    thinkingTokens: update.thinkingTokens,
    contextWindow: update.contextWindow,
    totalCostUsd: update.totalCostUsd
  };
}

export function buildClaudeAccountUsageDisplay(snapshot: ClaudeAccountUsageSnapshot, now = Date.now()): ClaudeAccountUsageDisplay {
  const compactLimits = snapshot.limits.filter((limit) => limit.kind === '5h' || limit.kind === 'weekly');
  const lines = ['Claude account limits'];
  if (snapshot.account) lines.push(`Account: ${snapshot.account}`);
  lines.push(`Plan: ${formatPlan(snapshot.plan)}`);
  lines.push(`Fetched: ${new Date(snapshot.fetchedAt).toLocaleString()}`);
  const isStale = now - snapshot.fetchedAt > STALE_AFTER_MS;
  if (isStale) lines.push('Warning: usage data is older than 15 minutes.');
  for (const limit of snapshot.limits) {
    lines.push(`${formatLimitLabel(limit)}: ${formatLimitDetail(limit, now)}`);
  }
  if (snapshot.isUsingOverage) lines.push('Usage credits: active');
  const latest = snapshot.latestRequest;
  if (latest) {
    lines.push(formatLatestRequestLine({ ...latest, reasoningTokens: latest.thinkingTokens }));
    if (latest.totalCostUsd !== undefined) lines.push(`Latest API-equivalent cost: ${formatUsd(latest.totalCostUsd)}`);
  }
  return {
    compactText: compactLimits.length > 0
      ? `Claude: ${compactLimits.map((limit) => `${formatLimitLabel(limit)} ${formatPercent(100 - limit.usedPercent)}`).join(' · ')}`
      : undefined,
    tooltip: lines.join('\n'),
    isStale
  };
}

function classifyLimit(label: string): Pick<ClaudeLimitWindow, 'kind' | 'label'> {
  if (/session/i.test(label)) return { kind: '5h', label };
  if (/week/i.test(label)) {
    return /\((?!all models)[^)]*\)/i.test(label) ? { kind: 'weekly-model', label } : { kind: 'weekly', label };
  }
  return { kind: 'other', label };
}

function sortLimits(limits: ClaudeLimitWindow[]): ClaudeLimitWindow[] {
  const order: Record<ClaudeLimitKind, number> = { '5h': 0, weekly: 1, 'weekly-model': 2, other: 3 };
  return limits.sort((left, right) => order[left.kind] - order[right.kind]);
}

function formatLimitLabel(limit: ClaudeLimitWindow): string {
  switch (limit.kind) {
    case '5h': return '5h';
    case 'weekly': return 'Weekly';
    case 'weekly-model': return `Weekly ${/\(([^)]+)\)/.exec(limit.label)?.[1].replace(/\s*only$/i, '') ?? ''}`.trim();
    default: return limit.label.replace(/^Current\s+/i, '');
  }
}

function formatLimitDetail(limit: ClaudeLimitWindow, now: number): string {
  const reset = limit.resetsAt !== undefined
    ? `, resets ${formatReset(limit.resetsAt, now)}`
    : limit.resetsText ? `, resets ${limit.resetsText}` : '';
  return `${formatPercent(limit.usedPercent)} used, ${formatPercent(100 - limit.usedPercent)} remaining${reset}`;
}

function formatReset(epochSeconds: number, now: number): string {
  const milliseconds = epochSeconds * 1000;
  const remaining = milliseconds - now;
  if (remaining <= 0) return 'now';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `in ${minutes}m (${new Date(milliseconds).toLocaleTimeString()})`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h (${new Date(milliseconds).toLocaleString()})`;
  return new Date(milliseconds).toLocaleString();
}

function formatPlan(plan: string | undefined): string {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Unknown';
}

function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
