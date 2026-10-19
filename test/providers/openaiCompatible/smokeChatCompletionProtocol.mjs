import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-chat-completion-protocol-'));
const bundlePath = join(directory, 'chatCompletionProtocol.mjs');

try {
  await build({
    entryPoints: ['src/providers/openaiCompatible/protocol.ts'],
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
  const parser = new protocol.ChatCompletionStreamParser({
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
  const resilientParser = new protocol.ChatCompletionStreamParser({
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
  const splitParser = new protocol.ChatCompletionStreamParser({ onText: (value) => splitText.push(value) });
  splitParser.push('data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r');
  splitParser.push('\ndata: {"choices":[{"delta":{"content":"B"}}]}\r\n\r\n');
  splitParser.finish();
  assert.equal(splitText.join(''), 'AB');

  // A leading <think> block, split at awkward chunk boundaries, becomes reasoning; the answer loses the separator.
  const thinkText = [];
  const thinkReasoning = [];
  const thinkParser = new protocol.ChatCompletionStreamParser({
    onText: (value) => thinkText.push(value),
    onReasoning: (value) => thinkReasoning.push(value)
  });
  for (const piece of ['\n<th', 'ink>Step one', ' and two</thi', 'nk>', '\n\n', 'Final answer', ' <think>stays</think>']) {
    thinkParser.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  thinkParser.finish();
  assert.equal(thinkReasoning.join(''), 'Step one and two');
  assert.equal(thinkText.join(''), 'Final answer <think>stays</think>');

  // Text that only starts like a tag stays text, and an unclosed block at the end is reasoning.
  const tagLikeText = [];
  const tagLikeParser = new protocol.ChatCompletionStreamParser({ onText: (value) => tagLikeText.push(value), onReasoning() {} });
  tagLikeParser.push('data: {"choices":[{"delta":{"content":"<th"}}]}\n\n');
  tagLikeParser.push('data: {"choices":[{"delta":{"content":"ree>"}}]}\n\n');
  tagLikeParser.finish();
  assert.equal(tagLikeText.join(''), '<three>');
  const truncatedReasoning = [];
  const truncatedParser = new protocol.ChatCompletionStreamParser({ onText() { assert.fail('no text expected'); }, onReasoning: (value) => truncatedReasoning.push(value) });
  truncatedParser.push('data: {"choices":[{"delta":{"content":"<think>cut off </"}}]}\n\n');
  truncatedParser.finish();
  assert.equal(truncatedReasoning.join(''), 'cut off </');

  // Disabled tag parsing keeps content verbatim.
  const rawText = [];
  const rawParser = new protocol.ChatCompletionStreamParser({ onText: (value) => rawText.push(value) }, { parseThinkTags: false });
  rawParser.push('data: {"choices":[{"delta":{"content":"<think>x</think>y"}}]}\n\n');
  rawParser.finish();
  assert.equal(rawText.join(''), '<think>x</think>y');

  // Ollama and newer vLLM stream reasoning in `reasoning` instead of `reasoning_content`.
  const fieldReasoning = [];
  const fieldParser = new protocol.ChatCompletionStreamParser({ onText() {}, onReasoning: (value) => fieldReasoning.push(value) });
  fieldParser.push('data: {"choices":[{"delta":{"reasoning":"Ollama "}}]}\n\n');
  fieldParser.push('data: {"choices":[{"delta":{"reasoning_content":"vLLM"}}]}\n\n');
  fieldParser.finish();
  assert.equal(fieldReasoning.join(''), 'Ollama vLLM');

  const detailedUsage = [];
  const usageParser = new protocol.ChatCompletionStreamParser({ onText() {}, onUsage: (value) => detailedUsage.push(value) });
  usageParser.push('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":12}}}\n\n');
  usageParser.finish();
  assert.deepEqual(detailedUsage, [{ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 80, reasoningTokens: 12 }]);
  console.log('Chat completion protocol smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
