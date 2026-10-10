import * as vscode from 'vscode';
import {
  buildClaudeAccountUsageDisplay,
  mergeRateLimitUpdate,
  parseClaudeUsageReport,
  toLatestRequestUsage,
  type ClaudeAccountUsageSnapshot
} from './accountUsage';
import type { ClaudeUsageUpdate } from './protocol';

const STORAGE_KEY = 'modelBridge.claude.accountUsage';
const LEGACY_STORAGE_KEY = 'modelBridge.claude.usageSnapshot';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface ClaudeAccountUsageStatusBarOptions {
  /** Fetches the `/usage` report text; rejects when Claude Code is unavailable. */
  fetchReport(): Promise<string>;
  output?: Pick<vscode.LogOutputChannel, 'debug' | 'warn'>;
}

/** Mirrors the Codex account-limits status bar: proactive refresh, compact remaining percentages, details picker. */
export class ClaudeAccountUsageStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private snapshot?: ClaudeAccountUsageSnapshot;
  private signedIn = false;
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: ClaudeAccountUsageStatusBarOptions
  ) {
    this.item.name = 'Claude Account Limits';
    this.item.command = 'modelBridge.claude.showAccountLimits';
    void context.globalState.update(LEGACY_STORAGE_KEY, undefined);
    this.snapshot = context.globalState.get<ClaudeAccountUsageSnapshot>(STORAGE_KEY);
    this.refreshTimer = setInterval(() => {
      if (this.signedIn) void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.disposables = [
      this.item,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('modelBridge.claude.usageStatusBar')) this.render();
      })
    ];
    this.render();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Called once Claude Code reports a signed-in subscription account. */
  setAccount(account: string | undefined, plan?: string): void {
    this.signedIn = true;
    this.update({ account, ...(plan ? { plan } : {}) }, false);
  }

  getCompactText(): string | undefined {
    return this.snapshot ? buildClaudeAccountUsageDisplay(this.snapshot).compactText : undefined;
  }

  clear(): void {
    this.signedIn = false;
    this.snapshot = undefined;
    void this.context.globalState.update(STORAGE_KEY, undefined);
    this.render();
  }

  async refresh(): Promise<void> {
    this.refreshInFlight ??= this.refreshNow().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /** Applies rate-limit windows and token usage streamed with a chat response. */
  record(update: ClaudeUsageUpdate): void {
    this.signedIn = true;
    const latestRequest = toLatestRequestUsage(update);
    const hasLimits = update.fiveHour !== undefined || update.sevenDay !== undefined;
    this.update({
      ...(hasLimits ? { limits: mergeRateLimitUpdate(this.snapshot?.limits ?? [], update) } : {}),
      ...(latestRequest ? { latestRequest } : {}),
      ...(update.isUsingOverage !== undefined ? { isUsingOverage: update.isUsingOverage } : {})
    }, hasLimits);
  }

  async showDetails(): Promise<void> {
    if (!this.snapshot?.limits.length) {
      await this.refresh();
    }
    const snapshot = this.snapshot;
    if (!snapshot?.limits.length) {
      vscode.window.showInformationMessage('No Claude account limits are available. Sign in to Claude Code and try again.');
      return;
    }

    const display = buildClaudeAccountUsageDisplay(snapshot);
    const [, ...detailLines] = display.tooltip.split('\n');
    const accountItem: vscode.QuickPickItem = {
      label: `$(check) ${snapshot.account ?? 'Claude account'}`,
      description: ['active', display.compactText ?? ''].filter(Boolean).join('  '),
      detail: detailLines.join('  •  ')
    };
    const refreshItem: vscode.QuickPickItem = { label: '$(sync) Refresh' };
    const picked = await vscode.window.showQuickPick(
      [accountItem, { label: '', kind: vscode.QuickPickItemKind.Separator }, refreshItem],
      { title: 'Claude Account Limits', placeHolder: 'Claude account limits from Claude Code.' }
    );
    if (picked === refreshItem) {
      await this.refresh();
    }
  }

  private async refreshNow(): Promise<void> {
    try {
      const limits = parseClaudeUsageReport(await this.options.fetchReport());
      if (limits.length === 0) {
        this.options.output?.debug('Claude account usage report contained no limit windows');
        return;
      }
      this.signedIn = true;
      // `/usage` only has human-readable reset times; keep streamed epoch resets when present.
      const previous = new Map((this.snapshot?.limits ?? []).map((limit) => [limit.kind, limit]));
      this.update({
        limits: limits.map((limit) => {
          const known = previous.get(limit.kind);
          return known?.resetsAt !== undefined && limit.kind !== 'other' && limit.kind !== 'weekly-model'
            ? { ...limit, resetsAt: known.resetsAt }
            : limit;
        })
      }, true);
    } catch (error) {
      this.options.output?.warn('Claude account usage refresh failed', error instanceof Error ? error.message : String(error));
    }
  }

  private update(patch: Partial<ClaudeAccountUsageSnapshot>, fetched: boolean): void {
    const previous = this.snapshot;
    this.snapshot = {
      limits: [],
      ...previous,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      fetchedAt: fetched || !previous ? Date.now() : previous.fetchedAt
    };
    void this.context.globalState.update(STORAGE_KEY, this.snapshot);
    this.render();
  }

  private render(): void {
    if (!vscode.workspace.getConfiguration('modelBridge.claude').get('usageStatusBar', true) || !this.snapshot) {
      this.item.hide();
      return;
    }
    const display = buildClaudeAccountUsageDisplay(this.snapshot);
    if (!display.compactText) {
      this.item.hide();
      return;
    }
    this.item.text = display.compactText;
    this.item.tooltip = display.tooltip;
    this.item.show();
  }
}
