import * as vscode from 'vscode';

export interface ManagementMenuAction {
  icon: string;
  label: string;
  command: string;
  description?: string;
}

export interface ManagementMenuSection {
  label: string;
  actions: readonly ManagementMenuAction[];
}

export const SUPPORT_URL = 'https://buymeacoffee.com/rtmo0';

const SUPPORT_SECTION: ManagementMenuSection = {
  label: 'Support',
  actions: [{ icon: 'heart', label: 'Support the Project', description: 'Buy Me a Coffee', command: 'modelBridge.support' }]
};

/** Shared provider "Manage" picker so Claude, Codex, and LM Studio menus look and behave the same. */
export async function showManagementMenu(title: string, sections: readonly ManagementMenuSection[]): Promise<void> {
  type Item = vscode.QuickPickItem & { command?: string };
  const items: Item[] = [...sections, SUPPORT_SECTION].flatMap((section) => [
    { label: section.label, kind: vscode.QuickPickItemKind.Separator },
    ...section.actions.map((action) => ({
      label: `$(${action.icon}) ${action.label}`,
      description: action.description,
      command: action.command
    }))
  ]);
  const selection = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose an action' });
  if (selection?.command) {
    await vscode.commands.executeCommand(selection.command);
  }
}

/** Shared Doctor presentation: modal-free report with copy and logs actions. */
export async function showDoctorReport(
  lines: readonly string[],
  options: { logsCommand: string; extraActions?: ReadonlyArray<{ label: string; command: string }> }
): Promise<void> {
  const report = lines.join('\n');
  const extra = options.extraActions ?? [];
  const action = await vscode.window.showInformationMessage(report, 'Copy Report', 'Open Logs', ...extra.map((entry) => entry.label));
  if (action === 'Copy Report') {
    await vscode.env.clipboard.writeText(report);
    vscode.window.showInformationMessage('Diagnostic report copied. It contains no prompts or credentials.');
  } else if (action === 'Open Logs') {
    await vscode.commands.executeCommand(options.logsCommand);
  } else {
    const command = extra.find((entry) => entry.label === action)?.command;
    if (command) await vscode.commands.executeCommand(command);
  }
}
