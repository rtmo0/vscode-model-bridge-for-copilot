import * as vscode from 'vscode';

// Settings from the extensions this one replaced. Secrets cannot be migrated because
// SecretStorage is scoped to the extension ID, so users sign in again after upgrading.
const LEGACY_SECTIONS: ReadonlyArray<{ legacy: string; current: string }> = [
  { legacy: 'anthropicForCopilot', current: 'modelBridge.claude' },
  { legacy: 'codexModelProvider', current: 'modelBridge.codex' }
];
const MIGRATION_STATE_KEY = 'modelBridge.legacySettingsMigrated';

export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<number> {
  const keys = getContributedSettingKeys(context);
  let migrated = 0;
  if (context.globalState.get<boolean>(MIGRATION_STATE_KEY) !== true) {
    migrated += await migrateTarget(keys, vscode.ConfigurationTarget.Global);
    await context.globalState.update(MIGRATION_STATE_KEY, true);
  }
  if (vscode.workspace.workspaceFolders?.length && context.workspaceState.get<boolean>(MIGRATION_STATE_KEY) !== true) {
    migrated += await migrateTarget(keys, vscode.ConfigurationTarget.Workspace);
    await context.workspaceState.update(MIGRATION_STATE_KEY, true);
  }
  return migrated;
}

async function migrateTarget(keys: readonly string[], target: vscode.ConfigurationTarget): Promise<number> {
  const configuration = vscode.workspace.getConfiguration();
  let migrated = 0;
  for (const { legacy, current } of LEGACY_SECTIONS) {
    for (const key of keys) {
      if (!key.startsWith(`${current}.`)) continue;
      const legacyKey = `${legacy}.${key.slice(current.length + 1)}`;
      const legacyValue = readTargetValue(configuration.inspect(legacyKey), target);
      if (legacyValue === undefined || readTargetValue(configuration.inspect(key), target) !== undefined) continue;
      await configuration.update(key, legacyValue, target);
      migrated += 1;
    }
  }
  return migrated;
}

function readTargetValue(
  inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']>,
  target: vscode.ConfigurationTarget
): unknown {
  return target === vscode.ConfigurationTarget.Global ? inspected?.globalValue : inspected?.workspaceValue;
}

function getContributedSettingKeys(context: vscode.ExtensionContext): string[] {
  const properties = context.extension.packageJSON?.contributes?.configuration?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties) : [];
}
