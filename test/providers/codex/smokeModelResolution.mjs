import assert from 'node:assert/strict';
import { loadBundled } from './testBundleHelper.mjs';

const bundle = await loadBundled('src/providers/codex/providerModelResolution.ts');

try {
  const {
    createBackendRejectedModelError,
    getBackendModelRejection,
    getExactModelNotFoundName,
    isClientVersionSupported,
    RuntimeModelAvailability
  } = bundle.exports;

  assert.equal(isClientVersionSupported('0.162.0', '0.162.1'), true, 'older minimum is callable');
  assert.equal(isClientVersionSupported('0.162.1', '0.162.1'), true, 'equal minimum is callable');
  assert.equal(isClientVersionSupported('0.163.0', '0.162.1'), false, 'newer minimum is hidden');
  assert.equal(isClientVersionSupported('1.0.0', '0.162.1'), false, 'newer major is hidden');
  assert.equal(isClientVersionSupported(undefined, '0.162.1'), true, 'missing minimum is callable');
  assert.equal(isClientVersionSupported('0.163.0', undefined), true, 'undeclared client version is not filtered');
  assert.equal(isClientVersionSupported('latest', '0.162.1'), true, 'unparseable minimum is not filtered');

  const stored = new Map();
  const memento = { get: (key) => stored.get(key), update: async (key, value) => { stored.set(key, value); } };
  const config = { baseURL: 'https://chatgpt.com/backend-api/codex/responses', transport: 'auto' };
  new RuntimeModelAvailability(memento).markRejectedByBackend('gpt-6-sol', config, 'account-a');
  const reloaded = new RuntimeModelAvailability(memento);
  assert.deepEqual(reloaded.getTemporarilyUnavailableModels(config, 'account-a'), ['gpt-6-sol'], 'backend rejection survives reload');
  assert.deepEqual(reloaded.getTemporarilyUnavailableModels(config, 'account-b'), [], 'backend rejection is scoped to the account');
  const [key, entry] = Object.entries(stored.get('modelBridge.codex.backendRejectedModels'))[0];
  stored.set('modelBridge.codex.backendRejectedModels', { [key]: { ...entry, clientVersion: '0.0.1' } });
  assert.deepEqual(reloaded.getTemporarilyUnavailableModels(config, 'account-a'), [], 'a new declared Codex version retries rejected models');

  const versionMessage = "502 The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
  const accountMessage = "502 The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
  const wrapped = new Error('OpenAI server error while contacting https://chatgpt.com/backend-api/codex/responses. Status: 502.', {
    cause: new Error(versionMessage)
  });
  assert.deepEqual(getBackendModelRejection(wrapped, 'gpt-5.6-sol'), { model: 'gpt-5.6-sol', reason: 'client-version' }, 'nested version rejection is detected');
  assert.deepEqual(getBackendModelRejection({ error: { message: versionMessage } }, 'gpt-5.6-sol'), { model: 'gpt-5.6-sol', reason: 'client-version' }, 'WebSocket error envelope is detected');
  assert.deepEqual(getBackendModelRejection(new Error(accountMessage), 'gpt-6-sol'), { model: 'gpt-6-sol', reason: 'account' }, 'account rejection is detected');
  assert.equal(getBackendModelRejection(new Error(versionMessage), 'gpt-5.5'), undefined, 'rejection for another model is ignored');
  assert.deepEqual(
    getBackendModelRejection(new Error('This model requires a newer version of Codex.'), 'gpt-6-astra'),
    { model: 'gpt-6-astra', reason: 'client-version' },
    'unnamed rejection applies to the requested model'
  );
  assert.equal(getBackendModelRejection(new Error('502 Bad Gateway'), 'gpt-6-astra'), undefined, 'generic 502 is not a model rejection');
  assert.equal(getExactModelNotFoundName(new Error('Model not found gpt-5.5'), 'gpt-5.5'), 'gpt-5.5', 'model-not-found detection is unchanged');

  const surfaced = createBackendRejectedModelError('gpt-5.6-sol', 'client-version', wrapped);
  assert.match(surfaced.message, /gpt-5\.6-sol requires a newer Codex client/);
  assert.equal(surfaced.cause, wrapped, 'original rejection is preserved as cause');
  assert.match(createBackendRejectedModelError('gpt-6-sol', 'account', undefined).message, /not available to ChatGPT accounts/);
  console.log('Smoke test passed: Codex model rejection detection is correct.');
} finally {
  await bundle.dispose();
}
