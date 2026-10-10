import * as vscode from 'vscode';
import type { ClaudeUsageUpdate } from './claudeProtocol';

const STORAGE_KEY = 'anthropicForCopilot.usageSnapshot';

interface PersistedClaudeUsage extends ClaudeUsageUpdate {
  updatedAt: number;
  account?: string;
}

export class ClaudeUsageStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private snapshot?: PersistedClaudeUsage;
  private account?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item.name = 'Claude Account Usage';
    this.item.command = 'anthropicForCopilot.showUsage';
    this.snapshot = context.globalState.get<PersistedClaudeUsage>(STORAGE_KEY);
    this.account = this.snapshot?.account;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  refresh(): void {
    this.render();
  }

  clear(): void {
    this.snapshot = undefined;
    this.account = undefined;
    void this.context.globalState.update(STORAGE_KEY, undefined);
    this.render();
  }

  setAccount(account: string | undefined): void {
    this.account = account;
    if (this.snapshot && account !== this.snapshot.account) {
      this.snapshot = { ...this.snapshot, account };
      void this.context.globalState.update(STORAGE_KEY, this.snapshot);
    }
    this.render();
  }

  record(update: ClaudeUsageUpdate): void {
    const previous = this.snapshot;
    this.snapshot = {
      ...(previous ?? { updatedAt: Date.now() }),
      ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
      updatedAt: Date.now(),
      ...(this.account ? { account: this.account } : {})
    };
    void this.context.globalState.update(STORAGE_KEY, this.snapshot);
    this.render();
  }

  async showDetails(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      await vscode.window.showInformationMessage(
        'Claude usage has not been received yet. Send a request with a Claude model to load account limits.'
      );
      return;
    }

    const lines = [
      snapshot.account ? `Account: ${snapshot.account}` : undefined,
      snapshot.model ? `Model: ${snapshot.model}` : undefined,
      formatWindowDetails('5-hour window', snapshot.fiveHour),
      formatWindowDetails('7-day window', snapshot.sevenDay),
      snapshot.inputTokens !== undefined ? `Latest uncached input: ${formatTokens(snapshot.inputTokens)}` : undefined,
      snapshot.cacheReadInputTokens !== undefined ? `Latest cache read: ${formatTokens(snapshot.cacheReadInputTokens)}` : undefined,
      snapshot.cacheCreationInputTokens !== undefined ? `Latest cache write: ${formatTokens(snapshot.cacheCreationInputTokens)}` : undefined,
      snapshot.outputTokens !== undefined ? `Latest output: ${formatTokens(snapshot.outputTokens)}` : undefined,
      snapshot.thinkingTokens !== undefined ? `Latest thinking: ${formatTokens(snapshot.thinkingTokens)}` : undefined,
      snapshot.contextWindow !== undefined ? `Model context: ${formatTokens(snapshot.contextWindow)}` : undefined,
      snapshot.totalCostUsd !== undefined ? `Latest API-equivalent cost: ${formatUsd(snapshot.totalCostUsd)}` : undefined,
      snapshot.isUsingOverage ? 'Usage credits: active' : undefined,
      `Updated: ${new Date(snapshot.updatedAt).toLocaleString()}`
    ].filter((line): line is string => Boolean(line));
    await vscode.window.showInformationMessage(lines.join('\n'));
  }

  private render(): void {
    if (!vscode.workspace.getConfiguration('anthropicForCopilot').get('usageStatusBar', true)) {
      this.item.hide();
      return;
    }

    const snapshot = this.snapshot;
    const compact = [
      snapshot?.fiveHour ? `5h ${formatPercent(1 - snapshot.fiveHour.utilization)}` : undefined,
      snapshot?.sevenDay ? `7d ${formatPercent(1 - snapshot.sevenDay.utilization)}` : undefined
    ].filter(Boolean).join(' · ');
    this.item.text = compact ? `$(pulse) Claude ${compact}` : '$(pulse) Claude Usage';
    this.item.tooltip = this.buildTooltip();
    this.item.show();
  }

  private buildTooltip(): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown('### Claude account usage\n\n');
    const snapshot = this.snapshot;
    if (!snapshot) {
      tooltip.appendMarkdown('Send a Claude request to load rate-limit windows and token usage.');
      return tooltip;
    }
    if (snapshot.account) {
      tooltip.appendMarkdown(`**Account:** ${escapeMarkdown(snapshot.account)}\n\n`);
    }
    appendWindowTooltip(tooltip, '5-hour window', snapshot.fiveHour);
    appendWindowTooltip(tooltip, '7-day window', snapshot.sevenDay);
    if (snapshot.model) {
      tooltip.appendMarkdown(`**Latest model:** ${escapeMarkdown(snapshot.model)}\n\n`);
    }
    const latestInput = (snapshot.inputTokens ?? 0)
      + (snapshot.cacheCreationInputTokens ?? 0)
      + (snapshot.cacheReadInputTokens ?? 0);
    if (latestInput > 0 || (snapshot.outputTokens ?? 0) > 0) {
      tooltip.appendMarkdown(`**Latest request:** ${formatTokens(latestInput)} input · ${formatTokens(snapshot.outputTokens ?? 0)} output\n\n`);
    }
    tooltip.appendMarkdown(`_Updated ${new Date(snapshot.updatedAt).toLocaleString()}_\n\n`);
    tooltip.appendMarkdown('Click for details.');
    return tooltip;
  }
}

function appendWindowTooltip(
  tooltip: vscode.MarkdownString,
  label: string,
  window: ClaudeUsageUpdate['fiveHour']
): void {
  if (!window) {
    return;
  }
  const remaining = Math.max(0, 1 - window.utilization);
  const reset = window.resetsAt ? ` · resets ${formatReset(window.resetsAt)}` : '';
  tooltip.appendMarkdown(`**${label}:** ${formatPercent(window.utilization)} used · ${formatPercent(remaining)} remaining${reset}\n\n`);
}

function formatWindowDetails(label: string, window: ClaudeUsageUpdate['fiveHour']): string | undefined {
  if (!window) {
    return undefined;
  }
  const reset = window.resetsAt ? `, resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : '';
  return `${label}: ${formatPercent(window.utilization)} used, ${formatPercent(1 - window.utilization)} remaining${reset}`;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatReset(epochSeconds: number): string {
  const milliseconds = epochSeconds * 1000;
  const remaining = milliseconds - Date.now();
  if (remaining <= 0) {
    return 'now';
  }
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `in ${hours}h`;
  }
  return new Date(milliseconds).toLocaleDateString();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}
