import * as vscode from 'vscode';
import type { UsageRecorder } from '../../usage/usageRecorder';
import type { ActivatedProvider } from '../registry';
import { showDoctorReport, showManagementMenu } from '../managementMenu';
import { formatTokenCount, isInsecureRemoteURL } from './chatCompletions';
import { ENDPOINT_PRESETS, ENDPOINT_TYPES, type EndpointConfig } from './discovery';
import {
  getOpenAICompatibleConfig,
  OPENAI_COMPATIBLE_SECTION,
  OpenAICompatibleModelProvider
} from './provider';

const INSECURE_TOKEN_WARNING = 'This endpoint uses plain HTTP on a non-local host, so the API token is sent unencrypted. Use HTTPS or an SSH tunnel.';

export function activateOpenAICompatible(context: vscode.ExtensionContext, usageRecorder?: UsageRecorder): ActivatedProvider {
  const output = vscode.window.createOutputChannel('Model Bridge: OpenAI-Compatible', { log: true });
  const provider = new OpenAICompatibleModelProvider(context, output, usageRecorder);
  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider('model-bridge-openai-compatible', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(OPENAI_COMPATIBLE_SECTION)) provider.refresh();
    }),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', OPENAI_COMPATIBLE_SECTION)
    )),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('OpenAI-compatible models refreshed.');
    }),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.addEndpoint', () => addEndpoint(provider)),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.removeEndpoint', () => removeEndpoint(provider)),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.setApiToken', async () => {
      const endpoint = await pickEndpoint('Set API Token');
      if (endpoint && await promptForToken(provider, endpoint)) {
        vscode.window.showInformationMessage(`API token for ${endpoint.name} saved in VS Code SecretStorage.`);
      }
    }),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.clearApiToken', async () => {
      const endpoint = await pickEndpoint('Clear API Token');
      if (endpoint) {
        await provider.clearApiToken(endpoint);
        vscode.window.showInformationMessage(`API token for ${endpoint.name} removed.`);
      }
    }),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.doctor', () => runDoctor(provider)),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.testConnection', () => testConnection(provider)),
    vscode.commands.registerCommand('modelBridge.openaiCompatible.manage', () => showManagementMenu('Model Bridge: OpenAI-Compatible', [
      { label: 'Endpoints', actions: [
        { icon: 'add', label: 'Add Endpoint', description: 'Ollama, llama.cpp, vLLM, or another server', command: 'modelBridge.openaiCompatible.addEndpoint' },
        { icon: 'trash', label: 'Remove Endpoint', command: 'modelBridge.openaiCompatible.removeEndpoint' },
        { icon: 'key', label: 'Set API Token', command: 'modelBridge.openaiCompatible.setApiToken' },
        { icon: 'clear-all', label: 'Clear API Token', command: 'modelBridge.openaiCompatible.clearApiToken' }
      ] },
      { label: 'Models', actions: [
        { icon: 'refresh', label: 'Refresh Models', command: 'modelBridge.openaiCompatible.refreshModels' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'debug-start', label: 'Test Connection', command: 'modelBridge.openaiCompatible.testConnection' },
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.openaiCompatible.doctor' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.openaiCompatible.openLogs' },
        { icon: 'gear', label: 'Open Settings', command: 'modelBridge.openaiCompatible.openSettings' }
      ] }
    ]))
  );
  return { provider };
}

async function addEndpoint(provider: OpenAICompatibleModelProvider): Promise<void> {
  const type = await vscode.window.showQuickPick(ENDPOINT_TYPES.map((value) => ({
    label: ENDPOINT_PRESETS[value].label,
    description: ENDPOINT_PRESETS[value].description,
    value
  })), { title: 'Add OpenAI-Compatible Endpoint', placeHolder: 'Choose the server type' });
  if (!type) return;

  const existing = getOpenAICompatibleConfig().endpoints;
  const baseURL = await vscode.window.showInputBox({
    title: `${type.label}: Server URL`,
    prompt: 'Base URL of the OpenAI-compatible API, usually ending in /v1',
    value: ENDPOINT_PRESETS[type.value].baseURL,
    ignoreFocusOut: true,
    validateInput: validateBaseURL
  });
  if (!baseURL) return;

  const name = await vscode.window.showInputBox({
    title: `${type.label}: Name`,
    prompt: 'Name shown next to the models in the model picker',
    value: uniqueName(type.label, existing),
    ignoreFocusOut: true,
    validateInput: (value) => !value.trim()
      ? 'Enter a name.'
      : existing.some((entry) => entry.name === value.trim()) ? 'An endpoint with this name already exists.' : undefined
  });
  if (!name) return;

  const entry = { name: name.trim(), type: type.value, baseURL: baseURL.trim().replace(/\/+$/, '') };
  const configuration = vscode.workspace.getConfiguration(OPENAI_COMPATIBLE_SECTION);
  const current = configuration.inspect<unknown[]>('endpoints')?.globalValue ?? [];
  await configuration.update('endpoints', [...current, entry], vscode.ConfigurationTarget.Global);

  const endpoint = getOpenAICompatibleConfig().endpoints.find((value) => value.name === entry.name);
  if (!endpoint) return;
  await promptForToken(provider, endpoint, true);
  await testConnection(provider, [endpoint]);
}

async function removeEndpoint(provider: OpenAICompatibleModelProvider): Promise<void> {
  const endpoint = await pickEndpoint('Remove Endpoint');
  if (!endpoint) return;
  const configuration = vscode.workspace.getConfiguration(OPENAI_COMPATIBLE_SECTION);
  const current = configuration.inspect<unknown[]>('endpoints')?.globalValue ?? [];
  const next = current.filter((value) => !(typeof value === 'object' && value !== null
    && (value as { name?: unknown }).name === endpoint.name));
  if (next.length === current.length) {
    vscode.window.showWarningMessage(`${endpoint.name} is not defined in your user settings; remove it from the settings file that defines it.`);
    return;
  }
  await configuration.update('endpoints', next, vscode.ConfigurationTarget.Global);
  // Tokens are keyed by URL, so keep it while another endpoint still uses the same server.
  if (!getOpenAICompatibleConfig().endpoints.some((entry) => entry.baseURL === endpoint.baseURL)) {
    await provider.clearApiToken(endpoint);
  }
  vscode.window.showInformationMessage(`${endpoint.name} removed.`);
}

async function promptForToken(provider: OpenAICompatibleModelProvider, endpoint: EndpointConfig, optional = false): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: `${endpoint.name}: API Token`,
    prompt: optional
      ? 'Optional API key or bearer token. Leave empty if the server needs none.'
      : 'API key or bearer token for this server',
    password: true,
    ignoreFocusOut: true
  });
  if (!token?.trim()) return false;
  await provider.setApiToken(endpoint, token.trim());
  if (isInsecureRemoteURL(endpoint.baseURL)) {
    void vscode.window.showWarningMessage(INSECURE_TOKEN_WARNING);
  }
  return true;
}

async function pickEndpoint(title: string): Promise<EndpointConfig | undefined> {
  const endpoints = getOpenAICompatibleConfig().endpoints;
  if (endpoints.length === 0) {
    const action = await vscode.window.showInformationMessage('No OpenAI-compatible endpoints are configured.', 'Add Endpoint');
    if (action === 'Add Endpoint') await vscode.commands.executeCommand('modelBridge.openaiCompatible.addEndpoint');
    return undefined;
  }
  if (endpoints.length === 1) return endpoints[0];
  const selection = await vscode.window.showQuickPick(endpoints.map((endpoint) => ({
    label: endpoint.name,
    description: `${ENDPOINT_PRESETS[endpoint.type].label} · ${endpoint.baseURL}`,
    endpoint
  })), { title, placeHolder: 'Choose an endpoint' });
  return selection?.endpoint;
}

async function testConnection(provider: OpenAICompatibleModelProvider, endpoints?: EndpointConfig[]): Promise<void> {
  if ((endpoints ?? getOpenAICompatibleConfig().endpoints).length === 0) {
    await pickEndpoint('Test Connection');
    return;
  }
  const statuses = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing OpenAI-compatible endpoints…' },
    () => provider.getStatus(endpoints)
  );
  provider.refresh();
  const failed = statuses.filter((status) => !status.reachable);
  const summary = statuses.map((status) => status.reachable
    ? `${status.name}: ${status.models.length} model${status.models.length === 1 ? '' : 's'}`
    : `${status.name}: ${status.error}`).join('; ');
  if (failed.length > 0) {
    vscode.window.showErrorMessage(`Connection test failed. ${summary}`);
  } else {
    vscode.window.showInformationMessage(`Connection test passed. ${summary}`);
  }
}

async function runDoctor(provider: OpenAICompatibleModelProvider): Promise<void> {
  const config = getOpenAICompatibleConfig();
  const statuses = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking OpenAI-compatible endpoints…' },
    () => provider.getStatus(config.endpoints)
  );
  const lines = ['Model Bridge: OpenAI-Compatible Doctor', `Endpoints: ${config.endpoints.length}`];
  if (config.invalidEndpoints.length > 0) {
    lines.push(`Skipped invalid endpoints: ${config.invalidEndpoints.join(', ')} (each needs a unique name and an http(s) baseURL)`);
  }
  for (const status of statuses) {
    lines.push('', `${status.name} — ${ENDPOINT_PRESETS[status.type].label}`, `Server: ${status.baseURL}`);
    if (isInsecureRemoteURL(status.baseURL)) {
      lines.push('Warning: plain HTTP to a non-local host; requests and any API token are unencrypted.');
    }
    lines.push(`API token: ${status.hasToken ? 'set' : 'not set'}`, `Reachable: ${status.reachable ? 'yes' : 'no'}`);
    if (!status.reachable) {
      lines.push(`Problem: ${status.error ?? 'unknown error'}`);
      continue;
    }
    lines.push(`Models: ${status.models.length}`);
    for (const model of status.models.slice(0, 20)) {
      const flags = [
        `${formatTokenCount(model.contextLength)} context`,
        model.toolCalling ? 'tools' : 'no tools',
        ...(model.vision ? ['vision'] : []),
        ...(model.reasoning ? ['reasoning'] : []),
        ...(model.loaded ? ['loaded'] : [])
      ];
      lines.push(`- ${model.id}: ${flags.join(', ')}`);
    }
    if (status.models.length > 20) lines.push(`- … ${status.models.length - 20} more`);
    const withoutTools = status.models.filter((model) => !model.toolCalling).length;
    if (withoutTools > 0) {
      lines.push(`Note: ${withoutTools} model${withoutTools === 1 ? ' is' : 's are'} not offered to Agent mode because the server does not report tool support. Set "toolCalling": true on the endpoint if the server supports tools (vLLM needs --enable-auto-tool-choice, llama.cpp needs --jinja).`);
    }
  }
  lines.push('', statuses.length > 0 && statuses.every((status) => status.reachable) ? 'Result: ready' : 'Result: needs attention');
  await showDoctorReport(lines, {
    logsCommand: 'modelBridge.openaiCompatible.openLogs',
    extraActions: [
      { label: 'Add Endpoint', command: 'modelBridge.openaiCompatible.addEndpoint' },
      { label: 'Open Settings', command: 'modelBridge.openaiCompatible.openSettings' }
    ]
  });
}

function validateBaseURL(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && url.hostname ? undefined : 'Enter an http:// or https:// URL.';
  } catch {
    return 'Enter an http:// or https:// URL.';
  }
}

function uniqueName(base: string, existing: readonly EndpointConfig[]): string {
  let name = base;
  for (let index = 2; existing.some((entry) => entry.name === name); index += 1) {
    name = `${base} ${index}`;
  }
  return name;
}

