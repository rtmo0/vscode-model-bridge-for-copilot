import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-for-copilot-test-'));
const bundlePath = join(directory, 'claudeProtocol.mjs');

try {
  await build({
    entryPoints: ['src/claudeProtocol.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath
  });
  const protocol = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

  assert.equal(protocol.toProviderModelId('sonnet'), 'anthropic::sonnet');
  assert.equal(protocol.parseProviderModelId('anthropic::opus', 'default'), 'opus');
  assert.equal(protocol.parseProviderModelId('', 'default'), 'default');

  const prompt = protocol.buildClaudePrompt([
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }
  ]);
  assert.match(prompt, /<user>\nHello\n<\/user>/);
  assert.match(prompt, /<assistant>\nHi\n<\/assistant>/);

  const nonce = 'testnonce';
  const tools = [{ name: 'lookup', description: 'Look something up', inputSchema: { type: 'object' } }];
  const systemPrompt = protocol.buildClaudeSystemPrompt('Be helpful.', tools, nonce, true);
  assert.match(systemPrompt, /Claude Code's own tools are disabled/);
  assert.match(systemPrompt, /must call at least one catalog tool/);
  assert.match(systemPrompt, /multiple tool requests/);
  assert.match(systemPrompt, /"name":"lookup"/);
  assert(protocol.CLAUDE_MODELS.some((model) => model.id === 'best'));
  assert(protocol.CLAUDE_MODELS.some((model) => model.id === 'fable'));

  const text = [];
  const calls = [];
  const toolParser = new protocol.ClaudeToolProtocolParser(nonce, new Set(['lookup']), {
    onText: (value) => text.push(value),
    onToolCall: (call) => calls.push(call)
  });
  const start = protocol.toolStartMarker(nonce);
  const end = protocol.toolEndMarker(nonce);
  toolParser.push(`Before ${start.slice(0, 8)}`);
  toolParser.push(`${start.slice(8)}{"name":"lookup","arguments":{"query":"docs"}}${end.slice(0, 10)}`);
  toolParser.push(end.slice(10));
  toolParser.finish();
  assert.equal(text.join(''), 'Before ');
  assert.deepEqual(calls, [{ name: 'lookup', arguments: { query: 'docs' } }]);

  const streamedText = [];
  const thinking = [];
  const usageUpdates = [];
  const sessionIds = [];
  const streamToolParser = new protocol.ClaudeToolProtocolParser(nonce, new Set(), {
    onText: (value) => streamedText.push(value)
  });
  const streamParser = new protocol.ClaudeStreamJsonParser(streamToolParser, {
    onText: (value) => streamedText.push(value),
    onThinking: (value) => thinking.push(value),
    onUsage: (value) => usageUpdates.push(value),
    onSessionId: (value) => sessionIds.push(value)
  });
  streamParser.push('{"type":"system","subtype":"init","session_id":"session-test"}\n');
  streamParser.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Plan"}}}\n');
  streamParser.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}\n');
  streamParser.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}}\n');
  streamParser.push('{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":1791667200},"seven_day":{"utilization":0.4,"resetsAt":1792123200}},"isUsingOverage":false,"overageStatus":"rejected"}}\n');
  streamParser.push('{"type":"result","subtype":"success","is_error":false,"result":"Hello Claude","total_cost_usd":0.0123,"usage":{"input_tokens":2,"output_tokens":9,"cache_creation_input_tokens":100,"cache_read_input_tokens":200,"output_tokens_details":{"thinking_tokens":4}},"modelUsage":{"claude-haiku-5-5":{"costUSD":0.0001,"contextWindow":1000000,"maxOutputTokens":128000},"claude-sonnet-5-5":{"costUSD":0.0122,"contextWindow":1000000,"maxOutputTokens":128000}}}\n');
  streamParser.finish();
  assert.equal(streamedText.join(''), 'Hello Claude');
  assert.equal(thinking.join(''), 'Plan');
  assert.deepEqual(sessionIds, ['session-test']);
  assert.deepEqual(usageUpdates[0], {
    fiveHour: { utilization: 0.25, resetsAt: 1791667200 },
    sevenDay: { utilization: 0.4, resetsAt: 1792123200 },
    isUsingOverage: false,
    overageStatus: 'rejected'
  });
  assert.deepEqual(usageUpdates[1], {
    inputTokens: 2,
    outputTokens: 9,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    thinkingTokens: 4,
    totalCostUsd: 0.0123,
    model: 'claude-sonnet-5-5',
    contextWindow: 1000000,
    maxOutputTokens: 128000
  });

  const errorParser = new protocol.ClaudeStreamJsonParser(
    new protocol.ClaudeToolProtocolParser(nonce, new Set(), { onText() {} }),
    { onText() {} }
  );
  errorParser.push('{"type":"result","subtype":"error","is_error":true,"result":"Not signed in"}\n');
  assert.throws(() => errorParser.finish(), /Not signed in/);

  console.log('Claude protocol smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
