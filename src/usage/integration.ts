import * as vscode from 'vscode';
import { UsageLedger } from './usageLedger';
import { createUsageRecorder, USAGE_SECTION, type UsageRecorder } from './usageRecorder';
import { clearUsage, exportCsv, UsageReportPanel } from './usageReportPanel';

export function activateUsage(context: vscode.ExtensionContext): UsageRecorder {
  const ledger = new UsageLedger(
    vscode.Uri.joinPath(context.globalStorageUri, 'usage').fsPath,
    () => readRetentionDays()
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('modelBridge.usage.showReport', () => UsageReportPanel.show(context, ledger)),
    vscode.commands.registerCommand('modelBridge.usage.exportCsv', () => exportCsv(ledger)),
    vscode.commands.registerCommand('modelBridge.usage.clear', () => clearUsage(ledger))
  );
  void ledger.prune();
  return createUsageRecorder(context, ledger, () => UsageReportPanel.notifyRecorded());
}

function readRetentionDays(): number {
  const value = vscode.workspace.getConfiguration(USAGE_SECTION).get<number>('retentionDays', 90);
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(365, Math.max(1, Math.floor(value))) : 90;
}
