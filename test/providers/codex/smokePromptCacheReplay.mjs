import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const identityModule = await loadBundled('src/providers/codex/codexIdentity.ts');
const replayModule = await loadBundled('src/providers/codex/nativeToolSearch/nativeToolReplay.ts');
try {
  const { derivePromptCacheKey, isUuid } = identityModule.exports;
  const { buildCanonicalReplayInput } = replayModule.exports;

  const root = { type: 'message', role: 'user', content: 'Fix the failing test' };
  const turn = [root, { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }];
  const key = derivePromptCacheKey('account-a', turn);
  assertEqual(isUuid(key), true, 'prompt cache key is UUID-shaped');
  assertEqual(
    derivePromptCacheKey('account-a', [...turn, { type: 'function_call_output', call_id: 'c1', output: 'ok' }]),
    key,
    'prompt cache key stays stable as the conversation grows'
  );
  assertEqual(
    derivePromptCacheKey('account-a', [root, { type: 'message', role: 'user', content: 'edited follow-up' }]),
    key,
    'forks that share the conversation root keep the prompt cache key'
  );
  assertEqual(derivePromptCacheKey('account-b', turn) === key, false, 'prompt cache key is scoped to the account');
  assertEqual(
    derivePromptCacheKey('account-a', [{ type: 'message', role: 'user', content: 'Another conversation' }]) === key,
    false,
    'different conversation roots get different keys'
  );
  assertEqual(derivePromptCacheKey('account-a', [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }]), undefined, 'no key without a user message');

  const previousInput = [root];
  const snapshot = {
    fullRequest: { input: previousInput },
    responseId: 'resp_1',
    responseItems: [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
      { type: 'reasoning', id: 'rs_2', summary: [] },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }
    ],
    requestFingerprint: 'fingerprint',
    turnId: 'turn'
  };
  const appended = [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }];
  const replay = buildCanonicalReplayInput({
    previousSnapshot: snapshot,
    convertedInput: [root, snapshot.responseItems[2], ...appended],
    appendedInput: appended
  });
  assertEqual(
    JSON.stringify(replay.map((item) => item.id ?? item.type)),
    JSON.stringify(['message', 'rs_1', 'function_call', 'function_call_output']),
    'canonical replay keeps encrypted reasoning and drops reasoning without encrypted content'
  );
  assertEqual(
    buildCanonicalReplayInput({ convertedInput: [root], appendedInput: [] }).length,
    1,
    'without a snapshot the converted VS Code history is replayed'
  );
  assertEqual(
    buildCanonicalReplayInput({ previousSnapshot: { ...snapshot, catalogHash: 'old' }, convertedInput: [root], appendedInput: [], catalogHash: 'new' })[0],
    root,
    'a changed native tool catalog falls back to the converted history'
  );
  console.log('Smoke test passed: Codex prompt cache key and canonical replay are correct.');
} finally {
  await identityModule.dispose();
  await replayModule.dispose();
}
