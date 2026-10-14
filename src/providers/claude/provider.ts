import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getClaudeCliStatus, streamClaudeResponse, type ClaudeCliStatus, type ClaudeSystemPromptMode } from './cli';
import { ClaudeSessionStore } from './sessionStore';
import {
  buildClaudePromptBlocks,
  buildClaudeSystemPrompt,
  CLAUDE_MODELS,
  compactToolSchema,
  parseProviderModelId,
  toProviderModelId,
  type ClaudeEffort,
  type ClaudePromptMessage,
  type ClaudeToolDefinition,
  type ClaudeUsageUpdate
} from './protocol';

export interface ClaudeProviderConfig {
  claudePath: string;
  model: string;
  instructions: string;
  defaultEffort: ClaudeEffort;
  defaultContextSize: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  enabledModels: string[];
  sessionContinuation: boolean;
  systemPromptMode: ClaudeSystemPromptMode;
}

type RuntimeResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type ModelConfigurationSchema = {
  readonly properties: {
    readonly reasoningEffort: {
      readonly type: 'string';
      readonly title: 'Thinking Effort';
      readonly enum: readonly ClaudeEffort[];
      readonly enumItemLabels: readonly string[];
      readonly enumDescriptions: readonly string[];
      readonly default: ClaudeEffort;
      readonly group: 'navigation';
    };
    readonly contextSize: {
      readonly type: 'number';
      readonly title: 'Context Size';
      readonly enum: readonly number[];
      readonly enumItemLabels: readonly string[];
      readonly enumDescriptions: readonly string[];
      readonly default: number;
      readonly group: 'tokens';
    };
  };
};

type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly configurationSchema: ModelConfigurationSchema;
};

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;
};

const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_CONTEXT_SIZES = [100_000, 200_000, 500_000, 1_000_000] as const;
const USAGE_DATA_PART_MIME = 'usage';
const READY_STATUS_TTL_MS = 60_000;
const UNAVAILABLE_MODELS_KEY = 'modelBridge.claude.unavailableModels';
const UNAVAILABLE_MODEL_TTL_MS = 24 * 60 * 60_000;
const MODEL_ACCESS_REJECTION = /requires usage credits|unavailable for this account|model.+(?:not available|not found|unsupported)|does not support this model/i;

export class ClaudeModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  private readonly sessionStore = new ClaudeSessionStore();
  // Stable across requests so the system prompt stays cacheable and resumed sessions
  // keep recognizing tool markers already present in their history.
  private markerNonce = createMarkerNonce();
  private statusCache?: { claudePath: string; status: Promise<ClaudeCliStatus>; expiresAt: number };
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;

  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly usageSink?: (usage: ClaudeUsageUpdate) => void,
    private readonly state?: vscode.Memento
  ) {}

  dispose(): void {
    this.sessionStore.clear();
    this.modelsChanged.dispose();
  }

  refresh(): void {
    void this.state?.update(UNAVAILABLE_MODELS_KEY, undefined);
    this.sessionStore.clear();
    this.markerNonce = createMarkerNonce();
    this.statusCache = undefined;
    this.modelsChanged.fire();
  }

  private getStatus(claudePath: string): Promise<ClaudeCliStatus> {
    const now = Date.now();
    if (this.statusCache?.claudePath === claudePath && this.statusCache.expiresAt > now) {
      return this.statusCache.status;
    }
    const status = getClaudeCliStatus(claudePath);
    const entry = { claudePath, status, expiresAt: now + READY_STATUS_TTL_MS };
    this.statusCache = entry;
    // Only a ready CLI is cached; failures are re-checked so sign-in and updates apply immediately.
    void status.then(
      (result) => {
        if ((!result.authenticated || !result.compatible) && this.statusCache === entry) this.statusCache = undefined;
      },
      () => {
        if (this.statusCache === entry) this.statusCache = undefined;
      }
    );
    return status;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getClaudeProviderConfig();
    const status = await this.getStatus(config.claudePath);
    this.output.debug('Claude Code status checked', {
      installed: status.installed,
      authenticated: status.authenticated,
      version: status.version,
      authMethod: status.authMethod
    });

    if (!status.installed) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          'Claude Code is required to use Anthropic models without an API key.',
          'Install Claude Code',
          'Open Settings'
        );
        if (action === 'Install Claude Code') {
          await vscode.commands.executeCommand('modelBridge.claude.installClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('modelBridge.claude.openSettings');
        }
      }
      return [];
    }

    if (!status.compatible) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          status.error ?? 'Claude Code must be updated before it can be used by this extension.',
          'Update Claude Code',
          'Open Settings'
        );
        if (action === 'Update Claude Code') {
          await vscode.commands.executeCommand('modelBridge.claude.updateClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('modelBridge.claude.openSettings');
        }
      }
      return [];
    }

    if (!status.authenticated) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          status.error ?? 'Sign in to Claude Code before using Anthropic models.',
          'Sign in with Browser',
          'Open Claude Code'
        );
        if (action === 'Sign in with Browser') {
          await vscode.commands.executeCommand('modelBridge.claude.auth.signInWithBrowser');
        } else if (action === 'Open Claude Code') {
          await vscode.commands.executeCommand('modelBridge.claude.auth.signInWithClaudeCode');
        }
      }
      return [];
    }

    const unavailableModels = this.getUnavailableModels();
    return CLAUDE_MODELS
      .filter((model) => config.enabledModels.includes(model.id) && !unavailableModels.has(model.id))
      .map((model): ModelPickerChatInformation => {
        const limits = resolveTokenLimits(model, config);
        return {
          id: toProviderModelId(model.id),
          name: model.name,
          family: 'claude',
          version: '1.0.0',
          maxInputTokens: limits.maxInputTokens,
          maxOutputTokens: limits.maxOutputTokens,
          tooltip: model.description,
          detail: `Runs through the signed-in Claude Code CLI (${status.authMethod ?? 'authenticated'}).`,
          configurationSchema: buildModelConfigurationSchema(config),
          capabilities: {
            imageInput: false,
            toolCalling: true
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
    const config = getClaudeProviderConfig();
    const selectedModel = parseProviderModelId(model.id, config.model);
    const runtimeOptions = options as RuntimeResponseOptions;
    const effort = resolveEffortOption(runtimeOptions, config.defaultEffort);
    const contextSize = resolveContextSizeOption(runtimeOptions, config.defaultContextSize);
    const tools = normalizeTools(options.tools ?? []);
    const markerNonce = this.markerNonce;
    const promptMessages = messages.map(convertMessage);
    const toolRequired = options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length > 0;
    const sessionEnvelope = {
      model: selectedModel,
      effort,
      contextSize,
      instructions: config.instructions,
      systemPromptMode: config.systemPromptMode,
      toolRequired,
      tools
    };
    const continuation = config.sessionContinuation
      ? this.sessionStore.resolve(promptMessages, sessionEnvelope)
      : undefined;
    const requestedSessionId = continuation?.sessionId ?? (config.sessionContinuation ? randomUUID() : undefined);
    const messagesToSend = continuation?.appendedMessages ?? promptMessages;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const outputSegments: Array<{ kind: 'text' | 'tool'; value: string }> = [];
    let activeSessionId = requestedSessionId;
    let textCharacters = 0;
    let thinkingCharacters = 0;
    let toolCallCount = 0;
    let usage: ClaudeUsageUpdate = {};

    this.output.info('Starting Claude Code request', {
      model: selectedModel,
      effort,
      contextSize,
      messageCount: messages.length,
      incrementalMessageCount: messagesToSend.length,
      sessionContinuation: continuation ? 'resumed' : config.sessionContinuation ? 'new' : 'disabled',
      toolCount: tools.length,
      toolRequired,
      hasWorkspace: Boolean(workspaceFolder)
    });

    await this.streamWithModelAccessCheck(selectedModel, {
      executable: config.claudePath,
      model: selectedModel,
      effort,
      contextSize,
      promptBlocks: buildClaudePromptBlocks(messagesToSend),
      systemPrompt: buildClaudeSystemPrompt(config.instructions, tools, markerNonce, toolRequired),
      systemPromptMode: config.systemPromptMode,
      markerNonce,
      allowedTools: new Set(tools.map((tool) => tool.name)),
      cwd: workspaceFolder,
      token,
      timeoutMs: config.requestTimeoutMs,
      persistSession: config.sessionContinuation,
      sessionId: requestedSessionId,
      resumeSession: continuation !== undefined,
      callbacks: {
        onText: (text) => {
          if (!text) {
            return;
          }
          textCharacters += text.length;
          const lastSegment = outputSegments.at(-1);
          if (lastSegment?.kind === 'text') {
            lastSegment.value += text;
          } else {
            outputSegments.push({ kind: 'text', value: text });
          }
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onThinking: (thinking) => {
          const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
          if (!ThinkingPart || !thinking) {
            return;
          }
          thinkingCharacters += thinking.length;
          progress.report(new ThinkingPart(thinking));
        },
        onToolCall: (call) => {
          toolCallCount += 1;
          const callId = call.id ?? randomUUID();
          outputSegments.push({
            kind: 'tool',
            value: `[Tool call ${callId}: ${call.name}]\n${safeJson(call.arguments)}`
          });
          progress.report(new vscode.LanguageModelToolCallPart(callId, call.name, call.arguments));
        },
        onUsage: (update) => {
          usage = mergeUsageUpdates(usage, update);
          this.usageSink?.(update);
        },
        onSessionId: (sessionId) => {
          activeSessionId = sessionId;
        }
      }
    });

    if (config.sessionContinuation && activeSessionId && outputSegments.length > 0) {
      this.sessionStore.record(activeSessionId, [
        ...promptMessages,
        { role: 'assistant', content: outputSegments.map((segment) => segment.value).join('\n') }
      ], sessionEnvelope);
    }

    const usagePart = createUsageDataPart(usage);
    if (usagePart) {
      progress.report(usagePart);
    }

    this.output.info('Claude Code request completed', {
      model: selectedModel,
      textCharacters,
      thinkingCharacters,
      toolCallCount,
      inputTokens: usage.inputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      outputTokens: usage.outputTokens
    });
  }

  private async streamWithModelAccessCheck(
    selectedModel: string,
    request: Parameters<typeof streamClaudeResponse>[0]
  ): Promise<void> {
    try {
      await streamClaudeResponse(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedModels = getRejectedClaudeModels(message, selectedModel);
      if (!rejectedModels) {
        throw error;
      }
      this.markModelsUnavailable(rejectedModels);
      this.output.warn('Claude model hidden after access rejection', { models: rejectedModels });
      const rejection = new Error(`${message.replace(/\.?\s*$/, '.')} Claude ${selectedModel} has been hidden from the model picker; choose another model. Use Refresh in the Claude Manage menu after changing your plan or credits.`);
      (rejection as Error & { cause?: unknown }).cause = error;
      throw rejection;
    }
  }

  private getUnavailableModels(): Set<string> {
    return new Set(Object.keys(this.readUnavailableModels()));
  }

  private readUnavailableModels(): Record<string, number> {
    const stored = this.state?.get<Record<string, number>>(UNAVAILABLE_MODELS_KEY);
    const now = Date.now();
    return Object.fromEntries(Object.entries(stored && typeof stored === 'object' ? stored : {})
      .filter(([, expiresAt]) => typeof expiresAt === 'number' && expiresAt > now));
  }

  private markModelsUnavailable(models: readonly string[]): void {
    const next = this.readUnavailableModels();
    for (const model of models) {
      next[model] = Date.now() + UNAVAILABLE_MODEL_TTL_MS;
    }
    void this.state?.update(UNAVAILABLE_MODELS_KEY, next).then(() => this.modelsChanged.fire());
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const text = typeof value === 'string' ? value : convertMessage(value).content;
    return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
  }
}

export function getClaudeProviderConfig(): ClaudeProviderConfig {
  const config = vscode.workspace.getConfiguration('modelBridge.claude');
  return {
    claudePath: resolveClaudePath(config.get('claudePath', 'claude')),
    model: config.get('model', 'default').trim() || 'default',
    instructions: config.get(
      'instructions',
      'You are a helpful coding assistant integrated with VS Code. Follow the user’s instructions and use only tools explicitly provided by VS Code.'
    ),
    defaultEffort: normalizeEffort(config.get('defaultEffort', 'high'), 'high'),
    defaultContextSize: normalizeContextSize(config.get('defaultContextSize', 200_000), 200_000),
    maxOutputTokens: normalizePositiveInteger(config.get('maxOutputTokens', 32_000), 32_000),
    requestTimeoutMs: normalizeRequestTimeout(config.get('requestTimeoutSeconds', 600)) * 1_000,
    enabledModels: normalizeEnabledModels(config.get('enabledModels', CLAUDE_MODELS.map((model) => model.id))),
    sessionContinuation: config.get('sessionContinuation', false),
    systemPromptMode: config.get<string>('systemPrompt', 'minimal') === 'claudeCode' ? 'claudeCode' : 'minimal'
  };
}

// The input budget plus the output reservation must fit inside the context window
// Claude Code is configured to use, otherwise VS Code builds prompts that cannot fit.
export function resolveTokenLimits(
  model: { maxInputTokens: number; maxOutputTokens: number },
  config: Pick<ClaudeProviderConfig, 'defaultContextSize' | 'maxOutputTokens'>
): { maxInputTokens: number; maxOutputTokens: number } {
  const contextWindow = Math.min(model.maxInputTokens, config.defaultContextSize);
  const maxOutputTokens = Math.min(model.maxOutputTokens, config.maxOutputTokens, Math.floor(contextWindow / 2));
  return { maxInputTokens: contextWindow - maxOutputTokens, maxOutputTokens };
}

export function buildModelConfigurationSchema(config: ClaudeProviderConfig): ModelConfigurationSchema {
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        enum: CLAUDE_EFFORTS,
        enumItemLabels: ['Low', 'Medium', 'High', 'Extra High', 'Maximum'],
        enumDescriptions: [
          'Fastest responses with minimal extended thinking.',
          'Balanced speed and reasoning.',
          'Deeper reasoning for coding tasks.',
          'Very deep reasoning for difficult tasks.',
          'Maximum available reasoning effort.'
        ],
        default: config.defaultEffort,
        group: 'navigation'
      },
      contextSize: {
        type: 'number',
        title: 'Context Size',
        enum: CLAUDE_CONTEXT_SIZES,
        enumItemLabels: ['100K', '200K', '500K', '1M'],
        enumDescriptions: [
          'Compact earlier for faster, smaller conversations.',
          'Standard context for ordinary coding sessions.',
          'Extended context for larger repositories and long conversations.',
          'Maximum Claude context for long-running work.'
        ],
        default: config.defaultContextSize,
        group: 'tokens'
      }
    }
  };
}

export function resolveEffortOption(options: RuntimeResponseOptions, fallback: ClaudeEffort): ClaudeEffort {
  for (const candidate of getModelOptionCandidates(options, 'reasoningEffort')) {
    if (typeof candidate === 'string' && CLAUDE_EFFORTS.includes(candidate as ClaudeEffort)) {
      return candidate as ClaudeEffort;
    }
  }
  return fallback;
}

export function resolveContextSizeOption(options: RuntimeResponseOptions, fallback: number): number {
  for (const candidate of getModelOptionCandidates(options, 'contextSize')) {
    if (typeof candidate === 'number' && CLAUDE_CONTEXT_SIZES.includes(candidate as typeof CLAUDE_CONTEXT_SIZES[number])) {
      return candidate;
    }
  }
  return fallback;
}

function getModelOptionCandidates(options: RuntimeResponseOptions, key: string): unknown[] {
  return [
    options.modelOptions?.[key],
    options.modelConfiguration?.[key],
    options.configuration?.[key]
  ];
}

function mergeUsageUpdates(current: ClaudeUsageUpdate, update: ClaudeUsageUpdate): ClaudeUsageUpdate {
  return {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))
  };
}

function createUsageDataPart(usage: ClaudeUsageUpdate): vscode.LanguageModelResponsePart | undefined {
  const inputTokens = (usage.inputTokens ?? 0)
    + (usage.cacheCreationInputTokens ?? 0)
    + (usage.cacheReadInputTokens ?? 0);
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  return vscode.LanguageModelDataPart.json({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadInputTokens ?? 0
    },
    completion_tokens_details: {
      reasoning_tokens: usage.thinkingTokens ?? 0
    }
  }, USAGE_DATA_PART_MIME) as vscode.LanguageModelResponsePart;
}

function convertMessage(message: vscode.LanguageModelChatRequestMessage): ClaudePromptMessage {
  const role = message.role === vscode.LanguageModelChatMessageRole.User
    ? 'user'
    : message.role === vscode.LanguageModelChatMessageRole.Assistant
      ? 'assistant'
      : 'system';
  const content = message.content.map(convertMessagePart).filter(Boolean).join('\n');
  return { role, content };
}

function convertMessagePart(part: vscode.LanguageModelChatRequestMessage['content'][number]): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call ${part.callId}: ${part.name}]\n${safeJson(part.input ?? {})}`;
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return `[Tool result for ${part.callId}]\n${part.content.map(convertToolResultPart).filter(Boolean).join('\n')}`;
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    const size = part.data instanceof Uint8Array ? part.data.byteLength : 0;
    return `[Binary attachment: ${part.mimeType || 'application/octet-stream'}, ${size} bytes. Image input is not available through the Claude Code CLI provider.]`;
  }
  return '';
}

function convertToolResultPart(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    const size = part.data instanceof Uint8Array ? part.data.byteLength : 0;
    return `[Tool returned ${part.mimeType || 'binary data'} (${size} bytes)]`;
  }
  return typeof part === 'string' ? part : safeJson(part);
}

// Sorted, annotation-free tools keep the system prompt byte-stable and smaller across requests.
function normalizeTools(tools: readonly vscode.LanguageModelChatTool[]): ClaudeToolDefinition[] {
  return tools
    .filter((tool) => typeof tool.name === 'string' && tool.name.trim().length > 0)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: isRecord(tool.inputSchema) ? compactToolSchema(tool.inputSchema) as object : { type: 'object' }
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function createMarkerNonce(): string {
  return randomBytes(12).toString('hex');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveClaudePath(configuredPath: string): string {
  const normalized = configuredPath.trim() || 'claude';
  if (normalized !== 'claude') {
    return normalized;
  }

  const candidates = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe')]
    : [join(homedir(), '.local', 'bin', 'claude')];
  return candidates.find((candidate) => candidate.length > 0 && existsSync(candidate)) ?? normalized;
}

function normalizeEffort(value: unknown, fallback: ClaudeEffort): ClaudeEffort {
  return typeof value === 'string' && CLAUDE_EFFORTS.includes(value as ClaudeEffort)
    ? value as ClaudeEffort
    : fallback;
}

function normalizeContextSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && CLAUDE_CONTEXT_SIZES.includes(value as typeof CLAUDE_CONTEXT_SIZES[number])
    ? value
    : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeRequestTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 600;
  }
  return Math.min(3_600, Math.max(30, Math.floor(value)));
}

function normalizeEnabledModels(value: unknown): string[] {
  const knownModels = new Set(CLAUDE_MODELS.map((model) => model.id));
  if (!Array.isArray(value)) {
    return [...knownModels];
  }
  const models = [...new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && knownModels.has(entry as typeof CLAUDE_MODELS[number]['id'])
  )))];
  return models.length > 0 ? models : ['default'];
}

/** Models to hide after Claude Code refuses the selected model for this account. */
export function getRejectedClaudeModels(message: string, selectedModel: string): string[] | undefined {
  if (!MODEL_ACCESS_REJECTION.test(message)) {
    return undefined;
  }
  // `best` resolves to Fable when Claude Code offers it, so a Fable rejection hides both aliases.
  return /\bfable\b/i.test(message) && (selectedModel === 'fable' || selectedModel === 'best')
    ? ['fable', 'best']
    : [selectedModel];
}
