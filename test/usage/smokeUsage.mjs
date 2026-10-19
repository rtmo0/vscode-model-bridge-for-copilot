import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-usage-'));
const DAY = 86_400_000;

const vscodeShim = `
  export class LanguageModelTextPart { constructor(value){ this.value=value; } }
  export class LanguageModelToolResultPart { constructor(callId,content){ Object.assign(this,{callId,content}); } }
  export class LanguageModelToolCallPart { constructor(callId,name,input){ Object.assign(this,{callId,name,input}); } }
  export const LanguageModelChatMessageRole={User:1,Assistant:2};
  export class ThemeIcon { constructor(id){ this.id=id; } }
  export const ViewColumn={Active:-1};
  export class Uri {
    constructor(path){ this.path=path; this.fsPath=path; }
    static file(path){ return new Uri(path); }
    static joinPath(base,...parts){ return new Uri([base.path,...parts].join('/')); }
    toString(){ return 'vscode-webview://test' + this.path; }
  }
  const test = globalThis.__usageTest;
  export const workspace={
    getConfiguration(){ return { get(key,fallback){ return key in test.settings ? test.settings[key] : fallback; } }; },
    workspaceFolders: undefined,
    fs: { async writeFile(){} }
  };
  export const window={
    createWebviewPanel(viewType,title){
      const panel = {
        viewType, title, visible: true, iconPath: undefined,
        webview: {
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri(uri){ return uri.toString(); },
          async postMessage(message){ test.posted.push(message); return true; },
          onDidReceiveMessage(callback){ test.receive = callback; return { dispose(){} }; }
        },
        onDidDispose(callback){ test.disposePanel = callback; return { dispose(){} }; },
        reveal(){ test.revealed = (test.revealed ?? 0) + 1; }
      };
      test.panel = panel;
      return panel;
    },
    async showInformationMessage(){}, async showWarningMessage(){ return undefined; }, async showSaveDialog(){ return undefined; }
  };
  export const commands={ async executeCommand(){} };
`;

globalThis.__usageTest = { settings: {}, posted: [] };

try {
  const bundlePath = join(directory, 'usage.mjs');
  await writeFile(join(directory, 'entry.ts'), [
    `export * from ${JSON.stringify(join(process.cwd(), 'src/usage/usageLedger.ts'))};`,
    `export * from ${JSON.stringify(join(process.cwd(), 'src/usage/usageReport.ts'))};`,
    `export * from ${JSON.stringify(join(process.cwd(), 'src/usage/usageRecorder.ts'))};`,
    `export * from ${JSON.stringify(join(process.cwd(), 'src/usage/usageReportPanel.ts'))};`,
    `export { LanguageModelTextPart, LanguageModelToolResultPart, LanguageModelToolCallPart } from 'vscode';`
  ].join('\n'));
  await build({
    entryPoints: [join(directory, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    plugins: [{
      name: 'vscode-test-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: vscodeShim, loader: 'js' }));
      }
    }]
  });
  const usage = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

  // ------------------------------------------------------------ ledger
  const ledgerDirectory = join(directory, 'ledger');
  let retention = 30;
  const ledger = new usage.UsageLedger(ledgerDirectory, () => retention);
  const now = Date.now();
  const base = {
    v: 1, provider: 'claude', model: 'sonnet', conversation: 'aaaa', messages: 2, tools: 3,
    cacheWriteTokens: 0, reasoningTokens: 0
  };
  const records = [
    // Conversation aaaa: a user turn, a cached tool step, then a cache miss.
    { ...base, ts: now - 3_000, step: 1, kind: 'user', inputTokens: 20_000, cachedInputTokens: 0, cacheWriteTokens: 20_000, outputTokens: 500, costUsd: 0.1 },
    { ...base, ts: now - 2_000, step: 2, kind: 'tool', inputTokens: 21_000, cachedInputTokens: 20_000, outputTokens: 300, costUsd: 0.02 },
    { ...base, ts: now - 1_000, step: 3, kind: 'tool', inputTokens: 40_000, cachedInputTokens: 1_000, cacheWriteTokens: 39_000, outputTokens: 700, costUsd: 0.2 },
    // Codex conversation bbbb, two days ago.
    { ...base, ts: now - 2 * DAY, provider: 'codex', model: 'gpt-5.5', conversation: 'bbbb', step: 1, kind: 'user', inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 2_000, reasoningTokens: 1_500, transport: 'websocket', continuation: true },
    // A local model with no cache data: never a cache miss.
    { ...base, ts: now - 500, provider: 'openaiCompatible', endpoint: 'Ollama', model: 'qwen3:8b', conversation: 'cccc', step: 2, kind: 'tool', inputTokens: 30_000, cachedInputTokens: 0, outputTokens: 100 },
    // Older than the retention period.
    { ...base, ts: now - 40 * DAY, conversation: 'old', step: 1, kind: 'user', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
  ];
  for (const record of records) await ledger.append(record);
  await writeFile(join(ledgerDirectory, 'usage-2000-01-01.jsonl'), 'not json\n');
  const files = await readdir(ledgerDirectory);
  assert(files.every((file) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)));

  const stored = await ledger.read(0, now);
  assert.equal(stored.length, 5, 'records outside the retention period are not read');
  assert.deepEqual(stored.map((record) => record.ts), [...stored.map((record) => record.ts)].sort((a, b) => a - b));
  const line = (await readFile(join(ledgerDirectory, files.find((file) => file.includes(new Date(now).toISOString().slice(0, 10)))), 'utf8')).split('\n')[0];
  assert.doesNotMatch(line, /prompt|content|arguments/i, 'records hold counts only');

  assert.equal(await ledger.prune(now), 2, 'the old day and the malformed old file are deleted');
  retention = 1;
  assert.equal((await ledger.read(0, now)).some((record) => record.provider === 'codex'), false, 'a shorter retention hides older days');
  retention = 30;

  // ------------------------------------------------------------ CSV
  const csv = usage.toCsv([
    { ...records[0], model: 'a,"b"' },
    { ...records[1], model: '=HYPERLINK("x")' }
  ]);
  const csvLines = csv.trim().split('\n');
  assert.match(csvLines[0], /^time,provider,endpoint,model,conversation,step,kind/);
  assert.match(csvLines[1], /,"a,""b""",/);
  assert.match(csvLines[2], /,"'=HYPERLINK\(""x""\)",/, 'formula-like text cells are neutralized');

  // ------------------------------------------------------------ report
  const report = usage.buildUsageReport(stored, { range: 30, provider: 'all' }, now);
  assert.equal(report.totals.requests, 5);
  assert.equal(report.totals.conversations, 3);
  assert.equal(report.totals.toolSteps, 3);
  assert.equal(report.totals.inputTokens, 116_000);
  assert.equal(report.totals.cacheMisses, 1, 'only the Claude step that lost its cache counts as a miss');
  assert.equal(report.totals.cacheMissInputTokens, 40_000);
  assert.equal(report.totals.cacheHitRatio, (20_000 + 1_000 + 4_000) / (20_000 + 21_000 + 40_000 + 5_000));
  assert.equal(report.totals.costUsd.toFixed(2), '0.32');
  assert.equal(report.daily.length, 30);
  assert.equal(report.daily.at(-1).requests, 4);
  assert.equal(report.daily.reduce((sum, day) => sum + day.requests, 0), 5);
  assert.deepEqual(report.providers, ['claude', 'codex', 'openaiCompatible']);
  assert.equal(report.byModel[0].label, 'Claude · sonnet');
  assert(report.byModel.some((row) => row.label === 'Ollama · qwen3:8b'));
  assert.equal(report.conversations[0].id, 'aaaa');
  assert.equal(report.conversations[0].steps, 3);
  assert.equal(report.conversations[0].maxInputTokens, 40_000);
  assert.equal(report.conversations[0].cacheMisses, 1);
  assert.equal(report.topRequests[0].inputTokens, 40_000);
  assert.equal(report.topRequests[0].uncachedInputTokens, 39_000);

  const codexOnly = usage.buildUsageReport(stored, { range: 'all', provider: 'codex' }, now);
  assert.equal(codexOnly.totals.requests, 1);
  assert.equal(codexOnly.totals.reasoningTokens, 1_500);
  assert.equal(codexOnly.daily.length, 3, '"all" starts at the first recorded day');
  const today = usage.buildUsageReport(stored, { range: 1, provider: 'all' }, now);
  assert.equal(today.daily.length, 1);

  const detail = usage.buildConversationDetail(stored, 'aaaa');
  assert.deepEqual(detail.rows.map((row) => row.step), [1, 2, 3]);
  assert.deepEqual(detail.rows.map((row) => row.cacheMiss), [false, false, true]);

  // ------------------------------------------------------------ request shape
  const conversation = [
    { role: 1, content: [new usage.LanguageModelTextPart('Fix the bug')] },
    { role: 2, content: [new usage.LanguageModelToolCallPart('c1', 'read', {})] },
    { role: 1, content: [new usage.LanguageModelToolResultPart('c1', [new usage.LanguageModelTextPart('file')])] }
  ];
  const first = usage.describeRequest(conversation.slice(0, 1), 'salt');
  const toolStep = usage.describeRequest(conversation, 'salt');
  assert.equal(first.conversation, toolStep.conversation, 'the conversation hash is stable as the history grows');
  assert.notEqual(usage.describeRequest(conversation, 'other-salt').conversation, toolStep.conversation, 'the hash depends on the local salt');
  assert.notEqual(usage.describeRequest([{ role: 1, content: [new usage.LanguageModelTextPart('Other task')] }], 'salt').conversation, first.conversation);
  assert.match(toolStep.conversation, /^[0-9a-f]{16}$/);
  assert.deepEqual([first.step, first.kind, first.messages], [1, 'user', 1]);
  assert.deepEqual([toolStep.step, toolStep.kind, toolStep.messages], [2, 'tool', 3]);

  // ------------------------------------------------------------ recorder
  const recorderLedger = new usage.UsageLedger(join(directory, 'recorder'), () => 30);
  const globalState = new Map();
  const context = { globalState: { get: (key) => globalState.get(key), update: async (key, value) => { globalState.set(key, value); } } };
  let notified = 0;
  const recorder = usage.createUsageRecorder(context, recorderLedger, () => { notified += 1; });
  recorder.recordRequest(conversation, { provider: 'lmstudio', model: 'm', tools: 0, inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await recorderLedger.read()).length, 1);
  assert.equal(notified, 1);
  assert.match(globalState.get('modelBridge.usage.conversationSalt'), /^[0-9a-f]{64}$/);
  globalThis.__usageTest.settings.recordRequests = false;
  recorder.recordRequest(conversation, { provider: 'lmstudio', model: 'm', tools: 0, inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await recorderLedger.read()).length, 1, 'recording can be turned off');
  globalThis.__usageTest.settings.recordRequests = true;

  // ------------------------------------------------------------ webview panel
  const panelContext = { extensionUri: { path: '/ext' } };
  usage.UsageReportPanel.show(panelContext, ledger);
  const html = globalThis.__usageTest.panel.webview.html;
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
  assert(nonce, 'scripts require a nonce');
  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}" src="vscode-webview://test/ext/media/usageReport.js">`));
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|https?:\/\//);
  usage.UsageReportPanel.show(panelContext, ledger);
  assert.equal(globalThis.__usageTest.revealed, 1, 'a second show reveals the existing panel');

  const send = async (message) => {
    globalThis.__usageTest.receive(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await send({ type: 'ready', filter: { range: 7, provider: 'claude' } });
  const posted = globalThis.__usageTest.posted.at(-1);
  assert.equal(posted.type, 'report');
  assert.equal(posted.recording, true);
  assert.deepEqual(posted.report.filter, { range: 7, provider: 'claude' });
  assert.equal(posted.report.totals.requests, 3);
  assert.deepEqual(posted.report.providers, ['claude', 'codex', 'openaiCompatible'], 'the provider menu lists the whole history');

  await send({ type: 'setFilter', filter: { range: 12345, provider: 'evil' } });
  assert.deepEqual(globalThis.__usageTest.posted.at(-1).report.filter, { range: 7, provider: 'claude' }, 'invalid filters keep the previous one');

  await send({ type: 'openConversation', id: 'aaaa' });
  assert.equal(globalThis.__usageTest.posted.at(-1).type, 'conversation');
  assert.equal(globalThis.__usageTest.posted.at(-1).detail.rows.length, 3);
  const before = globalThis.__usageTest.posted.length;
  await send({ type: 'openConversation', id: '../etc' });
  assert.equal(globalThis.__usageTest.posted.length, before, 'malformed conversation IDs are ignored');
  globalThis.__usageTest.disposePanel();

  await ledger.clear();
  assert.deepEqual(await ledger.read(), []);
  console.log('Usage ledger, report, recorder, and panel smoke tests passed.');

} finally {
  delete globalThis.__usageTest;
  await rm(directory, { recursive: true, force: true });
}
