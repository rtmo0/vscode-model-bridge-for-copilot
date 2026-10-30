import * as vscode from 'vscode';
import { formatLatestRequestLine, type LatestRequestUsage } from '../usageSummary';

export interface DeepSeekBalance {
  /** Whether the balance is enough for API calls. */
  available: boolean;
  balances: Array<{ currency: string; total: string; granted: string; toppedUp: string }>;
}

export interface DeepSeekRequestSummary extends LatestRequestUsage {
  costUsd?: number;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Agent turns send many requests; the balance is refreshed after at most one of them per interval.
const REQUEST_REFRESH_INTERVAL_MS = 30 * 1000;
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' };

export function parseDeepSeekBalance(payload: unknown): DeepSeekBalance | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { is_available?: unknown; balance_infos?: unknown };
  if (typeof record.is_available !== 'boolean' || !Array.isArray(record.balance_infos)) return undefined;
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '0';
  return {
    available: record.is_available,
    balances: record.balance_infos.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const info = entry as Record<string, unknown>;
      return typeof info.currency === 'string'
        ? [{ currency: info.currency, total: text(info.total_balance), granted: text(info.granted_balance), toppedUp: text(info.topped_up_balance) }]
        : [];
    })
  };
}

export function formatDeepSeekBalance(balance: DeepSeekBalance): string {
  if (balance.balances.length === 0) return balance.available ? 'available' : 'empty';
  return balance.balances.map((entry) => formatAmount(entry.currency, entry.total)).join(' · ');
}

/** Account balance in the status bar, like the Claude and Codex account limits: on startup, every 5 minutes, and after requests. */
export class DeepSeekBalanceStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private balance?: DeepSeekBalance;
  private latestRequest?: DeepSeekRequestSummary;
  private lastRefreshAt = 0;
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly options: {
      fetchBalance(): Promise<DeepSeekBalance | undefined>;
      output?: Pick<vscode.LogOutputChannel, 'warn'>;
    }
  ) {
    this.item.name = 'DeepSeek Balance';
    this.item.command = 'modelBridge.deepseek.showBalance';
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.disposables = [
      this.item,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('modelBridge.deepseek.balanceStatusBar')) this.render();
      })
    ];
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  getBalance(): DeepSeekBalance | undefined {
    return this.balance;
  }

  clear(): void {
    this.balance = undefined;
    this.latestRequest = undefined;
    this.render();
  }

  async refresh(): Promise<void> {
    this.refreshInFlight ??= this.refreshNow().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  recordRequest(summary: DeepSeekRequestSummary): void {
    this.latestRequest = summary;
    this.render();
    if (Date.now() - this.lastRefreshAt >= REQUEST_REFRESH_INTERVAL_MS) void this.refresh();
  }

  async showDetails(): Promise<void> {
    await this.refresh();
    const balance = this.balance;
    if (!balance) {
      const action = await vscode.window.showInformationMessage('No DeepSeek balance is available. Set your API key and try again.', 'Set API Key');
      if (action) await vscode.commands.executeCommand('modelBridge.deepseek.setApiKey');
      return;
    }
    const items: Array<vscode.QuickPickItem & { command?: string }> = [
      ...balance.balances.map((entry) => ({
        label: `$(credit-card) ${formatAmount(entry.currency, entry.total)}`,
        description: balance.available ? 'available' : 'insufficient for API calls',
        detail: `Topped up ${formatAmount(entry.currency, entry.toppedUp)}  •  Granted ${formatAmount(entry.currency, entry.granted)}`
      })),
      ...(this.latestRequest ? [{ label: `$(pulse) ${latestRequestLine(this.latestRequest)}` }] : []),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(sync) Refresh' },
      { label: '$(link-external) Top Up on the DeepSeek Platform', command: 'modelBridge.deepseek.openPlatform' }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'DeepSeek Balance', placeHolder: 'DeepSeek account balance' });
    if (picked?.label === '$(sync) Refresh') {
      await this.refresh();
    } else if (picked?.command) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  private async refreshNow(): Promise<void> {
    this.lastRefreshAt = Date.now();
    try {
      this.balance = await this.options.fetchBalance();
    } catch (error) {
      this.options.output?.warn('DeepSeek balance refresh failed', { error: error instanceof Error ? error.message : String(error) });
    }
    this.render();
  }

  private render(): void {
    if (!vscode.workspace.getConfiguration('modelBridge.deepseek').get('balanceStatusBar', true) || !this.balance) {
      this.item.hide();
      return;
    }
    this.item.text = `${this.balance.available ? '' : '$(warning) '}DeepSeek: ${formatDeepSeekBalance(this.balance)}`;
    this.item.tooltip = [
      `DeepSeek balance: ${formatDeepSeekBalance(this.balance)}${this.balance.available ? '' : ' (insufficient for API calls)'}`,
      ...(this.latestRequest ? [latestRequestLine(this.latestRequest)] : []),
      'Refreshes on startup, every 5 minutes, and after requests.'
    ].join('\n');
    this.item.show();
  }
}

function latestRequestLine(summary: DeepSeekRequestSummary): string {
  const line = formatLatestRequestLine(summary);
  return summary.costUsd === undefined ? line : `${line} · ~$${summary.costUsd.toFixed(4)}`;
}

function formatAmount(currency: string, amount: string): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
}
