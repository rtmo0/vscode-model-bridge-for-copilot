import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-lmstudio-provider-'));
const bundlePath = join(directory, 'lmStudioProvider.mjs');
let receivedBody;
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      models: [{
        type: 'llm',
        key: 'local/qwen-test',
        display_name: 'Qwen Test',
        publisher: 'local',
        architecture: 'qwen',
        params_string: '7B',
        max_context_length: 65536,
        loaded_instances: [{ id: 'local/qwen-test', config: { context_length: 32768 } }],
        capabilities: { vision: false, trained_for_tool_use: true }
      }, {
        type: 'llm',
        key: 'local/unloaded',
        max_context_length: 131072,
        loaded_instances: [],
        capabilities: { vision: false, trained_for_tool_use: true }
      }]
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"Think"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"Local reply"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_local","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n');
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(404).end();
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  await build({
    entryPoints: ['src/providers/lmstudio/provider.ts'],
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
            export class EventEmitter { constructor(){ this.event=()=>({dispose(){}}); } fire(){} dispose(){} }
            export class CancellationError extends Error {}
            export class LanguageModelTextPart { constructor(value){ this.value=value; } }
            export class LanguageModelThinkingPart { constructor(value){ this.value=value; this.thinking=true; } }
            export class LanguageModelToolCallPart { constructor(callId,name,input){ Object.assign(this,{callId,name,input}); } }
            export class LanguageModelToolResultPart { constructor(callId,content){ Object.assign(this,{callId,content}); } }
            export class LanguageModelDataPart { constructor(data,mimeType){Object.assign(this,{data,mimeType});} static json(value,mimeType){return {value,mimeType};} }
            globalThis.__lmStudioVscodeTest = { LanguageModelTextPart, LanguageModelDataPart, LanguageModelToolCallPart, LanguageModelToolResultPart, CancellationError };
            export const LanguageModelChatMessageRole={User:1,Assistant:2};
            export const LanguageModelChatToolMode={Auto:1,Required:2};
            export const commands={async executeCommand(){}};
            export const env={async openExternal(){}};
            export class Uri { static parse(value){return value;} }
            export const window={async showWarningMessage(){}};
            export const workspace={getConfiguration(){return {get(key,fallback){return key==='baseURL'?${JSON.stringify(baseURL)}:fallback;}}}};
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const context = { secrets: { async get(){return undefined;}, async store(){}, async delete(){} } };
  const output = { info(){}, warn(){} };
  const provider = new module.LmStudioModelProvider(context, output);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(){} }) };
  const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'Qwen Test');
  assert.equal(models[0].maxInputTokens + models[0].maxOutputTokens, 32768);
  assert.equal(models[0].maxOutputTokens, 8192);
  assert.equal(models[1].maxInputTokens + models[1].maxOutputTokens, 32768, 'unloaded models use the configured context, not their maximum');
  assert.equal(models[0].capabilities.toolCalling, true);

  const parts = [];
  await provider.provideLanguageModelChatResponse(
    models[0],
    [{ role: 1, name: undefined, content: [] }],
    { tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], toolMode: 2 },
    { report: (part) => parts.push(part) },
    token
  );
  assert.equal(receivedBody.model, 'local/qwen-test');
  assert.equal(receivedBody.stream, true);
  assert.equal(receivedBody.tool_choice, 'required');
  assert.equal(receivedBody.stream_options.include_usage, true);
  assert(parts.some((part) => part.value === 'Local reply'));
  assert(parts.some((part) => part.thinking === true && part.value === 'Think'));
  assert(parts.some((part) => part.name === 'lookup' && part.callId === 'call_local'));
  assert(parts.some((part) => part.mimeType === 'usage' && part.value.total_tokens === 14));

  const { LanguageModelTextPart: TextPart } = globalThis.__lmStudioVscodeTest;
  await provider.provideLanguageModelChatResponse(
    models[0],
    [
      { role: 1, name: undefined, content: [new TextPart('Find it')] },
      { role: 2, name: undefined, content: [new globalThis.__lmStudioVscodeTest.LanguageModelToolCallPart('call_a', 'lookup', { q: 'x' })] },
      { role: 1, name: undefined, content: [new globalThis.__lmStudioVscodeTest.LanguageModelToolResultPart('call_a', [new TextPart('found')]), new TextPart('Continue')] }
    ],
    { tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], toolMode: 1 },
    { report() {} },
    token
  );
  assert.deepEqual(receivedBody.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(receivedBody.messages[1].content, null);
  assert.equal(receivedBody.messages[2].tool_call_id, 'call_a');

  const imagePart = new globalThis.__lmStudioVscodeTest.LanguageModelDataPart(new Uint8Array(100_000), 'image/png');
  const imageTokens = await provider.provideTokenCount(models[0], { role: 1, name: undefined, content: [imagePart] }, token);
  assert.equal(imageTokens, 1024);
  const cancelledToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose(){} }) };
  await assert.rejects(provider.provideTokenCount(models[0], { role: 1, name: undefined, content: [imagePart] }, cancelledToken));
  provider.dispose();
  console.log('LM Studio provider smoke tests passed.');
} finally {
  delete globalThis.__lmStudioVscodeTest;
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
