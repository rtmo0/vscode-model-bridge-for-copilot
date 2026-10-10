import * as vscode from 'vscode';
import { isInsecureRemoteURL, LmStudioModelProvider } from './provider';
import { showDoctorReport, showManagementMenu } from '../managementMenu';

const DOCUMENTATION_URL = 'https://lmstudio.ai/docs/developer/core/server';

export function activateLmStudio(context: vscode.ExtensionContext): LmStudioModelProvider {
  const output = vscode.window.createOutputChannel('Model Bridge: LM Studio', { log: true });
  const provider = new LmStudioModelProvider(context, output);
  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider('model-bridge-lmstudio', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('modelBridge.lmstudio')) provider.refresh();
    }),
    vscode.commands.registerCommand('modelBridge.lmstudio.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('modelBridge.lmstudio.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', 'modelBridge.lmstudio')
    )),
    vscode.commands.registerCommand('modelBridge.lmstudio.openDocumentation', () => (
      vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL))
    )),
    vscode.commands.registerCommand('modelBridge.lmstudio.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('LM Studio models refreshed.');
    }),
    vscode.commands.registerCommand('modelBridge.lmstudio.setApiToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'LM Studio API Token',
        prompt: 'Enter the token configured by the local LM Studio server',
        password: true,
        ignoreFocusOut: true
      });
      if (token?.trim()) {
        await provider.setApiToken(token.trim());
        vscode.window.showInformationMessage('LM Studio API token saved in VS Code SecretStorage.');
        const baseURL = vscode.workspace.getConfiguration('modelBridge.lmstudio').get('baseURL', '');
        if (isInsecureRemoteURL(baseURL)) {
          void vscode.window.showWarningMessage('The LM Studio server URL uses plain HTTP on a non-local host, so the API token is sent unencrypted. Use HTTPS or an SSH tunnel.');
        }
      }
    }),
    vscode.commands.registerCommand('modelBridge.lmstudio.clearApiToken', async () => {
      await provider.clearApiToken();
      vscode.window.showInformationMessage('LM Studio API token removed.');
    }),
    vscode.commands.registerCommand('modelBridge.lmstudio.doctor', () => runLmStudioDoctor(provider)),
    vscode.commands.registerCommand('modelBridge.lmstudio.testConnection', () => testLmStudioConnection(provider)),
    vscode.commands.registerCommand('modelBridge.lmstudio.manage', () => showManagementMenu('Model Bridge: LM Studio', [
      { label: 'Account', actions: [
        { icon: 'key', label: 'Set API Token', command: 'modelBridge.lmstudio.setApiToken' },
        { icon: 'clear-all', label: 'Clear API Token', command: 'modelBridge.lmstudio.clearApiToken' }
      ] },
      { label: 'Models', actions: [
        { icon: 'refresh', label: 'Refresh Models', command: 'modelBridge.lmstudio.refreshModels' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'debug-start', label: 'Test Connection', command: 'modelBridge.lmstudio.testConnection' },
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.lmstudio.doctor' },
        { icon: 'book', label: 'Open Documentation', command: 'modelBridge.lmstudio.openDocumentation' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.lmstudio.openLogs' },
        { icon: 'gear', label: 'Open Settings', command: 'modelBridge.lmstudio.openSettings' }
      ] }
    ]))
  );
  return provider;
}

async function testLmStudioConnection(provider: LmStudioModelProvider): Promise<void> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing LM Studio connection…' },
    () => provider.getStatus()
  );
  if (!status.reachable) {
    vscode.window.showErrorMessage(status.error ?? `Cannot reach LM Studio at ${status.baseURL}.`);
    return;
  }
  provider.refresh();
  vscode.window.showInformationMessage(
    `LM Studio connection test passed: ${status.modelCount} model${status.modelCount === 1 ? '' : 's'} available, ${status.loadedModelCount} loaded.`
  );
}

async function runLmStudioDoctor(provider: LmStudioModelProvider): Promise<void> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking LM Studio…' },
    () => provider.getStatus()
  );
  await showDoctorReport([
    'Model Bridge: LM Studio Doctor',
    `Server: ${status.baseURL}`,
    ...(isInsecureRemoteURL(status.baseURL) ? ['Warning: plain HTTP to a non-local host; requests and any API token are unencrypted.'] : []),
    `Reachable: ${status.reachable ? 'yes' : 'no'}`,
    `Models: ${status.modelCount}`,
    `Loaded models: ${status.loadedModelCount}`,
    ...(status.models.length > 0 ? [`Catalog: ${status.models.join(', ')}`] : []),
    ...(status.error ? [`Problem: ${status.error}`] : ['Result: ready'])
  ], {
    logsCommand: 'modelBridge.lmstudio.openLogs',
    extraActions: [status.reachable
      ? { label: 'Refresh Models', command: 'modelBridge.lmstudio.refreshModels' }
      : { label: 'Open Documentation', command: 'modelBridge.lmstudio.openDocumentation' }]
  });
}
