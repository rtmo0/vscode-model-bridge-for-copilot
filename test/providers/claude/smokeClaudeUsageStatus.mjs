import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-claude-usage-test-'));
const bundlePath = join(directory, 'claudeUsageStatusBar.mjs');

// Shape of `claude -p /usage` output (Claude Code 2.1.296), including the local analytics that must be ignored.
const USAGE_REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 26% used · resets Oct 11 at 12:19am (Europe/Moscow)',
  'Current week (all models): 35% used · resets Oct 16 at 6:59am (Europe/Moscow)',
  'Current week (Sonnet only): 10% used · resets Oct 16 at 6:59am (Europe/Moscow)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 214 requests · 2 sessions',
  '  89% of your usage was at >150k context'
].join('\n');

try {
  await build({
    entryPoints: ['src/providers/claude/usageStatusBar.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    plugins: [{
      name: 'vscode-test-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
          contents: `
            const item = {
              text: '', tooltip: undefined, visible: false,
              show() { this.visible = true; },
              hide() { this.visible = false; },
              dispose() {}
            };
            globalThis.__claudeUsageTest = { item, messages: [], picks: [] };
            export const StatusBarAlignment = { Right: 2 };
            export const QuickPickItemKind = { Separator: -1 };
            export class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } static from(...items) { return { dispose() { items.forEach((entry) => entry.dispose()); } }; } }
            export const window = {
              createStatusBarItem() { return item; },
              async showInformationMessage(message) { globalThis.__claudeUsageTest.messages.push(message); },
              async showQuickPick(items) { globalThis.__claudeUsageTest.picks.push(items); return undefined; }
            };
            export const workspace = {
              getConfiguration() { return { get(_key, fallback) { return fallback; } }; },
              onDidChangeConfiguration() { return { dispose() {} }; }
            };
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const values = new Map([['modelBridge.claude.usageSnapshot', { legacy: true }]]);
  const context = {
    globalState: {
      get(key) { return values.get(key); },
      async update(key, value) { values.set(key, value); }
    }
  };
  let fetchCount = 0;
  const statusBar = new module.ClaudeAccountUsageStatusBar(context, {
    async fetchReport() { fetchCount += 1; return USAGE_REPORT; }
  });
  const shim = globalThis.__claudeUsageTest;
  assert.equal(shim.item.visible, false, 'hidden until limits are known, like Codex');
  assert.equal(values.get('modelBridge.claude.usageSnapshot'), undefined, 'legacy snapshot is dropped');

  statusBar.setAccount('developer@example.test', 'pro');
  await statusBar.refresh();
  assert.equal(fetchCount, 1);
  assert.equal(shim.item.visible, true);
  assert.equal(shim.item.text, 'Claude: 5h 74% · Weekly 65%');
  assert.match(shim.item.tooltip, /^Claude account limits\nAccount: developer@example\.test\nPlan: Pro\n/);
  assert.match(shim.item.tooltip, /5h: 26% used, 74% remaining, resets Oct 11 at 12:19am/);
  assert.match(shim.item.tooltip, /Weekly Sonnet: 10% used/);
  assert.doesNotMatch(shim.item.tooltip, /150k context/, 'local analytics are not shown');
  assert.equal(statusBar.getCompactText(), 'Claude: 5h 74% · Weekly 65%');

  // Streamed rate-limit windows and token usage update the bar without another /usage call.
  statusBar.record({ fiveHour: { utilization: 0.5, resetsAt: Math.floor(Date.now() / 1000) + 7200 } });
  statusBar.record({
    inputTokens: 2,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    outputTokens: 9,
    thinkingTokens: 4,
    model: 'claude-sonnet-5-5',
    totalCostUsd: 0.0123
  });
  assert.equal(fetchCount, 1);
  assert.equal(shim.item.text, 'Claude: 5h 50% · Weekly 65%');
  assert.match(shim.item.tooltip, /5h: 50% used, 50% remaining, resets in 2h/);
  assert.match(shim.item.tooltip, /Latest request \(claude-sonnet-5-5\): 302 input · 200 cached · 9 output · 4 reasoning/);
  assert(values.has('modelBridge.claude.accountUsage'));

  await statusBar.showDetails();
  const picks = shim.picks.at(-1);
  assert.equal(picks[0].label, '$(check) developer@example.test');
  assert.match(picks[0].description, /Claude: 5h 50%/);
  assert.equal(picks.at(-1).label, '$(sync) Refresh');

  statusBar.clear();
  assert.equal(shim.item.visible, false);
  assert.equal(values.get('modelBridge.claude.accountUsage'), undefined);

  const failing = new module.ClaudeAccountUsageStatusBar(context, { async fetchReport() { throw new Error('not signed in'); } });
  await failing.refresh();
  assert.equal(shim.item.visible, false, 'refresh failures keep the bar hidden');
  await failing.showDetails();
  assert.match(shim.messages.at(-1), /No Claude account limits/);
  failing.dispose();
  statusBar.dispose();
  console.log('Claude usage status smoke tests passed.');
} finally {
  delete globalThis.__claudeUsageTest;
  await rm(directory, { recursive: true, force: true });
}
