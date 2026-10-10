import { randomUUID } from 'node:crypto';

export interface LmStudioToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface LmStudioUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LmStudioStreamCallbacks {
  onText(text: string): void;
  onReasoning?(text: string): void;
  onToolCall?(call: { id: string; name: string; arguments: Record<string, unknown> }): void;
  onUsage?(usage: LmStudioUsage): void;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

const MAX_TOOL_ARGUMENT_BYTES = 1_000_000;

export class LmStudioChatStreamParser {
  private buffer = '';
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private finished = false;

  constructor(private readonly callbacks: LmStudioStreamCallbacks) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let boundary = findEventBoundary(this.buffer);
    while (boundary) {
      const event = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.processEvent(event);
      boundary = findEventBoundary(this.buffer);
    }
  }

  finish(): void {
    if (this.buffer.trim()) {
      this.processEvent(this.buffer);
    }
    this.buffer = '';
    if (this.finished) {
      return;
    }
    this.finished = true;
    for (const [, toolCall] of [...this.toolCalls.entries()].sort(([left], [right]) => left - right)) {
      if (!toolCall.name) {
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = parseToolArguments(toolCall.arguments);
      } catch (error) {
        // Local models often emit malformed JSON; keep the streamed answer and skip only this call.
        this.callbacks.onText(`\n\n[Skipped tool call "${toolCall.name}": ${error instanceof Error ? error.message : String(error)}]`);
        continue;
      }
      this.callbacks.onToolCall?.({
        id: toolCall.id || `call_${randomUUID()}`,
        name: toolCall.name,
        arguments: args
      });
    }
  }

  private processEvent(rawEvent: string): void {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(payload)) {
      return;
    }

    const usage = parseUsage(payload.usage);
    if (usage) {
      this.callbacks.onUsage?.(usage);
    }
    if (!Array.isArray(payload.choices)) {
      return;
    }
    for (const choice of payload.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        continue;
      }
      const delta = choice.delta;
      if (typeof delta.content === 'string') {
        this.callbacks.onText(delta.content);
      }
      if (typeof delta.reasoning_content === 'string') {
        this.callbacks.onReasoning?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const entry of delta.tool_calls) {
          this.accumulateToolCall(entry);
        }
      }
    }
  }

  private accumulateToolCall(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }
    const index = typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0
      ? value.index
      : 0;
    const pending = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
    if (typeof value.id === 'string') {
      pending.id = mergeIdentifierDelta(pending.id, value.id);
    }
    if (isRecord(value.function)) {
      if (typeof value.function.name === 'string') {
        pending.name = mergeIdentifierDelta(pending.name, value.function.name);
      }
      if (typeof value.function.arguments === 'string'
        && Buffer.byteLength(pending.arguments) < MAX_TOOL_ARGUMENT_BYTES) {
        pending.arguments += value.function.arguments.slice(0, MAX_TOOL_ARGUMENT_BYTES - Buffer.byteLength(pending.arguments));
      }
    }
    this.toolCalls.set(index, pending);
  }
}

export function parseToolArguments(serialized: string): Record<string, unknown> {
  if (!serialized.trim()) {
    return {};
  }
  if (Buffer.byteLength(serialized) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error('LM Studio returned tool arguments larger than 1 MB.');
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`LM Studio returned invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// OpenAI streams ids and names once, but some compatible servers repeat them in every delta.
function mergeIdentifierDelta(current: string, delta: string): string {
  return !current || delta === current ? delta || current : current + delta;
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseUsage(value: unknown): LmStudioUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = readTokenCount(value.prompt_tokens);
  const completionTokens = readTokenCount(value.completion_tokens);
  const totalTokens = readTokenCount(value.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === 0) {
    return undefined;
  }
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
