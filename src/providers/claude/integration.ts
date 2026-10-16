import * as vscode from 'vscode';
import { ClaudeModelProvider, getClaudeProviderConfig } from './provider';
import { fetchClaudeUsageReport, getClaudeCliStatus, MINIMUM_CLAUDE_CODE_VERSION, streamClaudeResponse } from './cli';
import { ClaudeAccountUsageStatusBar } from './usageStatusBar';
import { showDoctorReport, showManagementMenu } from '../managementMenu';

const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';
const claudeTerminals = new WeakSet<vscode.Terminal>();

export function activateClaude(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Model Bridge: Claude', { log: true });
  const usageStatusBar = new ClaudeAccountUsageStatusBar(context, {
    fetchReport: () => fetchClaudeUsageReport(getClaudeProviderConfig().claudePath),
    output
  });
  const provider = new ClaudeModelProvider(output, (usage) => usageStatusBar.record(usage), context.globalState);
  // Keeps the account limits in step with the CLI sign-in, like Codex does with its auth events.
  const syncAccount = async (): Promise<void> => {
    const status = await getClaudeCliStatus(getClaudeProviderConfig().claudePath);
    if (status.authenticated) {
      usageStatusBar.setAccount(status.account, status.subscriptionType);
      await usageStatusBar.refresh();
    } else {
      usageStatusBar.clear();
    }
  };
  output.info('Model Bridge: Claude activated', {
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform
  });

  context.subscriptions.push(
    output,
    provider,
    usageStatusBar,
    vscode.lm.registerLanguageModelChatProvider('model-bridge-claude', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('modelBridge.claude.claudePath')) {
        void syncAccount().catch(() => undefined);
      }
      if (event.affectsConfiguration('modelBridge.claude')) {
        provider.refresh();
      }
    }),
    // Sign-in, sign-out, and updates run in a terminal; re-check the CLI once it exits.
    vscode.window.onDidCloseTerminal((terminal) => {
      if (claudeTerminals.has(terminal)) {
        claudeTerminals.delete(terminal);
        provider.refresh();
        void syncAccount().catch(() => undefined);
      }
    }),
    vscode.commands.registerCommand('modelBridge.claude.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('modelBridge.claude.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', 'modelBridge.claude')
    )),
    vscode.commands.registerCommand('modelBridge.claude.installClaudeCode', () => (
      vscode.env.openExternal(vscode.Uri.parse(CLAUDE_CODE_INSTALL_URL))
    )),
    vscode.commands.registerCommand('modelBridge.claude.updateClaudeCode', () => {
      createClaudeTerminal('Update Claude Code', ['update']).show();
    }),
    vscode.commands.registerCommand('modelBridge.claude.doctor', () => runDoctor(context, usageStatusBar)),
    vscode.commands.registerCommand('modelBridge.claude.testConnection', () => testClaudeConnection()),
    vscode.commands.registerCommand('modelBridge.claude.quickConfigure', async () => {
      if (await quickConfigure()) {
        provider.refresh();
        vscode.window.showInformationMessage('Claude model defaults updated.');
      }
    }),
    vscode.commands.registerCommand('modelBridge.claude.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('Anthropic model availability refreshed.');
    }),
    vscode.commands.registerCommand('modelBridge.claude.showAccountLimits', () => usageStatusBar.showDetails()),
    vscode.commands.registerCommand('modelBridge.claude.refreshAccountLimits', async () => {
      await usageStatusBar.refresh();
      await usageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('modelBridge.claude.auth.signInWithClaudeCode', () => {
      createClaudeTerminal('Claude Code').show();
      vscode.window.showInformationMessage('Complete the official Claude Code sign-in flow in the terminal.');
    }),
    vscode.commands.registerCommand('modelBridge.claude.auth.signInWithBrowser', () => {
      createClaudeTerminal('Claude Code Sign In', ['auth', 'login']).show();
    }),
    vscode.commands.registerCommand('modelBridge.claude.auth.signOut', () => {
      usageStatusBar.clear();
      createClaudeTerminal('Claude Code Sign Out', ['auth', 'logout']).show();
    }),
    vscode.commands.registerCommand('modelBridge.claude.auth.showStatus', async () => {
      const status = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking Claude Code sign-in…' },
        () => getClaudeCliStatus(getClaudeProviderConfig().claudePath)
      );
      if (!status.installed) {
        const action = await vscode.window.showWarningMessage(
          status.error ?? 'Claude Code is not installed.',
          'Install Claude Code',
          'Open Settings'
        );
        if (action === 'Install Claude Code') {
          await vscode.commands.executeCommand('modelBridge.claude.installClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('modelBridge.claude.openSettings');
        }
        return;
      }
      if (status.authenticated) {
        usageStatusBar.setAccount(status.account, status.subscriptionType);
      }
      const details = [
        status.authenticated ? 'Connection: ready' : 'Not signed in',
        status.account ? `Email: ${status.account}` : undefined,
        status.subscriptionType ? `Plan: ${status.subscriptionType}` : undefined,
        status.authMethod ? `Authentication: ${status.authMethod}` : undefined,
        status.version ? `Claude Code: ${status.version}` : undefined,
        status.error
      ].filter(Boolean).join('\n');
      const action = await vscode.window.showInformationMessage(
        details,
        status.authenticated ? 'Test Connection' : 'Sign in with Browser'
      );
      if (action === 'Test Connection') {
        await vscode.commands.executeCommand('modelBridge.claude.testConnection');
      } else if (action === 'Sign in with Browser') {
        await vscode.commands.executeCommand('modelBridge.claude.auth.signInWithBrowser');
      }
    }),
    vscode.commands.registerCommand('modelBridge.claude.manage', () => showManagementMenu('Model Bridge: Claude', [
      { label: 'Account', actions: [
        { icon: 'browser', label: 'Sign in with Browser', command: 'modelBridge.claude.auth.signInWithBrowser' },
        { icon: 'terminal', label: 'Sign in with Claude Code', command: 'modelBridge.claude.auth.signInWithClaudeCode' },
        { icon: 'account', label: 'Show Sign-In Status', command: 'modelBridge.claude.auth.showStatus' },
        { icon: 'sign-out', label: 'Sign Out', command: 'modelBridge.claude.auth.signOut' }
      ] },
      { label: 'Usage', actions: [
        { icon: 'pulse', label: 'Show Account Limits', command: 'modelBridge.claude.showAccountLimits' },
        { icon: 'sync', label: 'Refresh Account Limits', command: 'modelBridge.claude.refreshAccountLimits' }
      ] },
      { label: 'Models', actions: [
        { icon: 'settings-gear', label: 'Quick Configure Models', command: 'modelBridge.claude.quickConfigure' },
        { icon: 'refresh', label: 'Refresh Models', command: 'modelBridge.claude.refreshModels' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'debug-start', label: 'Test Connection', command: 'modelBridge.claude.testConnection' },
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.claude.doctor' },
        { icon: 'cloud-download', label: 'Update Claude Code', command: 'modelBridge.claude.updateClaudeCode' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.claude.openLogs' },
        { icon: 'gear', label: 'Open Settings', command: 'modelBridge.claude.openSettings' }
      ] }
    ]))
  );

  void syncAccount().catch(() => undefined);

}

function createClaudeTerminal(name: string, args: string[] = []): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    shellPath: getClaudeProviderConfig().claudePath,
    shellArgs: args,
    env: {
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null
    }
  });
  claudeTerminals.add(terminal);
  return terminal;
}

async function testClaudeConnection(): Promise<void> {
  const config = getClaudeProviderConfig();
  const status = await getClaudeCliStatus(config.claudePath);
  if (!status.authenticated || !status.compatible) {
    const action = await vscode.window.showWarningMessage(
      status.error ?? 'Claude Code is not ready.',
      status.installed ? 'Sign in with Browser' : 'Install Claude Code'
    );
    if (action === 'Sign in with Browser') {
      await vscode.commands.executeCommand('modelBridge.claude.auth.signInWithBrowser');
    } else if (action === 'Install Claude Code') {
      await vscode.commands.executeCommand('modelBridge.claude.installClaudeCode');
    }
    return;
  }

  const text: string[] = [];
  const source = new vscode.CancellationTokenSource();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing Claude connection…', cancellable: true },
      async (_progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => source.cancel());
        try {
          await streamClaudeResponse({
            executable: config.claudePath,
            model: 'default',
            effort: 'low',
            contextSize: 100_000,
            promptBlocks: ['<user>Reply with the single word OK.</user>'],
            systemPrompt: 'This is a connection test. Reply with the single word OK.',
            systemPromptMode: config.systemPromptMode,
            markerNonce: 'connection-test',
            allowedTools: new Set(),
            callbacks: { onText: (value) => text.push(value) },
            token: source.token,
            timeoutMs: Math.min(config.requestTimeoutMs, 60_000)
          });
        } finally {
          subscription.dispose();
        }
      }
    );
    vscode.window.showInformationMessage(`Claude connection test passed${text.join('').trim() ? `: ${text.join('').trim().slice(0, 80)}` : '.'}`);
  } catch (error) {
    if (!(error instanceof vscode.CancellationError)) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Claude connection test failed.');
    }
  } finally {
    source.dispose();
  }
}

async function runDoctor(context: vscode.ExtensionContext, usageStatusBar: ClaudeAccountUsageStatusBar): Promise<void> {
  const config = getClaudeProviderConfig();
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Model Bridge: Claude…' },
    () => getClaudeCliStatus(config.claudePath)
  );
  await showDoctorReport([
    'Model Bridge: Claude Doctor',
    `Extension: ${context.extension.packageJSON.version}`,
    `VS Code: ${vscode.version}`,
    `Host: ${process.platform} ${process.arch}${vscode.env.remoteName ? ` (${vscode.env.remoteName})` : ''}`,
    `Claude executable: ${config.claudePath}`,
    `Claude installed: ${status.installed ? 'yes' : 'no'}`,
    `Claude version: ${status.version ?? 'unavailable'}`,
    `Minimum version: ${MINIMUM_CLAUDE_CODE_VERSION}`,
    `Compatible: ${status.compatible ? 'yes' : 'no'}`,
    `Signed in without API key: ${status.authenticated ? 'yes' : 'no'}`,
    `Authentication method: ${status.authMethod ?? 'unknown'}`,
    `Plan: ${status.subscriptionType ?? 'unknown'}`,
    `Account limits: ${usageStatusBar.getCompactText() ?? 'not loaded'}`,
    `Workspace host available: ${vscode.workspace.workspaceFolders?.length ? 'yes' : 'no'}`,
    `Session continuation: ${config.sessionContinuation ? 'enabled' : 'disabled'}`,
    `Request timeout: ${Math.round(config.requestTimeoutMs / 1_000)} seconds`,
    status.error ? `Problem: ${status.error}` : 'Result: ready'
  ], {
    logsCommand: 'modelBridge.claude.openLogs',
    extraActions: !status.compatible && status.installed
      ? [{ label: 'Update Claude Code', command: 'modelBridge.claude.updateClaudeCode' }]
      : []
  });
}

async function quickConfigure(): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration('modelBridge.claude');
  const currentModels = new Set(configuration.get<string[]>('enabledModels', ['default', 'best', 'fable', 'sonnet', 'opus', 'haiku']));
  const modelItems = [
    { label: 'Claude Default', value: 'default' },
    { label: 'Claude Best', value: 'best', description: 'Fable when available, otherwise Opus' },
    { label: 'Claude Fable', value: 'fable', description: 'May require usage credits' },
    { label: 'Claude Sonnet', value: 'sonnet' },
    { label: 'Claude Opus', value: 'opus' },
    { label: 'Claude Haiku', value: 'haiku' }
  ].map((item) => ({ ...item, picked: currentModels.has(item.value) }));
  const models = await vscode.window.showQuickPick(modelItems, {
    title: 'Claude models',
    placeHolder: 'Choose models to show in the model picker',
    canPickMany: true
  });
  if (!models || models.length === 0) {
    return false;
  }

  const effort = await vscode.window.showQuickPick([
    { label: 'Claude Code Default', value: 'auto' },
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High', value: 'high' },
    { label: 'Extra High', value: 'xhigh' },
    { label: 'Maximum', value: 'max' }
  ], { title: 'Default thinking effort' });
  if (!effort) {
    return false;
  }

  const context = await vscode.window.showQuickPick([
    { label: '100K', value: 100_000 },
    { label: '200K', value: 200_000 },
    { label: '500K', value: 500_000 },
    { label: '1M', value: 1_000_000 }
  ], { title: 'Default context size' });
  if (!context) {
    return false;
  }

  await Promise.all([
    configuration.update('enabledModels', models.map((model) => model.value), vscode.ConfigurationTarget.Global),
    configuration.update('defaultEffort', effort.value, vscode.ConfigurationTarget.Global),
    configuration.update('defaultContextSize', context.value, vscode.ConfigurationTarget.Global)
  ]);
  return true;
}
