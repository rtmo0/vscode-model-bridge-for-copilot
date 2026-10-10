import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-for-copilot-cli-test-'));
const bundlePath = join(directory, 'claudeCli.mjs');
const fakeCliPath = join(directory, 'fake-claude.mjs');
const recordPath = join(directory, 'record.json');

try {
  await writeFile(fakeCliPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('API credential leaked to Claude process');
  process.exit(9);
}
if (args[0] === '--version') {
  console.log('2.1.300 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ authMethod: 'claude.ai', email: 'signed-in@example.test' }));
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const flagIndex = args.indexOf('--append-system-prompt-file');
const systemPromptPath = args[flagIndex + 1];
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
  args,
  prompt,
  systemPromptPath,
  systemPrompt: readFileSync(systemPromptPath, 'utf8')
}));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello from Claude' } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from Claude' }));
`, { mode: 0o755 });
  await chmod(fakeCliPath, 0o755);

  await build({
    entryPoints: ['src/claudeCli.ts'],
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
          contents: 'export class CancellationError extends Error {}',
          loader: 'js'
        }));
      }
    }]
  });
  const cli = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-leak';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-leak';
  process.env.FAKE_CLAUDE_RECORD = recordPath;

  const status = await cli.getClaudeCliStatus(fakeCliPath);
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'claude.ai');
  assert.equal(status.account, 'signed-in@example.test');

  const output = [];
  await cli.streamClaudeResponse({
    executable: fakeCliPath,
    model: 'sonnet',
    prompt: '<user>\nHello\n</user>',
    systemPrompt: 'System instructions',
    markerNonce: 'nonce',
    allowedTools: new Set(),
    callbacks: { onText: (text) => output.push(text) },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }
  });
  assert.equal(output.join(''), 'Hello from Claude');

  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.prompt, '<user>\nHello\n</user>');
  assert.equal(record.systemPrompt, 'System instructions');
  assert(record.args.includes('--bare'));
  assert(record.args.includes('--no-session-persistence'));
  assert(record.args.includes('--include-partial-messages'));
  assert.deepEqual(record.args.slice(record.args.indexOf('--tools'), record.args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--model'), record.args.indexOf('--model') + 2), ['--model', 'sonnet']);
  await assert.rejects(access(record.systemPromptPath, constants.F_OK));

  console.log('Claude CLI smoke tests passed.');
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.FAKE_CLAUDE_RECORD;
  await rm(directory, { recursive: true, force: true });
}
