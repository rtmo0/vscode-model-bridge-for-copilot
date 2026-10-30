import * as vscode from 'vscode';
import { activateClaude } from './providers/claude/integration';
import { activateCodex } from './providers/codex/integration';
import { activateDeepSeek } from './providers/deepseek/integration';
import { activateLmStudio } from './providers/lmstudio/integration';
import { activateOpenAICompatible } from './providers/openaiCompatible/integration';
import { SUPPORT_URL } from './providers/managementMenu';
import { migrateLegacySettings } from './settingsMigration';
import { activateUsage } from './usage/integration';
import type { UsageRecorder } from './usage/usageRecorder';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Model Bridge', { log: true });
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('modelBridge.manage', () => showProviderManager()),
    vscode.commands.registerCommand('modelBridge.doctor', () => showDiagnosticsManager()),
    vscode.commands.registerCommand('modelBridge.support', () => vscode.env.openExternal(vscode.Uri.parse(SUPPORT_URL)))
  );

  try {
    const migrated = await migrateLegacySettings(context);
    if (migrated > 0) output.info('Migrated legacy settings', { count: migrated });
  } catch (error) {
    output.warn('Legacy settings migration failed', error);
  }

  // Usage recording is optional: providers work without it if it fails to start.
  let usage: UsageRecorder | undefined;
  try {
    usage = activateUsage(context);
  } catch (error) {
    output.warn('Usage recording failed to activate', error);
  }

  // Providers are isolated: one failing to activate must not disable the others.
  await activateProvider(output, 'Claude', () => activateClaude(context, usage));
  await activateProvider(output, 'LM Studio', () => activateLmStudio(context, usage));
  await activateProvider(output, 'OpenAI-Compatible', () => activateOpenAICompatible(context, usage));
  await activateProvider(output, 'DeepSeek', () => activateDeepSeek(context, usage));
  await activateProvider(output, 'Codex', () => activateCodex(context, usage));
}

export function deactivate(): void {}

async function activateProvider(output: vscode.LogOutputChannel, name: string, activate: () => unknown): Promise<void> {
  try {
    await activate();
  } catch (error) {
    output.error(`${name} provider failed to activate`, error);
    void vscode.window.showWarningMessage(`Model Bridge could not activate the ${name} provider. Other providers remain available.`);
  }
}

async function showProviderManager(): Promise<void> {
  const selection = await vscode.window.showQuickPick([
    { label: '$(sparkle) Claude', description: 'Claude Code subscription sign-in', command: 'modelBridge.claude.manage' },
    { label: '$(cloud) Codex', description: 'ChatGPT Codex sign-in and Responses API', command: 'modelBridge.codex.manage' },
    { label: '$(telescope) DeepSeek', description: 'DeepSeek API key and balance', command: 'modelBridge.deepseek.manage' },
    { label: '$(server) LM Studio', description: 'Local LM Studio models', command: 'modelBridge.lmstudio.manage' },
    { label: '$(plug) OpenAI-Compatible', description: 'Ollama, llama.cpp, vLLM, and other servers', command: 'modelBridge.openaiCompatible.manage' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
    { label: '$(graph) Usage Report', description: 'Tokens per day, model, and conversation', command: 'modelBridge.usage.showReport' },
    { label: '$(heart) Support the Project', description: 'Boosty', command: 'modelBridge.support' }
  ], { title: 'Model Bridge Providers', placeHolder: 'Choose a provider to manage' });
  if (selection) await vscode.commands.executeCommand(selection.command);
}

async function showDiagnosticsManager(): Promise<void> {
  const selection = await vscode.window.showQuickPick([
    { label: '$(sparkle) Claude Doctor', command: 'modelBridge.claude.doctor' },
    { label: '$(cloud) Codex Doctor', command: 'modelBridge.codex.doctor' },
    { label: '$(telescope) DeepSeek Doctor', command: 'modelBridge.deepseek.doctor' },
    { label: '$(server) LM Studio Doctor', command: 'modelBridge.lmstudio.doctor' },
    { label: '$(plug) OpenAI-Compatible Doctor', command: 'modelBridge.openaiCompatible.doctor' }
  ], { title: 'Model Bridge Diagnostics', placeHolder: 'Choose a provider diagnostic' });
  if (selection) await vscode.commands.executeCommand(selection.command);
}
