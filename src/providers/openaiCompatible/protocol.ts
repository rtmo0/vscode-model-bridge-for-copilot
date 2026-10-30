import { randomUUID } from 'node:crypto';

export interface ChatCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** `prompt_tokens_details.cached_tokens`, when the server reports prompt caching. */
  cachedPromptTokens?: number;
  /** `completion_tokens_details.reasoning_tokens`. */
  reasoningTokens?: number;
}

export interface ChatCompletionStreamCallbacks {
  onText(text: string): void;
  onReasoning?(text: string): void;
  onToolCall?(call: { id: string; name: string; arguments: Record<string, unknown> }): void;
  onUsage?(usage: ChatCompletionUsage): void;
}

export interface ChatCompletionStreamOptions {
  /** Moves a leading `<think>…</think>` block of `content` to reasoning, for models whose server does not split it. */
  parseThinkTags?: boolean;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

const MAX_TOOL_ARGUMENT_BYTES = 1_000_000;
const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

export class ChatCompletionStreamParser {
  private buffer = '';
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private readonly thinkTags?: ThinkTagSplitter;
  private finished = false;

  constructor(private readonly callbacks: ChatCompletionStreamCallbacks, options: ChatCompletionStreamOptions = {}) {
    if (options.parseThinkTags !== false) {
      this.thinkTags = new ThinkTagSplitter(
        (text) => this.callbacks.onText(text),
        (text) => this.callbacks.onReasoning?.(text)
      );
    }
  }

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
    this.thinkTags?.flush();
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
      // LM Studio, llama.cpp, and older vLLM use `reasoning_content`; Ollama and newer vLLM use `reasoning`.
      const reasoning = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
      if (reasoning) {
        this.callbacks.onReasoning?.(reasoning);
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (this.thinkTags) {
          this.thinkTags.push(delta.content);
        } else {
          this.callbacks.onText(delta.content);
        }
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

/**
 * Splits `<think>…</think>` out of streamed content. Only a tag at the start of the answer (after whitespace)
 * opens a block, so answers that merely mention the tag stay text. Tags may arrive split across deltas.
 */
export class ThinkTagSplitter {
  private state: 'start' | 'think' | 'text' = 'start';
  private pending = '';
  private afterThink = false;

  constructor(
    private readonly emitText: (text: string) => void,
    private readonly emitReasoning: (text: string) => void
  ) {}

  push(chunk: string): void {
    if (this.state === 'text') {
      this.emitText(chunk);
      return;
    }
    this.pending += chunk;
    while (this.pending) {
      if (this.state === 'start') {
        const trimmed = this.pending.trimStart();
        if (!trimmed || (trimmed.length < THINK_OPEN_TAG.length && THINK_OPEN_TAG.startsWith(trimmed))) {
          return;
        }
        if (trimmed.startsWith(THINK_OPEN_TAG)) {
          this.state = 'think';
          this.pending = trimmed.slice(THINK_OPEN_TAG.length);
          continue;
        }
        this.state = 'text';
        const text = this.afterThink ? trimmed : this.pending;
        this.pending = '';
        this.emitText(text);
        return;
      }
      if (this.state === 'think') {
        const closeIndex = this.pending.indexOf(THINK_CLOSE_TAG);
        if (closeIndex >= 0) {
          this.emitReasoningText(this.pending.slice(0, closeIndex));
          this.pending = this.pending.slice(closeIndex + THINK_CLOSE_TAG.length);
          this.state = 'start';
          this.afterThink = true;
          continue;
        }
        const keep = partialTagSuffixLength(this.pending, THINK_CLOSE_TAG);
        this.emitReasoningText(this.pending.slice(0, this.pending.length - keep));
        this.pending = this.pending.slice(this.pending.length - keep);
        return;
      }
      this.emitText(this.pending);
      this.pending = '';
    }
  }

  flush(): void {
    const pending = this.pending;
    this.pending = '';
    if (!pending) {
      return;
    }
    if (this.state === 'think') {
      // The model stopped inside its reasoning (for example at the output limit).
      this.emitReasoningText(pending);
    } else if (!this.afterThink || pending.trim()) {
      this.emitText(this.afterThink ? pending.trimStart() : pending);
    }
  }

  private emitReasoningText(text: string): void {
    if (text) {
      this.emitReasoning(text);
    }
  }
}

export function parseToolArguments(serialized: string): Record<string, unknown> {
  if (!serialized.trim()) {
    return {};
  }
  if (Buffer.byteLength(serialized) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error('The server returned tool arguments larger than 1 MB.');
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`The server returned invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Length of the longest suffix of `value` that could begin `tag`, so a tag split across deltas is not emitted early.
function partialTagSuffixLength(value: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, value.length); length > 0; length -= 1) {
    if (tag.startsWith(value.slice(value.length - length))) {
      return length;
    }
  }
  return 0;
}

// OpenAI streams ids and names once, but some compatible servers repeat them in every delta.
function mergeIdentifierDelta(current: string, delta: string): string {
  return !current || delta === current ? delta || current : current + delta;
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseUsage(value: unknown): ChatCompletionUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = readTokenCount(value.prompt_tokens);
  const completionTokens = readTokenCount(value.completion_tokens);
  const totalTokens = readTokenCount(value.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === 0) {
    return undefined;
  }
  // DeepSeek also reports cache hits as `prompt_cache_hit_tokens`; its `prompt_tokens` already include them.
  const cachedPromptTokens = (isRecord(value.prompt_tokens_details) ? readTokenCount(value.prompt_tokens_details.cached_tokens) : undefined)
    ?? readTokenCount(value.prompt_cache_hit_tokens);
  const reasoningTokens = isRecord(value.completion_tokens_details) ? readTokenCount(value.completion_tokens_details.reasoning_tokens) : undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
