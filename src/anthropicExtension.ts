import * as vscode from 'vscode';
import { AnthropicModelProvider, getAnthropicProviderConfig } from './anthropicProvider';
import { getClaudeCliStatus } from './claudeCli';
import { ClaudeUsageStatusBar } from './claudeUsageStatusBar';

const PROVIDER_ID = 'anthropic-for-copilot';
const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Anthropic for Copilot', { log: true });
  const usageStatusBar = new ClaudeUsageStatusBar(context);
  const provider = new AnthropicModelProvider(output, (usage) => usageStatusBar.record(usage));
  output.info('Anthropic for Copilot activated', {
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform
  });

  context.subscriptions.push(
    output,
    provider,
    usageStatusBar,
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_ID, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('anthropicForCopilot')) {
        provider.refresh();
        usageStatusBar.refresh();
      }
    }),
    vscode.commands.registerCommand('anthropicForCopilot.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('anthropicForCopilot.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', 'anthropicForCopilot')
    )),
    vscode.commands.registerCommand('anthropicForCopilot.installClaudeCode', () => (
      vscode.env.openExternal(vscode.Uri.parse(CLAUDE_CODE_INSTALL_URL))
    )),
    vscode.commands.registerCommand('anthropicForCopilot.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('Anthropic model availability refreshed.');
    }),
    vscode.commands.registerCommand('anthropicForCopilot.showUsage', () => usageStatusBar.showDetails()),
    vscode.commands.registerCommand('anthropicForCopilot.auth.signInWithClaudeCode', () => {
      createClaudeTerminal('Claude Code').show();
      vscode.window.showInformationMessage('Complete the official Claude Code sign-in flow in the terminal.');
    }),
    vscode.commands.registerCommand('anthropicForCopilot.auth.signInWithBrowser', () => {
      createClaudeTerminal('Claude Code Sign In', ['auth', 'login']).show();
    }),
    vscode.commands.registerCommand('anthropicForCopilot.auth.signOut', () => {
      usageStatusBar.clear();
      createClaudeTerminal('Claude Code Sign Out', ['auth', 'logout']).show();
    }),
    vscode.commands.registerCommand('anthropicForCopilot.auth.showStatus', async () => {
      const status = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking Claude Code sign-in…' },
        () => getClaudeCliStatus(getAnthropicProviderConfig().claudePath)
      );
      if (!status.installed) {
        const action = await vscode.window.showWarningMessage(
          status.error ?? 'Claude Code is not installed.',
          'Install Claude Code',
          'Open Settings'
        );
        if (action === 'Install Claude Code') {
          await vscode.commands.executeCommand('anthropicForCopilot.installClaudeCode');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('anthropicForCopilot.openSettings');
        }
        return;
      }
      usageStatusBar.setAccount(status.account);
      const details = [
        status.authenticated ? 'Signed in' : 'Not signed in',
        status.version,
        status.authMethod ? `Authentication: ${status.authMethod}` : undefined,
        status.account ? `Account: ${status.account}` : undefined,
        status.error
      ].filter(Boolean).join('\n');
      const action = await vscode.window.showInformationMessage(
        details,
        status.authenticated ? 'Refresh Models' : 'Sign in with Browser'
      );
      if (action === 'Refresh Models') {
        provider.refresh();
      } else if (action === 'Sign in with Browser') {
        await vscode.commands.executeCommand('anthropicForCopilot.auth.signInWithBrowser');
      }
    }),
    vscode.commands.registerCommand('anthropicForCopilot.manage', async () => {
      const selection = await vscode.window.showQuickPick([
        { label: '$(account) Show Claude Code Sign-In Status', command: 'anthropicForCopilot.auth.showStatus' },
        { label: '$(browser) Sign in with Browser', command: 'anthropicForCopilot.auth.signInWithBrowser' },
        { label: '$(terminal) Sign in with Claude Code', command: 'anthropicForCopilot.auth.signInWithClaudeCode' },
        { label: '$(pulse) Show Account Usage', command: 'anthropicForCopilot.showUsage' },
        { label: '$(refresh) Refresh Models', command: 'anthropicForCopilot.refreshModels' },
        { label: '$(gear) Open Settings', command: 'anthropicForCopilot.openSettings' },
        { label: '$(output) Open Logs', command: 'anthropicForCopilot.openLogs' },
        { label: '$(sign-out) Sign Out', command: 'anthropicForCopilot.auth.signOut' }
      ], { title: 'Anthropic for Copilot', placeHolder: 'Choose an action' });
      if (selection) {
        await vscode.commands.executeCommand(selection.command);
      }
    })
  );

  void getClaudeCliStatus(getAnthropicProviderConfig().claudePath)
    .then((status) => {
      if (status.authenticated) {
        usageStatusBar.setAccount(status.account);
      } else {
        usageStatusBar.clear();
      }
    })
    .catch(() => undefined);
}

export function deactivate(): void {}

function createClaudeTerminal(name: string, args: string[] = []): vscode.Terminal {
  return vscode.window.createTerminal({
    name,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    shellPath: getAnthropicProviderConfig().claudePath,
    shellArgs: args,
    env: {
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null
    }
  });
}
