import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'anthropic-provider-options-test-'));
const bundlePath = join(directory, 'claudeProvider.mjs');

try {
  await build({
    entryPoints: ['src/providers/claude/provider.ts'],
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
            export class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
            export class CancellationError extends Error {}
            export class LanguageModelTextPart {}
            export class LanguageModelToolCallPart {}
            export class LanguageModelToolResultPart {}
            export class LanguageModelThinkingPart {}
            export class LanguageModelDataPart { static json(value, mimeType) { return { value, mimeType }; } }
            export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
            export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
            export const workspace = { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } };
            export const commands = { async executeCommand() {} };
            export const window = {};
          `,
          loader: 'js'
        }));
      }
    }]
  });
  const provider = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
  const config = {
    claudePath: 'claude',
    model: 'default',
    instructions: 'test',
    defaultEffort: 'high',
    defaultContextSize: 1000000,
    maxOutputTokens: 128000
  };
  const schema = provider.buildModelConfigurationSchema(config);
  assert.deepEqual(schema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(schema.properties.reasoningEffort.default, 'high');
  assert.deepEqual(schema.properties.contextSize.enum, [100000, 200000, 500000, 1000000]);
  assert.equal(schema.properties.contextSize.default, 1000000);

  assert.equal(provider.resolveEffortOption({ modelOptions: { reasoningEffort: 'xhigh' } }, 'high'), 'xhigh');
  assert.equal(provider.resolveEffortOption({ modelOptions: { reasoningEffort: 'invalid' } }, 'high'), 'high');
  assert.equal(provider.resolveContextSizeOption({ modelOptions: { contextSize: 200000 } }, 1000000), 200000);
  assert.equal(provider.resolveContextSizeOption({ configuration: { contextSize: 123 } }, 1000000), 1000000);
  assert.deepEqual(
    provider.resolveTokenLimits({ maxInputTokens: 1000000, maxOutputTokens: 128000 }, { defaultContextSize: 1000000, maxOutputTokens: 128000 }),
    { maxInputTokens: 872000, maxOutputTokens: 128000 }
  );
  assert.deepEqual(
    provider.resolveTokenLimits({ maxInputTokens: 1000000, maxOutputTokens: 128000 }, { defaultContextSize: 100000, maxOutputTokens: 128000 }),
    { maxInputTokens: 50000, maxOutputTokens: 50000 }
  );
  const creditsMessage = 'Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.';
  assert.deepEqual(provider.getRejectedClaudeModels(creditsMessage, 'best'), ['fable', 'best'], 'Fable credit rejection hides both Fable aliases');
  assert.deepEqual(provider.getRejectedClaudeModels(creditsMessage, 'fable'), ['fable', 'best']);
  assert.deepEqual(provider.getRejectedClaudeModels(creditsMessage, 'default'), ['default'], 'default only hides itself');
  assert.deepEqual(
    provider.getRejectedClaudeModels('The selected Claude model is unavailable for this account. Choose another model or update Claude Code.', 'opus'),
    ['opus']
  );
  assert.equal(provider.getRejectedClaudeModels('Claude account usage limit reached. Check the Claude usage status bar for reset times.', 'opus'), undefined, 'usage limits do not hide models');
  assert.equal(provider.getRejectedClaudeModels('Claude Code request timed out.', 'opus'), undefined);
  console.log('Claude provider model option smoke tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
