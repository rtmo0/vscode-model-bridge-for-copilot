import * as vscode from 'vscode';
import {
  buildChatCompletionBody,
  createHttpError,
  estimateTokenCount,
  formatTokenCount,
  isRecord,
  nativeRoot,
  normalizeBaseURL,
  normalizeInteger,
  normalizeTemperature,
  parseReasoningCapability,
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
} from '../openaiCompatible/chatCompletions';

import type { UsageRecorder } from '../../usage/usageRecorder';

export { isInsecureRemoteURL } from '../openaiCompatible/chatCompletions';

const MODEL_PREFIX = 'lmstudio::';
const TOKEN_SECRET_KEY = 'modelBridge.lmstudio.apiToken';
const DEFAULT_BASE_URL = 'http://127.0.0.1:1234/v1';

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
  reasoning?: ReasoningCapability;
  architecture?: string;
  loaded: boolean;
  detail: string;
}

export interface LmStudioStatus {
  reachable: boolean;
  baseURL: string;
  /** `openai` means the native API was unavailable, so tool and vision support are unknown. */
  catalogSource?: 'native' | 'openai';
  modelCount: number;
  loadedModelCount: number;
  models: string[];
  error?: string;
}

export class LmStudioModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;
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
    this.modelsChanged.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const { models } = await this.fetchModels(token);
      const config = getConfig();
      this.reasoningByModel = new Map(models.flatMap((model) => model.reasoning ? [[model.id, model.reasoning] as const] : []));
      return models.map((model): ModelPickerInformation => {
        const limits = resolveTokenLimits(model.contextLength, config.maxOutputTokens);
        return {
          id: toProviderModelId(model.id),
          name: model.displayName,
          family: model.architecture ?? 'local-llm',
          version: 'local',
          tooltip: `Local model served by LM Studio. ${model.detail}`,
          detail: `${formatTokenCount(model.contextLength)} context · ${model.toolCalling ? 'tools' : 'text'}${model.vision ? ' · vision' : ''}${model.reasoning ? ' · reasoning' : ''}`,
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
    const runtimeOptions = options as RuntimeResponseOptions;
    const reasoningEffort = resolveReasoningEffort(runtimeOptions, this.reasoningByModel.get(requestModel));
    const result = await streamChatCompletion({
      serverName: 'LM Studio',
      url: `${config.baseURL}/chat/completions`,
      headers: await this.getHeaders(),
      body: buildChatCompletionBody(requestModel, messages, options, {
        temperature: resolveTemperature(runtimeOptions, config.temperature),
        maxTokens: Math.min(config.maxOutputTokens, model.maxOutputTokens),
        reasoningEffort
      }),
      timeoutMs: config.requestTimeoutMs,
      token,
      progress
    });
    this.output.info('LM Studio request completed', {
      model: requestModel,
      reasoningEffort: reasoningEffort ?? 'default',
      durationMs: result.durationMs,
      textCharacters: result.textCharacters,
      reasoningCharacters: result.reasoningCharacters,
      toolCallCount: result.toolCallCount,
      usage: result.usage
    });
    if (result.usage) {
      this.usageRecorder?.recordRequest(messages, {
        provider: 'lmstudio',
        model: requestModel,
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

  async getStatus(): Promise<LmStudioStatus> {
    const config = getConfig();
    try {
      const { models, source } = await this.fetchModels();
      return {
        reachable: true,
        baseURL: config.baseURL,
        catalogSource: source,
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

  private async fetchModels(token?: vscode.CancellationToken): Promise<{ models: LmStudioModel[]; source: 'native' | 'openai' }> {
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
          return { models: payload.models.flatMap((value) => parseNativeModel(value, config.contextSize)), source: 'native' };
        }
      } else if (response.status === 401 || response.status === 403) {
        throw new Error('LM Studio requires an API token. Run “Model Bridge: LM Studio: Set API Token”.');
      }

      const fallback = await fetch(`${config.baseURL}/models`, {
        headers: await this.getHeaders(false),
        signal: controller.signal
      });
      if (!fallback.ok) {
        throw await createHttpError(fallback, 'LM Studio model discovery failed', 'LM Studio');
      }
      const payload = await fallback.json() as { data?: unknown };
      if (!Array.isArray(payload.data)) {
        throw new Error('LM Studio returned an invalid model catalog.');
      }
      const models = payload.data.flatMap((entry): LmStudioModel[] => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return [];
        // Without native metadata nothing says the model was trained for tools, so it is not offered to Agent mode.
        return [{
          id: entry.id,
          displayName: entry.id,
          contextLength: config.contextSize,
          vision: false,
          toolCalling: false,
          loaded: true,
          detail: 'OpenAI-compatible model; update LM Studio for tool and vision metadata'
        }];
      });
      return { models, source: 'openai' };
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
    baseURL: normalizeBaseURL(configuration.get('baseURL', DEFAULT_BASE_URL), DEFAULT_BASE_URL),
    contextSize: normalizeInteger(configuration.get('contextSize', 32_768), 32_768, 1_024),
    maxOutputTokens: normalizeInteger(configuration.get('maxOutputTokens', 8_192), 8_192, 1),
    temperature: normalizeTemperature(configuration.get('temperature', 0.2), 0.2),
    requestTimeoutMs: normalizeInteger(configuration.get('requestTimeoutSeconds', 600), 600, 30, 3_600) * 1_000
  };
}

function parseNativeModel(value: unknown, fallbackContext: number): LmStudioModel[] {
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
    reasoning: parseReasoningCapability(model.capabilities?.reasoning?.allowed_options, model.capabilities?.reasoning?.default),
    architecture: typeof model.architecture === 'string' ? model.architecture : undefined,
    loaded: loadedInstances.length > 0,
    detail: details
  }];
}

function toProviderModelId(id: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(id)}`;
}

function fromProviderModelId(id: string): string {
  return id.startsWith(MODEL_PREFIX) ? decodeURIComponent(id.slice(MODEL_PREFIX.length)) : id;
}
