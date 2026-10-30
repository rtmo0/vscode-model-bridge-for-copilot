import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-combos-'));
const bundlePath = join(directory, 'combos.mjs');

const vscodeShim = {
  name: 'vscode-test-shim',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
      contents: `
        export class EventEmitter {
          constructor(){ this.listeners=new Set(); this.event=(listener)=>{ this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
          fire(value){ for (const listener of [...this.listeners]) listener(value); }
          dispose(){ this.listeners.clear(); }
        }
        export class CancellationError extends Error {}
        export class LanguageModelTextPart { constructor(value){ this.value=value; } }
        export class LanguageModelThinkingPart { constructor(value){ this.value=value; } }
        export class LanguageModelToolCallPart { constructor(callId,name,input){ Object.assign(this,{callId,name,input}); } }
        export class LanguageModelToolResultPart { constructor(callId,content){ Object.assign(this,{callId,content}); } }
        export class LanguageModelDataPart { constructor(data,mimeType){ Object.assign(this,{data,mimeType}); } static json(value,mimeType){ return new LanguageModelDataPart(value,mimeType); } }
        export const LanguageModelChatMessageRole={User:1,Assistant:2};
        export const LanguageModelChatMessage={ User(text){ return { role: 1, name: undefined, content: [new LanguageModelTextPart(text)] }; } };
        export const LanguageModelChatToolMode={Auto:1,Required:2};
        export const QuickPickItemKind={Separator:-1};
        export const commands={ async executeCommand(){} };
        export const window={ messages: [], async showInformationMessage(message){ this.messages.push(message); return undefined; } };
        export const workspace={
          getConfiguration(section){ return { get(key,fallback){ const value = globalThis.__comboSettings[section + '.' + key]; return value === undefined ? fallback : value; } }; }
        };
        globalThis.__comboVscode = { EventEmitter, CancellationError, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelDataPart, window };
      `,
      loader: 'js'
    }));
  }
};

try {
  globalThis.__comboSettings = {};
  await build({
    stdin: {
      contents: [
        "export * from './src/providers/combos/routing';",
        "export * from './src/providers/combos/provider';",
        "export * from './src/providers/combos/planExecute';",
        "export { applyLoopGuard } from './src/loopGuard';",
        "export { createHttpError } from './src/providers/openaiCompatible/chatCompletions';",
        "export { toChatLimitError, ResponsesRateLimitedError, ResponsesQuotaExceededError } from './src/providers/codex/responsesLimitError';",
        "export { ProviderHttpError, parseRetryAfter } from './src/providers/providerError';"
      ].join('\n'),
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
  const {
    EventEmitter, CancellationError, LanguageModelTextPart: TextPart, LanguageModelThinkingPart: ThinkingPart,
    LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart, LanguageModelDataPart: DataPart, window
  } = globalThis.__comboVscode;

  // Settings: invalid entries and targets are reported, valid ones still work.
  const parsed = module.parseCombos([
    { name: 'Coding', targets: ['claude:opus', 'Codex: gpt-5.5', 'claude:opus', 'nope', 'deepseek:'] },
    { name: 'Coding', targets: ['codex:gpt-5.5'] },
    { name: 'Cheap agent', strategy: 'planExecute', planner: 'claude:opus', executor: 'deepseek:deepseek-flash' },
    { name: 'Same', strategy: 'planExecute', planner: 'claude:opus', executor: 'Claude:opus' },
    { name: 'Half', strategy: 'planExecute', planner: 'claude:opus' },
    { name: 'Later', strategy: 'roundRobin', targets: ['claude:opus'] },
    { name: 'Empty', targets: [] },
    { targets: ['claude:opus'] },
    'text'
  ]);
  assert.deepEqual(parsed.combos, [{
    name: 'Coding',
    strategy: 'fallback',
    targets: [
      { provider: 'claude', model: 'opus', label: 'claude:opus' },
      { provider: 'codex', model: 'gpt-5.5', label: 'codex:gpt-5.5' }
    ]
  }, {
    name: 'Cheap agent',
    strategy: 'planExecute',
    planner: { provider: 'claude', model: 'opus', label: 'claude:opus' },
    executor: { provider: 'deepseek', model: 'deepseek-flash', label: 'deepseek:deepseek-flash' }
  }], 'duplicates are dropped and the provider is case-insensitive');
  assert.equal(parsed.invalid.length, 9);
  assert.match(parsed.invalid.join('\n'), /Same \(the planner and the executor must be different models\)/);
  assert.match(parsed.invalid.join('\n'), /Half \(planExecute needs a planner and an executor/);
  assert.match(parsed.invalid.join('\n'), /Later \(strategy "roundRobin" is not supported/);
  assert.match(parsed.invalid.join('\n'), /Coding: target "nope"/);
  assert.match(parsed.invalid.join('\n'), /Coding \(duplicate name\)/);
  assert.match(parsed.invalid.join('\n'), /Empty \(no valid targets\)/);
  assert.match(parsed.invalid.join('\n'), /#8 \(needs a name\)/);
  assert.deepEqual(module.parseCombos(undefined), { combos: [], invalid: [] });

  // Target resolution: id, id without the provider prefix, OpenAI-Compatible endpoint/model, then name.
  const target = (value) => module.parseTarget(value);
  const claudeModels = [{ id: 'anthropic::opus', name: 'Opus' }, { id: 'anthropic::sonnet', name: 'Sonnet' }];
  assert.equal(module.findTargetModel(target('claude:anthropic::sonnet'), claudeModels)?.id, 'anthropic::sonnet');
  assert.equal(module.findTargetModel(target('claude:OPUS'), claudeModels)?.id, 'anthropic::opus');
  assert.equal(module.findTargetModel(target('claude:Sonnet'), [{ id: 'anthropic::claude-sonnet-4-6', name: 'Sonnet' }])?.id, 'anthropic::claude-sonnet-4-6');
  const oaiModels = [{ id: 'oai::My%20Ollama::qwen3%3A8b', name: 'qwen3:8b' }];
  assert.equal(module.findTargetModel(target('openaiCompatible:My Ollama/qwen3:8b'), oaiModels)?.id, oaiModels[0].id);
  assert.equal(module.findTargetModel(target('openaiCompatible:oai::My%20Ollama::qwen3%3A8b'), oaiModels)?.id, oaiModels[0].id);
  assert.equal(module.findTargetModel(target('openaiCompatible:qwen3:8b'), oaiModels)?.id, oaiModels[0].id);
  assert.equal(module.findTargetModel(target('claude:haiku'), claudeModels), undefined);

  // Error classification: the messages and errors the providers produce.
  const classify = (error) => module.classifyFailure(error)?.reason;
  const httpError = (status, body, headers = {}) => module.createHttpError(new Response(JSON.stringify(body), { status, statusText: 'x', headers }), 'DeepSeek chat request failed', 'DeepSeek');
  const rateLimited = await httpError(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '7' });
  assert(rateLimited instanceof module.ProviderHttpError);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.retryAfterMs, 7_000);
  assert.deepEqual(module.classifyFailure(rateLimited), { reason: 'rate-limit', retryAfterMs: 7_000 });
  assert.equal(classify(await httpError(429, { error: { message: 'You exceeded your current quota' } })), 'quota');
  assert.equal(classify(await httpError(402, { error: { message: 'Insufficient Balance' } })), 'quota');
  assert.equal(classify(await httpError(401, { error: { message: 'bad key' } })), 'auth');
  assert.equal(classify(await httpError(503, {})), 'server');
  assert.equal(classify(await httpError(400, { error: { message: 'Invalid tool schema; rate limit is fine' } })), undefined,
    'a rejected request would fail on every target');
  assert.equal(module.parseRetryAfter(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' }), 30_000), 30_000);
  assert.equal(module.parseRetryAfter(new Headers({ 'retry-after-ms': '250' })), 250);
  assert.equal(module.parseRetryAfter(new Headers({ 'retry-after': '' })), undefined);
  const codexRate = module.toChatLimitError(new module.ResponsesRateLimitedError('Rate limit reached. Please try again in 2.5s.', 2_500));
  assert.equal(codexRate.name, 'ChatRateLimited');
  assert.equal(codexRate.stack, undefined);
  assert.deepEqual(module.classifyFailure(codexRate), { reason: 'rate-limit', retryAfterMs: 2_500 });
  assert.equal(classify(module.toChatLimitError(new module.ResponsesQuotaExceededError('usage limit reached'))), 'quota');
  assert.equal(classify(new Error('Claude account usage limit reached. Check the Claude usage status bar for reset times.')), 'quota');
  assert.equal(classify(new Error('Claude Code is not signed in. Run “Model Bridge: Claude: Sign in with Browser”.')), 'auth');
  assert.equal(classify(new Error('Claude Code was not found at "claude". Install it or update the Claude Code path in settings.')), 'unavailable');
  assert.equal(classify(new Error('Claude Code did not finish within 10 minutes. Increase the request timeout.')), 'timeout');
  assert.equal(classify(new Error('Cannot reach LM Studio at http://127.0.0.1:1234. Start the server or update its URL.')), 'network');
  assert.equal(classify(new Error('OpenAI server error while contacting https://chatgpt.com/backend-api/codex/responses. Status: 503.')), 'server');
  assert.equal(classify(new Error('Codex is not signed in. Run "Model Bridge: Codex: Sign in with Browser".')), 'auth');
  assert.equal(classify(new Error('The conversation exceeds the selected Claude context size. Choose a larger context or start a new chat.')), undefined);
  assert.equal(classify(new Error('Something unexpected')), undefined);

  // Capabilities are the intersection, token limits the minimum.
  assert.deepEqual(module.combineTargetWindows([
    { maxInputTokens: 200_000, maxOutputTokens: 32_000, capabilities: { toolCalling: true, imageInput: true } },
    { maxInputTokens: 900_000, maxOutputTokens: 8_000, capabilities: { toolCalling: 128, imageInput: false } }
  ]), { maxInputTokens: 200_000, maxOutputTokens: 8_000, toolCalling: 128, imageInput: false });
  assert.equal(module.combineTargetWindows([
    { maxInputTokens: 1, maxOutputTokens: 1, capabilities: { toolCalling: true } },
    { maxInputTokens: 1, maxOutputTokens: 1, capabilities: {} }
  ]).toolCalling, false);

  // Cooldown: 60 s, doubling up to 15 min, Retry-After instead of the backoff, reset on success.
  let now = 1_000_000;
  const health = new module.TargetHealth(() => now);
  assert.equal(health.recordFailure('a', { reason: 'server' }), 60_000);
  assert.equal(health.recordFailure('a', { reason: 'server' }), 120_000);
  for (let index = 0; index < 6; index += 1) health.recordFailure('a', { reason: 'server' });
  assert.equal(health.recordFailure('a', { reason: 'server' }), 15 * 60_000);
  assert.equal(health.recordFailure('b', { reason: 'rate-limit', retryAfterMs: 5_000 }), 5_000);
  assert.equal(health.cooldown('b').reason, 'rate-limit');
  now += 5_001;
  assert.equal(health.cooldown('b'), undefined, 'the cooldown ends after Retry-After');
  health.recordSuccess('a');
  assert.equal(health.cooldown('a'), undefined);
  assert.equal(health.recordFailure('a', { reason: 'server' }), 60_000, 'success resets the backoff');

  // Route memory is a bounded LRU.
  const routes = new module.RouteMemory(2);
  routes.set('one', 'a');
  routes.set('two', 'b');
  routes.get('one');
  routes.set('three', 'c');
  assert.equal(routes.size, 2);
  assert.equal(routes.get('two'), undefined, 'the least recently used route is dropped');
  assert.equal(routes.get('one'), 'a');

  // Provider with fake targets in a registry.
  const createTarget = (models) => {
    const changed = new EventEmitter();
    const fake = {
      models,
      calls: [],
      listCount: 0,
      next: [],
      onDidChangeLanguageModelChatInformation: changed.event,
      fireChanged: () => changed.fire(),
      async provideLanguageModelChatInformation(options) {
        fake.listCount += 1;
        assert.equal(options.silent, true, 'targets are listed silently');
        return fake.models;
      },
      async provideLanguageModelChatResponse(info, messages, options, progress, token) {
        fake.calls.push({ info, messages, options });
        const behavior = fake.next.shift() ?? ((report) => report(new TextPart(`answer from ${info.id}`)));
        await behavior((part) => progress.report(part), token);
      },
      async provideTokenCount(_info, value) {
        return typeof value === 'string' ? value.length : 1;
      }
    };
    return fake;
  };
  const info = (id, name, maxInputTokens, maxOutputTokens, capabilities) => ({ id, name, family: 'test', version: '1', maxInputTokens, maxOutputTokens, capabilities });
  const claude = createTarget([info('anthropic::opus', 'Opus', 200_000, 32_000, { toolCalling: true, imageInput: false })]);
  const codex = createTarget([info('codex::gpt-5.5', 'GPT-5.5', 400_000, 64_000, { toolCalling: true, imageInput: true })]);
  const deepseek = createTarget([info('deepseek-v4-pro', 'DeepSeek V4 Pro', 900_000, 16_000, { toolCalling: true, imageInput: false })]);
  const registry = new Map([['claude', { provider: claude }], ['codex', { provider: codex }], ['deepseek', { provider: deepseek }]]);
  const logs = [];
  const output = {
    info: (message, details) => logs.push({ level: 'info', message, details }),
    warn: (message, details) => logs.push({ level: 'warn', message, details })
  };
  globalThis.__comboSettings['modelBridge.combos'] = [
    { name: 'Coding', strategy: 'fallback', targets: ['claude:opus', 'codex:gpt-5.5', 'deepseek:deepseek-v4-pro'] },
    { name: 'Local only', targets: ['lmstudio:qwen'] },
    { name: 'Broken', targets: 'claude:opus' }
  ];
  now = 5_000_000;
  const provider = new module.ComboModelProvider(registry, output, module.getComboConfig, () => now);
  let changes = 0;
  provider.onDidChangeLanguageModelChatInformation(() => { changes += 1; });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

  const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.deepEqual(models.map((model) => model.name), ['Coding'], 'a combo without an available target is hidden');
  const [coding] = models;
  assert.equal(coding.id, 'combo::Coding');
  assert.equal(coding.detail, 'Opus → GPT-5.5 → DeepSeek V4 Pro');
  assert.equal(coding.maxInputTokens, 200_000);
  assert.equal(coding.maxOutputTokens, 16_000);
  assert.deepEqual(coding.capabilities, { toolCalling: true, imageInput: false });
  assert.match(coding.tooltip, /claude:opus → codex:gpt-5\.5 → deepseek:deepseek-v4-pro/);

  // Model lists are cached briefly and refreshed on a target's change event.
  await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(claude.listCount, 1);
  claude.fireChanged();
  assert.equal(changes, 1, 'a target change refreshes the combos');
  await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(claude.listCount, 2);
  now += 31_000;
  await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(claude.listCount, 3);

  const user = (text) => ({ role: 1, name: undefined, content: [new TextPart(text)] });
  const assistant = (...parts) => ({ role: 2, name: undefined, content: parts });
  const ask = async (messages, requestToken = token) => {
    const parts = [];
    await provider.provideLanguageModelChatResponse(coding, messages, { tools: [], toolMode: 1 }, { report: (part) => parts.push(part) }, requestToken);
    return parts;
  };
  const rateLimit = () => httpError(429, { error: { message: 'Rate limit reached' } });

  // A new conversation starts on the first target and passes the target's own model information.
  const first = await ask([user('Task A')]);
  assert.deepEqual(first.map((part) => part.value), ['answer from anthropic::opus']);
  assert.equal(claude.calls.at(-1).info.id, 'anthropic::opus');

  // Fallback on 429 before output: the next target answers and the conversation sticks to it.
  const limited = await rateLimit();
  claude.next.push(async () => { throw limited; });
  const second = await ask([user('Task B')]);
  assert.deepEqual(second.map((part) => part.value), ['answer from codex::gpt-5.5']);
  assert.equal(logs.find((entry) => entry.level === 'warn').details.reason, 'rate-limit');
  assert.equal(logs.find((entry) => entry.level === 'warn').details.cooldownSeconds, 60);
  assert.equal(JSON.stringify(logs).includes('Task B'), false, 'prompts are never logged');
  now += 61_000;
  const codexCalls = codex.calls.length;
  await ask([user('Task B'), assistant(new TextPart('answer from codex::gpt-5.5')), user('More')]);
  assert.equal(codex.calls.length, codexCalls + 1, 'the conversation stays on its target after the cooldown ends');
  const claudeCalls = claude.calls.length;
  await ask([user('Task C')]);
  assert.equal(claude.calls.length, claudeCalls + 1, 'a new conversation picks the first healthy target');

  // No fallback after partial output.
  claude.next.push(async (report) => {
    report(new TextPart('partial'));
    throw await rateLimit();
  });
  const partialParts = [];
  await assert.rejects(
    provider.provideLanguageModelChatResponse(coding, [user('Task D')], { tools: [] }, { report: (part) => partialParts.push(part) }, token),
    /Rate limit reached/
  );
  assert.deepEqual(partialParts.map((part) => part.value), ['partial']);
  assert.equal(codex.calls.length, codexCalls + 1);

  // Cancellation is not retried.
  now += 16 * 60_000;
  claude.next.push(async () => { throw new CancellationError(); });
  await assert.rejects(ask([user('Task E')]), CancellationError);
  const cancelled = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  claude.next.push(async () => {
    cancelled.isCancellationRequested = true;
    throw new Error('Cannot reach Claude');
  });
  await assert.rejects(ask([user('Task F')], cancelled), /Cannot reach Claude/);
  assert.equal(codex.calls.length, codexCalls + 1, 'a cancelled request never moves to another target');

  // A failure every target would hit is not retried and does not start a cooldown.
  claude.next.push(async () => { throw new Error('The conversation exceeds the selected Claude context size.'); });
  await assert.rejects(ask([user('Task G')]), /context size/);
  assert.equal(codex.calls.length, codexCalls + 1);
  const status = await provider.getStatus();
  assert.equal(status.statuses[0].targets[0].cooldown, undefined);

  // When every target is cooling down, the one that recovers first is tried instead of failing outright.
  now += 16 * 60_000;
  claude.next.push(async () => { throw new Error('Claude account usage limit reached.'); });
  codex.next.push(async () => { throw new Error('Codex is temporarily rate limited. Try again shortly.'); });
  deepseek.next.push(async () => { throw await httpError(402, { error: { message: 'Insufficient Balance' } }, { 'retry-after': '30' }); });
  const exhausted = await ask([user('Task H')]).catch((error) => error);
  assert.match(exhausted.message, /No model in the combo "Coding" could answer\. claude:opus: Claude account usage limit reached\. codex:gpt-5\.5: .+ deepseek:deepseek-v4-pro: DeepSeek chat request failed: 402/);
  assert.equal(exhausted.stack, undefined);
  const afterExhaustion = (await provider.getStatus()).statuses[0].targets;
  assert.deepEqual(afterExhaustion.map((entry) => entry.cooldown?.reason), ['quota', 'rate-limit', 'quota']);
  assert.equal(afterExhaustion[2].cooldown.remainingMs, 30_000, 'Retry-After sets the cooldown');
  const deepseekCalls = deepseek.calls.length;
  const recovered = await ask([user('Task I')]);
  assert.deepEqual(recovered.map((part) => part.value), ['answer from deepseek-v4-pro'], 'DeepSeek recovers first');
  assert.equal(deepseek.calls.length, deepseekCalls + 1);
  assert.equal((await provider.getStatus()).statuses[0].targets[2].cooldown, undefined, 'success resets the cooldown');

  // The loop-guard notice a target shows first is held back, so a fallback does not repeat it.
  const shown = [];
  const gate = new module.OutputGate({ report: (part) => shown.push(part.value) }, 'Loop guard: still stuck');
  gate.report(new TextPart('Loop guard: still stuck'));
  assert.equal(gate.started, false);
  assert.deepEqual(shown, []);
  gate.report(new TextPart('answer'));
  assert.equal(gate.started, true);
  assert.deepEqual(shown, ['Loop guard: still stuck', 'answer']);
  const quiet = [];
  const quietGate = new module.OutputGate({ report: (part) => quiet.push(part.value) }, 'notice');
  quietGate.report(new TextPart('notice'));
  quietGate.flush();
  assert.deepEqual(quiet, ['notice'], 'a held notice is shown when the target completes without other output');

  // Codex continuation markers are removed for other targets and kept for Codex.
  now += 16 * 60_000;
  const marker = new DataPart(new Uint8Array([1]), 'stateful_marker');
  const history = [user('Task J'), assistant(new TextPart('done'), marker), user('Next')];
  await ask(history);
  const sentToClaude = claude.calls.at(-1).messages;
  assert.equal(sentToClaude[1].content.length, 1);
  assert.equal(sentToClaude[1].content[0].value, 'done');
  assert.equal(sentToClaude[0], history[0], 'messages without a marker are passed unchanged');
  claude.next.push(async () => { throw new Error('Cannot reach Claude Code'); });
  await ask([user('Task K'), assistant(new TextPart('done'), marker), user('Next')]);
  assert.equal(codex.calls.at(-1).messages[1].content.at(-1), marker);

  // Tool calls and usage parts pass through unchanged.
  now += 16 * 60_000;
  const usage = DataPart.json({ prompt_tokens: 1 }, 'usage');
  claude.next.push(async (report) => {
    report(new ToolCallPart('call_1', 'lookup', {}));
    report(usage);
  });
  const toolParts = await ask([user('Task L')]);
  assert(toolParts[0] instanceof ToolCallPart);
  assert.equal(toolParts[1], usage);

  // A missing provider is skipped; the Doctor shows why.
  const doctor = await provider.getStatus();
  assert.deepEqual(doctor.invalid, ['Broken (no valid targets)']);
  assert.equal(doctor.statuses.length, 2);
  assert.equal(doctor.statuses[1].available, false);
  assert.equal(doctor.statuses[1].targets[0].problem, 'provider is not active');
  assert.equal(doctor.statuses[0].targets[0].model, 'Opus');
  assert.equal(doctor.statuses[0].toolCalling, true);
  const withoutClaude = new module.ComboModelProvider(new Map([['codex', { provider: codex }], ['deepseek', { provider: deepseek }]]), output, module.getComboConfig, () => now);
  const [reduced] = await withoutClaude.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(reduced.detail, 'GPT-5.5 → DeepSeek V4 Pro');
  assert.equal(reduced.maxOutputTokens, 16_000);
  assert.equal(reduced.maxInputTokens, 400_000);

  // A removed combo fails clearly; token counts come from the first available target.
  assert.equal(await provider.provideTokenCount(coding, 'abcd', token), 4);
  await assert.rejects(
    provider.provideLanguageModelChatResponse({ ...coding, id: 'combo::Gone' }, [user('x')], {}, { report() {} }, token),
    /The combo "Gone" is no longer configured/
  );

  // Quota pre-check: a target whose account status says it is exhausted is tried last, without a failed call.
  now += 16 * 60_000;
  let claudeExhaustedUntil = now + 10 * 60_000;
  const checked = new module.ComboModelProvider(new Map([
    ['claude', { provider: claude, availability: { exhaustedUntil: (modelId, at) => (assert.equal(modelId, 'anthropic::opus'), at < claudeExhaustedUntil ? claudeExhaustedUntil : undefined) } }],
    ['codex', { provider: codex, availability: { exhaustedUntil: () => { throw new Error('status unavailable'); } } }],
    ['deepseek', { provider: deepseek }]
  ]), output, module.getComboConfig, () => now);
  const [checkedCoding] = await checked.provideLanguageModelChatInformation({ silent: true }, token);
  const claudeBefore = claude.calls.length;
  const checkedParts = [];
  await checked.provideLanguageModelChatResponse(checkedCoding, [user('Task Q')], { tools: [] }, { report: (part) => checkedParts.push(part) }, token);
  assert.deepEqual(checkedParts.map((part) => part.value), ['answer from codex::gpt-5.5'], 'a failing status check never blocks a target');
  assert.equal(claude.calls.length, claudeBefore, 'the exhausted target is not called');
  const checkedStatus = (await checked.getStatus()).statuses[0].targets;
  assert.equal(checkedStatus[0].exhaustedForMs, 10 * 60_000);
  assert.equal(checkedStatus[1].exhaustedForMs, undefined);
  claudeExhaustedUntil = now;
  const checkedAgain = [];
  await checked.provideLanguageModelChatResponse(checkedCoding, [user('Task R')], { tools: [] }, { report: (part) => checkedAgain.push(part) }, token);
  assert.deepEqual(checkedAgain.map((part) => part.value), ['answer from anthropic::opus'], 'a recovered account is used again');
  checked.dispose();

  // Plan → execute.
  globalThis.__comboSettings['modelBridge.combos'] = [
    { name: 'Cheap agent', strategy: 'planExecute', planner: 'claude:opus', executor: 'deepseek:deepseek-v4-pro' }
  ];
  now += 16 * 60_000;
  const planning = new module.ComboModelProvider(registry, output, module.getComboConfig, () => now);
  const [cheap] = await planning.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(cheap.version, 'planExecute');
  assert.equal(cheap.detail, 'Plan: Opus → Execute: DeepSeek V4 Pro');
  assert.equal(cheap.maxOutputTokens, 16_000);
  assert.match(cheap.tooltip, /claude:opus writes a short plan/);
  const tools = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }];
  const run = async (messages) => {
    const parts = [];
    await planning.provideLanguageModelChatResponse(cheap, messages, { tools, toolMode: 2 }, { report: (part) => parts.push(part) }, token);
    return parts;
  };
  const describe = (parts) => parts.map((part) => part instanceof ToolCallPart ? `call:${part.name}` : part.value);

  // A new prompt: the plan is streamed under a heading before the executor's tool calls, in one response.
  claude.next.push(async (report) => {
    report(new ThinkingPart('weighing options'));
    report(new TextPart('1. Read app.ts\n2. Fix the bug'));
    report(DataPart.json({ prompt_tokens: 5 }, 'usage'));
  });
  deepseek.next.push(async (report) => {
    report(new TextPart('Reading'));
    report(new ToolCallPart('call_p1', 'read_file', {}));
  });
  const prompt = [user('Fix the bug in app.ts')];
  const planned = await run(prompt);
  assert.deepEqual(describe(planned), ['**Plan · Opus**\n\n', '1. Read app.ts\n2. Fix the bug', '\n\n', 'Reading', 'call:read_file'],
    'the planner\'s thinking and usage stay out of the response');
  const plannerCall = claude.calls.at(-1);
  assert.deepEqual(plannerCall.options.tools, [], 'the planner gets no tools');
  assert.equal(plannerCall.options.toolMode, 1);
  assert.equal(plannerCall.messages.length, 2);
  assert.match(plannerCall.messages[1].content[0].value, /Write a short numbered plan/);
  const executorCall = deepseek.calls.at(-1);
  assert.equal(executorCall.options.tools, tools);
  assert.equal(executorCall.messages.length, 3);
  assert.equal(executorCall.messages[1].role, 2);
  assert.equal(executorCall.messages[1].content[0].value, '**Plan · Opus**\n\n1. Read app.ts\n2. Fix the bug\n\n', 'the executor sees the plan as streamed');
  assert.match(executorCall.messages[2].content[0].value, /Carry out the plan above/);
  assert.equal(JSON.stringify(logs).includes('Read app.ts'), false, 'plans are never logged');

  // Tool steps go to the executor only, with the history unchanged.
  const step = [
    ...prompt,
    assistant(new TextPart('**Plan · Opus**\n\n1. Read app.ts\n2. Fix the bug\n\nReading'), new ToolCallPart('call_p1', 'read_file', {})),
    { role: 1, name: undefined, content: [new ToolResultPart('call_p1', [new TextPart('contents')])] }
  ];
  const plannerCalls = claude.calls.length;
  await run(step);
  assert.equal(claude.calls.length, plannerCalls);
  assert.equal(deepseek.calls.at(-1).messages, step);

  // Escalation: a new loop-guard redirect asks the planner for a revised plan, even with the guard setting off.
  let nextCall = 0;
  const round = (name, input, result) => {
    const id = `call_loop_${nextCall += 1}`;
    return [assistant(new ToolCallPart(id, name, input)), { role: 1, name: undefined, content: [new ToolResultPart(id, [new TextPart(result)])] }];
  };
  const spiral = (pairs) => Array.from({ length: pairs }, () => [
    ...round('replace_string_in_file', { filePath: '/repo/src/app.ts', oldString: 'a', newString: 'b' }, 'The file was edited.'),
    ...round('run_in_terminal', { command: 'npm test' }, 'FAIL src/app.test.ts\nAssertionError: expected 3 to equal 4 at line 12')
  ]).flat();
  const stuck = [user('Fix the failing test'), ...spiral(10)];
  assert.equal(module.applyLoopGuard(stuck).event, undefined, 'the loop guard setting is off');
  claude.next.push(async (report) => report(new TextPart('1. Read the test first')));
  const escalated = await run(stuck);
  assert.deepEqual(describe(escalated), ['**Revised plan · Opus**\n\n', '1. Read the test first', '\n\n', 'answer from deepseek-v4-pro']);
  assert.match(claude.calls.at(-1).messages.at(-1).content[0].value, /looks stuck in this turn: 20 tool calls, 10 failing outputs, 9 repeated failures/);
  assert.match(deepseek.calls.at(-1).messages.at(-1).content[0].value, /Continue with the revised plan/);
  const afterRevision = [...stuck, assistant(new TextPart('**Revised plan · Opus**\n\n1. Read the test first\n\n')), ...spiral(1)];
  const revisedCalls = claude.calls.length;
  await run(afterRevision);
  assert.equal(claude.calls.length, revisedCalls, 'the planner is asked once per turn');
  assert.equal(module.escalationEvent([user('Fix it'), assistant(new TextPart('**Revised plan · Opus**\n\nTry')), ...spiral(10)]), undefined,
    'a revised plan already in the turn prevents another one');
  assert.equal(module.escalationEvent(stuck)?.action, 'redirect');

  // A failed planner: the executor continues alone, and a cooling planner is skipped.
  claude.next.push(async () => { throw await rateLimit(); });
  const unplanned = await run([user('Task S')]);
  assert.deepEqual(describe(unplanned), ['answer from deepseek-v4-pro']);
  assert.equal(deepseek.calls.at(-1).messages.length, 1);
  const coolingCalls = claude.calls.length;
  await run([user('Task T')]);
  assert.equal(claude.calls.length, coolingCalls, 'a cooling planner is not asked');

  // A planner that fails after part of the plan: the executor continues with what was streamed.
  now += 16 * 60_000;
  claude.next.push(async (report) => {
    report(new TextPart('1. Start here'));
    throw new Error('Cannot reach Claude Code');
  });
  const partialPlan = await run([user('Task U')]);
  assert.deepEqual(describe(partialPlan), ['**Plan · Opus**\n\n', '1. Start here', '\n\n', 'answer from deepseek-v4-pro']);
  assert.equal(deepseek.calls.at(-1).messages[1].content[0].value, '**Plan · Opus**\n\n1. Start here\n\n');

  // The executor fails before answering: the planner takes over with the tools, and the conversation stays there.
  now += 16 * 60_000;
  claude.next.push(async (report) => report(new TextPart('1. Do it')));
  deepseek.next.push(async () => { throw await httpError(402, { error: { message: 'Insufficient Balance' } }); });
  const takeover = await run([user('Task V')]);
  assert.deepEqual(describe(takeover), ['**Plan · Opus**\n\n', '1. Do it', '\n\n', 'answer from anthropic::opus']);
  assert.equal(claude.calls.at(-1).options.tools, tools, 'the planner executes with the real tools');
  const takeoverCalls = { claude: claude.calls.length, deepseek: deepseek.calls.length };
  await run([user('Task V'), assistant(new TextPart('answer')), user('And then?')]);
  assert.equal(claude.calls.length, takeoverCalls.claude + 1, 'the planner, now executing, does not plan for itself');
  assert.equal(deepseek.calls.length, takeoverCalls.deepseek);
  assert.equal(claude.calls.at(-1).options.tools, tools);

  const planStatus = (await planning.getStatus()).statuses[0];
  assert.deepEqual(planStatus.targets.map((target) => target.role), ['planner', 'executor']);
  assert.equal(await planning.provideTokenCount(cheap, 'abcdef', token), 6);
  planning.dispose();

  // Without its planner the combo runs the executor alone.
  const executorOnly = new module.ComboModelProvider(new Map([['deepseek', { provider: deepseek }]]), output, module.getComboConfig, () => now);
  const [alone] = await executorOnly.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(alone.detail, 'Execute: DeepSeek V4 Pro');
  const aloneParts = [];
  await executorOnly.provideLanguageModelChatResponse(alone, [user('Task W')], { tools }, { report: (part) => aloneParts.push(part) }, token);
  assert.deepEqual(describe(aloneParts), ['answer from deepseek-v4-pro']);
  executorOnly.dispose();

  // Without combos, the person is pointed at the setting.
  globalThis.__comboSettings['modelBridge.combos'] = [];
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: false }, token), []);
  assert.match(window.messages.at(-1), /No combos are configured/);

  provider.dispose();
  console.log('Combos smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
