import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-session-store-test-'));
const bundlePath = join(directory, 'claudeSessionStore.mjs');

try {
  await build({
    entryPoints: ['src/providers/claude/sessionStore.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath
  });
  const { ClaudeSessionStore } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const store = new ClaudeSessionStore(2, 1000);
  const envelope = { model: 'sonnet', effort: 'high', tools: [{ name: 'read' }] };
  const firstTurn = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }
  ];
  store.record('session-1', firstTurn, envelope, 1000);
  const continuation = store.resolve([
    ...firstTurn,
    { role: 'user', content: 'Continue' }
  ], { tools: [{ name: 'read' }], effort: 'high', model: 'sonnet' }, 1500);
  assert.deepEqual(continuation, {
    sessionId: 'session-1',
    appendedMessages: [{ role: 'user', content: 'Continue' }]
  });

  // VS Code may replay the assistant turn with different whitespace between text and tool-call parts.
  store.record('session-ws', [
    { role: 'user', content: 'Read it' },
    { role: 'assistant', content: 'Reading.\n[Tool call c1: read]\n{"path":"a"}' }
  ], envelope, 1000);
  assert.deepEqual(store.resolve([
    { role: 'user', content: 'Read it' },
    { role: 'assistant', content: 'Reading.\n\n[Tool call c1: read]\n{"path":"a"}\n' },
    { role: 'user', content: '[Tool result for c1]\nok' }
  ], envelope, 1200), {
    sessionId: 'session-ws',
    appendedMessages: [{ role: 'user', content: '[Tool result for c1]\nok' }]
  });
  // User content stays exact apart from line endings.
  assert.equal(store.resolve([
    { role: 'user', content: 'Read  it' },
    { role: 'assistant', content: 'Reading.\n[Tool call c1: read]\n{"path":"a"}' },
    { role: 'user', content: 'Next' }
  ], envelope, 1200), undefined);
  assert.equal(store.resolve([
    { role: 'user', content: 'Read it' },
    { role: 'assistant', content: 'Reading.\r\n[Tool call c1: read]\r\n{"path":"a"}' },
    { role: 'user', content: 'Next' }
  ], envelope, 1200)?.sessionId, 'session-ws');
  store.clear();
  store.record('session-1', firstTurn, envelope, 1000);

  assert.equal(store.resolve([...firstTurn, { role: 'user', content: 'Fork' }], { ...envelope, effort: 'max' }, 1500), undefined);
  assert.equal(store.resolve([{ role: 'user', content: 'Different' }], envelope, 1500), undefined);
  assert.equal(store.resolve([...firstTurn, { role: 'user', content: 'Expired' }], envelope, 2501), undefined);

  store.record('session-2', firstTurn, envelope, 3000);
  store.record('session-3', firstTurn, envelope, 3001);
  store.record('session-4', firstTurn, envelope, 3002);
  assert.equal(store.size, 2);
  store.clear();
  assert.equal(store.size, 0);
  console.log('Claude session store smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
