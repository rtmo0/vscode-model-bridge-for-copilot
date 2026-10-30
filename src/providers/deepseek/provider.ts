import * as vscode from 'vscode';
import { applyLoopGuard, reportLoopGuard } from '../../loopGuard';
import type { UsageRecorder } from '../../usage/usageRecorder';
import {
  buildChatCompletionBody,
  createHttpError,
  estimateTokenCount,
  formatTokenCount,
  isNetworkError,
  normalizeBaseURL,
  normalizeInteger,
  normalizeTemperature,
  reasoningEffortSchema,
  resolveReasoningEffort,
  resolveTemperature,
  resolveTokenLimits,
  safeError,
  streamChatCompletion,
  temperatureSchema,
  toUsageEntryTokens,
  type ChatCompletionResult,
  type ModelPickerInformation,
  type ReasoningReplayHook,
  type RuntimeResponseOptions
} from '../openaiCompatible/chatCompletions';
import { ReasoningReplayStore } from '../openaiCompatible/reasoningReplay';
import { parseDeepSeekBalance, type DeepSeekBalance, type DeepSeekRequestSummary } from './balanceStatusBar';
import { estimateDeepSeekCostUsd, readModelIds, toDeepSeekModels, type DeepSeekModel } from './models';

export const DEEPSEEK_SECTION = 'modelBridge.deepseek';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const API_KEY_SECRET_PREFIX = 'modelBridge.deepseek.apiKey:';
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface DeepSeekConfig {
  baseURL: string;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface DeepSeekStatus {
  baseURL: string;
  hasApiKey: boolean;
  reachable: boolean;
  models: DeepSeekModel[];
  balance?: DeepSeekBalance;
  error?: string;
}

export class DeepSeekModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;
  private readonly reasoningReplay = new ReasoningReplayStore();
  private models = new Map<string, DeepSeekModel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
    private readonly usageRecorder?: UsageRecorder,
    private readonly onRequestCompleted?: (summary: DeepSeekRequestSummary) => void
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
    const config = getDeepSeekConfig();
    if (!await this.getApiKey(config)) {
      if (!options.silent) {
        // Not awaited: the model list must not wait for the notification to be dismissed.
        void vscode.window.showInformationMessage('Set your DeepSeek API key to use DeepSeek models.', 'Set API Key')
          .then((action) => action ? vscode.commands.executeCommand('modelBridge.deepseek.setApiKey') : undefined);
      }
      return [];
    }

    let models: DeepSeekModel[];
    try {
      models = await this.discover(config, token);
    } catch (error) {
      this.output.warn('DeepSeek model discovery failed', { error: safeError(error) });
      if (!options.silent) {
        void vscode.window.showWarningMessage(`Model Bridge could not load DeepSeek models: ${safeError(error)}`, 'Run Doctor')
          .then((action) => action ? vscode.commands.executeCommand('modelBridge.deepseek.doctor') : undefined);
      }
      return [];
    }
    this.models = new Map(models.map((model) => [model.id, model]));

    return models.map((model): ModelPickerInformation => {
      const limits = resolveTokenLimits(model.contextLength, config.maxOutputTokens);
      const capabilities = [
        `${formatTokenCount(model.contextLength)} context`,
        model.toolCalling ? 'tools' : 'text',
        ...(model.vision ? ['vision'] : []),
        ...(model.reasoning ? ['thinking'] : [])
      ];
      return {
        id: model.id,
        name: model.displayName,
        family: 'deepseek',
        version: model.id,
        tooltip: `${model.id} through the DeepSeek API at ${config.baseURL}.`,
        detail: capabilities.join(' · '),
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
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getDeepSeekConfig();
    const apiKey = await this.getApiKey(config);
    if (!apiKey) {
      throw new Error('DeepSeek API key is not set. Run "Model Bridge: DeepSeek: Set API Key".');
    }
    const runtimeOptions = options as RuntimeResponseOptions;
    const reasoningEffort = resolveReasoningEffort(runtimeOptions, this.models.get(model.id)?.reasoning);
    const guarded = applyLoopGuard(messages);
    reportLoopGuard(guarded, this.output, progress);
    const hasTools = (options.tools?.length ?? 0) > 0;
    let missingReasoning = 0;
    const replayReasoning: ReasoningReplayHook = (message) => {
      const reasoning = message.thinking ?? this.reasoningReplay.lookup(message);
      if (!reasoning && message.toolCallIds.length > 0) missingReasoning += 1;
      return reasoning;
    };
    const body = buildChatCompletionBody(model.id, guarded.messages, options, {
      temperature: resolveTemperature(runtimeOptions, config.temperature),
      maxTokens: model.maxOutputTokens,
      reasoningEffort,
      replayReasoning
    });
    // In thinking mode DeepSeek rejects tool histories without their reasoning, and `tool_choice: required`.
    let thinking = reasoningEffort !== 'none'
      && !(hasTools && (missingReasoning > 0 || options.toolMode === vscode.LanguageModelChatToolMode.Required));
    if (reasoningEffort !== 'none' && !thinking) {
      this.output.info('DeepSeek thinking is off for this request', {
        reason: missingReasoning > 0 ? 'earlier tool calls have no reasoning to send back' : 'a tool call is required',
        toolCallsWithoutReasoning: missingReasoning
      });
    }
    setThinking(body, thinking);

    const send = () => streamChatCompletion({
      serverName: 'DeepSeek',
      url: `${config.baseURL}/chat/completions`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body,
      timeoutMs: config.requestTimeoutMs,
      token,
      progress,
      captureReplay: thinking
    });
    let result: ChatCompletionResult;
    try {
      result = await send();
    } catch (error) {
      // The HTTP error arrives before any output, so the request can be repeated once without thinking.
      if (!thinking || !/reasoning_content/i.test(safeError(error))) throw error;
      this.output.warn('DeepSeek rejected the reasoning history; retrying without thinking', { model: model.id });
      thinking = false;
      setThinking(body, false);
      result = await send();
    }
    if (result.replay?.reasoning) {
      this.reasoningReplay.record(result.replay, result.replay.reasoning);
    }

    const tokens = toUsageEntryTokens(result);
    const costUsd = result.usage ? estimateDeepSeekCostUsd(model.id, tokens) : undefined;
    this.output.info('DeepSeek request completed', {
      model: model.id,
      reasoningEffort: reasoningEffort ?? 'default',
      thinking,
      durationMs: result.durationMs,
      textCharacters: result.textCharacters,
      reasoningCharacters: result.reasoningCharacters,
      toolCallCount: result.toolCallCount,
      usage: result.usage
    });
    if (result.usage) {
      this.usageRecorder?.recordRequest(messages, {
        provider: 'deepseek',
        model: model.id,
        tools: options.tools?.length ?? 0,
        effort: reasoningEffort,
        ...tokens,
        ...(costUsd !== undefined ? { costUsd } : {})
      });
      this.onRequestCompleted?.({ model: model.id, ...tokens, costUsd });
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    return estimateTokenCount(value, token);
  }

  async getStatus(config = getDeepSeekConfig()): Promise<DeepSeekStatus> {
    const hasApiKey = Boolean(await this.getApiKey(config));
    if (!hasApiKey) {
      return { baseURL: config.baseURL, hasApiKey, reachable: false, models: [], error: 'No API key is set.' };
    }
    try {
      const [models, balance] = await Promise.all([this.discover(config), this.getBalance(config)]);
      return { baseURL: config.baseURL, hasApiKey, reachable: true, models, balance };
    } catch (error) {
      return { baseURL: config.baseURL, hasApiKey, reachable: false, models: [], error: safeError(error) };
    }
  }

  async getBalance(config = getDeepSeekConfig()): Promise<DeepSeekBalance | undefined> {
    if (!await this.getApiKey(config)) return undefined;
    const balance = parseDeepSeekBalance(await this.getJson(config, '/user/balance'));
    if (!balance) {
      throw new Error('DeepSeek returned an invalid balance.');
    }
    return balance;
  }

  async hasApiKey(): Promise<boolean> {
    return Boolean(await this.getApiKey(getDeepSeekConfig()));
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(apiKeySecret(getDeepSeekConfig()), apiKey);
    this.refresh();
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(apiKeySecret(getDeepSeekConfig()));
    this.refresh();
  }

  private async discover(config: DeepSeekConfig, token?: vscode.CancellationToken): Promise<DeepSeekModel[]> {
    return toDeepSeekModels(readModelIds(await this.getJson(config, '/models', token)));
  }

  private async getJson(config: DeepSeekConfig, path: string, token?: vscode.CancellationToken): Promise<unknown> {
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(`${config.baseURL}${path}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${await this.getApiKey(config) ?? ''}` },
        signal: controller.signal
      });
      if (!response.ok) {
        throw await createHttpError(response, `DeepSeek ${path} request failed`, 'DeepSeek');
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted || isNetworkError(error)) {
        throw new Error(`Cannot reach DeepSeek at ${config.baseURL}. Check the network or modelBridge.deepseek.baseURL.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  private async getApiKey(config: DeepSeekConfig): Promise<string | undefined> {
    return (await this.context.secrets.get(apiKeySecret(config)))?.trim() || undefined;
  }
}

export function getDeepSeekConfig(): DeepSeekConfig {
  const configuration = vscode.workspace.getConfiguration(DEEPSEEK_SECTION);
  return {
    baseURL: normalizeBaseURL(configuration.get('baseURL', DEFAULT_DEEPSEEK_BASE_URL), DEFAULT_DEEPSEEK_BASE_URL),
    maxOutputTokens: normalizeInteger(configuration.get('maxOutputTokens', 65_536), 65_536, 1, 393_216),
    temperature: normalizeTemperature(configuration.get('temperature', 0.2), 0.2),
    requestTimeoutMs: normalizeInteger(configuration.get('requestTimeoutSeconds', 600), 600, 30, 3_600) * 1_000
  };
}

// Thinking is DeepSeek's default; turning it off also drops the effort, which would turn it back on.
function setThinking(body: Record<string, unknown>, enabled: boolean): void {
  if (enabled) {
    delete body.thinking;
  } else {
    body.thinking = { type: 'disabled' };
    delete body.reasoning_effort;
  }
}

// The key is bound to the API URL, so changing modelBridge.deepseek.baseURL never sends it to another server.
function apiKeySecret(config: DeepSeekConfig): string {
  return `${API_KEY_SECRET_PREFIX}${config.baseURL}`;
}
