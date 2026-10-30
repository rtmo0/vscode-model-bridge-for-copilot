import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-deepseek-provider-'));
const bundlePath = join(directory, 'deepSeekProvider.mjs');
const requests = [];
let toolCalls = 0;
let balanceAvailable = true;

const sse = (response, events) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
};

// Behaves like the DeepSeek API: thinking is on unless disabled, and tool histories must carry their reasoning.
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
  const json = (value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== 'Bearer sk-deepseek') {
    return json({ error: { message: 'Authentication Fails, Your api key is invalid' } }, 401);
  }
  switch (`${request.method} ${request.url}`) {
    case 'GET /models':
      return json({ object: 'list', data: [
        { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-next', object: 'model', owned_by: 'deepseek' }
      ] });
    case 'GET /user/balance':
      return json({ is_available: balanceAvailable, balance_infos: [{ currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }] });
    case 'POST /chat/completions': {
      const thinking = body.thinking?.type !== 'disabled';
      const missing = body.messages.some((message) => message.role === 'assistant' && message.tool_calls && !message.reasoning_content);
      const lastUser = body.messages.findLast((message) => message.role === 'user');
      if (thinking && body.tools && (missing || lastUser?.content === 'Reject reasoning')) {
        return json({ error: { message: 'Missing `reasoning_content` field in the assistant message at message index 1.' } }, 400);
      }
      const afterTool = body.messages.at(-1)?.role === 'tool';
      return sse(response, [
        ...(thinking ? [{ choices: [{ delta: { reasoning_content: afterTool ? 'Wrap up' : 'Need lookup' } }] }] : []),
        afterTool || !body.tools
          ? { choices: [{ delta: { content: 'Done' } }] }
          : { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_ds_${toolCalls += 1}`, function: { name: 'lookup', arguments: '{}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000, prompt_cache_hit_tokens: 800_000, prompt_cache_miss_tokens: 200_000 } }
      ]);
    }
    default:
      response.writeHead(404).end();
  }
});

const vscodeShim = {
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
        export const LanguageModelChatMessageRole={User:1,Assistant:2};
        export const LanguageModelChatMessage={ User(text){ return { role: 1, name: undefined, content: [new LanguageModelTextPart(text)] }; } };
        export const LanguageModelChatToolMode={Auto:1,Required:2};
        export const StatusBarAlignment={Left:1,Right:2};
        export const QuickPickItemKind={Separator:-1};
        export const Disposable={ from(...items){ return { dispose(){ items.forEach((item) => item.dispose?.()); } }; } };
        export const commands={ executed: [], async executeCommand(command){ this.executed.push(command); } };
        export const window={
          messages: [],
          statusItem: undefined,
          async showInformationMessage(message){ this.messages.push(message); return undefined; },
          async showWarningMessage(message){ this.messages.push(message); return undefined; },
          async showQuickPick(items){ this.picked = items; return undefined; },
          createStatusBarItem(){ return this.statusItem = { text: '', tooltip: '', visible: false, show(){ this.visible=true; }, hide(){ this.visible=false; }, dispose(){} }; }
        };
        export const workspace={
          onDidChangeConfiguration(){ return { dispose(){} }; },
          getConfiguration(){ return { get(key,fallback){ const value = globalThis.__deepSeekSettings[key]; return value === undefined ? fallback : value; } }; }
        };
        globalThis.__deepSeekVscode = { LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, window, commands };
      `,
      loader: 'js'
    }));
  }
};

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.__deepSeekSettings = { baseURL: `${origin}/` };
  // One bundle, so the provider, the status bar, and the test share one vscode shim.
  await build({
    stdin: {
      contents: ['provider', 'balanceStatusBar', 'models'].map((name) => `export * from './src/providers/deepseek/${name}';`).join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    plugins: [vscodeShim]
  });
  const module = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const { LanguageModelTextPart: TextPart, LanguageModelThinkingPart: ThinkingPart, LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart, window } = globalThis.__deepSeekVscode;

  const secrets = new Map();
  const context = { secrets: {
    async get(key) { return secrets.get(key); },
    async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); }
  } };
  const logs = [];
  const recorded = [];
  const completed = [];
  const output = {
    info: (message, details) => logs.push({ level: 'info', message, details }),
    warn: (message, details) => logs.push({ level: 'warn', message, details })
  };
  const provider = new module.DeepSeekModelProvider(context, output, { recordRequest: (_messages, entry) => recorded.push(entry) }, (summary) => completed.push(summary));
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

  assert.equal(module.getDeepSeekConfig().baseURL, origin, 'trailing slashes are removed');
  assert.equal(module.getDeepSeekConfig().maxOutputTokens, 65_536);

  // Without a key nothing is requested, and the person is asked to set one.
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, token), []);
  assert.equal(requests.length, 0);
  assert.match(window.messages.at(-1), /Set your DeepSeek API key/);
  assert.equal(await provider.getBalance(), undefined);

  await provider.setApiKey('sk-deepseek');
  assert.deepEqual([...secrets.keys()], [`modelBridge.deepseek.apiKey:${origin}`], 'the key is bound to the API URL');

  const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.deepEqual(models.map((model) => model.name), ['DeepSeek Flash', 'DeepSeek V4 Pro', 'deepseek-next'], 'retired names are hidden');
  const [flash, pro, unknown] = models;
  assert.equal(flash.id, 'deepseek-flash');
  assert.equal(flash.family, 'deepseek');
  assert.equal(flash.maxInputTokens + flash.maxOutputTokens, 1_000_000);
  assert.equal(flash.maxOutputTokens, 65_536);
  assert.equal(flash.capabilities.toolCalling, true);
  assert.equal(flash.capabilities.imageInput, true);
  assert.equal(pro.capabilities.imageInput, false);
  assert.match(flash.detail, /^1M context · tools · vision · thinking$/);
  assert.deepEqual(flash.configurationSchema.properties.reasoningEffort.enum, ['off', 'low', 'high', 'max']);
  assert.equal(flash.configurationSchema.properties.reasoningEffort.default, 'high');
  assert.equal(unknown.capabilities.toolCalling, false, 'unknown models are not offered to Agent mode');
  assert.equal(unknown.configurationSchema.properties.reasoningEffort, undefined);

  const tools = [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }];
  const chats = () => requests.filter((entry) => entry.url === '/chat/completions');
  const ask = async (messages, modelOptions = {}, model = flash) => {
    const parts = [];
    await provider.provideLanguageModelChatResponse(model, messages, { modelOptions, tools, toolMode: 1 }, { report: (part) => parts.push(part) }, token);
    return { parts, body: chats().at(-1).body };
  };
  const user = (text) => ({ role: 1, name: undefined, content: [new TextPart(text)] });
  const toolRound = (callId, assistantParts = []) => [
    { role: 2, name: undefined, content: [...assistantParts, new ToolCallPart(callId, 'lookup', {})] },
    { role: 1, name: undefined, content: [new ToolResultPart(callId, [new TextPart('found')])] }
  ];

  // Default effort: thinking stays on with the server's default effort and the configured output limit.
  const firstTurn = await ask([user('Find it')]);
  assert.equal(firstTurn.body.model, 'deepseek-flash');
  assert.equal(firstTurn.body.thinking, undefined);
  assert.equal(firstTurn.body.reasoning_effort, undefined);
  assert.equal(firstTurn.body.max_tokens, 65_536);
  assert.equal(firstTurn.body.tool_choice, 'auto');
  assert.deepEqual(firstTurn.parts.filter((part) => part.thinking).map((part) => part.value), ['Need lookup']);
  assert(firstTurn.parts.some((part) => part.callId === 'call_ds_1'));

  // Usage: prompt_tokens include cache hits; the cost follows the list price.
  assert.equal(recorded.at(-1).provider, 'deepseek');
  assert.equal(recorded.at(-1).model, 'deepseek-flash');
  assert.equal(recorded.at(-1).inputTokens, 1_000_000);
  assert.equal(recorded.at(-1).cachedInputTokens, 800_000);
  const expectedCost = module.estimateDeepSeekCostUsd('deepseek-flash', { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 });
  assert(Math.abs(recorded.at(-1).costUsd - expectedCost) < 1e-9);
  assert.equal(completed.at(-1).model, 'deepseek-flash');
  assert.equal(completed.at(-1).cachedInputTokens, 800_000);

  // The tool round goes back with the reasoning that produced it.
  const afterTool = await ask([user('Find it'), ...toolRound('call_ds_1')]);
  assert.equal(afterTool.body.messages[1].reasoning_content, 'Need lookup');
  assert.equal(afterTool.body.thinking, undefined);

  // A final answer of an earlier turn carries its reasoning too, found by its text.
  const nextTurn = await ask([user('Find it'), ...toolRound('call_ds_1'), { role: 2, name: undefined, content: [new TextPart('Done')] }, user('Again')]);
  assert.equal(nextTurn.body.messages[3].reasoning_content, 'Wrap up');

  // Reasoning that VS Code kept in the history is used as is.
  const fromHistory = await ask([user('Find it'), ...toolRound('call_vscode', [new ThinkingPart('Kept by VS Code')])]);
  assert.equal(fromHistory.body.messages[1].reasoning_content, 'Kept by VS Code');

  // A tool call without known reasoning (for example after a reload) turns thinking off instead of failing.
  const unknownHistory = await ask([user('Find it'), ...toolRound('call_from_before_reload')]);
  assert.deepEqual(unknownHistory.body.thinking, { type: 'disabled' });
  assert.equal(unknownHistory.body.reasoning_effort, undefined);
  assert(logs.some((entry) => entry.message === 'DeepSeek thinking is off for this request' && entry.details.toolCallsWithoutReasoning === 1));

  // If DeepSeek still rejects the reasoning history, the request is repeated once without thinking.
  const requestsBeforeRetry = chats().length;
  const retried = await ask([user('Reject reasoning')]);
  assert.equal(chats().length, requestsBeforeRetry + 2);
  assert.equal(chats().at(-2).body.thinking, undefined);
  assert.deepEqual(retried.body.thinking, { type: 'disabled' });
  assert(retried.parts.some((part) => part.callId?.startsWith('call_ds_')));
  assert(logs.some((entry) => entry.level === 'warn' && /retrying without thinking/.test(entry.message)));

  // Off disables thinking; Max is sent as DeepSeek's `max` effort; a required tool call turns thinking off.
  const off = await ask([user('Hi')], { reasoningEffort: 'off' });
  assert.deepEqual(off.body.thinking, { type: 'disabled' });
  assert.equal(off.body.reasoning_effort, undefined);
  assert.equal((await ask([user('Hi')], { reasoningEffort: 'max' })).body.reasoning_effort, 'max');
  await provider.provideLanguageModelChatResponse(flash, [user('Hi')], { tools, toolMode: 2 }, { report() {} }, token);
  assert.deepEqual(chats().at(-1).body.thinking, { type: 'disabled' });
  assert.equal(chats().at(-1).body.tool_choice, 'required');
  assert(requests.every((entry) => entry.authorization === 'Bearer sk-deepseek'));
  assert(logs.every((entry) => !JSON.stringify(entry.details ?? {}).includes('Need lookup')), 'reasoning is never logged');

  // Status and balance.
  const status = await provider.getStatus();
  assert.equal(status.reachable, true);
  assert.equal(status.hasApiKey, true);
  assert.deepEqual(status.models.map((model) => model.id), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-next']);
  assert.deepEqual(status.balance, { available: true, balances: [{ currency: 'USD', total: '12.50', granted: '2.50', toppedUp: '10.00' }] });

  // The balance status bar shows the balance and the latest request.
  globalThis.__deepSeekSettings.balanceStatusBar = true;
  const statusBar = new module.DeepSeekBalanceStatusBar({ fetchBalance: () => provider.getBalance(), output });
  await statusBar.refresh();
  assert.equal(window.statusItem.text, 'DeepSeek: $12.50');
  assert.equal(window.statusItem.visible, true);
  statusBar.recordRequest({ model: 'deepseek-flash', inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, costUsd: 0.0012 });
  assert.match(window.statusItem.tooltip, /Latest request \(deepseek-flash\): 1,000 input · 800 cached · 50 output · ~\$0\.0012/);
  balanceAvailable = false;
  await statusBar.refresh();
  assert.equal(window.statusItem.text, '$(warning) DeepSeek: $12.50');
  assert.match(window.statusItem.tooltip, /insufficient for API calls/);
  globalThis.__deepSeekSettings.balanceStatusBar = false;
  statusBar.recordRequest({ model: 'deepseek-flash', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
  assert.equal(window.statusItem.visible, false, 'the status bar setting hides it');
  statusBar.dispose();
  assert.equal(module.formatDeepSeekBalance({ available: true, balances: [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }, { currency: 'EUR', total: '1', granted: '0', toppedUp: '1' }] }), '¥110.00 · 1 EUR');
  assert.equal(module.parseDeepSeekBalance({ balance_infos: [] }), undefined);

  // A wrong key is reported without the key itself.
  await provider.setApiKey('sk-wrong');
  const rejected = await provider.getStatus();
  assert.equal(rejected.reachable, false);
  assert.match(rejected.error, /rejected authentication/);
  assert(!rejected.error.includes('sk-wrong'));

  // Changing the API URL drops the key, so it never reaches another server.
  globalThis.__deepSeekSettings.baseURL = 'https://proxy.example.com';
  assert.equal(await provider.hasApiKey(), false);
  await provider.clearApiKey();

  // Pricing: off-peak list price, doubled during peak hours on weekdays; unknown models have no cost.
  const tokens = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 };
  const offPeak = new Date('2026-10-28T12:00:00Z');
  const peak = new Date('2026-10-28T07:30:00Z');
  const weekend = new Date('2026-10-31T07:30:00Z');
  assert(Math.abs(module.estimateDeepSeekCostUsd('deepseek-flash', tokens, offPeak) - (0.8 * 0.003 + 0.2 * 0.15 + 0.1 * 0.6)) < 1e-12);
  assert(Math.abs(module.estimateDeepSeekCostUsd('deepseek-v4-pro', tokens, peak) - 2 * (0.8 * 0.022 + 0.2 * 0.66 + 0.1 * 1.98)) < 1e-12);
  assert.equal(module.isDeepSeekPeak(weekend), false);
  assert.equal(module.isDeepSeekPeak(new Date('2026-10-28T04:00:00Z')), false);
  assert.equal(module.isDeepSeekPeak(new Date('2026-10-28T01:00:00Z')), true);
  assert.equal(module.estimateDeepSeekCostUsd('deepseek-next', tokens), undefined);
  assert.throws(() => module.readModelIds({ models: [] }), /invalid model list/);

  provider.dispose();
  console.log('DeepSeek provider smoke tests passed.');
} finally {
  delete globalThis.__deepSeekSettings;
  delete globalThis.__deepSeekVscode;
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
