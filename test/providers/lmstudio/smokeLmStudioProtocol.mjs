import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-lmstudio-protocol-'));
const bundlePath = join(directory, 'lmStudioProtocol.mjs');

try {
  await build({
    entryPoints: ['src/providers/lmstudio/protocol.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath
  });
  const protocol = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  const usages = [];
  const parser = new protocol.LmStudioChatStreamParser({
    onText: (value) => text.push(value),
    onReasoning: (value) => reasoning.push(value),
    onToolCall: (value) => toolCalls.push(value),
    onUsage: (value) => usages.push(value)
  });

  parser.push('data: {"choices":[{"delta":{"reasoning_content":"Plan "}}]}\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
  parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":"}}]}}]}\n\n');
  parser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs\\"}"}}]}}]}\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
  parser.push('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n');
  parser.push('data: [DONE]\n\n');
  parser.finish();

  assert.equal(text.join(''), 'Hello world');
  assert.equal(reasoning.join(''), 'Plan ');
  assert.deepEqual(toolCalls, [{ id: 'call_1', name: 'lookup', arguments: { query: 'docs' } }]);
  assert.deepEqual(usages, [{ promptTokens: 12, completionTokens: 7, totalTokens: 19 }]);
  assert.deepEqual(protocol.parseToolArguments('{}'), {});
  assert.throws(() => protocol.parseToolArguments('[]'), /JSON object/);
  assert.throws(() => protocol.parseToolArguments('{bad'), /invalid tool arguments/);

  const resilientText = [];
  const resilientCalls = [];
  const resilientParser = new protocol.LmStudioChatStreamParser({
    onText: (value) => resilientText.push(value),
    onToolCall: (value) => resilientCalls.push(value)
  });
  // Repeated id/name deltas, a missing id, and malformed arguments.
  resilientParser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_r","function":{"name":"read","arguments":"{\\"a\\":"}}]}}]}\n\n');
  resilientParser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_r","function":{"name":"read","arguments":"1}"}}]}}]}\n\n');
  resilientParser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"list","arguments":"{}"}}]}}]}\n\n');
  resilientParser.push('data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_bad","function":{"name":"write","arguments":"{bad"}}]}}]}\n\n');
  resilientParser.finish();
  assert.equal(resilientCalls.length, 2);
  assert.deepEqual(resilientCalls[0], { id: 'call_r', name: 'read', arguments: { a: 1 } });
  assert.equal(resilientCalls[1].name, 'list');
  assert.match(resilientCalls[1].id, /^call_[0-9a-f-]{36}$/);
  assert.match(resilientText.join(''), /Skipped tool call "write"/);

  const splitText = [];
  const splitParser = new protocol.LmStudioChatStreamParser({ onText: (value) => splitText.push(value) });
  splitParser.push('data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r');
  splitParser.push('\ndata: {"choices":[{"delta":{"content":"B"}}]}\r\n\r\n');
  splitParser.finish();
  assert.equal(splitText.join(''), 'AB');
  console.log('LM Studio protocol smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
