import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { toCsv, type UsageLedger, type UsageProvider } from './usageLedger';
import { buildConversationDetail, buildUsageReport, filterRecords, rangeStart, type UsageFilter, type UsageRange } from './usageReport';
import { USAGE_SECTION } from './usageRecorder';

const RANGES: readonly UsageRange[] = [1, 7, 30, 90, 'all'];
const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex', 'deepseek', 'lmstudio', 'openaiCompatible'];
const LIVE_REFRESH_DELAY_MS = 1_500;

/** Single usage-report webview; it refreshes itself while visible when new requests are recorded. */
export class UsageReportPanel implements vscode.Disposable {
  private static current?: UsageReportPanel;
  private filter: UsageFilter = { range: 30, provider: 'all' };
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, ledger: UsageLedger): void {
    if (UsageReportPanel.current) {
      UsageReportPanel.current.panel.reveal();
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('modelBridge.usageReport', 'Model Bridge Usage', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    });
    UsageReportPanel.current = new UsageReportPanel(panel, mediaRoot, ledger);
  }

  /** Called after a request is recorded. */
  static notifyRecorded(): void {
    UsageReportPanel.current?.scheduleRefresh();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    mediaRoot: vscode.Uri,
    private readonly ledger: UsageLedger
  ) {
    panel.iconPath = new vscode.ThemeIcon('graph');
    panel.webview.html = renderHtml(panel.webview, mediaRoot);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); })
    );
  }

  dispose(): void {
    if (UsageReportPanel.current === this) UsageReportPanel.current = undefined;
    clearTimeout(this.refreshTimer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private scheduleRefresh(): void {
    if (!this.panel.visible) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.postReport(); }, LIVE_REFRESH_DELAY_MS);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
      case 'setFilter':
        this.filter = parseFilter(message.filter, this.filter);
        await this.postReport();
        return;
      case 'openConversation':
        if (typeof message.id === 'string' && /^[0-9a-f]{1,64}$/.test(message.id)) {
          const detail = buildConversationDetail(await this.ledger.read(), message.id);
          await this.panel.webview.postMessage({ type: 'conversation', detail });
        }
        return;
      case 'exportCsv':
        await exportCsv(this.ledger, parseFilter(message.filter, this.filter));
        return;
      case 'clear':
        if (await clearUsage(this.ledger)) await this.postReport();
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', USAGE_SECTION);
        return;
    }
  }

  private async postReport(): Promise<void> {
    // The whole retention period is read so the provider menu lists every provider, not only those in range.
    const report = buildUsageReport(await this.ledger.read(), this.filter);
    await this.panel.webview.postMessage({
      type: 'report',
      report,
      recording: vscode.workspace.getConfiguration(USAGE_SECTION).get<boolean>('recordRequests', true)
    });
  }
}

export async function exportCsv(ledger: UsageLedger, filter: UsageFilter = { range: 'all', provider: 'all' }): Promise<void> {
  const records = filterRecords(await ledger.read(rangeStart(filter.range)), filter);
  if (records.length === 0) {
    vscode.window.showInformationMessage('No usage has been recorded for this period.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Export Model Bridge Usage',
    defaultUri: vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
      `model-bridge-usage-${new Date().toISOString().slice(0, 10)}.csv`
    ),
    filters: { CSV: ['csv'] }
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(toCsv(records), 'utf8'));
  const action = await vscode.window.showInformationMessage(`Exported ${records.length} requests.`, 'Open File');
  if (action === 'Open File') await vscode.commands.executeCommand('vscode.open', target);
}

export async function clearUsage(ledger: UsageLedger): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    'Delete all recorded Model Bridge usage on this machine?',
    { modal: true, detail: 'This removes the request history used by the usage report. Account limits are not affected.' },
    'Delete Usage History'
  );
  if (confirmed !== 'Delete Usage History') return false;
  await ledger.clear();
  vscode.window.showInformationMessage('Model Bridge usage history deleted.');
  return true;
}

function parseFilter(value: unknown, fallback: UsageFilter): UsageFilter {
  if (!isRecord(value)) return fallback;
  const range = RANGES.includes(value.range as UsageRange) ? value.range as UsageRange : fallback.range;
  const provider = value.provider === 'all' || PROVIDERS.includes(value.provider as UsageProvider)
    ? value.provider as UsageFilter['provider']
    : fallback.provider;
  return { range, provider };
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'usageReport.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'usageReport.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Model Bridge Usage</title>
</head>
<body class="loading">
  <header class="toolbar">
    <h1>Model Bridge usage</h1>
    <div class="filters">
      <label>Period
        <select id="range">
          <option value="1">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All recorded</option>
        </select>
      </label>
      <label>Provider <select id="provider"><option value="all">All providers</option></select></label>
      <button id="refresh" class="primary">Refresh</button>
      <button id="export">Export CSV</button>
      <button id="clear">Clear History…</button>
      <button id="settings">Settings</button>
    </div>
  </header>
  <p class="note">Token counts reported by each provider for requests made through Model Bridge. Only counts and model names are stored on this machine — never prompts or responses. Conversations are identified by a local hash. Costs are API-equivalent estimates; Claude and ChatGPT subscriptions are not billed per token.</p>
  <p class="note" id="recording-off" hidden>Recording is turned off (<code>modelBridge.usage.recordRequests</code>), so new requests are not added.</p>

  <div id="empty" class="empty" hidden>No requests have been recorded for this period yet. Use a Model Bridge model in Chat, then refresh.</div>

  <main id="content" hidden>
    <section id="kpis" class="kpis" aria-label="Totals"></section>

    <section class="card">
      <div class="card-head"><h2>Tokens per day</h2><div class="legend" id="daily-legend"></div></div>
      <div class="chart" id="daily-chart"></div>
      <details><summary>Show as table</summary><div id="daily-table"></div></details>
    </section>

    <section class="card">
      <div class="card-head"><h2>Tokens by model</h2><div class="legend" id="model-legend"></div></div>
      <div class="chart" id="model-chart"></div>
      <details><summary>Show as table</summary><div id="model-table"></div></details>
    </section>

    <section class="card">
      <h2>Heaviest conversations</h2>
      <p class="hint">Select a conversation to see the tokens of each step. Sort by any column.</p>
      <div id="conversations-table"></div>
    </section>

    <section class="card" id="detail" hidden>
      <div class="card-head">
        <h2>Conversation <code id="detail-id"></code></h2>
        <button id="detail-close">Close</button>
      </div>
      <p class="hint" id="detail-summary"></p>
      <div class="legend" id="detail-legend"></div>
      <div class="chart" id="detail-chart"></div>
      <details open><summary>Steps</summary><div id="detail-table"></div></details>
    </section>

    <section class="card">
      <h2>Heaviest requests</h2>
      <p class="hint">Select a request to open its conversation.</p>
      <div id="requests-table"></div>
    </section>
  </main>

  <div id="tooltip" class="tooltip" role="tooltip" hidden></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
