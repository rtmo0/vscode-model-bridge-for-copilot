import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { parseRetryAfter, ProviderHttpError } from '../providerError';
import { ChatCompletionStreamParser, type ChatCompletionUsage } from './protocol';
import type { AssistantReplayKey } from './reasoningReplay';

/** Shared `/v1/chat/completions` runtime for LM Studio and the OpenAI-compatible endpoint provider. */

export const USAGE_DATA_PART_MIME = 'usage';
const MAX_ERROR_BYTES = 16_384;

export type ModelPickerInformation = vscode.LanguageModelChatInformation & {
  readonly configurationSchema?: {
    readonly properties: Record<string, unknown>;
  };
};

export type RuntimeResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;
};

/** Public reasoning settings, as LM Studio publishes them in `capabilities.reasoning.allowed_options`; DeepSeek adds `max`. */
export type ReasoningOption = 'off' | 'on' | 'low' | 'medium' | 'high' | 'max';

export interface ReasoningCapability {
  options: ReasoningOption[];
  default: ReasoningOption;
}

const REASONING_OPTIONS: readonly ReasoningOption[] = ['off', 'on', 'low', 'medium', 'high', 'max'];
const REASONING_LABELS: Record<ReasoningOption, string> = { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const REASONING_DESCRIPTIONS: Record<ReasoningOption, string> = {
  off: 'Answer without a reasoning pass.',
  on: 'Reason before answering.',
  low: 'Light reasoning for quick answers.',
  medium: 'Balanced reasoning depth.',
  high: 'Deep reasoning for difficult tasks.',
  max: 'Deepest reasoning; slowest and uses the most tokens.'
};

/**
 * Returns the reasoning to send back with an assistant message as `reasoning_content`. `thinking` is the reasoning
 * VS Code kept in the history, when it did.
 */
export type ReasoningReplayHook = (message: AssistantReplayKey & { thinking?: string }) => string | undefined;

export interface ChatCompletionRequest {
  serverName: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  token: vscode.CancellationToken;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  /** Keeps the streamed reasoning, answer text, and tool call IDs, for servers that need the reasoning back. */
  captureReplay?: boolean;
}

export interface ChatCompletionResult {
  durationMs: number;
  textCharacters: number;
  reasoningCharacters: number;
  toolCallCount: number;
  usage?: ChatCompletionUsage;
  replay?: AssistantReplayKey & { reasoning: string };
}

/** Ledger token fields for a completed request; OpenAI-style prompt_tokens already include cached tokens. */
export function toUsageEntryTokens(result: ChatCompletionResult): {
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
} {
  return {
    durationMs: result.durationMs,
    inputTokens: result.usage?.promptTokens ?? 0,
    cachedInputTokens: result.usage?.cachedPromptTokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: result.usage?.completionTokens ?? 0,
    reasoningTokens: result.usage?.reasoningTokens ?? 0
  };
}

export function buildChatCompletionBody(
  model: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: { temperature: number; maxTokens: number; reasoningEffort?: string; replayReasoning?: ReasoningReplayHook }
): Record<string, unknown> {
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} }
    }
  }));
  return {
    model,
    messages: convertMessages(messages, settings.replayReasoning),
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
    ...(tools.length > 0 ? {
      tools,
      tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
    } : {})
  };
}

export async function streamChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  const cancellation = request.token.onCancellationRequested(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  timeout.unref();
  const startedAt = Date.now();
  const result: ChatCompletionResult = { durationMs: 0, textCharacters: 0, reasoningCharacters: 0, toolCallCount: 0 };
  const replay = request.captureReplay ? { text: [] as string[], reasoning: [] as string[], toolCallIds: [] as string[] } : undefined;

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      signal: controller.signal,
      body: JSON.stringify(request.body)
    });
    if (!response.ok || !response.body) {
      throw await createHttpError(response, `${request.serverName} chat request failed`, request.serverName);
    }

    const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
    const parser = new ChatCompletionStreamParser({
      onText: (text) => {
        result.textCharacters += text.length;
        replay?.text.push(text);
        request.progress.report(new vscode.LanguageModelTextPart(text));
      },
      onReasoning: (reasoning) => {
        result.reasoningCharacters += reasoning.length;
        replay?.reasoning.push(reasoning);
        if (ThinkingPart) {
          request.progress.report(new ThinkingPart(reasoning));
        }
      },
      onToolCall: (call) => {
        result.toolCallCount += 1;
        const callId = call.id || randomUUID();
        replay?.toolCallIds.push(callId);
        request.progress.report(new vscode.LanguageModelToolCallPart(callId, call.name, call.arguments));
      },
      onUsage: (update) => { result.usage = update; }
    });
    const decoder = new TextDecoder();
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      parser.push(decoder.decode(chunk, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
    if (result.usage) {
      request.progress.report(createUsagePart(result.usage));
    }
    if (replay) {
      result.replay = { text: replay.text.join(''), reasoning: replay.reasoning.join(''), toolCallIds: replay.toolCallIds };
    }
    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    if (request.token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (controller.signal.aborted) {
      throw new Error(`${request.serverName} did not finish within ${Math.round(request.timeoutMs / 1000)} seconds.`);
    }
    if (isNetworkError(error)) {
      throw new Error(`Cannot reach ${request.serverName} at ${new URL(request.url).origin}. Start the server or update its URL.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation.dispose();
  }
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  replayReasoning?: ReasoningReplayHook
): Record<string, unknown>[] {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const textContent: Array<Record<string, unknown>> = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];
    const thinking: string[] = [];
    for (const part of message.content) {
      if (ThinkingPart && part instanceof ThinkingPart) {
        const value = (part as { value?: unknown }).value;
        thinking.push(Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '');
      } else if (part instanceof vscode.LanguageModelTextPart) {
        textContent.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
        textContent.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` }
        });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({ callId: part.callId, content: serializeToolResult(part.content) });
      }
    }
    const role = message.role === vscode.LanguageModelChatMessageRole.User
      ? 'user'
      : message.role === vscode.LanguageModelChatMessageRole.Assistant
        ? 'assistant'
        : 'system';
    // Tool messages must directly follow the assistant message that requested them.
    for (const toolResult of toolResults) {
      result.push({ role: 'tool', tool_call_id: toolResult.callId, content: toolResult.content });
    }
    const reasoning = replayReasoning && role === 'assistant' && (textContent.length > 0 || toolCalls.length > 0)
      ? replayReasoning({
        toolCallIds: toolCalls.map((call) => call.id as string),
        text: textContent.map((entry) => entry.type === 'text' ? entry.text as string : '').join(''),
        thinking: thinking.join('') || undefined
      })
      : undefined;
    if (textContent.length > 0 || toolCalls.length > 0) {
      result.push({
        role,
        content: textContent.length === 0
          ? null
          : textContent.length === 1 && textContent[0].type === 'text' ? textContent[0].text : textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {})
      });
    }
  }
  return result;
}

export function estimateTokenCount(
  value: string | vscode.LanguageModelChatRequestMessage,
  token: vscode.CancellationToken
): number {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  if (typeof value === 'string') {
    return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
  }

  let tokens = 0;
  for (const part of value.content) {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (part instanceof vscode.LanguageModelTextPart) {
      tokens += Math.ceil(part.value.length / 4);
    } else if (part instanceof vscode.LanguageModelDataPart) {
      tokens += estimateDataPartTokens(part);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      tokens += Math.ceil((part.name.length + boundedJsonLength(part.input)) / 4);
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      tokens += part.content.reduce<number>((sum, entry) => sum + estimateToolResultTokens(entry), 0);
    } else {
      tokens += 16;
    }
  }
  return tokens;
}

export function temperatureSchema(defaultValue: number): Record<string, unknown> {
  return {
    type: 'number',
    title: 'Temperature',
    enum: [0, 0.2, 0.7, 1],
    enumItemLabels: ['Deterministic', 'Focused', 'Creative', 'Very Creative'],
    enumDescriptions: [
      'Most deterministic output.',
      'Focused coding output.',
      'More varied responses.',
      'Maximum preset creativity.'
    ],
    default: defaultValue,
    group: 'navigation'
  };
}

export function reasoningEffortSchema(reasoning: ReasoningCapability): Record<string, unknown> {
  return {
    type: 'string',
    title: 'Thinking Effort',
    enum: reasoning.options,
    enumItemLabels: reasoning.options.map((option) => option === reasoning.default
      ? `${REASONING_LABELS[option]} (Default)`
      : REASONING_LABELS[option]),
    enumDescriptions: reasoning.options.map((option) => REASONING_DESCRIPTIONS[option]),
    default: reasoning.default,
    group: 'navigation'
  };
}

/** Reads a reasoning capability, keeping only the known options; a single option offers no choice. */
export function parseReasoningCapability(options: unknown, defaultValue: unknown): ReasoningCapability | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const allowed = REASONING_OPTIONS.filter((option) => options.includes(option));
  if (allowed.length < 2) {
    return undefined;
  }
  return {
    options: allowed,
    default: allowed.includes(defaultValue as ReasoningOption) ? defaultValue as ReasoningOption : allowed[0]
  };
}

/**
 * Maps the picker selection to the OpenAI-compatible `reasoning_effort` field. The model default sends nothing,
 * so the server keeps its own per-model reasoning setting.
 */
export function resolveReasoningEffort(options: RuntimeResponseOptions, reasoning: ReasoningCapability | undefined): string | undefined {
  if (!reasoning) {
    return undefined;
  }
  const selected = readModelOptions(options, 'reasoningEffort')
    .find((value): value is ReasoningOption => reasoning.options.includes(value as ReasoningOption));
  if (!selected || selected === reasoning.default) {
    return undefined;
  }
  return selected === 'off' ? 'none' : selected === 'on' ? 'medium' : selected;
}

export function resolveTemperature(options: RuntimeResponseOptions, fallback: number): number {
  for (const value of readModelOptions(options, 'temperature')) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) return value;
  }
  return fallback;
}

function readModelOptions(options: RuntimeResponseOptions, key: string): unknown[] {
  return [options.modelOptions?.[key], options.modelConfiguration?.[key], options.configuration?.[key]];
}

// Input plus the output reservation must fit in the context window.
export function resolveTokenLimits(contextLength: number, configuredMaxOutput: number): { maxInputTokens: number; maxOutputTokens: number } {
  const maxOutputTokens = Math.max(1, Math.min(configuredMaxOutput, Math.floor(contextLength / 2)));
  return { maxInputTokens: Math.max(1, contextLength - maxOutputTokens), maxOutputTokens };
}

export function isInsecureRemoteURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return url.protocol === 'http:' && host !== 'localhost' && host !== '::1' && !/^127\./.test(host);
  } catch {
    return false;
  }
}

export function normalizeBaseURL(value: unknown, fallback: string): string {
  return (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '') || fallback;
}

/** Root of a server's native API, for base URLs that point at its `/v1` OpenAI-compatible API. */
export function nativeRoot(baseURL: string): string {
  return baseURL.replace(/\/v1$/i, '');
}

export function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

export function normalizeTemperature(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : fallback;
}

export function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function formatTokenCount(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : `${Math.round(value / 1_000)}K`;
}

export async function createHttpError(response: Response, prefix: string, serverName: string): Promise<ProviderHttpError> {
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  let message = body;
  try {
    const payload = JSON.parse(body) as unknown;
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
      message = payload.error.message;
    } else if (isRecord(payload) && typeof payload.error === 'string') {
      message = payload.error;
    }
  } catch {}
  if (response.status === 401 || response.status === 403) {
    return new ProviderHttpError(`${serverName} rejected authentication. Set or clear the configured API token.`, response.status);
  }
  return new ProviderHttpError(
    `${prefix}: ${response.status} ${response.statusText}${message ? ` — ${message}` : ''}`,
    response.status,
    parseRetryAfter(response.headers)
  );
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createUsagePart(usage: ChatCompletionUsage): vscode.LanguageModelResponsePart {
  return vscode.LanguageModelDataPart.json({
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens
  }, USAGE_DATA_PART_MIME) as vscode.LanguageModelResponsePart;
}

function estimateDataPartTokens(part: vscode.LanguageModelDataPart): number {
  return part.mimeType.startsWith('image/')
    ? 1_024
    : Math.min(1_024, Math.max(1, Math.ceil(part.data.byteLength / 16)));
}

function estimateToolResultTokens(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return Math.ceil(part.value.length / 4);
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return estimateDataPartTokens(part);
  }
  return 16;
}

function boundedJsonLength(value: unknown): number {
  try {
    return Math.min(65_536, JSON.stringify(value).length);
  } catch {
    return 2;
  }
}

function serializeToolResult(content: readonly unknown[]): string {
  return content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part instanceof vscode.LanguageModelDataPart) return `[${part.mimeType} data: ${part.data.byteLength} bytes]`;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).join('\n');
}
