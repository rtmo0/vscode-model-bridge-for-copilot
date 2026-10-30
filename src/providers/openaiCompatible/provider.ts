import * as vscode from 'vscode';
import { applyLoopGuard, reportLoopGuard } from '../../loopGuard';
import type { UsageRecorder } from '../../usage/usageRecorder';
import {
  buildChatCompletionBody,
  estimateTokenCount,
  formatTokenCount,
  isNetworkError,
  isRecord,
  normalizeBaseURL,
  normalizeInteger,
  normalizeTemperature,
  readPositiveInteger,
  reasoningEffortSchema,
  resolveReasoningEffort,
  resolveTemperature,
  resolveTokenLimits,
  safeError,
  streamChatCompletion,
  temperatureSchema,
  toUsageEntryTokens,
  type ModelPickerInformation,
  type ReasoningCapability,
  type RuntimeResponseOptions
} from './chatCompletions';
import {
  discoverModels,
  ENDPOINT_PRESETS,
  ENDPOINT_TYPES,
  type DiscoveredModel,
  type EndpointConfig,
  type EndpointType,
  type OllamaShow
} from './discovery';

export const OPENAI_COMPATIBLE_SECTION = 'modelBridge.openaiCompatible';
const MODEL_PREFIX = 'oai::';
const TOKEN_SECRET_PREFIX = 'modelBridge.openaiCompatible.apiToken:';
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface OpenAICompatibleConfig {
  endpoints: EndpointConfig[];
  /** Entries skipped because they are invalid or reuse a name. */
  invalidEndpoints: string[];
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface EndpointStatus {
  name: string;
  type: EndpointType;
  baseURL: string;
  reachable: boolean;
  hasToken: boolean;
  models: Array<{ id: string; contextLength: number; toolCalling: boolean; vision: boolean; reasoning: boolean; loaded?: boolean }>;
  error?: string;
}

export class OpenAICompatibleModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;
  private readonly ollamaShowCache = new Map<string, OllamaShow>();
  private reasoningByModel = new Map<string, ReasoningCapability>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
    private readonly usageRecorder?: UsageRecorder
  ) {}

  dispose(): void {
    this.modelsChanged.dispose();
  }

  refresh(): void {
    this.ollamaShowCache.clear();
    this.modelsChanged.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getOpenAICompatibleConfig();
    if (config.endpoints.length === 0) {
      if (!options.silent) {
        // Not awaited: the model list must not wait for the notification to be dismissed.
        void vscode.window.showInformationMessage(
          'No OpenAI-compatible endpoints are configured. Add Ollama, llama.cpp, vLLM, or another server.',
          'Add Endpoint'
        ).then((action) => action === 'Add Endpoint'
          ? vscode.commands.executeCommand('modelBridge.openaiCompatible.addEndpoint')
          : undefined);
      }
      return [];
    }

    const results = await Promise.all(config.endpoints.map(async (endpoint) => {
      try {
        return { endpoint, models: await this.discover(endpoint, token) };
      } catch (error) {
        this.output.warn('OpenAI-compatible model discovery failed', { endpoint: endpoint.name, error: safeError(error) });
        return { endpoint, models: [] as DiscoveredModel[], error: safeError(error) };
      }
    }));

    const reasoningByModel = new Map<string, ReasoningCapability>();
    const information = results.flatMap(({ endpoint, models }) => models.map((model): ModelPickerInformation => {
      const id = toProviderModelId(endpoint.name, model.id);
      if (model.reasoning) reasoningByModel.set(id, model.reasoning);
      const limits = resolveTokenLimits(model.contextLength, config.maxOutputTokens);
      const capabilities = [
        `${formatTokenCount(model.contextLength)} context`,
        model.toolCalling ? 'tools' : 'text',
        ...(model.vision ? ['vision'] : []),
        ...(model.reasoning ? ['reasoning'] : [])
      ];
      return {
        id,
        name: model.displayName,
        family: model.family ?? endpoint.type,
        version: endpoint.name,
        tooltip: `Served by ${endpoint.name} (${ENDPOINT_PRESETS[endpoint.type].label}) at ${endpoint.baseURL}.${model.detail ? ` ${model.detail}` : ''}`,
        detail: `${endpoint.name} · ${capabilities.join(' · ')}`,
        maxInputTokens: limits.maxInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
        configurationSchema: {
          properties: {
            ...(model.reasoning ? { reasoningEffort: reasoningEffortSchema(model.reasoning) } : {}),
            temperature: temperatureSchema(config.temperature)
          }
        },
        capabilities: {
          imageInput: model.vision,
          toolCalling: model.toolCalling
        }
      };
    }));
    this.reasoningByModel = reasoningByModel;

    const failed = results.filter((result) => result.error);
    if (failed.length > 0 && !options.silent) {
      void vscode.window.showWarningMessage(
        `Model Bridge could not load models from ${failed.map((result) => `${result.endpoint.name} (${result.error})`).join('; ')}`,
        'Run Doctor',
        'Open Settings'
      ).then((action) => action === 'Run Doctor'
        ? vscode.commands.executeCommand('modelBridge.openaiCompatible.doctor')
        : action === 'Open Settings' ? vscode.commands.executeCommand('modelBridge.openaiCompatible.openSettings') : undefined);
    }
    return information;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getOpenAICompatibleConfig();
    const { endpointName, modelId } = fromProviderModelId(model.id);
    const endpoint = config.endpoints.find((entry) => entry.name === endpointName);
    if (!endpoint) {
      throw new Error(`The endpoint "${endpointName}" is no longer configured in ${OPENAI_COMPATIBLE_SECTION}.endpoints.`);
    }
    const runtimeOptions = options as RuntimeResponseOptions;
    const reasoningEffort = resolveReasoningEffort(runtimeOptions, this.reasoningByModel.get(model.id));
    const guarded = applyLoopGuard(messages);
    reportLoopGuard(guarded, this.output, progress);
    const result = await streamChatCompletion({
      serverName: endpoint.name,
      url: `${endpoint.baseURL}/chat/completions`,
      headers: await this.getHeaders(endpoint),
      body: buildChatCompletionBody(modelId, guarded.messages, options, {
        temperature: resolveTemperature(runtimeOptions, config.temperature),
        maxTokens: Math.min(config.maxOutputTokens, model.maxOutputTokens),
        reasoningEffort
      }),
      timeoutMs: config.requestTimeoutMs,
      token,
      progress
    });
    this.output.info('OpenAI-compatible request completed', {
      endpoint: endpoint.name,
      type: endpoint.type,
      model: modelId,
      reasoningEffort: reasoningEffort ?? 'default',
      durationMs: result.durationMs,
      textCharacters: result.textCharacters,
      reasoningCharacters: result.reasoningCharacters,
      toolCallCount: result.toolCallCount,
      usage: result.usage
    });
    if (result.usage) {
      this.usageRecorder?.recordRequest(messages, {
        provider: 'openaiCompatible',
        endpoint: endpoint.name,
        model: modelId,
        tools: options.tools?.length ?? 0,
        effort: reasoningEffort,
        ...toUsageEntryTokens(result)
      });
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    return estimateTokenCount(value, token);
  }

  async getStatus(endpoints = getOpenAICompatibleConfig().endpoints): Promise<EndpointStatus[]> {
    return Promise.all(endpoints.map(async (endpoint) => {
      const hasToken = Boolean(await this.getToken(endpoint));
      try {
        const models = await this.discover(endpoint);
        return {
          name: endpoint.name,
          type: endpoint.type,
          baseURL: endpoint.baseURL,
          reachable: true,
          hasToken,
          models: models.map((model) => ({
            id: model.id,
            contextLength: model.contextLength,
            toolCalling: model.toolCalling,
            vision: model.vision,
            reasoning: Boolean(model.reasoning),
            loaded: model.loaded
          }))
        };
      } catch (error) {
        return { name: endpoint.name, type: endpoint.type, baseURL: endpoint.baseURL, reachable: false, hasToken, models: [], error: safeError(error) };
      }
    }));
  }

  async setApiToken(endpoint: EndpointConfig, token: string): Promise<void> {
    await this.context.secrets.store(tokenSecretKey(endpoint), token);
    this.refresh();
  }

  async clearApiToken(endpoint: EndpointConfig): Promise<void> {
    await this.context.secrets.delete(tokenSecretKey(endpoint));
    this.refresh();
  }

  private async discover(endpoint: EndpointConfig, token?: vscode.CancellationToken): Promise<DiscoveredModel[]> {
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    timeout.unref();
    try {
      return await discoverModels(endpoint, {
        headers: await this.getHeaders(endpoint, false),
        signal: controller.signal,
        ollamaShowCache: this.ollamaShowCache
      });
    } catch (error) {
      if (controller.signal.aborted || isNetworkError(error)) {
        throw new Error(`Cannot reach ${endpoint.name} at ${endpoint.baseURL}. Start the server or update its URL.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  private async getHeaders(endpoint: EndpointConfig, json = true): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    const token = await this.getToken(endpoint);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async getToken(endpoint: EndpointConfig): Promise<string | undefined> {
    return (await this.context.secrets.get(tokenSecretKey(endpoint)))?.trim() || undefined;
  }
}

export function getOpenAICompatibleConfig(): OpenAICompatibleConfig {
  const configuration = vscode.workspace.getConfiguration(OPENAI_COMPATIBLE_SECTION);
  const contextSize = normalizeInteger(configuration.get('contextSize', 32_768), 32_768, 1_024);
  const endpoints: EndpointConfig[] = [];
  const invalidEndpoints: string[] = [];
  const rawEndpoints = configuration.get<unknown>('endpoints', []);
  for (const [index, value] of (Array.isArray(rawEndpoints) ? rawEndpoints : []).entries()) {
    const endpoint = parseEndpoint(value, contextSize);
    if (!endpoint) {
      invalidEndpoints.push(`#${index + 1}`);
    } else if (endpoints.some((entry) => entry.name === endpoint.name)) {
      invalidEndpoints.push(`${endpoint.name} (duplicate name)`);
    } else {
      endpoints.push(endpoint);
    }
  }
  return {
    endpoints,
    invalidEndpoints,
    maxOutputTokens: normalizeInteger(configuration.get('maxOutputTokens', 8_192), 8_192, 1),
    temperature: normalizeTemperature(configuration.get('temperature', 0.2), 0.2),
    requestTimeoutMs: normalizeInteger(configuration.get('requestTimeoutSeconds', 600), 600, 30, 3_600) * 1_000
  };
}

function parseEndpoint(value: unknown, fallbackContext: number): EndpointConfig | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    return undefined;
  }
  const type = ENDPOINT_TYPES.includes(value.type as EndpointType) ? value.type as EndpointType : 'openai';
  const baseURL = normalizeBaseURL(value.baseURL, '');
  try {
    if (!/^https?:$/.test(new URL(baseURL).protocol)) return undefined;
  } catch {
    return undefined;
  }
  return {
    name: value.name.trim(),
    type,
    baseURL,
    contextSize: readPositiveInteger(value.contextSize) ?? fallbackContext,
    toolCalling: typeof value.toolCalling === 'boolean' ? value.toolCalling : undefined,
    vision: typeof value.vision === 'boolean' ? value.vision : undefined,
    models: Array.isArray(value.models) ? value.models.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : []
  };
}

// Tokens are bound to the server URL, so an endpoint renamed or redirected elsewhere never receives them.
function tokenSecretKey(endpoint: EndpointConfig): string {
  return `${TOKEN_SECRET_PREFIX}${endpoint.baseURL}`;
}

function toProviderModelId(endpointName: string, modelId: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(endpointName)}::${encodeURIComponent(modelId)}`;
}

function fromProviderModelId(id: string): { endpointName: string; modelId: string } {
  const [endpointName = '', modelId = ''] = id.startsWith(MODEL_PREFIX) ? id.slice(MODEL_PREFIX.length).split('::') : [];
  return { endpointName: decodeURIComponent(endpointName), modelId: decodeURIComponent(modelId) };
}
