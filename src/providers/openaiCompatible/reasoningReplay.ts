import { createHash } from 'node:crypto';

/**
 * Reasoning for servers that need earlier `reasoning_content` sent back, such as DeepSeek in thinking mode with tools.
 * VS Code does not always return provider reasoning in the history, so it is kept here by tool call ID or, for answers
 * without tool calls, by a hash of the answer text. In memory, bounded, and never persisted or logged.
 */

const MAX_ENTRIES = 512;
const MAX_TOTAL_CHARACTERS = 8_000_000;
const MAX_ENTRY_CHARACTERS = 1_000_000;

export interface AssistantReplayKey {
  toolCallIds: readonly string[];
  text: string;
}

export class ReasoningReplayStore {
  private readonly entries = new Map<string, string>();
  private totalCharacters = 0;

  record(key: AssistantReplayKey, reasoning: string): void {
    const entryKey = toEntryKeys(key)[0];
    if (!entryKey || !reasoning || reasoning.length > MAX_ENTRY_CHARACTERS) {
      return;
    }
    this.remove(entryKey);
    this.entries.set(entryKey, reasoning);
    this.totalCharacters += reasoning.length;
    for (const [oldest] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && this.totalCharacters <= MAX_TOTAL_CHARACTERS) break;
      this.remove(oldest);
    }
  }

  lookup(key: AssistantReplayKey): string | undefined {
    for (const entryKey of toEntryKeys(key)) {
      const reasoning = this.entries.get(entryKey);
      if (reasoning !== undefined) {
        // Most recently used entries are evicted last.
        this.entries.delete(entryKey);
        this.entries.set(entryKey, reasoning);
        return reasoning;
      }
    }
    return undefined;
  }

  private remove(entryKey: string): void {
    const existing = this.entries.get(entryKey);
    if (existing !== undefined) {
      this.totalCharacters -= existing.length;
      this.entries.delete(entryKey);
    }
  }
}

// Recorded under the first tool call ID; any ID of the message finds it, in case the history reorders parallel calls.
function toEntryKeys(key: AssistantReplayKey): string[] {
  if (key.toolCallIds.length > 0) {
    return key.toolCallIds.map((id) => `tool:${id}`);
  }
  return key.text ? [`text:${createHash('sha256').update(key.text).digest('hex')}`] : [];
}
