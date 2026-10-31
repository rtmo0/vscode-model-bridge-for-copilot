import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { COMBOS_SETTING, type ComboModelChoice } from './provider';
import { parseCombos } from './routing';

const MAX_COMBOS = 50;
const MAX_TARGETS = 20;
const MAX_TEXT = 200;

/** A combo as the editor shows it; both strategies' fields are kept so switching strategy loses nothing. */
export interface EditableCombo {
  name: string;
  strategy: 'fallback' | 'planExecute';
  targets: string[];
  planner: string;
  executors: string[];
}

export interface ComboEditorHost {
  listModelChoices(): Promise<ComboModelChoice[]>;
}

/**
 * Visual editor for `modelBridge.combos`. The setting stays the single source of truth: the editor reads it,
 * validates with the same parser as the provider, and writes it back to user settings.
 */
export class ComboEditorPanel implements vscode.Disposable {
  private static current?: ComboEditorPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private saving = false;

  static show(context: vscode.ExtensionContext, host: ComboEditorHost): void {
    if (ComboEditorPanel.current) {
      ComboEditorPanel.current.panel.reveal();
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('modelBridge.comboEditor', 'Model Bridge Combos', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot]
    });
    ComboEditorPanel.current = new ComboEditorPanel(panel, mediaRoot, host);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    mediaRoot: vscode.Uri,
    private readonly host: ComboEditorHost
  ) {
    panel.iconPath = new vscode.ThemeIcon('layers');
    panel.webview.html = renderHtml(panel.webview, mediaRoot);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(COMBOS_SETTING) && !this.saving) void this.postState(true);
      })
    );
  }

  dispose(): void {
    if (ComboEditorPanel.current === this) ComboEditorPanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
      case 'refreshModels':
        await this.postState(false);
        return;
      case 'save':
        await this.save(message.combos);
        return;
      case 'doctor':
        await vscode.commands.executeCommand('modelBridge.combos.doctor');
        return;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: COMBOS_SETTING } });
        return;
    }
  }

  private async postState(external: boolean): Promise<void> {
    const raw = readRawCombos();
    const models = await this.host.listModelChoices();
    await this.panel.webview.postMessage({
      type: 'state',
      external,
      combos: toEditableCombos(raw),
      invalid: parseCombos(raw).invalid,
      models
    });
  }

  private async save(value: unknown): Promise<void> {
    const combos = sanitizeEditableCombos(value);
    const setting = toSettingValue(combos);
    const { invalid } = parseCombos(setting);
    if (!combos || invalid.length > 0) {
      await this.panel.webview.postMessage({ type: 'saved', ok: false, errors: combos ? invalid : ['The editor sent an invalid list.'] });
      return;
    }
    this.saving = true;
    try {
      await vscode.workspace.getConfiguration('modelBridge').update('combos', setting, vscode.ConfigurationTarget.Global);
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'saved', ok: false, errors: [error instanceof Error ? error.message : String(error)] });
      return;
    } finally {
      this.saving = false;
    }
    await this.panel.webview.postMessage({ type: 'saved', ok: true });
    await this.postState(false);
  }
}

/** Reads the setting as written, so entries the provider skips can still be shown and fixed. */
export function toEditableCombos(value: unknown): EditableCombo[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).map((entry) => {
    const executor = entry.executor;
    return {
      name: typeof entry.name === 'string' ? entry.name : '',
      strategy: entry.strategy === 'planExecute' ? 'planExecute' : 'fallback',
      targets: strings(entry.targets),
      planner: typeof entry.planner === 'string' ? entry.planner : '',
      executors: typeof executor === 'string' ? [executor] : strings(executor)
    };
  });
}

/** Writes only the fields of each combo's strategy; one executor stays a plain string. */
export function toSettingValue(combos: readonly EditableCombo[] | undefined): Array<Record<string, unknown>> {
  return (combos ?? []).map((combo) => combo.strategy === 'fallback'
    ? { name: combo.name.trim(), strategy: 'fallback', targets: combo.targets }
    : {
      name: combo.name.trim(),
      strategy: 'planExecute',
      planner: combo.planner,
      executor: combo.executors.length === 1 ? combo.executors[0] : combo.executors
    });
}

// Messages from the webview are untrusted input: bounded, typed, and trimmed before they reach the setting.
export function sanitizeEditableCombos(value: unknown): EditableCombo[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_COMBOS) return undefined;
  const combos: EditableCombo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    combos.push({
      name: text(entry.name),
      strategy: entry.strategy === 'planExecute' ? 'planExecute' : 'fallback',
      targets: strings(entry.targets).slice(0, MAX_TARGETS),
      planner: text(entry.planner),
      executors: strings(entry.executors).slice(0, MAX_TARGETS)
    });
  }
  return combos;
}

function readRawCombos(): unknown {
  return vscode.workspace.getConfiguration('modelBridge').get<unknown>('combos', []);
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, MAX_TEXT))
    .filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'comboEditor.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'comboEditor.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Model Bridge Combos</title>
</head>
<body class="loading">
  <header class="toolbar">
    <h1>Combos</h1>
    <div class="actions">
      <button id="add-fallback" class="primary">Add fallback combo</button>
      <button id="add-plan" class="primary">Add plan → execute combo</button>
      <button id="refresh">Refresh models</button>
      <button id="doctor">Run Doctor</button>
      <button id="json">Edit as JSON</button>
    </div>
  </header>
  <p class="note">A combo is one model in the <strong>Combos</strong> group of the model picker that uses the models of the other Model Bridge providers. <strong>Fallback</strong> tries the models in order and moves on only when one fails before answering. <strong>Plan → execute</strong> lets the planner write a short plan for each new prompt; the executors carry it out with the tools, the next one taking over when one fails.</p>
  <p class="banner warning" id="external" hidden>The combos were changed outside the editor. <button id="reload">Load the saved combos</button></p>
  <p class="banner warning" id="invalid" hidden></p>
  <div id="empty" class="empty" hidden>No combos yet. Add a fallback combo or a plan → execute combo to start.</div>
  <main id="combos"></main>
  <footer class="savebar">
    <span id="status" class="status" role="status"></span>
    <button id="discard">Discard changes</button>
    <button id="save" class="primary">Save</button>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
