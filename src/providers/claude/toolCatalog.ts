import { createHash } from 'node:crypto';
import type { ClaudePromptMessage, ClaudeToolDefinition } from './protocol';

export interface ClaudeToolCatalogPlan {
  /** Tools rendered in the system prompt; stays fixed while a conversation only gains or loses tools. */
  catalogTools: ClaudeToolDefinition[];
  /** Conversation messages with catalog-update blocks spliced in where each change first appeared. */
  messages: ClaudePromptMessage[];
  updateCount: number;
}

interface ClaudeToolCatalogUpdate {
  /** Number of original conversation messages that precede this update. */
  position: number;
  prefixHash: string;
  added: ClaudeToolDefinition[];
  removed: string[];
  message: ClaudePromptMessage;
}

interface ClaudeToolCatalogEntry {
  rootHash: string;
  base: ClaudeToolDefinition[];
  updates: ClaudeToolCatalogUpdate[];
  updatedAt: number;
}

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_MAX_UPDATES = 8;

/**
 * Keeps the system-prompt tool catalog append-only per conversation. The catalog sits before
 * the whole history, so rewriting it whenever VS Code adds a tool (for example when a Virtual
 * Tool group activates) would invalidate the prompt cache for everything after it. Changes are
 * instead appended as a system block at the point where they happened, which later requests
 * reproduce byte-for-byte. Entries are in-memory and bounded.
 */
export class ClaudeToolCatalogStore {
  private readonly entries: ClaudeToolCatalogEntry[] = [];

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxUpdates = DEFAULT_MAX_UPDATES
  ) {}

  plan(
    messages: readonly ClaudePromptMessage[],
    tools: readonly ClaudeToolDefinition[],
    now = Date.now()
  ): ClaudeToolCatalogPlan {
    const passthrough = { catalogTools: [...tools], messages: [...messages], updateCount: 0 };
    const rootIndex = messages.findIndex((message) => message.role === 'user');
    if (tools.length === 0 || rootIndex < 0) {
      return passthrough;
    }
    this.prune(now);
    const rootHash = hashMessages(messages.slice(0, rootIndex + 1));
    const entry = this.entries.find((candidate) => candidate.rootHash === rootHash);
    if (!entry) {
      this.entries.unshift({ rootHash, base: [...tools], updates: [], updatedAt: now });
      this.entries.splice(this.maxEntries);
      return passthrough;
    }

    // Updates recorded on a branch this conversation no longer shares are dropped from there on.
    const validUpdates: ClaudeToolCatalogUpdate[] = [];
    for (const update of entry.updates) {
      if (update.position > messages.length || hashMessages(messages.slice(0, update.position)) !== update.prefixHash) {
        break;
      }
      validUpdates.push(update);
    }
    entry.updates = validUpdates;
    entry.updatedAt = now;

    const { added, removed } = diffCatalog(applyUpdates(entry.base, validUpdates), tools);
    if (added.length > 0 || removed.length > 0) {
      if (validUpdates.length >= this.maxUpdates) {
        entry.base = [...tools];
        entry.updates = [];
      } else {
        entry.updates.push({
          position: messages.length,
          prefixHash: hashMessages(messages),
          added,
          removed,
          message: { role: 'system', content: formatCatalogUpdate(added, removed) }
        });
      }
    }

    return {
      catalogTools: [...entry.base],
      messages: spliceUpdates(messages, entry.updates),
      updateCount: entry.updates.length
    };
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

function applyUpdates(
  base: readonly ClaudeToolDefinition[],
  updates: readonly ClaudeToolCatalogUpdate[]
): Map<string, ClaudeToolDefinition> {
  const catalog = new Map(base.map((tool) => [tool.name, tool]));
  for (const update of updates) {
    for (const name of update.removed) {
      catalog.delete(name);
    }
    for (const tool of update.added) {
      catalog.set(tool.name, tool);
    }
  }
  return catalog;
}

function diffCatalog(
  effective: ReadonlyMap<string, ClaudeToolDefinition>,
  tools: readonly ClaudeToolDefinition[]
): { added: ClaudeToolDefinition[]; removed: string[] } {
  const currentNames = new Set(tools.map((tool) => tool.name));
  return {
    added: tools.filter((tool) => {
      const previous = effective.get(tool.name);
      return !previous || serializeTool(previous) !== serializeTool(tool);
    }),
    removed: [...effective.keys()].filter((name) => !currentNames.has(name)).sort()
  };
}

function spliceUpdates(
  messages: readonly ClaudePromptMessage[],
  updates: readonly ClaudeToolCatalogUpdate[]
): ClaudePromptMessage[] {
  const result: ClaudePromptMessage[] = [];
  let updateIndex = 0;
  for (let position = 0; position <= messages.length; position += 1) {
    while (updateIndex < updates.length && updates[updateIndex].position === position) {
      result.push({ ...updates[updateIndex].message });
      updateIndex += 1;
    }
    if (position < messages.length) {
      result.push({ ...messages[position] });
    }
  }
  return result;
}

export function formatCatalogUpdate(added: readonly ClaudeToolDefinition[], removed: readonly string[]): string {
  const lines = ['Tool catalog update. The tool request format above still applies, and these entries replace earlier catalog entries with the same name.'];
  if (added.length > 0) {
    lines.push(`Added or changed tools:\n${JSON.stringify(added.map(serializableTool))}`);
  }
  if (removed.length > 0) {
    lines.push(`Removed tools, do not call them: ${removed.join(', ')}`);
  }
  return lines.join('\n');
}

function serializableTool(tool: ClaudeToolDefinition): ClaudeToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function serializeTool(tool: ClaudeToolDefinition): string {
  return JSON.stringify(serializableTool(tool));
}

function hashMessages(messages: readonly ClaudePromptMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(message.role).update('\0').update(message.content).update('\0');
  }
  return hash.digest('hex');
}
