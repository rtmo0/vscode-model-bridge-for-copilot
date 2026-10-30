import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'model-bridge-loop-guard-'));
const bundlePath = join(directory, 'loopGuard.mjs');

try {
  await build({
    entryPoints: ['src/loopGuard.ts'],
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
            export class LanguageModelTextPart { constructor(value){ this.value=value; } }
            export class LanguageModelToolCallPart { constructor(callId,name,input){ Object.assign(this,{callId,name,input}); } }
            export class LanguageModelToolResultPart { constructor(callId,content){ Object.assign(this,{callId,content}); } }
            export const LanguageModelChatMessageRole={User:1,Assistant:2};
            export const LanguageModelChatMessage={ User(text){ return { role: 1, name: undefined, content: [new LanguageModelTextPart(text)], injected: true }; } };
            export const workspace={getConfiguration(){return {get(key,fallback){
              const value = globalThis.__loopGuardSettings?.[key];
              return value === undefined ? fallback : value;
            }}}};
            globalThis.__loopGuardVscode = { LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart };
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const { applyLoopGuard, getLoopGuardSettings } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const { LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result } = globalThis.__loopGuardVscode;
  const enabled = { enabled: true, sensitivity: 'default' };

  const prompt = (text) => ({ role: 1, name: undefined, content: [new Text(text)] });
  const answer = (text) => ({ role: 2, name: undefined, content: [new Text(text)] });
  let nextId = 0;
  // One tool round: the assistant call and the user message with its result.
  const round = (name, input, result) => {
    const id = `call_${nextId += 1}`;
    return [
      { role: 2, name: undefined, content: [new Call(id, name, input)] },
      { role: 1, name: undefined, content: [new Result(id, [new Text(result)])] }
    ];
  };
  // Edit the same file, then run the same failing test, again and again.
  const spiral = (pairs) => Array.from({ length: pairs }, () => [
    ...round('replace_string_in_file', { filePath: '/repo/src/app.ts', oldString: 'a', newString: 'b' }, 'The file was edited.'),
    ...round('run_in_terminal', { command: 'npm test' }, 'FAIL src/app.test.ts\nAssertionError: expected 3 to equal 4 at line 12')
  ]).flat();

  // Disabled by default, and the history passes through untouched.
  assert.deepEqual(getLoopGuardSettings(), { enabled: false, sensitivity: 'default' });
  const quiet = [prompt('Fix the bug'), ...spiral(15)];
  assert.equal(applyLoopGuard(quiet).messages, quiet);
  globalThis.__loopGuardSettings = { enabled: true, sensitivity: 'loud' };
  assert.deepEqual(getLoopGuardSettings(), enabled, 'unknown sensitivities fall back to the default');
  delete globalThis.__loopGuardSettings;

  // The 20th tool call (a repeated failure) crosses the default thresholds: a redirect after its result.
  const history = [prompt('Fix the bug'), ...spiral(10)];
  const first = applyLoopGuard(history, enabled);
  assert.equal(first.event?.action, 'redirect');
  assert.deepEqual(first.event, { action: 'redirect', toolCalls: 20, editedFiles: 1, errorOutputs: 10, repeatedFailures: 9 });
  assert.equal(first.notice, undefined);
  assert.equal(first.messages.length, history.length + 1);
  const redirect = first.messages[41];
  assert.equal(redirect.injected, true);
  assert.match(redirect.content[0].value, /10 edit\(s\) across 1 file\(s\) \(most to `app\.ts`\).*recurred 9 time\(s\).*Do not stop/s);
  assert(!/npm test|expected 3/.test(redirect.content[0].value), 'the redirect carries no tool output');
  assert.equal(history.length, 41, 'the input history is not modified');

  // Two calls earlier nothing happens.
  assert.equal(applyLoopGuard(history.slice(0, 39), enabled).messages.length, 39);

  // Later requests keep the redirect at the same place, without a new event.
  const later = [...history, ...spiral(3)];
  const second = applyLoopGuard(later, enabled);
  assert.equal(second.event, undefined);
  assert.equal(second.messages.length, later.length + 1);
  assert.equal(second.messages[41].injected, true);
  assert.deepEqual(second.messages.slice(0, 42), first.messages, 'the history the backend sees only grows');

  // Still stuck 20 calls after the redirect: one notice for the person, and the redirect is not repeated.
  const stuck = [...history, ...spiral(10)];
  const third = applyLoopGuard(stuck, enabled);
  assert.equal(third.event?.action, 'notice');
  assert.equal(third.event.toolCalls, 40);
  assert.match(third.notice, /still looks stuck after a redirect \(40 tool calls/);
  assert.equal(third.messages.filter((message) => message.injected).length, 1);
  const afterNotice = applyLoopGuard([...stuck, ...spiral(4)], enabled);
  assert.equal(afterNotice.event, undefined);
  assert.equal(afterNotice.notice, undefined);

  // A new prompt starts a new turn; the earlier turn's redirect stays where it was.
  const nextTurn = [...stuck, answer('I could not fix it.'), prompt('Try again'), ...spiral(2)];
  const fourth = applyLoopGuard(nextTurn, enabled);
  assert.equal(fourth.event, undefined);
  assert.equal(fourth.messages[41].injected, true);
  assert.equal(fourth.messages.filter((message) => message.injected).length, 1);

  // Reading files full of asserts and errors is not a failure.
  const reading = [prompt('Explain the tests'), ...Array.from({ length: 30 }, (_, index) => [
    ...round('replace_string_in_file', { filePath: `/repo/src/file${index % 4}.ts` }, 'The file was edited.'),
    ...round('read_file', { filePath: '/repo/test/app.test.ts' }, 'assert.equal(error, undefined); // TypeError expected')
  ]).flat()];
  assert.equal(applyLoopGuard(reading, enabled).messages.length, reading.length);

  // Failures that change every time are progress, not a loop.
  const progress = [prompt('Fix the bug'), ...Array.from({ length: 15 }, (_, index) => [
    ...round('apply_patch', { input: `*** Begin Patch\n*** Update File: /repo/src/mod${index % 3}.py\n*** End Patch` }, 'Done.'),
    ...round('run_in_terminal', { command: 'pytest' }, `FAILED tests/test_${String.fromCharCode(97 + index)}.py::case - KeyError: '${String.fromCharCode(97 + index)}'`)
  ]).flat()];
  assert.equal(applyLoopGuard(progress, enabled).event, undefined);

  // A successful exit code is not a failure, even when the output mentions errors.
  const passing = [prompt('Fix the bug'), ...Array.from({ length: 15 }, () => [
    ...round('replace_string_in_file', { filePath: '/repo/src/app.ts' }, 'The file was edited.'),
    ...round('run_in_terminal', { command: 'npm test' }, 'test errors_are_reported ... ok\nCommand exited with exit code 0')
  ]).flat()];
  assert.equal(applyLoopGuard(passing, enabled).event, undefined);

  // Conservative needs more evidence; aggressive steps in earlier.
  assert.equal(applyLoopGuard(history, { enabled: true, sensitivity: 'conservative' }).event, undefined);
  assert.equal(applyLoopGuard([prompt('Fix the bug'), ...spiral(7)], { enabled: true, sensitivity: 'aggressive' }).event?.toolCalls, 14);

  console.log('Loop guard smoke tests passed.');
} finally {
  delete globalThis.__loopGuardSettings;
  delete globalThis.__loopGuardVscode;
  await rm(directory, { recursive: true, force: true });
}
