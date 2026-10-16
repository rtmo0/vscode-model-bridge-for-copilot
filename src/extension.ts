import * as vscode from 'vscode';
import { activateClaude } from './providers/claude/integration';
import { activateCodex } from './providers/codex/integration';
import { activateLmStudio } from './providers/lmstudio/integration';
import { SUPPORT_URL } from './providers/managementMenu';
import { migrateLegacySettings } from './settingsMigration';

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

  // Providers are isolated: one failing to activate must not disable the others.
  await activateProvider(output, 'Claude', () => activateClaude(context));
  await activateProvider(output, 'LM Studio', () => activateLmStudio(context));
  await activateProvider(output, 'Codex', () => activateCodex(context));
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
    { label: '$(server) LM Studio', description: 'Local OpenAI-compatible models', command: 'modelBridge.lmstudio.manage' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
    { label: '$(heart) Support the Project', description: 'Buy Me a Coffee', command: 'modelBridge.support' }
  ], { title: 'Model Bridge Providers', placeHolder: 'Choose a provider to manage' });
  if (selection) await vscode.commands.executeCommand(selection.command);
}

async function showDiagnosticsManager(): Promise<void> {
  const selection = await vscode.window.showQuickPick([
    { label: '$(sparkle) Claude Doctor', command: 'modelBridge.claude.doctor' },
    { label: '$(cloud) Codex Doctor', command: 'modelBridge.codex.doctor' },
    { label: '$(server) LM Studio Doctor', command: 'modelBridge.lmstudio.doctor' }
  ], { title: 'Model Bridge Diagnostics', placeHolder: 'Choose a provider diagnostic' });
  if (selection) await vscode.commands.executeCommand(selection.command);
}
