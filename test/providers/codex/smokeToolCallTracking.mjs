import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-codex-tool-tracking-'));
const bundlePath = join(directory, 'toolCallTracking.mjs');

try {
  await build({
    entryPoints: ['src/providers/codex/toolCallTracking.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    plugins: [{
      name: 'vscode-test-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
      }
    }]
  });
  const { ReportedToolCallTracker, ToolOutputContinuationCapabilities } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

  const tracker = new ReportedToolCallTracker();
  const now = Date.now();
  tracker.remember('call_a', 'read_file', now - 1_000);
  tracker.remember('call_old', 'list', now - 11 * 60_000);
  tracker.markResponseCompleted(new Set(['call_a']), now - 500);
  const observed = tracker.consumeResults([
    { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
    { type: 'function_call_output', call_id: 'call_old', output: 'late' },
    { type: 'function_call_output', call_id: 'call_unknown', output: 'x' },
    { type: 'message', role: 'user', content: 'hi' }
  ]);
  assert.equal(observed.length, 1, 'only fresh, reported calls are observed');
  assert.equal(observed[0].callId, 'call_a');
  assert.equal(observed[0].name, 'read_file');
  assert(observed[0].reportedToResultObservedMs >= 1_000);
  assert(observed[0].responseCompletedToResultObservedMs >= 500);
  assert.equal(tracker.consumeResults([{ type: 'function_call_output', call_id: 'call_a', output: 'ok' }]).length, 0, 'results are consumed once');

  for (let index = 0; index < 205; index += 1) tracker.remember(`call_${index}`, 'tool', now);
  assert.equal(tracker.consumeResults([{ type: 'function_call_output', call_id: 'call_0', output: '' }]).length, 0, 'oldest pending calls are evicted');
  assert.equal(tracker.consumeResults([{ type: 'function_call_output', call_id: 'call_204', output: '' }]).length, 1);

  const capabilities = new ToolOutputContinuationCapabilities();
  assert.equal(capabilities.get('endpoint'), undefined);
  capabilities.record('endpoint', false);
  assert.equal(capabilities.get('endpoint'), false);
  for (let index = 0; index < 70; index += 1) capabilities.record(`key_${index}`, true);
  assert.equal(capabilities.get('endpoint'), undefined, 'capabilities are bounded');
  assert.equal(capabilities.get('key_69'), true);
  console.log('Smoke test passed: Codex tool-call tracking and continuation capabilities are correct.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
