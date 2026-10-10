import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getClaudeCliStatus, streamClaudeResponse } from './claudeCli';
import {
  buildClaudePrompt,
  buildClaudeSystemPrompt,
  CLAUDE_MODELS,
  parseProviderModelId,
  toProviderModelId,
  type ClaudePromptMessage,
  type ClaudeToolDefinition
} from './claudeProtocol';

export interface AnthropicProviderConfig {
  claudePath: string;
  model: string;
  instructions: string;
  maxOutputTokens: number;
}

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;
};

export class AnthropicModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;

  constructor(private readonly output: vscode.LogOutputChannel) {}

  dispose(): void {
    this.modelsChanged.dispose();
  }

  refresh(): void {
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

    return CLAUDE_MODELS.map((model) => ({
      id: toProviderModelId(model.id),
      name: model.name,
      family: 'claude',
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: Math.min(model.maxOutputTokens, config.maxOutputTokens),
      tooltip: model.description,
      detail: `Runs through the signed-in Claude Code CLI (${status.authMethod ?? 'authenticated'}).`,
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
    const tools = normalizeTools(options.tools ?? []);
    const markerNonce = randomBytes(12).toString('hex');
    const promptMessages = messages.map(convertMessage);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let textCharacters = 0;
    let thinkingCharacters = 0;
    let toolCallCount = 0;

    this.output.info('Starting Claude Code request', {
      model: selectedModel,
      messageCount: messages.length,
      toolCount: tools.length,
      hasWorkspace: Boolean(workspaceFolder)
    });

    await streamClaudeResponse({
      executable: config.claudePath,
      model: selectedModel,
      prompt: buildClaudePrompt(promptMessages),
      systemPrompt: buildClaudeSystemPrompt(config.instructions, tools, markerNonce),
      markerNonce,
      allowedTools: new Set(tools.map((tool) => tool.name)),
      cwd: workspaceFolder,
      token,
      callbacks: {
        onText: (text) => {
          if (!text) {
            return;
          }
          textCharacters += text.length;
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
          progress.report(new vscode.LanguageModelToolCallPart(
            call.id ?? randomUUID(),
            call.name,
            call.arguments
          ));
        }
      }
    });

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
    claudePath: config.get('claudePath', 'claude').trim() || 'claude',
    model: config.get('model', 'default').trim() || 'default',
    instructions: config.get(
      'instructions',
      'You are a helpful coding assistant integrated with VS Code. Follow the user’s instructions and use only tools explicitly provided by VS Code.'
    ),
    maxOutputTokens: normalizePositiveInteger(config.get('maxOutputTokens', 64_000), 64_000)
  };
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

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
