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

export interface ClaudeStreamCallbacks {
  onText(text: string): void;
  onThinking?(text: string): void;
  onToolCall?(call: ClaudeToolCall): void;
}

export const CLAUDE_MODELS = [
  {
    id: 'default',
    name: 'Claude (Default)',
    description: 'Uses the model selected by Claude Code.',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    description: 'Balanced Claude model for coding and agentic work.',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    description: 'Most capable Claude model for complex work.',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    description: 'Fast Claude model for lightweight tasks.',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000
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
  return messages
    .map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`)
    .join('\n\n');
}

export function buildClaudeSystemPrompt(
  instructions: string,
  tools: readonly ClaudeToolDefinition[],
  markerNonce: string
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

  return `${instructions}\n\nVS Code controls all tools for this conversation. Claude Code's own tools are disabled.\nWhen a tool is needed, output exactly one tool request using this format and no Markdown fences:\n${startMarker}{"name":"tool_name","arguments":{}}${endMarker}\nUse only a tool from the catalog below. Do not invent tool names. Stop generating after the closing marker so VS Code can execute the tool.\n\nTool catalog:\n${JSON.stringify(catalog)}`;
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

    if (message.type === 'result') {
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
