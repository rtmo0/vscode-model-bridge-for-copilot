import * as vscode from 'vscode';
import { showDoctorReport, showManagementMenu } from '../managementMenu';
import { formatTokenCount } from '../openaiCompatible/chatCompletions';
import type { ProviderRegistry } from '../registry';
import { ComboModelProvider, COMBOS_SETTING } from './provider';

export function activateCombos(context: vscode.ExtensionContext, registry: ProviderRegistry): ComboModelProvider {
  const output = vscode.window.createOutputChannel('Model Bridge: Combos', { log: true });
  const provider = new ComboModelProvider(registry, output);
  output.info('Model Bridge: Combos activated', { providers: [...registry.keys()] });
  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider('model-bridge-combos', provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(COMBOS_SETTING)) provider.refresh();
    }),
    vscode.commands.registerCommand('modelBridge.combos.openLogs', () => output.show(true)),
    vscode.commands.registerCommand('modelBridge.combos.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', COMBOS_SETTING)
    )),
    vscode.commands.registerCommand('modelBridge.combos.refreshModels', () => {
      provider.refresh();
      vscode.window.showInformationMessage('Combo models refreshed.');
    }),
    vscode.commands.registerCommand('modelBridge.combos.doctor', () => runDoctor(provider)),
    vscode.commands.registerCommand('modelBridge.combos.manage', () => showManagementMenu('Model Bridge: Combos', [
      { label: 'Combos', actions: [
        { icon: 'edit', label: 'Edit Combos', description: COMBOS_SETTING, command: 'modelBridge.combos.openSettings' },
        { icon: 'refresh', label: 'Refresh Models', command: 'modelBridge.combos.refreshModels' }
      ] },
      { label: 'Diagnostics', actions: [
        { icon: 'wrench', label: 'Run Doctor', command: 'modelBridge.combos.doctor' },
        { icon: 'output', label: 'Open Logs', command: 'modelBridge.combos.openLogs' }
      ] }
    ]))
  );
  return provider;
}

async function runDoctor(provider: ComboModelProvider): Promise<void> {
  const { statuses, invalid } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking combos…' },
    () => provider.getStatus()
  );
  const lines = ['Model Bridge: Combos Doctor', `Combos: ${statuses.length}`];
  if (invalid.length > 0) {
    lines.push(`Skipped invalid entries: ${invalid.join('; ')}`);
  }
  for (const status of statuses) {
    lines.push('', `${status.name} — ${status.strategy}`);
    for (const target of status.targets) {
      const state = target.problem
        ? `not used: ${target.problem}`
        : target.cooldown
          ? `${target.model} · cooling down for ${formatDuration(target.cooldown.remainingMs)} after ${target.cooldown.reason}`
          : target.exhaustedForMs !== undefined
            ? `${target.model} · account limit reached, tried last for ${formatDuration(target.exhaustedForMs)}`
            : `${target.model} · ready`;
      lines.push(`- ${target.role ? `${target.role} ` : ''}${target.label}: ${state}`);
    }
    if (status.available) {
      lines.push(`Window: ${formatTokenCount(status.maxInputTokens ?? 0)} input, ${formatTokenCount(status.maxOutputTokens ?? 0)} output`
        + ` · ${status.toolCalling ? 'tools' : 'no tools (a target lacks tool calling, so Agent mode is off)'}${status.imageInput ? ' · vision' : ''}`);
    } else {
      lines.push('Not shown in the model picker: no target is available.');
    }
    if (status.strategy === 'planExecute' && status.targets.some((target) => target.role === 'planner' && target.problem)) {
      lines.push('Without its planner the combo runs the executor alone.');
    }
  }
  if (statuses.length === 0 && invalid.length === 0) {
    lines.push(`Add combos to ${COMBOS_SETTING}, for example { "name": "Coding", "targets": ["claude:opus", "codex:gpt-5.5"] }`
      + ' or { "name": "Cheap agent", "strategy": "planExecute", "planner": "claude:opus", "executor": "deepseek:deepseek-flash" }.');
  }
  lines.push('', statuses.length > 0 && statuses.every((status) => status.available && status.targets.every((target) => !target.problem))
    ? 'Result: ready'
    : 'Result: needs attention');
  await showDoctorReport(lines, {
    logsCommand: 'modelBridge.combos.openLogs',
    extraActions: [{ label: 'Edit Combos', command: 'modelBridge.combos.openSettings' }]
  });
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}
