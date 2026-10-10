import * as vscode from 'vscode';
import { CodexAccountUsageStatusBar } from './accountUsageStatusBar';
import { CodexModelProvider } from './provider';
import { CodexAuthLock } from './auth/codexAuthLock';
import { CodexAuthManager } from './auth/codexAuthManager';
import { CodexAuthenticationProvider, CODEX_AUTHENTICATION_PROVIDER_ID } from './auth/codexAuthenticationProvider';
import { CodexSecretStore } from './auth/codexSecretStore';
import { createCodexLogger } from './codexLogger';
import { getProviderConfig } from './config';
import {
  enableNativeToolSearchGroupingBridge,
  getNativeToolGroupingBridgeStatus,
  migrateNativeToolSearchOptIn,
  restoreVSCodeToolGrouping
} from './nativeToolSearch/nativeToolGroupingBridge';
import { getNativeToolSearchRuntimeStatus } from './nativeToolSearch/nativeToolSearchStatus';
import { getLastEffectiveCodexProtocol } from './codexProtocol';
import { CodexIdentityManager } from './codexIdentity';
import { registerWebSearchTool } from './hostedTools/webSearchTool';
import { showDoctorReport, showManagementMenu } from '../managementMenu';

export async function activateCodex(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Model Bridge: Codex', { log: true });
  const logger = createCodexLogger(outputChannel, 'extension');
  logger.info('extension.activated', {
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    architecture: process.arch,
    logLevel: outputChannel.logLevel
  });
  try {
    if (await migrateNativeToolSearchOptIn(context)) {
      logger.info('native-tool-search.opt-in-migrated', { policy: 'auto' });
    }
  } catch (error) {
    logger.warn('native-tool-search.opt-in-migration-failed', { error });
    void vscode.window.showWarningMessage(
      'Native Tool Search was previously enabled, but its opt-in setting could not be migrated. Run Codex: Enable Native Tool Search to try again.'
    );
  }
  const config = getProviderConfig();
  logger.debug('configuration.loaded', {
    baseURL: config.baseURL,
    credentialsSource: config.credentialsSource,
    transport: config.transport,
    websocketPrewarm: config.websocketPrewarm,
    requestCompression: config.requestCompression,
    model: config.model,
    includeHiddenModels: config.includeHiddenModels,
    defaultServiceTier: config.defaultServiceTier ?? 'auto',
    defaultReasoningEffort: config.defaultReasoningEffort ?? 'auto'
  });
  void vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const authManager = new CodexAuthManager(
    new CodexSecretStore(context.secrets),
    (accountKey) => new CodexAuthLock(vscode.Uri.joinPath(context.globalStorageUri, `codex-auth-refresh.${sanitizeLockKey(accountKey)}.lock`)),
    undefined,
    logger.child('auth')
  );
  const authenticationProvider = new CodexAuthenticationProvider(authManager);
  const accountUsageStatusBar = new CodexAccountUsageStatusBar(context, logger.child('account-usage'), authManager);
  const provider = new CodexModelProvider(context, logger.child('provider'), accountUsageStatusBar, accountUsageStatusBar, accountUsageStatusBar, authManager);
  const webSearchIdentityManager = new CodexIdentityManager(context.globalState);

  context.subscriptions.push(authManager, authManager.onDidChangeAuth((event) => {
    logger.child('auth').info('auth.changed', { reason: event.reason, accountKey: event.accountKey });
    provider.handleAuthenticationChanged();
    void accountUsageStatusBar.refresh();
  }));

  context.subscriptions.push(
    outputChannel,
    authenticationProvider,
    accountUsageStatusBar,
    vscode.authentication.registerAuthenticationProvider(
      CODEX_AUTHENTICATION_PROVIDER_ID,
      'Model Bridge: Codex',
      authenticationProvider,
      { supportsMultipleAccounts: true }
    ),
    registerWebSearchTool({
      context,
      authManager,
      createIdentity: () => webSearchIdentityManager.createThread()
    }),
    vscode.lm.registerLanguageModelChatProvider('model-bridge-codex', provider),
    vscode.commands.registerCommand('modelBridge.codex.openDebugLogs', () => {
      logger.debug('command.open-logs');
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand('modelBridge.codex.openSettings', () => {
      return vscode.commands.executeCommand('workbench.action.openSettings', 'modelBridge.codex');
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.signOut', async () => {
      const accounts = await authManager.listAccounts();
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('No Codex accounts are signed in.');
        return;
      }
      await authManager.signOutAll();
      logger.child('command').info('auth.sign-out.completed', { count: accounts.length });
      vscode.window.showInformationMessage(accounts.length > 1 ? `Signed out of all ${accounts.length} Codex accounts.` : 'Codex credentials removed.');
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.signInWithBrowser', async () => {
      try {
        await authManager.signInWithBrowser();
        vscode.window.showInformationMessage('Signed in with ChatGPT.');
      } catch (error) {
        logger.child('command').error('auth.sign-in.failed', error);
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ChatGPT sign-in failed.');
      }
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.showStatus', async () => {
      const status = await authManager.getStatus();
      if (!status.authenticated) {
        vscode.window.showInformationMessage('Not signed in. Use “Model Bridge: Codex: Sign in with Browser”.');
        return;
      }
      const accounts = await authManager.listAccounts();
      const details = [
        'Connection: ready',
        status.email ? `Email: ${status.email}` : undefined,
        accounts.length > 1 ? `Accounts: ${accounts.length}` : undefined,
        status.accountId ? `Account: ${status.accountId}` : undefined,
        status.accessTokenExpiresAt ? `Access token expires: ${new Date(status.accessTokenExpiresAt).toLocaleString()}` : undefined,
        status.lastRefresh ? `Last refresh: ${status.lastRefresh}` : undefined
      ].filter(Boolean).join('\n');
      const action = await vscode.window.showInformationMessage(details, 'Test Connection');
      if (action === 'Test Connection') {
        provider.handleAuthenticationChanged();
        await accountUsageStatusBar.refresh();
        vscode.window.showInformationMessage('Codex connection test passed: authentication refreshed and account usage loaded.');
      }
    }),
    vscode.commands.registerCommand('modelBridge.codex.testConnection', async () => {
      const status = await authManager.getStatus();
      if (!status.authenticated) {
        const action = await vscode.window.showWarningMessage('Codex is not signed in.', 'Sign in with Browser');
        if (action === 'Sign in with Browser') {
          await vscode.commands.executeCommand('modelBridge.codex.auth.signInWithBrowser');
        }
        return;
      }
      try {
        await authManager.getCredentialSnapshot(status.accountKey);
        provider.handleAuthenticationChanged();
        await accountUsageStatusBar.refresh();
        vscode.window.showInformationMessage('Codex connection test passed. Models and account usage were refreshed.');
      } catch (error) {
        logger.child('command').error('connection-test.failed', error);
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Codex connection test failed.');
      }
    }),
    vscode.commands.registerCommand('modelBridge.codex.refreshAccountLimits', async () => {
      await accountUsageStatusBar.refresh();
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('modelBridge.codex.showAccountLimits', async () => {
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('modelBridge.codex.enableNativeToolSearch', () => enableNativeToolSearchGroupingBridge(context)),
    vscode.commands.registerCommand('modelBridge.codex.restoreVSCodeToolGrouping', () => restoreVSCodeToolGrouping(context)),
    vscode.commands.registerCommand('modelBridge.codex.showNativeToolSearchStatus', async () => {
      const runtime = getNativeToolSearchRuntimeStatus();
      const bridge = await getNativeToolGroupingBridgeStatus(context);
      const status = {
        setting: getProviderConfig().nativeToolSearch,
        bridge,
        runtime: runtime ?? null
      };
      logger.info('native-tool-search.status', status);
      const runtimeSummary = status.setting === 'disabled'
        ? 'Native Tool Search is disabled.'
        : runtime
        ? `${runtime.mode === 'native-hosted' ? 'Active' : 'Fallback'}: ${formatNativeToolSearchReason(runtime.reason)}; ${runtime.selectedToolCount} selected, ${runtime.deferredToolCount} deferred, ${runtime.deferredToolSchemaBytes} deferred schema bytes.`
        : 'No Agent request has run since this extension activated.';
      const discoverySummary = status.setting === 'disabled'
        ? 'Tool discovery: VS Code Virtual Tool Groups (default).'
        : bridge.enabledByThisExtension
          ? `Tool discovery: Codex Native Tool Search; VS Code Virtual Tool Groups are temporarily disabled (threshold ${formatSettingValue(bridge.effectiveThreshold)}).`
          : `Native Tool Search policy: ${status.setting}; VS Code Virtual Tool Groups were not disabled by this extension.`;
      const action = await vscode.window.showInformationMessage(
        `${discoverySummary} ${runtimeSummary}`,
        'Open Debug Logs',
        'Open Settings'
      );
      if (action === 'Open Debug Logs') {
        outputChannel.show(true);
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'modelBridge.codex.nativeToolSearch');
      }
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.switchAccount', async () => {
      const picked = await pickAccount(authManager, 'Switch Codex Account', 'Choose which account new chat requests use.');
      if (!picked) return;
      await authManager.switchAccount(picked.accountKey);
      logger.child('command').info('auth.switched', { accountKey: picked.accountKey });
      vscode.window.showInformationMessage(`Active Codex account switched to ${accountDisplayName(picked)}.`);
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.removeAccount', async () => {
      const picked = await pickAccount(authManager, 'Remove Codex Account', 'Choose an account to remove (its credentials will be deleted).');
      if (!picked) return;
      const label = accountDisplayName(picked);
      const confirm = await vscode.window.showWarningMessage(`Remove Codex account ${label}?`, { modal: true }, 'Remove');
      if (confirm !== 'Remove') return;
      await authManager.signOut(picked.accountKey);
      logger.child('command').info('auth.removed', { accountKey: picked.accountKey });
      vscode.window.showInformationMessage(`Codex account ${label} removed.`);
    }),
    vscode.commands.registerCommand('modelBridge.codex.auth.addAccount', async () => {
      try {
        const accountKey = await authManager.signInWithBrowser();
        await authManager.switchAccount(accountKey);
        const status = await authManager.getStatus(accountKey);
        vscode.window.showInformationMessage(`Added Codex account${status.email ? ` ${status.email}` : ''} and set it active.`);
      } catch (error) {
        logger.child('command').error('auth.add-account.failed', error);
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Adding a Codex account failed.');
      }
    }),
    vscode.commands.registerCommand('modelBridge.codex.showEffectiveProtocol', () => {
      const diagnostic = getLastEffectiveCodexProtocol();
      if (!diagnostic) {
        void vscode.window.showInformationMessage('No Codex-compatible request has run since this extension activated.');
        return;
      }
      logger.info('protocol.effective', { ...diagnostic });
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand('modelBridge.codex.doctor', () => runCodexDoctor(context, authManager, accountUsageStatusBar)),
    vscode.commands.registerCommand('modelBridge.codex.manage', () => showManagementMenu('Model Bridge: Codex', [
      { label: 'Account', actions: [
        { icon: 'browser', label: 'Sign in with Browser', command: 'modelBridge.codex.auth.signInWithBrowser' },
        { icon: 'person-add', label: 'Add Account in Browser', command: 'modelBridge.codex.auth.addAccount' },
        { icon: 'arrow-swap', label: 'Switch Account', command: 'modelBridge.codex.auth.switchAccount' },
        { icon: 'trash', label: 'Remove Account', command: 'modelBridge.codex.auth.removeAccount' },
        { icon: 'account', label: 'Show Sign-In Status', command: 'modelBridge.codex.auth.showStatus' },
        { icon: 'sign-out', label: 'Sign Out (All Accounts)', command: 'modelBridge.codex.auth.signOut' }
      ] },
      { label: 'Usage', actions: [
        { icon: 'pulse', label: 'Show Account Limits', command: 'modelBridge.codex.showAccountLimits' },
        { icon: 'sync', label: 'Refresh Account Limits', command: 'modelBridge.codex.refreshAccountLimits' }
      ] },
      { label: 'Tools', actions: [
        { icon: 'search', label: 'Enable Native Tool Search', command: 'modelBridge.codex.enableNativeToolSearch' },
        { icon: 'list-tree', label: 'Use VS Code Virtual Tool Groups', command: 'modelBridge.codex.restoreVSCodeToolGrouping' },
        { icon: 'info', label: 'Show Native Tool Search Status', command: 'modelBridge.codex.showNativeToolSearchStatus' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'debug-start', label: 'Test Connection', command: 'modelBridge.codex.testConnection' },
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.codex.doctor' },
        { icon: 'symbol-interface', label: 'Show Effective Protocol', command: 'modelBridge.codex.showEffectiveProtocol' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.codex.openDebugLogs' },
        { icon: 'gear', label: 'Open Settings', command: 'modelBridge.codex.openSettings' }
      ] }
    ]))
  );
  void authManager.startPeriodicRefresh();
}



async function runCodexDoctor(
  context: vscode.ExtensionContext,
  authManager: CodexAuthManager,
  accountUsageStatusBar: CodexAccountUsageStatusBar
): Promise<void> {
  const config = getProviderConfig();
  const [status, accounts] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Model Bridge: Codex…' },
    () => Promise.all([authManager.getStatus(), authManager.listAccounts()])
  );
  const protocol = getLastEffectiveCodexProtocol();
  await showDoctorReport([
    'Model Bridge: Codex Doctor',
    `Extension: ${context.extension.packageJSON.version}`,
    `VS Code: ${vscode.version}`,
    `Host: ${process.platform} ${process.arch}${vscode.env.remoteName ? ` (${vscode.env.remoteName})` : ''}`,
    `Signed in: ${status.authenticated ? 'yes' : 'no'}`,
    `Accounts: ${accounts.length}`,
    `Re-authentication required: ${accounts.some((account) => account.reauthRequired) ? 'yes' : 'no'}`,
    status.accessTokenExpiresAt ? `Access token expires: ${new Date(status.accessTokenExpiresAt).toLocaleString()}` : 'Access token expires: unknown',
    `Account limits: ${accountUsageStatusBar.getCompactText() ?? 'not loaded'}`,
    `Backend: ${config.baseURL}`,
    `Transport: ${config.transport}`,
    `Protocol profile: ${config.protocol.profile}`,
    `Native Tool Search: ${config.nativeToolSearch}`,
    `Last request protocol: ${protocol ? 'recorded' : 'none since activation'}`,
    status.authenticated ? 'Result: ready' : 'Problem: Codex is not signed in. Run “Model Bridge: Codex: Sign in with Browser”.'
  ], {
    logsCommand: 'modelBridge.codex.openDebugLogs',
    extraActions: status.authenticated ? [] : [{ label: 'Sign in with Browser', command: 'modelBridge.codex.auth.signInWithBrowser' }]
  });
}

function formatNativeToolSearchReason(reason: string): string {
  switch (reason) {
    case 'native-enabled': return 'native hosted Tool Search is active';
    case 'compatibility-disabled': return 'Codex compatibility is unavailable for this endpoint';
    case 'disabled-by-setting': return 'disabled in Settings';
    case 'backend-unsupported': return 'the model or endpoint rejected Tool Search recently';
    case 'backend-rejected': return 'the backend rejected Tool Search and this request retried with legacy tools';
    case 'virtual-tools-active': return 'VS Code supplied Virtual Tool placeholders';
    case 'auto-tool-count-below-threshold': return 'the selected tool count is below the automatic threshold';
    case 'auto-deferred-schema-small': return 'the deferred schemas are too small for automatic Tool Search';
    default: return reason;
  }
}

function formatSettingValue(value: unknown): string {
  return value === undefined ? 'default' : String(value);
}

function sanitizeLockKey(accountKey: string): string {
  return accountKey.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function pickAccount(
  authManager: CodexAuthManager,
  title: string,
  placeHolder: string
): Promise<{ accountKey: string; email?: string; source: 'extensionOAuth' | 'importedAuthJson' | 'legacyCodexFile'; isActive: boolean } | undefined> {
  const accounts = await authManager.listAccounts();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage('No Codex accounts are configured. Use "Add Codex Account" to sign in.');
    return undefined;
  }
  const items = accounts.map((account) => ({
    label: `${account.isActive ? '$(check) ' : ''}${accountDisplayName(account)}`,
    description: account.isActive ? 'Active browser sign-in' : 'Browser sign-in',
    detail: [workspaceLabel(account.accountId), account.reauthRequired ? 'Re-authentication required' : undefined].filter(Boolean).join(' · ') || undefined,
    account
  }));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, matchOnDescription: true });
  return picked?.account;
}

function accountDisplayName(account: { email?: string }): string {
  return account.email ?? 'ChatGPT account';
}

function workspaceLabel(accountId: string | undefined): string | undefined {
  const normalized = accountId?.trim();
  return normalized ? `Workspace ${normalized.slice(0, 8)}` : undefined;
}
