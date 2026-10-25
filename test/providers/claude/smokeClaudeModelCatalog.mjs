import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-claude-catalog-'));
const fakeCliPath = join(directory, 'fake-claude.mjs');
const recordPath = join(directory, 'record.jsonl');

const CATALOG = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-opus-4-6', displayName: 'Duplicate' },
  { value: 'bad value; rm -rf', displayName: 'Invalid' }
];

try {
  await writeFile(fakeCliPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const record = (entry) => appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(entry) + '\\n');
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('API credential leaked to Claude process');
  process.exit(9);
}
if (args[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ authMethod: 'claude.ai', email: 'user@example.test', subscriptionType: 'max' })); process.exit(0); }
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      record({ kind: 'initialize', args });
      if (mode === 'hang') return;
      if (mode === 'fail') { console.error('Not logged in'); process.exit(1); }
      if (mode === 'error') {
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'initialize failed' } }));
        return;
      }
      console.log(JSON.stringify({ type: 'system', subtype: 'noise' }));
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: { models: [] } } }));
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: ${JSON.stringify(CATALOG)} } } }));
    } else if (message.type === 'user') {
      record({ kind: 'user', args });
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  await chmod(fakeCliPath, 0o755);
  process.env.FAKE_CLAUDE_RECORD = recordPath;
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';

  globalThis.__claudeCatalogTest = { settings: { claudePath: fakeCliPath }, warnings: [] };
  const shim = `
    const test = globalThis.__claudeCatalogTest;
    export class EventEmitter { constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; } fire() { for (const listener of this.listeners) listener(); } dispose() {} }
    export class CancellationError extends Error {}
    export class LanguageModelTextPart { constructor(value) { this.value = value; } }
    test.TextPart = LanguageModelTextPart;
    export class LanguageModelToolCallPart {}
    export class LanguageModelToolResultPart {}
    export class LanguageModelThinkingPart {}
    export class LanguageModelDataPart { static json(value, mimeType) { return { value, mimeType }; } }
    export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
    export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
    export const workspace = {
      workspaceFolders: undefined,
      getConfiguration() { return { get(key, fallback) { return key in test.settings ? test.settings[key] : fallback; } }; }
    };
    export const commands = { async executeCommand() {} };
    export const window = { async showWarningMessage(message) { test.warnings.push(message); } };
  `;
  const bundle = async (entry, name) => {
    const outfile = join(directory, name);
    await build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile,
      plugins: [{ name: 'vscode-test-shim', setup(buildApi) {
        buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
        buildApi.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: shim, loader: 'js' }));
      } }]
    });
    return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  };
  const cli = await bundle('src/providers/claude/cli.ts', 'cli.mjs');
  const catalog = await bundle('src/providers/claude/modelCatalog.ts', 'catalog.mjs');
  const providerModule = await bundle('src/providers/claude/provider.ts', 'provider.mjs');
  const readRecords = async () => (await readFile(recordPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

  // ------------------------------------------------------------ CLI listing
  const options = await cli.fetchClaudeModelOptions(fakeCliPath);
  assert.deepEqual(options.map((option) => option.value), ['default', 'opus', 'fable', 'haiku', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
    'duplicates and unsafe values are dropped');
  assert.equal(options[4].effortLevels, undefined, 'models without effort support take no --effort');
  assert.deepEqual(options[5].effortLevels, ['low', 'medium', 'high', 'max']);
  const [initialize] = await readRecords();
  assert.equal(initialize.kind, 'initialize');
  for (const flag of ['--safe-mode', '--no-session-persistence', '--input-format', '--output-format']) assert(initialize.args.includes(flag), flag);
  assert.equal(initialize.args[initialize.args.indexOf('--tools') + 1], '', 'built-in tools stay disabled');
  assert.equal((await readRecords()).filter((entry) => entry.kind === 'user').length, 0, 'listing models sends no user message');

  process.env.FAKE_CLAUDE_MODE = 'error';
  await assert.rejects(cli.fetchClaudeModelOptions(fakeCliPath), /initialize failed/);
  process.env.FAKE_CLAUDE_MODE = 'fail';
  await assert.rejects(cli.fetchClaudeModelOptions(fakeCliPath), /not signed in/, 'CLI errors are translated like other Claude Code errors');
  process.env.FAKE_CLAUDE_MODE = 'hang';
  await assert.rejects(cli.fetchClaudeModelOptions(fakeCliPath, undefined, 300), /Timed out/);
  delete process.env.FAKE_CLAUDE_MODE;
  await assert.rejects(cli.fetchClaudeModelOptions(join(directory, 'missing-claude')), /not found/);

  // ------------------------------------------------------------ entries
  const entries = catalog.buildClaudeModelEntries(options);
  assert.deepEqual(entries.map((entry) => entry.value), ['default', 'best', 'opus', 'fable', 'haiku', 'claude-haiku-4-5-20251001', 'claude-opus-4-6']);
  const byValue = Object.fromEntries(entries.map((entry) => [entry.value, entry]));
  assert.equal(byValue.default.name, 'Claude Default');
  assert.equal(byValue.default.detail, 'Claude Code default · claude-opus-5-5');
  assert.equal(byValue.opus.name, 'Claude Opus 5.5');
  assert.equal(byValue.opus.detail, 'Latest Opus · claude-opus-5-5');
  assert.equal(byValue['claude-opus-4-6'].name, 'Claude Opus 4.6');
  assert.equal(byValue['claude-opus-4-6'].detail, 'claude-opus-4-6');
  assert.equal(byValue['claude-opus-4-6'].family, 'claude-opus');
  assert.equal(byValue['claude-opus-4-6'].alias, false);
  assert.equal(byValue.best.version, 'claude-fable-5-1', 'best follows Fable when the account has it');
  assert.equal(byValue['claude-haiku-4-5-20251001'].efforts, undefined);

  const fallback = catalog.buildClaudeModelEntries(undefined);
  assert.deepEqual(fallback.map((entry) => entry.value), ['default', 'best', 'fable', 'sonnet', 'opus', 'haiku']);
  assert(fallback.every((entry) => entry.efforts.length === 5));

  const visible = catalog.filterVisibleEntries(entries, { enabledModels: ['default', 'opus'], hiddenModels: ['claude-opus-4-6'] }, new Set(['default']));
  assert.deepEqual(visible.map((entry) => entry.value), ['opus', 'claude-haiku-4-5-20251001'],
    'aliases follow enabledModels, versions follow hiddenModels, and rejected models are hidden');

  assert.equal(catalog.resolveModelEffort('xhigh', byValue['claude-opus-4-6']), 'auto', 'unsupported efforts fall back to the Claude Code default');
  assert.equal(catalog.resolveModelEffort('max', byValue['claude-opus-4-6']), 'max');
  assert.equal(catalog.resolveModelEffort('high', byValue['claude-haiku-4-5-20251001']), 'auto');
  assert.equal(catalog.resolveModelEffort('high', undefined), 'high');

  // ------------------------------------------------------------ provider
  const state = new Map();
  const memento = { get: (key) => state.get(key), update: async (key, value) => { value === undefined ? state.delete(key) : state.set(key, value); } };
  const output = { info() {}, warn() {}, debug() {}, error() {} };
  const provider = new providerModule.ClaudeModelProvider(output, undefined, memento);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.deepEqual(models.map((model) => model.id), [
    'anthropic::default', 'anthropic::best', 'anthropic::opus', 'anthropic::fable', 'anthropic::haiku',
    'anthropic::claude-haiku-4-5-20251001', 'anthropic::claude-opus-4-6'
  ], 'specific versions appear next to the aliases');
  const modelById = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(modelById['anthropic::claude-opus-4-6'].name, 'Claude Opus 4.6');
  assert.equal(modelById['anthropic::claude-opus-4-6'].version, 'claude-opus-4-6');
  assert.deepEqual(modelById['anthropic::claude-opus-4-6'].configurationSchema.properties.reasoningEffort.enum, ['auto', 'low', 'medium', 'high', 'max']);
  assert.equal(modelById['anthropic::claude-haiku-4-5-20251001'].configurationSchema.properties.reasoningEffort, undefined);
  assert(modelById['anthropic::claude-haiku-4-5-20251001'].configurationSchema.properties.contextSize);
  assert.equal(state.get('modelBridge.claude.modelCatalog').models.length, 6, 'the catalog is cached');
  assert.doesNotMatch(JSON.stringify(state.get('modelBridge.claude.modelCatalog')), /user@example/, 'the account is hashed in the cache key');

  // A second listing uses the cache without starting Claude Code again.
  const listingsBefore = (await readRecords()).filter((entry) => entry.kind === 'initialize').length;
  const reloaded = new providerModule.ClaudeModelProvider(output, undefined, memento);
  assert.equal((await reloaded.provideLanguageModelChatInformation({ silent: true }, token)).length, 7);
  assert.equal((await readRecords()).filter((entry) => entry.kind === 'initialize').length, listingsBefore);

  // Settings hide aliases and versions; an empty alias list still keeps something to choose.
  globalThis.__claudeCatalogTest.settings.enabledModels = [];
  globalThis.__claudeCatalogTest.settings.hiddenModels = ['claude-haiku-4-5-20251001'];
  assert.deepEqual((await reloaded.provideLanguageModelChatInformation({ silent: true }, token)).map((model) => model.id), ['anthropic::claude-opus-4-6']);
  globalThis.__claudeCatalogTest.settings.hiddenModels = ['claude-haiku-4-5-20251001', 'claude-opus-4-6'];
  assert.deepEqual((await reloaded.provideLanguageModelChatInformation({ silent: true }, token)).map((model) => model.id), ['anthropic::default']);
  delete globalThis.__claudeCatalogTest.settings.enabledModels;
  delete globalThis.__claudeCatalogTest.settings.hiddenModels;

  // Requests pass the full model ID and drop an effort the model does not accept.
  await reloaded.provideLanguageModelChatResponse(
    modelById['anthropic::claude-opus-4-6'],
    [{ role: 1, name: undefined, content: [new globalThis.__claudeCatalogTest.TextPart('hi')] }],
    { modelOptions: { reasoningEffort: 'xhigh' } },
    { report() {} },
    token
  );
  const request = (await readRecords()).filter((entry) => entry.kind === 'user').at(-1);
  assert.equal(request.args[request.args.indexOf('--model') + 1], 'claude-opus-4-6');
  assert.equal(request.args.includes('--effort'), false, 'xhigh is not sent to a model that does not support it');

  // A failed listing falls back to the built-in aliases.
  process.env.FAKE_CLAUDE_MODE = 'fail';
  const uncached = new providerModule.ClaudeModelProvider(output, undefined, { get: () => undefined, update: async () => {} });
  assert.deepEqual((await uncached.provideLanguageModelChatInformation({ silent: true }, token)).map((model) => model.id),
    ['anthropic::default', 'anthropic::best', 'anthropic::fable', 'anthropic::sonnet', 'anthropic::opus', 'anthropic::haiku']);
  delete process.env.FAKE_CLAUDE_MODE;

  // Refresh Models drops the cache and lists again.
  reloaded.refreshModelCatalog();
  assert.equal(state.has('modelBridge.claude.modelCatalog'), false);
  assert.equal((await reloaded.listModelChoices()).length, 7);
  assert(state.has('modelBridge.claude.modelCatalog'));

  console.log('Claude model catalog smoke tests passed.');
} finally {
  delete globalThis.__claudeCatalogTest;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FAKE_CLAUDE_RECORD;
  await rm(directory, { recursive: true, force: true });
}
