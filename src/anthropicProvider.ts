import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getClaudeCliStatus, streamClaudeResponse } from './claudeCli';
import { ClaudeSessionStore } from './claudeSessionStore';
import {
  buildClaudePrompt,
  buildClaudeSystemPrompt,
  CLAUDE_MODELS,
  parseProviderModelId,
  toProviderModelId,
  type ClaudeEffort,
  type ClaudePromptMessage,
  type ClaudeToolDefinition,
  type ClaudeUsageUpdate
} from './claudeProtocol';

export interface AnthropicProviderConfig {
  claudePath: string;
  model: string;
  instructions: string;
  defaultEffort: ClaudeEffort;
  defaultContextSize: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  enabledModels: string[];
  sessionContinuation: boolean;
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

export class AnthropicModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  private readonly sessionStore = new ClaudeSessionStore();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;

  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly usageSink?: (usage: ClaudeUsageUpdate) => void
  ) {}

  dispose(): void {
    this.sessionStore.clear();
    this.modelsChanged.dispose();
  }

  refresh(): void {
    this.sessionStore.clear();
    this.modelsChanged.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getAnthropicProviderConfig();
    const status = await getClaudeCliStatus(config.claudePath);
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
          await vscode.commands.executeCommand('anthropicForCopilot.installClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('anthropicForCopilot.openSettings');
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
          await vscode.commands.executeCommand('anthropicForCopilot.updateClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('anthropicForCopilot.openSettings');
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
          await vscode.commands.executeCommand('anthropicForCopilot.auth.signInWithBrowser');
        } else if (action === 'Open Claude Code') {
          await vscode.commands.executeCommand('anthropicForCopilot.auth.signInWithClaudeCode');
        }
      }
      return [];
    }

    return CLAUDE_MODELS
      .filter((model) => config.enabledModels.includes(model.id))
      .map((model): ModelPickerChatInformation => ({
      id: toProviderModelId(model.id),
      name: model.name,
      family: 'claude',
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: Math.min(model.maxOutputTokens, config.maxOutputTokens),
      tooltip: model.description,
      detail: `Runs through the signed-in Claude Code CLI (${status.authMethod ?? 'authenticated'}).`,
      configurationSchema: buildModelConfigurationSchema(config),
      capabilities: {
        imageInput: false,
        toolCalling: true
      }
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getAnthropicProviderConfig();
    const selectedModel = parseProviderModelId(model.id, config.model);
    const runtimeOptions = options as RuntimeResponseOptions;
    const effort = resolveEffortOption(runtimeOptions, config.defaultEffort);
    const contextSize = resolveContextSizeOption(runtimeOptions, config.defaultContextSize);
    const tools = normalizeTools(options.tools ?? []);
    const markerNonce = randomBytes(12).toString('hex');
    const promptMessages = messages.map(convertMessage);
    const toolRequired = options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length > 0;
    const sessionEnvelope = {
      model: selectedModel,
      effort,
      contextSize,
      instructions: config.instructions,
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

    await streamClaudeResponse({
      executable: config.claudePath,
      model: selectedModel,
      effort,
      contextSize,
      prompt: buildClaudePrompt(messagesToSend),
      systemPrompt: buildClaudeSystemPrompt(config.instructions, tools, markerNonce, toolRequired),
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
      toolCallCount
    });
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

export function getAnthropicProviderConfig(): AnthropicProviderConfig {
  const config = vscode.workspace.getConfiguration('anthropicForCopilot');
  return {
    claudePath: resolveClaudePath(config.get('claudePath', 'claude')),
    model: config.get('model', 'default').trim() || 'default',
    instructions: config.get(
      'instructions',
      'You are a helpful coding assistant integrated with VS Code. Follow the user’s instructions and use only tools explicitly provided by VS Code.'
    ),
    defaultEffort: normalizeEffort(config.get('defaultEffort', 'high'), 'high'),
    defaultContextSize: normalizeContextSize(config.get('defaultContextSize', 1_000_000), 1_000_000),
    maxOutputTokens: normalizePositiveInteger(config.get('maxOutputTokens', 128_000), 128_000),
    requestTimeoutMs: normalizeRequestTimeout(config.get('requestTimeoutSeconds', 600)) * 1_000,
    enabledModels: normalizeEnabledModels(config.get('enabledModels', CLAUDE_MODELS.map((model) => model.id))),
    sessionContinuation: config.get('sessionContinuation', false)
  };
}

export function buildModelConfigurationSchema(config: AnthropicProviderConfig): ModelConfigurationSchema {
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

function normalizeTools(tools: readonly vscode.LanguageModelChatTool[]): ClaudeToolDefinition[] {
  return tools
    .filter((tool) => typeof tool.name === 'string' && tool.name.trim().length > 0)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' }
    }));
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
