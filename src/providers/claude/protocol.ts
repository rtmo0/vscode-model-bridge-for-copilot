/** `auto` omits `--effort`, so Claude Code applies its own configured or default effort. */
export type ClaudeEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ClaudePromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ClaudeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ClaudeRateLimitWindow {
  utilization: number;
  resetsAt?: number;
}

export interface ClaudeUsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  thinkingTokens?: number;
  totalCostUsd?: number;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  fiveHour?: ClaudeRateLimitWindow;
  sevenDay?: ClaudeRateLimitWindow;
  isUsingOverage?: boolean;
  overageStatus?: string;
}

export interface ClaudeStreamCallbacks {
  onText(text: string): void;
  onThinking?(text: string): void;
  onToolCall?(call: ClaudeToolCall): void;
  onUsage?(usage: ClaudeUsageUpdate): void;
  onSessionId?(sessionId: string): void;
}

export const CLAUDE_MODELS = [
  {
    id: 'default',
    name: 'Claude (Default)',
    description: 'Uses the model selected by Claude Code.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'best',
    name: 'Claude Best',
    description: 'Uses Fable when available, otherwise the latest Opus model.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'fable',
    name: 'Claude Fable',
    description: 'Anthropic’s most capable model for long-running, complex tasks. May require usage credits.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    description: 'Balanced Claude model for coding and agentic work.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    description: 'Most capable Claude model for complex work.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    description: 'Fast Claude model for lightweight tasks.',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000
  }
] as const;

const PROVIDER_MODEL_PREFIX = 'anthropic::';

export function toProviderModelId(model: string): string {
  return `${PROVIDER_MODEL_PREFIX}${model}`;
}

export function parseProviderModelId(modelId: string, fallback: string): string {
  const value = modelId.startsWith(PROVIDER_MODEL_PREFIX)
    ? modelId.slice(PROVIDER_MODEL_PREFIX.length)
    : modelId;
  return value.trim() || fallback;
}

export function buildClaudePrompt(messages: readonly ClaudePromptMessage[]): string {
  return buildClaudePromptBlocks(messages).join('\n\n');
}

// One block per message keeps earlier blocks byte-identical across tool-loop requests,
// so Anthropic prompt caching can match the previous request's prefix at a block boundary.
export function buildClaudePromptBlocks(messages: readonly ClaudePromptMessage[]): string[] {
  return messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`);
}

/** Serializes prompt blocks as a single stream-json user message for `--input-format stream-json`. */
export function buildClaudeStreamJsonInput(blocks: readonly string[]): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: blocks.map((text) => ({ type: 'text', text }))
    },
    parent_tool_use_id: null,
    session_id: ''
  })}\n`;
}

const SCHEMA_ANNOTATION_KEYS = new Set(['$schema', '$id', '$comment', 'title', 'examples', 'markdownDescription']);
const SCHEMA_NAME_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_LITERAL_KEYS = new Set(['default', 'const', 'enum']);

/** Drops JSON Schema annotations that do not constrain arguments; property names are never removed. */
export function compactToolSchema(schema: unknown, isNameMap = false): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => compactToolSchema(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!isNameMap && SCHEMA_ANNOTATION_KEYS.has(key)) {
      continue;
    }
    compacted[key] = !isNameMap && SCHEMA_LITERAL_KEYS.has(key)
      ? value
      : compactToolSchema(value, !isNameMap && SCHEMA_NAME_MAP_KEYS.has(key));
  }
  return compacted;
}

export function buildClaudeSystemPrompt(
  instructions: string,
  tools: readonly ClaudeToolDefinition[],
  markerNonce: string,
  toolRequired = false
): string {
  if (tools.length === 0) {
    return instructions;
  }

  const startMarker = toolStartMarker(markerNonce);
  const endMarker = toolEndMarker(markerNonce);
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
  const toolModeInstruction = toolRequired
    ? 'You must call at least one catalog tool before giving a final answer.'
    : 'Call a tool only when it improves the answer.';

  return `${instructions}\n\nVS Code controls all tools for this conversation. Claude Code's own tools are disabled. ${toolModeInstruction}\nFor each tool request, output this exact format with no Markdown fences:\n${startMarker}{"name":"tool_name","arguments":{}}${endMarker}\nYou may emit multiple tool requests when they are independent. Use only tools from the catalog, never invent names, and stop after the last closing marker so VS Code can execute them.\n\nTool catalog:\n${JSON.stringify(catalog)}`;
}

export function toolStartMarker(nonce: string): string {
  return `<vscode_tool_call_${nonce}>`;
}

export function toolEndMarker(nonce: string): string {
  return `</vscode_tool_call_${nonce}>`;
}

export class ClaudeStreamJsonParser {
  private lineBuffer = '';
  private sawPartialText = false;
  private emittedFallbackText = false;
  private resultError?: string;

  constructor(
    private readonly textParser: ClaudeToolProtocolParser,
    private readonly callbacks: ClaudeStreamCallbacks
  ) {}

  push(chunk: string): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line) {
        this.processLine(line);
      }
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  finish(): void {
    const remaining = this.lineBuffer.trim();
    if (remaining) {
      this.processLine(remaining);
    }
    this.lineBuffer = '';
    this.textParser.finish();
    if (this.resultError) {
      throw new Error(this.resultError);
    }
  }

  private processLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }

    if (typeof message.session_id === 'string' && message.session_id.trim()) {
      this.callbacks.onSessionId?.(message.session_id.trim());
    }

    if (message.type === 'stream_event' && isRecord(message.event)) {
      this.processStreamEvent(message.event);
      return;
    }

    if (message.type === 'assistant' && !this.sawPartialText && !this.emittedFallbackText) {
      const text = readAssistantText(message);
      if (text) {
        this.emittedFallbackText = true;
        this.textParser.push(text);
      }
      return;
    }

    if (message.type === 'rate_limit_event') {
      const usage = parseRateLimitUpdate(message);
      if (usage) {
        this.callbacks.onUsage?.(usage);
      }
      return;
    }

    if (message.type === 'result') {
      const usage = parseResultUsageUpdate(message);
      if (usage) {
        this.callbacks.onUsage?.(usage);
      }
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')) {
        this.resultError = typeof message.result === 'string' && message.result.trim()
          ? message.result.trim()
          : 'Claude Code could not complete the request.';
        return;
      }
      if (!this.sawPartialText && !this.emittedFallbackText && typeof message.result === 'string') {
        this.emittedFallbackText = true;
        this.textParser.push(message.result);
      }
    }
  }

  private processStreamEvent(event: Record<string, unknown>): void {
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) {
      return;
    }
    const delta = event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      this.sawPartialText = true;
      this.textParser.push(delta.text);
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.callbacks.onThinking?.(delta.thinking);
    }
  }
}

export class ClaudeToolProtocolParser {
  private buffer = '';

  constructor(
    private readonly markerNonce: string,
    private readonly allowedTools: ReadonlySet<string>,
    private readonly callbacks: ClaudeStreamCallbacks
  ) {}

  push(text: string): void {
    this.buffer += text;
    this.drain(false);
  }

  finish(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    const startMarker = toolStartMarker(this.markerNonce);
    const endMarker = toolEndMarker(this.markerNonce);

    while (this.buffer) {
      const startIndex = this.buffer.indexOf(startMarker);
      if (startIndex < 0) {
        const emitLength = final
          ? this.buffer.length
          : Math.max(0, this.buffer.length - startMarker.length + 1);
        if (emitLength > 0) {
          this.callbacks.onText(this.buffer.slice(0, emitLength));
          this.buffer = this.buffer.slice(emitLength);
        }
        return;
      }

      if (startIndex > 0) {
        this.callbacks.onText(this.buffer.slice(0, startIndex));
        this.buffer = this.buffer.slice(startIndex);
      }

      const endIndex = this.buffer.indexOf(endMarker, startMarker.length);
      if (endIndex < 0) {
        if (final) {
          this.callbacks.onText(this.buffer);
          this.buffer = '';
        }
        return;
      }

      const serialized = this.buffer.slice(startMarker.length, endIndex).trim();
      this.buffer = this.buffer.slice(endIndex + endMarker.length);
      const call = parseToolCall(serialized, this.allowedTools);
      if (call) {
        this.callbacks.onToolCall?.(call);
      } else {
        this.callbacks.onText(`${startMarker}${serialized}${endMarker}`);
      }
    }
  }
}

function parseToolCall(serialized: string, allowedTools: ReadonlySet<string>): ClaudeToolCall | undefined {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || typeof value.name !== 'string' || !allowedTools.has(value.name)) {
      return undefined;
    }
    const args = isRecord(value.arguments) ? value.arguments : {};
    return {
      ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id.trim() } : {}),
      name: value.name,
      arguments: args
    };
  } catch {
    return undefined;
  }
}

function parseRateLimitUpdate(message: Record<string, unknown>): ClaudeUsageUpdate | undefined {
  if (!isRecord(message.rate_limit_info)) {
    return undefined;
  }
  const info = message.rate_limit_info;
  const unifiedWindows = isRecord(info.unifiedWindows) ? info.unifiedWindows : undefined;
  const fiveHour = parseRateLimitWindow(unifiedWindows?.five_hour);
  const sevenDay = parseRateLimitWindow(unifiedWindows?.seven_day);
  if (!fiveHour && !sevenDay && typeof info.isUsingOverage !== 'boolean' && typeof info.overageStatus !== 'string') {
    return undefined;
  }
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(typeof info.isUsingOverage === 'boolean' ? { isUsingOverage: info.isUsingOverage } : {}),
    ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {})
  };
}

function parseRateLimitWindow(value: unknown): ClaudeRateLimitWindow | undefined {
  if (!isRecord(value) || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) {
    return undefined;
  }
  const resetsAt = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
    ? value.resetsAt
    : undefined;
  return {
    utilization: Math.min(1, Math.max(0, value.utilization)),
    ...(resetsAt !== undefined ? { resetsAt } : {})
  };
}

function parseResultUsageUpdate(message: Record<string, unknown>): ClaudeUsageUpdate | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const modelUsage = isRecord(message.modelUsage)
    ? Object.entries(message.modelUsage)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .sort((left, right) => (readFiniteNumber(right[1].costUSD) ?? 0) - (readFiniteNumber(left[1].costUSD) ?? 0))[0]
    : undefined;
  const modelDetails = modelUsage?.[1];
  const update: ClaudeUsageUpdate = {
    inputTokens: readFiniteNumber(usage?.input_tokens),
    outputTokens: readFiniteNumber(usage?.output_tokens),
    cacheCreationInputTokens: readFiniteNumber(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: readFiniteNumber(usage?.cache_read_input_tokens),
    thinkingTokens: isRecord(usage?.output_tokens_details)
      ? readFiniteNumber(usage.output_tokens_details.thinking_tokens)
      : undefined,
    totalCostUsd: readFiniteNumber(message.total_cost_usd),
    model: modelUsage?.[0],
    contextWindow: readFiniteNumber(modelDetails?.contextWindow),
    maxOutputTokens: readFiniteNumber(modelDetails?.maxOutputTokens)
  };
  const populated = Object.values(update).some((value) => value !== undefined);
  return populated ? update : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readAssistantText(message: Record<string, unknown>): string {
  if (!isRecord(message.message) || !Array.isArray(message.message.content)) {
    return '';
  }
  return message.message.content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
