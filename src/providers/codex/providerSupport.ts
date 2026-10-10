import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import { STATEFUL_MARKER_DATA_PART_MIME } from './convertMessages';
import { resolveReasoningEffort, type ReasoningEffort, type ReasoningEffortResolution } from './reasoningEffort';
import { normalizeBaseURL } from './responsesClient';
import { getApiCredentials } from './secrets';
import type { CodexLatencyContext } from './codexLatency';

export const USAGE_DATA_PART_MIME = 'usage';

export type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string, metadata?: { readonly [key: string]: any }) => unknown;
};

export type RuntimeProvideLanguageModelChatResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

export function buildCodexUserAgent(extensionVersion: string): string {
  return `model-bridge-for-copilot/${extensionVersion} (${process.platform}; ${process.arch}; vscode/${vscode.version})`;
}

export function getExtensionVersion(context: vscode.ExtensionContext): string {
  const extension = (context as vscode.ExtensionContext & {
    extension?: { packageJSON?: { version?: unknown } };
  }).extension;
  return typeof extension?.packageJSON?.version === 'string' ? extension.packageJSON.version : '0.0.0';
}

export function createMemoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue as T,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}

export function getReasoningEffort(
  selectedReasoningEffort: ReasoningEffort | undefined,
  options: RuntimeProvideLanguageModelChatResponseOptions,
  defaultReasoningEffort: ReasoningEffort | undefined
): ReasoningEffortResolution {
  return resolveReasoningEffort(selectedReasoningEffort, options, defaultReasoningEffort);
}

export type ContextSizeSchemaCarrier = {
  readonly configurationSchema?: {
    readonly properties?: {
      readonly contextSize?: {
        readonly enum?: readonly unknown[];
        readonly default?: unknown;
      };
    };
  };
};

export function resolveConfiguredContextSize(
  fallbackBudget: number | undefined,
  model: vscode.LanguageModelChatInformation,
  options: RuntimeProvideLanguageModelChatResponseOptions
): number | undefined {
  const contextSizeSchema = getContextSizeSchema(model);
  if (!contextSizeSchema) {
    return fallbackBudget;
  }

  for (const candidate of [
    options.modelOptions?.contextSize,
    options.modelConfiguration?.contextSize,
    options.configuration?.contextSize
  ]) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && contextSizeSchema.options.includes(candidate)) {
      return candidate;
    }
  }

  return contextSizeSchema.default ?? fallbackBudget;
}

export function getContextSizeSchema(model: vscode.LanguageModelChatInformation): { options: number[]; default: number | undefined } | undefined {
  const contextSize = (model as vscode.LanguageModelChatInformation & ContextSizeSchemaCarrier)
    .configurationSchema?.properties?.contextSize;
  if (!contextSize) {
    return undefined;
  }

  const options = (contextSize.enum ?? [])
    .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  if (options.length === 0) {
    return undefined;
  }

  return {
    options,
    default: typeof contextSize.default === 'number' && options.includes(contextSize.default)
      ? contextSize.default
      : undefined
  };
}

export function supportsOfficialTokenCounting(baseURL: string): boolean {
  const normalizedBaseURL = normalizeBaseURL(baseURL).toLowerCase();
  return !normalizedBaseURL.includes('chatgpt.com/backend-api/codex');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function waitForPromiseWithCancellation<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
  if (token.isCancellationRequested) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellation: vscode.Disposable | undefined;
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation?.dispose();
      action();
    };

    cancellation = token.onCancellationRequested(() => {
      settle(() => reject(createAbortError()));
    });
    if (settled) {
      cancellation.dispose();
    }

    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

export function createAbortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}

export function createThinkingPart(
  value: string | string[],
  id?: string,
  metadata?: { readonly [key: string]: unknown }
): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  if (typeof ThinkingPart !== 'function') {
    return undefined;
  }

  return new ThinkingPart(value, id, metadata) as vscode.LanguageModelResponsePart;
}

export function createUsageDataPart(usage: ResponseUsage | null | undefined): vscode.LanguageModelResponsePart | undefined {
  if (!usage) {
    return undefined;
  }

  return vscode.LanguageModelDataPart.json(
    {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0
      },
      completion_tokens_details: {
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0
      }
    },
    USAGE_DATA_PART_MIME
  ) as vscode.LanguageModelResponsePart;
}

export function createStatefulMarkerDataPart(payload: string): vscode.LanguageModelResponsePart {
  return vscode.LanguageModelDataPart.text(
    payload,
    STATEFUL_MARKER_DATA_PART_MIME
  ) as vscode.LanguageModelResponsePart;
}

export function combineRequestInstructions(configuredInstructions: string, systemInstructions: string | undefined): string {
  return systemInstructions
    ? `${configuredInstructions}\n\n${systemInstructions}`
    : configuredInstructions;
}

export function getToolModeName(toolMode: vscode.LanguageModelChatToolMode | undefined): 'auto' | 'required' | null {
  if (toolMode === undefined) {
    return null;
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Required) {
    return 'required';
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Auto) {
    return 'auto';
  }
  return null;
}

export function summarizeToolNames(tools: readonly vscode.LanguageModelChatTool[] | undefined): readonly string[] {
  return Object.freeze([...(tools ?? [])].map((tool) => tool.name).sort());
}

export function getCredentialIdentity(credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>): string {
  const accountId = credentials.headers['ChatGPT-Account-ID'];
  const credentialHash = createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 16);
  if (typeof accountId === 'string' && accountId.length > 0) {
    return `${credentials.source}:${accountId}:${credentialHash}`;
  }

  return `${credentials.source}:${credentialHash}`;
}

export function readLatencyContextFromTransportMetrics(metrics: Record<string, unknown>): CodexLatencyContext {
  const prewarmResult = readPrewarmResult(metrics.prewarmResult);
  const previousResponseIdUsed = typeof metrics.previousResponseIdUsed === 'boolean'
    ? metrics.previousResponseIdUsed
    : undefined;

  return {
    connectionOrigin: prewarmResult === 'success' ? 'prewarm' : undefined,
    connectionReused: typeof metrics.connectionReused === 'boolean' ? metrics.connectionReused : undefined,
    previousResponseIdUsed,
    incrementalInputCount: previousResponseIdUsed === true
      ? readNonNegativeInteger(metrics.incrementalInputCount)
      : undefined,
    requestBodyBytes: readNonNegativeInteger(metrics.requestBodyBytes),
    legacyToolSchemaCacheHit: readBoolean(metrics.legacyToolSchemaCacheHit),
    nativeToolCatalogCacheHit: readBoolean(metrics.nativeToolCatalogCacheHit),
    websocketSerializeMs: readNonNegativeNumber(metrics.websocketSerializeMs),
    prewarmResult
  };
}

export function readPrewarmResult(value: unknown): CodexLatencyContext['prewarmResult'] {
  switch (value) {
    case 'success':
    case 'timed-out':
    case 'disabled-after-failure':
    case 'skipped-auto':
      return value;
    default:
      return undefined;
  }
}

export function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
