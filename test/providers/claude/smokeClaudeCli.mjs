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
let input = '';
for await (const chunk of process.stdin) input += chunk;
const inputLines = input.split('\\n').filter(Boolean);
const message = JSON.parse(inputLines[0]);
const promptBlocks = message.message.content.map((block) => block.text);
if (process.env.FAKE_CLAUDE_DELAY) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_DELAY)));
}
const flagIndex = Math.max(args.indexOf('--system-prompt-file'), args.indexOf('--append-system-prompt-file'));
const systemPromptPath = args[flagIndex + 1];
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
  args,
  inputLineCount: inputLines.length,
  messageType: message.type,
  messageRole: message.message.role,
  promptBlocks,
  systemPromptPath,
  systemPrompt: readFileSync(systemPromptPath, 'utf8')
}));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello from Claude' } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from Claude' }));
`, { mode: 0o755 });
  await chmod(fakeCliPath, 0o755);

  await build({
    entryPoints: ['src/providers/claude/cli.ts'],
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
  assert.equal(status.compatible, true);
  assert.equal(status.authMethod, 'claude.ai');
  assert.equal(status.account, 'signed-in@example.test');

  const output = [];
  await cli.streamClaudeResponse({
    executable: fakeCliPath,
    model: 'sonnet',
    effort: 'xhigh',
    contextSize: 500000,
    promptBlocks: ['<system>\nRules\n</system>', '<user>\nHello\n</user>'],
    systemPrompt: 'System instructions',
    systemPromptMode: 'minimal',
    markerNonce: 'nonce',
    allowedTools: new Set(),
    callbacks: { onText: (text) => output.push(text) },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    timeoutMs: 5000
  });
  assert.equal(output.join(''), 'Hello from Claude');

  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.inputLineCount, 1);
  assert.equal(record.messageType, 'user');
  assert.equal(record.messageRole, 'user');
  assert.deepEqual(record.promptBlocks, ['<system>\nRules\n</system>', '<user>\nHello\n</user>']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--input-format'), record.args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  assert(record.args.includes('--system-prompt-file'));
  assert(!record.args.includes('--append-system-prompt-file'));
  assert(!record.args.includes('--exclude-dynamic-system-prompt-sections'));
  assert.equal(record.systemPrompt, 'System instructions');
  assert(record.args.includes('--safe-mode'));
  assert(!record.args.includes('--bare'));
  assert(record.args.includes('--no-session-persistence'));
  assert(record.args.includes('--include-partial-messages'));
  assert.deepEqual(record.args.slice(record.args.indexOf('--permission-prompts'), record.args.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--tools'), record.args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--model'), record.args.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--effort'), record.args.indexOf('--effort') + 2), ['--effort', 'xhigh']);
  assert.deepEqual(record.args.slice(record.args.indexOf('--autocompact'), record.args.indexOf('--autocompact') + 2), ['--autocompact', '500k']);
  await assert.rejects(access(record.systemPromptPath, constants.F_OK));
  assert.equal(cli.isClaudeVersionAtLeast('2.1.296 (Claude Code)', '2.1.259'), true);
  assert.equal(cli.isClaudeVersionAtLeast('2.1.200', '2.1.259'), false);

  await cli.streamClaudeResponse({
    executable: fakeCliPath,
    model: 'default',
    effort: 'high',
    contextSize: 1000000,
    promptBlocks: ['New session'],
    systemPrompt: 'System instructions',
    systemPromptMode: 'claudeCode',
    markerNonce: 'nonce',
    allowedTools: new Set(),
    callbacks: { onText() {} },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    timeoutMs: 5000,
    persistSession: true,
    sessionId: '550e8400-e29b-41d4-a716-446655440000'
  });
  const sessionRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  assert(!sessionRecord.args.includes('--no-session-persistence'));
  assert(sessionRecord.args.includes('--append-system-prompt-file'));
  assert(sessionRecord.args.includes('--exclude-dynamic-system-prompt-sections'));
  assert(!sessionRecord.args.includes('--system-prompt-file'));
  assert.equal(sessionRecord.systemPrompt, 'System instructions');
  assert.deepEqual(sessionRecord.args.slice(sessionRecord.args.indexOf('--session-id'), sessionRecord.args.indexOf('--session-id') + 2), [
    '--session-id', '550e8400-e29b-41d4-a716-446655440000'
  ]);
  assert.deepEqual(sessionRecord.args.slice(sessionRecord.args.indexOf('--system-prompt-snapshot'), sessionRecord.args.indexOf('--system-prompt-snapshot') + 2), [
    '--system-prompt-snapshot', 'off'
  ]);

  process.env.FAKE_CLAUDE_DELAY = '1000';
  await assert.rejects(cli.streamClaudeResponse({
    executable: fakeCliPath,
    model: 'default',
    effort: 'high',
    contextSize: 100000,
    promptBlocks: ['Timeout'],
    systemPrompt: 'System instructions',
    systemPromptMode: 'minimal',
    markerNonce: 'nonce',
    allowedTools: new Set(),
    callbacks: { onText() {} },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    timeoutMs: 30
  }), /did not finish within 1 second/);
  delete process.env.FAKE_CLAUDE_DELAY;

  console.log('Claude CLI smoke tests passed.');
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.FAKE_CLAUDE_RECORD;
  delete process.env.FAKE_CLAUDE_DELAY;
  await rm(directory, { recursive: true, force: true });
}
