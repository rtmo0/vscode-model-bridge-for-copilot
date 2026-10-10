import * as vscode from 'vscode';
import type { CodexAuthManager } from './auth/codexAuthManager';

export const DEFAULT_USER_AGENT = 'local.model-bridge-for-copilot Model Bridge: Codex';

export interface ApiCredentials {
  apiKey: string;
  headers: Record<string, string>;
  source: 'codexAuth';
  authManager?: CodexAuthManager;
  /** Codex account the credentials belong to (SecretStore account key). */
  accountKey?: string;
  kind: 'codexAccessToken' | 'openaiApiKey';
  omitMaxOutputTokens: boolean;
}

export async function getApiCredentials(_context: vscode.ExtensionContext, authManager?: CodexAuthManager): Promise<ApiCredentials | undefined> {
  return readCodexAuthCredentials(authManager);
}

async function readCodexAuthCredentials(authManager?: CodexAuthManager): Promise<ApiCredentials | undefined> {
  if (authManager) {
    try {
      const snapshot = await authManager.getCredentialSnapshot();
      const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
      if (snapshot.accountId?.trim()) {
        headers['ChatGPT-Account-ID'] = snapshot.accountId.trim();
      }
      return {
        apiKey: snapshot.accessToken,
        headers,
        source: 'codexAuth',
        authManager,
        accountKey: snapshot.accountKey,
        kind: 'codexAccessToken',
        omitMaxOutputTokens: true
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build Codex access-token credentials for one account, refreshing that account's token if needed. */
export async function getCodexCredentialsForAccount(authManager: CodexAuthManager, accountKey: string, refresh = true): Promise<ApiCredentials | undefined> {
  try {
    const snapshot = refresh
      ? await authManager.getCredentialSnapshot(accountKey)
      : await authManager.getStoredCredentialSnapshot(accountKey);
    const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
    if (snapshot.accountId?.trim()) {
      headers['ChatGPT-Account-ID'] = snapshot.accountId.trim();
    }
    return {
      apiKey: snapshot.accessToken,
      headers,
      source: 'codexAuth',
      ...(refresh ? { authManager } : {}),
      accountKey,
      kind: 'codexAccessToken',
      omitMaxOutputTokens: true
    };
  } catch {
    return undefined;
  }
}
