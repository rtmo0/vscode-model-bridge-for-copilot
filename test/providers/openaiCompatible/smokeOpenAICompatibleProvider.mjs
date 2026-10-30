import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-openai-compatible-provider-'));
const bundlePath = join(directory, 'openAICompatibleProvider.mjs');
const requests = [];
let showCalls = 0;

// One server hosts every server type under its own path prefix.
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
  const json = (value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };

  switch (`${request.method} ${request.url}`) {
    case 'GET /ollama/api/tags':
      return json({ models: [
        { name: 'qwen3:8b', model: 'qwen3:8b', digest: 'd1', details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
        { name: 'llava:7b', model: 'llava:7b', digest: 'd2', details: { family: 'llama' } },
        { name: 'nomic-embed-text', model: 'nomic-embed-text', digest: 'd3', details: {} }
      ] });
    case 'GET /ollama/api/ps':
      return json({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 16384 }] });
    case 'POST /ollama/api/show': {
      showCalls += 1;
      const shows = {
        'qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } },
        'llava:7b': { capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 } },
        'nomic-embed-text': { capabilities: ['embedding'], model_info: {} }
      };
      return json(shows[body.model] ?? {}, shows[body.model] ? 200 : 404);
    }
    case 'GET /llamacpp/v1/models':
      return json({ object: 'list', data: [{ id: 'gemma.gguf', meta: { n_ctx_train: 131072 } }] });
    case 'GET /llamacpp/props':
      return json({ default_generation_settings: { n_ctx: 8192 }, modalities: { vision: true }, chat_template_caps: { supports_tool_calls: true } });
    case 'GET /vllm/v1/models':
      return json({ object: 'list', data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 65536, owned_by: 'vllm' }] });
    case 'GET /router/v1/models':
      return json({ data: [
        { id: 'vendor/tool-model', name: 'Tool Model', context_length: 200000, supported_parameters: ['tools', 'temperature'], architecture: { input_modalities: ['text', 'image'] } },
        { id: 'vendor/plain-model', context_length: 8000 }
      ] });
    case 'POST /ollama/v1/chat/completions':
    case 'POST /vllm/v1/chat/completions':
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"reasoning":"Plan"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"<think>inline</think>\\n\\nAnswer"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n');
      return response.end('data: [DONE]\n\n');
    default:
      response.writeHead(404).end();
  }
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.__openAICompatibleSettings = {
    endpoints: [
      { name: 'Ollama', type: 'ollama', baseURL: `${origin}/ollama/v1/`, contextSize: 32768 },
      { name: 'Llama', type: 'llamacpp', baseURL: `${origin}/llamacpp/v1` },
      { name: 'vLLM', type: 'vllm', baseURL: `${origin}/vllm/v1` },
      { name: 'Router', type: 'openai', baseURL: `${origin}/router/v1`, models: ['vendor/tool-model', 'vendor/plain-model'] },
      { name: 'Ollama', type: 'ollama', baseURL: `${origin}/duplicate/v1` },
      { name: 'Broken', baseURL: 'ftp://example.com' },
      { name: 'Down', type: 'vllm', baseURL: 'http://127.0.0.1:1/v1' }
    ]
  };
  await build({
    entryPoints: ['src/providers/openaiCompatible/provider.ts'],
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
            globalThis.__openAICompatibleVscodeTest = { LanguageModelTextPart };
            export const LanguageModelChatMessageRole={User:1,Assistant:2};
            export const LanguageModelChatMessage={ User(text){ return { role: 1, name: undefined, content: [new LanguageModelTextPart(text)] }; } };
            export const LanguageModelChatToolMode={Auto:1,Required:2};
            export const commands={async executeCommand(){}};
            export const window={
              warnings: [],
              async showWarningMessage(message){ this.warnings.push(message); return undefined; },
              async showInformationMessage(){ return undefined; }
            };
            globalThis.__openAICompatibleWindow = window;
            export const workspace={getConfiguration(){return {get(key,fallback){
              const value = globalThis.__openAICompatibleSettings[key];
              return value === undefined ? fallback : value;
            }}}};
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const secrets = new Map();
  const context = { secrets: {
    async get(key) { return secrets.get(key); },
    async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); }
  } };
  const output = { info() {}, warn() {} };
  const provider = new module.OpenAICompatibleModelProvider(context, output);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

  const config = module.getOpenAICompatibleConfig();
  assert.deepEqual(config.endpoints.map((endpoint) => endpoint.name), ['Ollama', 'Llama', 'vLLM', 'Router', 'Down']);
  assert.deepEqual(config.invalidEndpoints, ['Ollama (duplicate name)', '#6']);
  assert.equal(config.endpoints[0].baseURL, `${origin}/ollama/v1`, 'trailing slashes are removed');

  const ollama = config.endpoints[0];
  await provider.setApiToken(ollama, 'secret-token');

  const models = await provider.provideLanguageModelChatInformation({ silent: false }, token);
  const byName = Object.fromEntries(models.map((model) => [model.name, model]));
  assert.deepEqual(models.map((model) => model.name), ['qwen3:8b', 'llava:7b', 'gemma.gguf', 'Qwen/Qwen3-32B', 'Tool Model', 'vendor/plain-model']);

  // Ollama: loaded context from /api/ps, capped maximum for unloaded models, capabilities from /api/show.
  const qwen = byName['qwen3:8b'];
  assert.equal(qwen.maxInputTokens + qwen.maxOutputTokens, 16384);
  assert.equal(qwen.capabilities.toolCalling, true);
  assert.equal(qwen.capabilities.imageInput, false);
  assert.deepEqual(qwen.configurationSchema.properties.reasoningEffort.enum, ['on', 'off', 'low', 'medium', 'high']);
  assert.match(qwen.detail, /^Ollama · 16K context · tools · reasoning$/);
  const llava = byName['llava:7b'];
  assert.equal(llava.maxInputTokens + llava.maxOutputTokens, 4096);
  assert.equal(llava.capabilities.toolCalling, false);
  assert.equal(llava.capabilities.imageInput, true);
  assert.equal(llava.configurationSchema.properties.reasoningEffort, undefined);
  assert(requests.filter((entry) => entry.url.startsWith('/ollama/')).every((entry) => entry.authorization === 'Bearer secret-token'));
  assert(requests.filter((entry) => !entry.url.startsWith('/ollama/')).every((entry) => entry.authorization === undefined), 'tokens stay with their endpoint');

  // llama.cpp: served context from /props, not n_ctx_train.
  const gemma = byName['gemma.gguf'];
  assert.equal(gemma.maxInputTokens + gemma.maxOutputTokens, 8192);
  assert.equal(gemma.capabilities.toolCalling, true);
  assert.equal(gemma.capabilities.imageInput, true);

  // vLLM and generic servers: tools only when metadata says so.
  const vllm = byName['Qwen/Qwen3-32B'];
  assert.equal(vllm.maxInputTokens + vllm.maxOutputTokens, 65536);
  assert.equal(vllm.capabilities.toolCalling, false);
  assert.equal(byName['Tool Model'].capabilities.toolCalling, true);
  assert.equal(byName['Tool Model'].capabilities.imageInput, true);
  assert.equal(byName['Tool Model'].maxInputTokens + byName['Tool Model'].maxOutputTokens, 200000);
  assert.equal(byName['vendor/plain-model'].capabilities.toolCalling, false);

  // The unreachable endpoint is reported once and does not hide the others.
  const warnings = globalThis.__openAICompatibleWindow.warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Down \(Cannot reach Down/);

  // Show results are cached by digest.
  const showsBefore = showCalls;
  await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(showCalls, showsBefore);

  const { LanguageModelTextPart: TextPart } = globalThis.__openAICompatibleVscodeTest;
  const parts = [];
  await provider.provideLanguageModelChatResponse(qwen, [{ role: 1, name: undefined, content: [new TextPart('Hi')] }],
    { modelOptions: { reasoningEffort: 'off' }, tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], toolMode: 1 },
    { report: (part) => parts.push(part) }, token);
  const chat = requests.findLast((entry) => entry.url === '/ollama/v1/chat/completions');
  assert.equal(chat.body.model, 'qwen3:8b');
  assert.equal(chat.body.reasoning_effort, 'none');
  assert.equal(chat.body.tool_choice, 'auto');
  assert.equal(chat.authorization, 'Bearer secret-token');
  assert.deepEqual(parts.filter((part) => part.thinking).map((part) => part.value), ['Plan', 'inline']);
  assert.deepEqual(parts.filter((part) => !part.thinking && typeof part.value === 'string').map((part) => part.value), ['Answer']);
  assert(parts.some((part) => part.name === 'lookup' && part.callId === 'call_1'));
  assert(parts.some((part) => part.mimeType === 'usage' && part.value.total_tokens === 8));

  await provider.provideLanguageModelChatResponse(vllm, [{ role: 1, name: undefined, content: [new TextPart('Hi')] }],
    { modelOptions: { reasoningEffort: 'high' } }, { report() {} }, token);
  const vllmChat = requests.findLast((entry) => entry.url === '/vllm/v1/chat/completions');
  assert.equal(vllmChat.body.model, 'Qwen/Qwen3-32B');
  assert.equal(vllmChat.body.reasoning_effort, undefined, 'models without a reasoning capability send no effort');
  assert.equal(vllmChat.authorization, undefined);

  // Endpoint overrides win over metadata; the token is bound to the URL, so a moved endpoint loses it.
  globalThis.__openAICompatibleSettings = {
    endpoints: [{ name: 'Ollama', type: 'vllm', baseURL: `${origin}/vllm/v1`, toolCalling: true }]
  };
  provider.refresh();
  const overridden = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(overridden[0].capabilities.toolCalling, true);
  assert.equal(requests.at(-1).authorization, undefined);

  await assert.rejects(
    provider.provideLanguageModelChatResponse({ ...qwen, id: 'oai::Missing::model' }, [], {}, { report() {} }, token),
    /"Missing" is no longer configured/
  );

  const statuses = await provider.getStatus();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].reachable, true);
  assert.equal(statuses[0].hasToken, false);
  provider.dispose();
  console.log('OpenAI-compatible provider smoke tests passed.');
} finally {
  delete globalThis.__openAICompatibleSettings;
  delete globalThis.__openAICompatibleVscodeTest;
  delete globalThis.__openAICompatibleWindow;
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
