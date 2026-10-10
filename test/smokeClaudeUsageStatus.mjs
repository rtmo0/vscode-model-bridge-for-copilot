import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-for-copilot-usage-test-'));
const bundlePath = join(directory, 'claudeUsageStatusBar.mjs');

try {
  await build({
    entryPoints: ['src/claudeUsageStatusBar.ts'],
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
            globalThis.__claudeUsageTest = { item, messages: [] };
            export const StatusBarAlignment = { Right: 2 };
            export class MarkdownString {
              constructor() { this.value = ''; }
              appendMarkdown(value) { this.value += value; }
            }
            export const window = {
              createStatusBarItem() { return item; },
              async showInformationMessage(message) {
                globalThis.__claudeUsageTest.messages.push(message);
              }
            };
            export const workspace = {
              getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
            };
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const values = new Map();
  const context = {
    globalState: {
      get(key) { return values.get(key); },
      async update(key, value) { values.set(key, value); }
    }
  };
  const statusBar = new module.ClaudeUsageStatusBar(context);
  statusBar.setAccount('developer@example.test');
  statusBar.record({
    fiveHour: { utilization: 0.25, resetsAt: 1791667200 },
    sevenDay: { utilization: 0.4, resetsAt: 1792123200 },
    inputTokens: 2,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    outputTokens: 9,
    thinkingTokens: 4,
    model: 'claude-sonnet-5-5',
    contextWindow: 1000000,
    totalCostUsd: 0.0123
  });

  const shim = globalThis.__claudeUsageTest;
  assert.equal(shim.item.visible, true);
  assert.equal(shim.item.text, '$(pulse) Claude 5h 75% · 7d 60%');
  assert.match(shim.item.tooltip.value, /75% remaining/);
  assert.match(shim.item.tooltip.value, /developer@example\\.test/);
  assert(values.has('anthropicForCopilot.usageSnapshot'));

  await statusBar.showDetails();
  assert.match(shim.messages.at(-1), /5-hour window: 25% used/);
  assert.match(shim.messages.at(-1), /Latest output: 9/);
  statusBar.clear();
  assert.equal(shim.item.text, '$(pulse) Claude Usage');
  assert.equal(values.get('anthropicForCopilot.usageSnapshot'), undefined);
  statusBar.dispose();
  console.log('Claude usage status smoke tests passed.');
} finally {
  delete globalThis.__claudeUsageTest;
  await rm(directory, { recursive: true, force: true });
}
