import { createHash } from 'node:crypto';
import type { ClaudePromptMessage } from './protocol';

export interface ClaudeSessionContinuation {
  sessionId: string;
  appendedMessages: ClaudePromptMessage[];
}

interface ClaudeSessionEntry {
  sessionId: string;
  envelopeHash: string;
  messages: ClaudePromptMessage[];
  updatedAt: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 30 * 60_000;

export class ClaudeSessionStore {
  private readonly entries: ClaudeSessionEntry[] = [];

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {}

  resolve(
    messages: readonly ClaudePromptMessage[],
    envelope: unknown,
    now = Date.now()
  ): ClaudeSessionContinuation | undefined {
    this.prune(now);
    const envelopeHash = hashValue(envelope);
    const match = this.entries
      .filter((entry) => entry.envelopeHash === envelopeHash && isMessagePrefix(entry.messages, messages))
      .sort((left, right) => right.messages.length - left.messages.length || right.updatedAt - left.updatedAt)[0];
    if (!match || match.messages.length >= messages.length) {
      return undefined;
    }
    match.updatedAt = now;
    return {
      sessionId: match.sessionId,
      appendedMessages: messages.slice(match.messages.length).map(cloneMessage)
    };
  }

  record(
    sessionId: string,
    messages: readonly ClaudePromptMessage[],
    envelope: unknown,
    now = Date.now()
  ): void {
    if (!sessionId.trim() || messages.length === 0) {
      return;
    }
    this.prune(now);
    const envelopeHash = hashValue(envelope);
    const existingIndex = this.entries.findIndex((entry) => entry.sessionId === sessionId);
    if (existingIndex >= 0) {
      this.entries.splice(existingIndex, 1);
    }
    this.entries.push({
      sessionId,
      envelopeHash,
      messages: messages.map(cloneMessage),
      updatedAt: now
    });
    this.entries.sort((left, right) => right.updatedAt - left.updatedAt);
    this.entries.splice(this.maxEntries);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (now - this.entries[index].updatedAt > this.ttlMs) {
        this.entries.splice(index, 1);
      }
    }
  }
}

function isMessagePrefix(
  prefix: readonly ClaudePromptMessage[],
  messages: readonly ClaudePromptMessage[]
): boolean {
  if (prefix.length > messages.length) {
    return false;
  }
  return prefix.every((message, index) => (
    message.role === messages[index].role
    && comparableContent(message) === comparableContent(messages[index])
  ));
}

// The recorded assistant turn is rebuilt from streamed segments, while VS Code replays it from
// its own text and tool-call parts, which may split or trim whitespace differently. The session
// already holds the model's exact output, so assistant turns compare without whitespace; other
// roles stay exact apart from line endings.
function comparableContent(message: ClaudePromptMessage): string {
  const content = message.content.replace(/\r\n?/g, '\n');
  return message.role === 'assistant' ? content.replace(/\s+/g, '') : content;
}

function cloneMessage(message: ClaudePromptMessage): ClaudePromptMessage {
  return { role: message.role, content: message.content };
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}
