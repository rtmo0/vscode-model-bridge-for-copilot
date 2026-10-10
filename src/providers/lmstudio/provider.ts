import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { LmStudioChatStreamParser, type LmStudioUsage } from './protocol';

const MODEL_PREFIX = 'lmstudio::';
const TOKEN_SECRET_KEY = 'modelBridge.lmstudio.apiToken';
const USAGE_DATA_PART_MIME = 'usage';
const MAX_ERROR_BYTES = 16_384;

interface NativeModel {
  type?: unknown;
  key?: unknown;
  display_name?: unknown;
  publisher?: unknown;
  architecture?: unknown;
  quantization?: { name?: unknown };
  params_string?: unknown;
  max_context_length?: unknown;
  loaded_instances?: Array<{
    id?: unknown;
    config?: { context_length?: unknown };
  }>;
  capabilities?: {
    vision?: unknown;
    trained_for_tool_use?: unknown;
    reasoning?: {
      allowed_options?: unknown;
      default?: unknown;
    };
  };
}

interface LmStudioModel {
  id: string;
  displayName: string;
  contextLength: number;
  vision: boolean;
  toolCalling: boolean;
  detail: string;
}

type ModelPickerInformation = vscode.LanguageModelChatInformation & {
  readonly configurationSchema?: {
    readonly properties: Record<string, unknown>;
  };
};

type RuntimeResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;
};

export interface LmStudioStatus {
  reachable: boolean;
  baseURL: string;
  modelCount: number;
  loadedModelCount: number;
  models: string[];
  error?: string;
}

export class LmStudioModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel
  ) {}

  dispose(): void {
    this.modelsChanged.dispose();
  }

  refresh(): void {
    this.modelsChanged.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const models = await this.fetchModels(token);
      const config = getConfig();
      return models.map((model): ModelPickerInformation => {
        const limits = resolveTokenLimits(model.contextLength, config.maxOutputTokens);
        return {
          id: toProviderModelId(model.id),
          name: model.displayName,
          family: model.architecture ?? 'local-llm',
          version: 'local',
          tooltip: `Local model served by LM Studio. ${model.detail}`,
          detail: `${formatTokenCount(model.contextLength)} context · ${model.toolCalling ? 'tools' : 'text'}${model.vision ? ' · vision' : ''}`,
          maxInputTokens: limits.maxInputTokens,
          maxOutputTokens: limits.maxOutputTokens,
          configurationSchema: {
            properties: {
              temperature: {
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
                default: config.temperature,
                group: 'navigation'
              }
            }
          },
          capabilities: {
            imageInput: model.vision,
            toolCalling: model.toolCalling
          }
        };
      });
    } catch (error) {
      this.output.warn('LM Studio model discovery failed', safeError(error));
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          `LM Studio is unavailable: ${safeError(error)}`,
          'Open LM Studio Settings',
          'Open Documentation'
        );
        if (action === 'Open LM Studio Settings') {
          await vscode.commands.executeCommand('modelBridge.lmstudio.openSettings');
        } else if (action === 'Open Documentation') {
          await vscode.env.openExternal(vscode.Uri.parse('https://lmstudio.ai/docs/developer/core/server'));
        }
      }
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getConfig();
    const requestModel = fromProviderModelId(model.id);
    const temperature = resolveTemperature(options as RuntimeResponseOptions, config.temperature);
    const tools = (options.tools ?? []).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} }
      }
    }));
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    timeout.unref();
    const startedAt = Date.now();
    let textCharacters = 0;
    let reasoningCharacters = 0;
    let toolCallCount = 0;
    let usage: LmStudioUsage | undefined;

    try {
      const response = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: await this.getHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: requestModel,
          messages: convertMessages(messages),
          temperature,
          max_tokens: Math.min(config.maxOutputTokens, model.maxOutputTokens),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length > 0 ? {
            tools,
            tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
          } : {})
        })
      });
      if (!response.ok || !response.body) {
        throw await createHttpError(response, 'LM Studio chat request failed');
      }

      const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
      const parser = new LmStudioChatStreamParser({
        onText: (text) => {
          textCharacters += text.length;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onReasoning: (reasoning) => {
          reasoningCharacters += reasoning.length;
          if (ThinkingPart) {
            progress.report(new ThinkingPart(reasoning));
          }
        },
        onToolCall: (call) => {
          toolCallCount += 1;
          progress.report(new vscode.LanguageModelToolCallPart(call.id || randomUUID(), call.name, call.arguments));
        },
        onUsage: (update) => { usage = update; }
      });
      const decoder = new TextDecoder();
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        parser.push(decoder.decode(chunk, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();
      if (usage) {
        progress.report(createUsagePart(usage));
      }
      this.output.info('LM Studio request completed', {
        model: requestModel,
        durationMs: Date.now() - startedAt,
        textCharacters,
        reasoningCharacters,
        toolCallCount,
        usage
      });
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (controller.signal.aborted) {
        throw new Error(`LM Studio did not finish within ${Math.round(config.requestTimeoutMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
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
        tokens += part.mimeType.startsWith('image/')
          ? 1_024
          : Math.min(1_024, Math.max(1, Math.ceil(part.data.byteLength / 16)));
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

  async getStatus(): Promise<LmStudioStatus> {
    const config = getConfig();
    try {
      const models = await this.fetchModels();
      return {
        reachable: true,
        baseURL: config.baseURL,
        modelCount: models.length,
        loadedModelCount: models.filter((model) => model.loaded).length,
        models: models.map((model) => model.displayName)
      };
    } catch (error) {
      return {
        reachable: false,
        baseURL: config.baseURL,
        modelCount: 0,
        loadedModelCount: 0,
        models: [],
        error: safeError(error)
      };
    }
  }

  async setApiToken(token: string): Promise<void> {
    await this.context.secrets.store(TOKEN_SECRET_KEY, token);
    this.refresh();
  }

  async clearApiToken(): Promise<void> {
    await this.context.secrets.delete(TOKEN_SECRET_KEY);
    this.refresh();
  }

  private async fetchModels(token?: vscode.CancellationToken): Promise<Array<LmStudioModel & { architecture?: string; loaded: boolean }>> {
    const config = getConfig();
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 15_000));
    timeout.unref();
    try {
      const response = await fetch(`${nativeRoot(config.baseURL)}/api/v1/models`, {
        headers: await this.getHeaders(false),
        signal: controller.signal
      });
      if (response.ok) {
        const payload = await response.json() as { models?: unknown };
        if (Array.isArray(payload.models)) {
          return payload.models.flatMap((value) => parseNativeModel(value, config.contextSize));
        }
      } else if (response.status === 401 || response.status === 403) {
        throw new Error('LM Studio requires an API token. Run “Model Bridge: LM Studio: Set API Token”.');
      }

      const fallback = await fetch(`${config.baseURL}/models`, {
        headers: await this.getHeaders(false),
        signal: controller.signal
      });
      if (!fallback.ok) {
        throw await createHttpError(fallback, 'LM Studio model discovery failed');
      }
      const payload = await fallback.json() as { data?: unknown };
      if (!Array.isArray(payload.data)) {
        throw new Error('LM Studio returned an invalid model catalog.');
      }
      return payload.data.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return [];
        return [{
          id: entry.id,
          displayName: entry.id,
          contextLength: config.contextSize,
          vision: false,
          toolCalling: true,
          loaded: true,
          detail: 'OpenAI-compatible model'
        }];
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Cannot reach LM Studio at ${config.baseURL}. Start the local server or update the URL.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  private async getHeaders(json = true): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    return headers;
  }
}

function getConfig(): {
  baseURL: string;
  contextSize: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
} {
  const configuration = vscode.workspace.getConfiguration('modelBridge.lmstudio');
  return {
    baseURL: normalizeBaseURL(configuration.get('baseURL', 'http://127.0.0.1:1234/v1')),
    contextSize: normalizeInteger(configuration.get('contextSize', 32_768), 32_768, 1_024),
    maxOutputTokens: normalizeInteger(configuration.get('maxOutputTokens', 8_192), 8_192, 1),
    temperature: normalizeTemperature(configuration.get('temperature', 0.2), 0.2),
    requestTimeoutMs: normalizeInteger(configuration.get('requestTimeoutSeconds', 600), 600, 30, 3_600) * 1_000
  };
}

function parseNativeModel(value: unknown, fallbackContext: number): Array<LmStudioModel & { architecture?: string; loaded: boolean }> {
  if (!isRecord(value) || value.type !== 'llm' || typeof value.key !== 'string' || !value.key.trim()) {
    return [];
  }
  const key = value.key;
  const model = value as unknown as NativeModel;
  const loadedInstances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
  const loadedContext = loadedInstances
    .map((instance) => readPositiveInteger(instance.config?.context_length))
    .find((entry): entry is number => entry !== undefined);
  const maxContext = readPositiveInteger(model.max_context_length);
  // An unloaded model is JIT-loaded with LM Studio's default context, not its maximum.
  const contextLength = loadedContext ?? (maxContext ? Math.min(maxContext, fallbackContext) : fallbackContext);
  const displayName = typeof model.display_name === 'string' && model.display_name.trim()
    ? model.display_name.trim()
    : key;
  const details = [
    typeof model.publisher === 'string' ? model.publisher : undefined,
    typeof model.params_string === 'string' ? model.params_string : undefined,
    typeof model.quantization?.name === 'string' ? model.quantization.name : undefined,
    loadedInstances.length > 0 ? 'loaded' : 'available'
  ].filter(Boolean).join(' · ');
  return [{
    id: key,
    displayName,
    contextLength,
    vision: model.capabilities?.vision === true,
    toolCalling: model.capabilities?.trained_for_tool_use === true,
    architecture: typeof model.architecture === 'string' ? model.architecture : undefined,
    loaded: loadedInstances.length > 0,
    detail: details
  }];
}

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const textContent: Array<Record<string, unknown>> = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
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
    if (textContent.length > 0 || toolCalls.length > 0) {
      result.push({
        role,
        content: textContent.length === 0
          ? null
          : textContent.length === 1 && textContent[0].type === 'text' ? textContent[0].text : textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
    }
  }
  return result;
}

function estimateToolResultTokens(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return Math.ceil(part.value.length / 4);
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return part.mimeType.startsWith('image/')
      ? 1_024
      : Math.min(1_024, Math.max(1, Math.ceil(part.data.byteLength / 16)));
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

function createUsagePart(usage: LmStudioUsage): vscode.LanguageModelResponsePart {
  return vscode.LanguageModelDataPart.json({
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens
  }, USAGE_DATA_PART_MIME) as vscode.LanguageModelResponsePart;
}

// Input plus the output reservation must fit in the loaded context window.
function resolveTokenLimits(contextLength: number, configuredMaxOutput: number): { maxInputTokens: number; maxOutputTokens: number } {
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

function resolveTemperature(options: RuntimeResponseOptions, fallback: number): number {
  for (const value of [options.modelOptions?.temperature, options.modelConfiguration?.temperature, options.configuration?.temperature]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) return value;
  }
  return fallback;
}

function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:1234/v1';
}

function nativeRoot(baseURL: string): string {
  return baseURL.replace(/\/v1$/i, '');
}

function toProviderModelId(id: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(id)}`;
}

function fromProviderModelId(id: string): string {
  return id.startsWith(MODEL_PREFIX) ? decodeURIComponent(id.slice(MODEL_PREFIX.length)) : id;
}

function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function normalizeTemperature(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : fallback;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function formatTokenCount(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : `${Math.round(value / 1_000)}K`;
}

async function createHttpError(response: Response, prefix: string): Promise<Error> {
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  let message = body;
  try {
    const payload = JSON.parse(body) as unknown;
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
      message = payload.error.message;
    }
  } catch {}
  if (response.status === 401 || response.status === 403) {
    return new Error('LM Studio rejected authentication. Set or clear the configured API token.');
  }
  return new Error(`${prefix}: ${response.status} ${response.statusText}${message ? ` — ${message}` : ''}`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
