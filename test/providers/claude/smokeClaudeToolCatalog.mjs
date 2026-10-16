import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-tool-catalog-test-'));
const bundlePath = join(directory, 'claudeToolCatalog.mjs');

const tool = (name, description = `${name} tool`) => ({ name, description, inputSchema: { type: 'object' } });

try {
  await build({
    entryPoints: ['src/providers/claude/toolCatalog.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath
  });
  const { ClaudeToolCatalogStore } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const store = new ClaudeToolCatalogStore(4, 1000, 2);
  const root = [
    { role: 'system', content: 'Copilot rules' },
    { role: 'user', content: 'Fix the bug' }
  ];

  // First request: the current tools become the conversation's base catalog.
  const first = store.plan(root, [tool('a'), tool('b')], 0);
  assert.deepEqual(first.catalogTools.map((entry) => entry.name), ['a', 'b']);
  assert.deepEqual(first.messages, root);
  assert.equal(first.updateCount, 0);

  // A tool appears mid-loop: the system-prompt catalog stays, the change is appended in place.
  const step2 = [...root, { role: 'assistant', content: 'Calling a' }, { role: 'user', content: 'result a' }];
  const second = store.plan(step2, [tool('a'), tool('b'), tool('c')], 10);
  assert.deepEqual(second.catalogTools.map((entry) => entry.name), ['a', 'b']);
  assert.equal(second.updateCount, 1);
  assert.equal(second.messages.length, step2.length + 1);
  assert.deepEqual(second.messages.slice(0, step2.length), step2);
  const update = second.messages.at(-1);
  assert.equal(update.role, 'system');
  assert.match(update.content, /Added or changed tools:\n\[\{"name":"c"/);
  assert.doesNotMatch(update.content, /Removed tools/);

  // The next request keeps the update at the same position, so the prompt prefix is byte-identical.
  const step3 = [...step2, { role: 'assistant', content: 'Calling c' }, { role: 'user', content: 'result c' }];
  const third = store.plan(step3, [tool('a'), tool('b'), tool('c')], 20);
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages);
  assert.deepEqual(third.messages.slice(second.messages.length), step3.slice(step2.length));
  assert.equal(third.updateCount, 1);

  // Removal and a changed definition are appended too, without touching the base catalog.
  const fourth = store.plan(step3, [tool('a', 'a tool, revised'), tool('c')], 30);
  assert.deepEqual(fourth.catalogTools.map((entry) => entry.name), ['a', 'b']);
  assert.equal(fourth.updateCount, 2);
  assert.match(fourth.messages.at(-1).content, /"name":"a","description":"a tool, revised"/);
  assert.match(fourth.messages.at(-1).content, /Removed tools, do not call them: b/);

  // Beyond the update limit the catalog is rebuilt from the current tools.
  const step4 = [...step3, { role: 'assistant', content: 'Done' }, { role: 'user', content: 'More' }];
  const fifth = store.plan(step4, [tool('d')], 40);
  assert.deepEqual(fifth.catalogTools.map((entry) => entry.name), ['d']);
  assert.equal(fifth.updateCount, 0);
  assert.deepEqual(fifth.messages, step4);

  // A diverged branch drops updates recorded after the divergence point.
  store.plan(step2, [tool('d'), tool('e')], 50);
  const diverged = [...root, { role: 'assistant', content: 'Other path' }, { role: 'user', content: 'result x' }];
  const sixth = store.plan(diverged, [tool('d')], 60);
  assert.equal(sixth.updateCount, 0);
  assert.deepEqual(sixth.messages, diverged);

  // Requests without tools, or without a user message, pass through unchanged.
  assert.deepEqual(store.plan(root, [], 70).messages, root);
  assert.deepEqual(store.plan([{ role: 'system', content: 'Only system' }], [tool('a')], 70).catalogTools.map((entry) => entry.name), ['a']);

  // Entries expire and are bounded.
  assert.equal(store.plan(step2, [tool('z')], 5000).updateCount, 0);
  for (let index = 0; index < 6; index += 1) {
    store.plan([{ role: 'user', content: `conversation ${index}` }], [tool('a')], 6000);
  }
  assert.equal(store.size, 4);
  store.clear();
  assert.equal(store.size, 0);
  console.log('Claude tool catalog smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
