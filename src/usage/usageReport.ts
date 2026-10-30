import type { UsageProvider, UsageRecord } from './usageLedger';

export type UsageRange = 1 | 7 | 30 | 90 | 'all';

export interface UsageFilter {
  range: UsageRange;
  provider: UsageProvider | 'all';
}

export interface TokenBreakdown {
  requests: number;
  /** Prompt tokens not read from the cache (full-price input plus cache writes). */
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd?: number;
}

export interface RequestRow extends TokenBreakdown {
  ts: number;
  label: string;
  conversation: string;
  step: number;
  kind: 'user' | 'tool';
  inputTokens: number;
  durationMs?: number;
  cacheMiss: boolean;
  effort?: string;
  transport?: string;
  continuation?: boolean;
}

export interface ConversationSummary extends TokenBreakdown {
  id: string;
  firstTs: number;
  lastTs: number;
  steps: number;
  toolSteps: number;
  models: string[];
  inputTokens: number;
  maxInputTokens: number;
  cacheMisses: number;
}

export interface UsageReport {
  generatedAt: number;
  filter: UsageFilter;
  providers: UsageProvider[];
  totals: TokenBreakdown & {
    inputTokens: number;
    conversations: number;
    toolSteps: number;
    /** Cache reads over prompt tokens, for providers that report prompt caching. */
    cacheHitRatio?: number;
    cacheMisses: number;
    cacheMissInputTokens: number;
  };
  daily: Array<TokenBreakdown & { day: string }>;
  byModel: Array<TokenBreakdown & { label: string }>;
  conversations: ConversationSummary[];
  topRequests: RequestRow[];
}

export interface ConversationDetail {
  id: string;
  rows: RequestRow[];
  truncated: boolean;
}

export const PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  lmstudio: 'LM Studio',
  openaiCompatible: 'OpenAI-Compatible'
};

/** Providers whose usage reports prompt-cache reads; local servers usually do not. */
const CACHING_PROVIDERS: ReadonlySet<UsageProvider> = new Set(['claude', 'codex', 'deepseek']);
const CACHE_MISS_MIN_INPUT = 8_000;
const CACHE_MISS_MAX_CACHED_SHARE = 0.5;
const MODEL_ROWS = 10;
const TABLE_ROWS = 50;
const DETAIL_ROWS = 1_000;

export function rangeStart(range: UsageRange, now = Date.now()): number {
  if (range === 'all') return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range - 1));
  return start.getTime();
}

export function filterRecords(records: readonly UsageRecord[], filter: UsageFilter, now = Date.now()): UsageRecord[] {
  const since = rangeStart(filter.range, now);
  return records.filter((record) => record.ts >= since && (filter.provider === 'all' || record.provider === filter.provider));
}

export function buildUsageReport(allRecords: readonly UsageRecord[], filter: UsageFilter, now = Date.now()): UsageReport {
  const records = filterRecords(allRecords, filter, now);
  const rows = records.map(toRow);
  const totals = sumRows(rows);
  const caching = rows.filter((row, index) => CACHING_PROVIDERS.has(records[index].provider));
  const cachingInput = caching.reduce((sum, row) => sum + row.inputTokens, 0);
  const misses = rows.filter((row) => row.cacheMiss);

  return {
    generatedAt: now,
    filter,
    providers: [...new Set(allRecords.map((record) => record.provider))].sort(),
    totals: {
      ...totals,
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      conversations: new Set(rows.map((row) => row.conversation)).size,
      toolSteps: rows.filter((row) => row.kind === 'tool').length,
      cacheHitRatio: cachingInput > 0 ? caching.reduce((sum, row) => sum + row.cachedInputTokens, 0) / cachingInput : undefined,
      cacheMisses: misses.length,
      cacheMissInputTokens: misses.reduce((sum, row) => sum + row.inputTokens, 0)
    },
    daily: buildDaily(rows, filter.range, now),
    byModel: buildByModel(rows),
    conversations: buildConversations(rows).slice(0, TABLE_ROWS),
    topRequests: [...rows].sort((left, right) => weight(right) - weight(left)).slice(0, TABLE_ROWS)
  };
}

export function buildConversationDetail(allRecords: readonly UsageRecord[], id: string): ConversationDetail {
  const rows = allRecords.filter((record) => record.conversation === id).map(toRow).sort((left, right) => left.ts - right.ts);
  return { id, rows: rows.slice(-DETAIL_ROWS), truncated: rows.length > DETAIL_ROWS };
}

export function recordLabel(record: Pick<UsageRecord, 'provider' | 'model' | 'endpoint'>): string {
  return record.provider === 'openaiCompatible' && record.endpoint
    ? `${record.endpoint} · ${record.model}`
    : `${PROVIDER_LABELS[record.provider] ?? record.provider} · ${record.model}`;
}

function toRow(record: UsageRecord): RequestRow {
  const cachedInputTokens = Math.min(record.cachedInputTokens, record.inputTokens);
  const cacheWriteTokens = Math.min(record.cacheWriteTokens, record.inputTokens - cachedInputTokens);
  const uncachedInputTokens = record.inputTokens - cachedInputTokens;
  // A tool step should read the earlier conversation from the cache; mostly fresh input means the prefix changed.
  const cacheMiss = record.kind === 'tool'
    && CACHING_PROVIDERS.has(record.provider)
    && record.inputTokens >= CACHE_MISS_MIN_INPUT
    && cachedInputTokens / record.inputTokens < CACHE_MISS_MAX_CACHED_SHARE;
  return {
    ts: record.ts,
    label: recordLabel(record),
    conversation: record.conversation,
    step: record.step,
    kind: record.kind,
    requests: 1,
    inputTokens: record.inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: Math.min(record.reasoningTokens, record.outputTokens),
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    cacheMiss,
    effort: record.effort,
    transport: record.transport,
    continuation: record.continuation
  };
}

function sumRows(rows: readonly TokenBreakdown[]): TokenBreakdown {
  const total: TokenBreakdown = {
    requests: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  };
  for (const row of rows) addTo(total, row);
  return total;
}

function addTo(target: TokenBreakdown, row: TokenBreakdown): void {
  target.requests += row.requests;
  target.uncachedInputTokens += row.uncachedInputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
  target.cacheWriteTokens += row.cacheWriteTokens;
  target.outputTokens += row.outputTokens;
  target.reasoningTokens += row.reasoningTokens;
  if (row.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + row.costUsd;
}

function buildDaily(rows: readonly RequestRow[], range: UsageRange, now: number): Array<TokenBreakdown & { day: string }> {
  const buckets = new Map<string, TokenBreakdown>();
  for (const row of rows) {
    const day = localDay(row.ts);
    const bucket = buckets.get(day) ?? sumRows([]);
    addTo(bucket, row);
    buckets.set(day, bucket);
  }
  const first = range === 'all'
    ? (rows.length > 0 ? startOfDay(Math.min(...rows.map((row) => row.ts))) : startOfDay(now))
    : rangeStart(range, now);
  const days: Array<TokenBreakdown & { day: string }> = [];
  // Step by calendar date, not 24 h, so daylight-saving changes do not skip or repeat a day.
  for (const cursor = new Date(first); cursor.getTime() <= now; cursor.setDate(cursor.getDate() + 1)) {
    const day = localDay(cursor.getTime());
    days.push({ day, ...(buckets.get(day) ?? sumRows([])) });
    if (days.length > 400) break;
  }
  return days;
}

function buildByModel(rows: readonly RequestRow[]): Array<TokenBreakdown & { label: string }> {
  const groups = new Map<string, TokenBreakdown>();
  for (const row of rows) {
    const group = groups.get(row.label) ?? sumRows([]);
    addTo(group, row);
    groups.set(row.label, group);
  }
  const sorted = [...groups.entries()]
    .map(([label, breakdown]) => ({ label, ...breakdown }))
    .sort((left, right) => weight(right) - weight(left));
  if (sorted.length <= MODEL_ROWS) return sorted;
  const other = sumRows(sorted.slice(MODEL_ROWS - 1));
  return [...sorted.slice(0, MODEL_ROWS - 1), { label: `Other (${sorted.length - MODEL_ROWS + 1} models)`, ...other }];
}

function buildConversations(rows: readonly RequestRow[]): ConversationSummary[] {
  const groups = new Map<string, ConversationSummary>();
  for (const row of rows) {
    let group = groups.get(row.conversation);
    if (!group) {
      group = {
        id: row.conversation,
        firstTs: row.ts,
        lastTs: row.ts,
        steps: 0,
        toolSteps: 0,
        models: [],
        inputTokens: 0,
        maxInputTokens: 0,
        cacheMisses: 0,
        ...sumRows([])
      };
      groups.set(row.conversation, group);
    }
    addTo(group, row);
    group.firstTs = Math.min(group.firstTs, row.ts);
    group.lastTs = Math.max(group.lastTs, row.ts);
    group.steps = Math.max(group.steps, row.step);
    group.toolSteps += row.kind === 'tool' ? 1 : 0;
    group.inputTokens += row.inputTokens;
    group.maxInputTokens = Math.max(group.maxInputTokens, row.inputTokens);
    group.cacheMisses += row.cacheMiss ? 1 : 0;
    if (!group.models.includes(row.label)) group.models.push(row.label);
  }
  return [...groups.values()].sort((left, right) => weight(right) - weight(left));
}

function weight(row: TokenBreakdown): number {
  return row.uncachedInputTokens + row.cachedInputTokens + row.outputTokens;
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDay(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
