import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type UsageProvider = 'claude' | 'codex' | 'deepseek' | 'lmstudio' | 'openaiCompatible';

/**
 * One completed model request. Counts and identifiers only: never prompts, responses,
 * tool arguments, or results. `conversation` is a salted hash of the first user message.
 */
export interface UsageRecord {
  v: 1;
  /** Completion time, epoch milliseconds. */
  ts: number;
  provider: UsageProvider;
  /** OpenAI-compatible endpoint name. */
  endpoint?: string;
  model: string;
  conversation: string;
  /** 1 for the first request of a conversation, then one more per earlier assistant turn. */
  step: number;
  /** `tool` when the request carries tool results (an agent tool-loop step). */
  kind: 'user' | 'tool';
  messages: number;
  /** Tool definitions sent with the request. */
  tools: number;
  durationMs?: number;
  /** All prompt tokens, including cache reads and cache writes. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** All output tokens, including reasoning. */
  outputTokens: number;
  reasoningTokens: number;
  /** API-equivalent estimate; subscriptions are not billed per token. DeepSeek uses its list price. */
  costUsd?: number;
  effort?: string;
  transport?: string;
  /** The request reused server-side state (Claude session or Codex previous_response_id). */
  continuation?: boolean;
}

const FILE_PATTERN = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

/** Append-only JSONL ledger with one file per UTC day, so retention deletes whole files. */
export class UsageLedger {
  private writes: Promise<void> = Promise.resolve();
  private lastPrunedDay?: string;

  constructor(
    private readonly directory: string,
    private readonly retentionDays: () => number
  ) {}

  append(record: UsageRecord): Promise<void> {
    // Serialized so lines from one window never interleave; each line is one small O_APPEND write.
    this.writes = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, fileNameFor(record.ts)), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      const day = utcDay(record.ts);
      if (this.lastPrunedDay !== day) {
        this.lastPrunedDay = day;
        await this.prune(record.ts);
      }
    }).catch(() => undefined);
    return this.writes;
  }

  async read(sinceMs = 0, now = Date.now()): Promise<UsageRecord[]> {
    const cutoff = Math.max(sinceMs, this.retentionCutoff(now));
    const files = await this.listFiles();
    const records: UsageRecord[] = [];
    for (const file of files) {
      // A file holds one UTC day; skip days that end before the cutoff.
      if (Date.parse(`${file.day}T00:00:00Z`) + DAY_MS <= cutoff) continue;
      let text: string;
      try {
        text = await readFile(join(this.directory, file.name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const record = parseRecord(line);
        if (record && record.ts >= cutoff) records.push(record);
      }
    }
    return records.sort((left, right) => left.ts - right.ts);
  }

  async prune(now = Date.now()): Promise<number> {
    const cutoff = this.retentionCutoff(now);
    let removed = 0;
    for (const file of await this.listFiles()) {
      if (Date.parse(`${file.day}T00:00:00Z`) + DAY_MS <= cutoff) {
        await rm(join(this.directory, file.name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    await this.writes;
    await rm(this.directory, { recursive: true, force: true });
  }

  private retentionCutoff(now: number): number {
    return now - Math.max(1, this.retentionDays()) * DAY_MS;
  }

  private async listFiles(): Promise<Array<{ name: string; day: string }>> {
    try {
      return (await readdir(this.directory)).flatMap((name) => {
        const match = FILE_PATTERN.exec(name);
        return match ? [{ name, day: match[1] }] : [];
      }).sort((left, right) => left.day.localeCompare(right.day));
    } catch {
      return [];
    }
  }
}

const CSV_COLUMNS: ReadonlyArray<keyof UsageRecord> = [
  'ts', 'provider', 'endpoint', 'model', 'conversation', 'step', 'kind', 'messages', 'tools', 'durationMs',
  'inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'costUsd',
  'effort', 'transport', 'continuation'
];

export function toCsv(records: readonly UsageRecord[]): string {
  const header = ['time', ...CSV_COLUMNS.slice(1)].join(',');
  const rows = records.map((record) => CSV_COLUMNS.map((column) => {
    const value = column === 'ts' ? new Date(record.ts).toISOString() : record[column];
    return csvCell(value);
  }).join(','));
  return [header, ...rows].join('\n') + '\n';
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  // Quote separators, and neutralize spreadsheet formulas in text cells.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function parseRecord(line: string): UsageRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as Partial<UsageRecord>;
    if (value.v !== 1 || typeof value.ts !== 'number' || typeof value.provider !== 'string' || typeof value.model !== 'string') {
      return undefined;
    }
    return {
      ...value,
      conversation: typeof value.conversation === 'string' ? value.conversation : '',
      step: count(value.step) || 1,
      kind: value.kind === 'tool' ? 'tool' : 'user',
      messages: count(value.messages),
      tools: count(value.tools),
      inputTokens: count(value.inputTokens),
      cachedInputTokens: count(value.cachedInputTokens),
      cacheWriteTokens: count(value.cacheWriteTokens),
      outputTokens: count(value.outputTokens),
      reasoningTokens: count(value.reasoningTokens)
    } as UsageRecord;
  } catch {
    return undefined;
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function fileNameFor(ts: number): string {
  return `usage-${utcDay(ts)}.jsonl`;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
