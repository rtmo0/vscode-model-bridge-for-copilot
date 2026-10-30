import * as vscode from 'vscode';
import type { UsageRecorder } from '../../usage/usageRecorder';
import { showDoctorReport, showManagementMenu } from '../managementMenu';
import { formatTokenCount, isInsecureRemoteURL } from '../openaiCompatible/chatCompletions';
import { DeepSeekBalanceStatusBar, formatDeepSeekBalance } from './balanceStatusBar';
import { DEEPSEEK_SECTION, DeepSeekModelProvider } from './provider';

const DOCUMENTATION_URL = 'https://api-docs.deepseek.com/';
const PLATFORM_URL = 'https://platform.deepseek.com/';

export function activateDeepSeek(context: vscode.ExtensionContext, usageRecorder?: UsageRecorder): DeepSeekModelProvider {
  const output = vscode.window.createOutputChannel('Model Bridge: DeepSeek', { log: true });
  const provider = new DeepSeekModelProvider(context, output, usageRecorder, (summary) => balanceBar.recordRequest(summary));
  const balanceBar = new DeepSeekBalanceStatusBar({ fetchBalance: () => provider.getBalance(), output });
  context.subscriptions.push(
    output,
    provider,
    balanceBar,
    vscode.lm.registerLanguageModelChatProvider('model-bridge-deepseek', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${DEEPSEEK_SECTION}.baseURL`)) {
        provider.refresh();
        void balanceBar.refresh();
      }
    }),
    vscode.commands.registerCommand('modelBridge.deepseek.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('modelBridge.deepseek.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', DEEPSEEK_SECTION)
    )),
    vscode.commands.registerCommand('modelBridge.deepseek.openDocumentation', () => (
      vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL))
    )),
    vscode.commands.registerCommand('modelBridge.deepseek.openPlatform', () => (
      vscode.env.openExternal(vscode.Uri.parse(PLATFORM_URL))
    )),
    vscode.commands.registerCommand('modelBridge.deepseek.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('DeepSeek models refreshed.');
    }),
    vscode.commands.registerCommand('modelBridge.deepseek.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'DeepSeek API Key',
        prompt: 'API key from platform.deepseek.com, stored in VS Code SecretStorage',
        password: true,
        ignoreFocusOut: true
      });
      if (!apiKey?.trim()) return;
      await provider.setApiKey(apiKey.trim());
      vscode.window.showInformationMessage('DeepSeek API key saved in VS Code SecretStorage.');
      const baseURL = vscode.workspace.getConfiguration(DEEPSEEK_SECTION).get('baseURL', '');
      if (isInsecureRemoteURL(baseURL)) {
        void vscode.window.showWarningMessage('modelBridge.deepseek.baseURL uses plain HTTP on a non-local host, so the API key is sent unencrypted. Use HTTPS.');
      }
      await testConnection(provider, balanceBar);
    }),
    vscode.commands.registerCommand('modelBridge.deepseek.clearApiKey', async () => {
      await provider.clearApiKey();
      balanceBar.clear();
      vscode.window.showInformationMessage('DeepSeek API key removed.');
    }),
    vscode.commands.registerCommand('modelBridge.deepseek.showBalance', () => balanceBar.showDetails()),
    vscode.commands.registerCommand('modelBridge.deepseek.testConnection', () => testConnection(provider, balanceBar)),
    vscode.commands.registerCommand('modelBridge.deepseek.doctor', () => runDoctor(provider)),
    vscode.commands.registerCommand('modelBridge.deepseek.manage', () => showManagementMenu('Model Bridge: DeepSeek', [
      { label: 'Account', actions: [
        { icon: 'key', label: 'Set API Key', command: 'modelBridge.deepseek.setApiKey' },
        { icon: 'clear-all', label: 'Clear API Key', command: 'modelBridge.deepseek.clearApiKey' },
        { icon: 'link-external', label: 'Open DeepSeek Platform', description: 'API keys and top-up', command: 'modelBridge.deepseek.openPlatform' }
      ] },
      { label: 'Usage', actions: [
        { icon: 'credit-card', label: 'Show Balance', command: 'modelBridge.deepseek.showBalance' },
        { icon: 'graph', label: 'Show Usage Report', command: 'modelBridge.usage.showReport' }
      ] },
      { label: 'Models', actions: [
        { icon: 'refresh', label: 'Refresh Models', command: 'modelBridge.deepseek.refreshModels' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'debug-start', label: 'Test Connection', command: 'modelBridge.deepseek.testConnection' },
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.deepseek.doctor' },
        { icon: 'book', label: 'Open Documentation', command: 'modelBridge.deepseek.openDocumentation' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.deepseek.openLogs' },
        { icon: 'gear', label: 'Open Settings', command: 'modelBridge.deepseek.openSettings' }
      ] }
    ]))
  );
  void provider.hasApiKey().then((hasKey) => hasKey ? balanceBar.refresh() : undefined);
  return provider;
}

async function testConnection(provider: DeepSeekModelProvider, statusBar: DeepSeekBalanceStatusBar): Promise<void> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing DeepSeek connection…' },
    () => provider.getStatus()
  );
  if (!status.reachable) {
    const action = await vscode.window.showErrorMessage(status.error ?? `Cannot reach DeepSeek at ${status.baseURL}.`,
      ...(status.hasApiKey ? ['Run Doctor'] : ['Set API Key']));
    if (action === 'Set API Key') await vscode.commands.executeCommand('modelBridge.deepseek.setApiKey');
    if (action === 'Run Doctor') await vscode.commands.executeCommand('modelBridge.deepseek.doctor');
    return;
  }
  provider.refresh();
  void statusBar.refresh();
  vscode.window.showInformationMessage(
    `DeepSeek connection test passed: ${status.models.length} model${status.models.length === 1 ? '' : 's'} available`
    + `${status.balance ? `, balance ${formatDeepSeekBalance(status.balance)}` : ''}.`
  );
}

async function runDoctor(provider: DeepSeekModelProvider): Promise<void> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking DeepSeek…' },
    () => provider.getStatus()
  );
  await showDoctorReport([
    'Model Bridge: DeepSeek Doctor',
    `API: ${status.baseURL}`,
    ...(isInsecureRemoteURL(status.baseURL) ? ['Warning: plain HTTP to a non-local host; requests and the API key are unencrypted.'] : []),
    `API key: ${status.hasApiKey ? 'set (VS Code SecretStorage)' : 'not set'}`,
    `Reachable: ${status.reachable ? 'yes' : 'no'}`,
    ...(status.balance ? [`Balance: ${formatDeepSeekBalance(status.balance)}${status.balance.available ? '' : ' (insufficient for API calls)'}`] : []),
    ...status.models.map((model) => `Model: ${model.id} · ${formatTokenCount(model.contextLength)} context · ${model.toolCalling ? 'tools' : 'text only'}${model.vision ? ' · vision' : ''}`),
    ...(status.error ? [`Problem: ${status.error}`] : ['Result: ready'])
  ], {
    logsCommand: 'modelBridge.deepseek.openLogs',
    extraActions: [status.hasApiKey
      ? { label: 'Open DeepSeek Platform', command: 'modelBridge.deepseek.openPlatform' }
      : { label: 'Set API Key', command: 'modelBridge.deepseek.setApiKey' }]
  });
}
