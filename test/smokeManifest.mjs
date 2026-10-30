import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from '../package.json' with { type: 'json' };

const sourceFiles = await collectTypeScriptFiles('src');
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')))).join('\n');
const registeredCommands = new Set([...source.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const contributedCommands = new Set((manifest.contributes.commands ?? []).map((command) => command.command));
assert.deepEqual(
  [...registeredCommands].sort(),
  [...contributedCommands].sort(),
  'Every registered command must be contributed, and every contributed command must be registered.'
);

const registeredProviders = new Set([
  ...source.matchAll(/registerLanguageModelChatProvider\(\s*['"]([^'"]+)['"]/g)
].map((match) => match[1]));
const contributedProviders = new Set((manifest.contributes.languageModelChatProviders ?? []).map((provider) => provider.vendor));
assert.deepEqual([...registeredProviders].sort(), [...contributedProviders].sort());
assert.deepEqual([...contributedProviders].sort(), [
  'model-bridge-claude',
  'model-bridge-codex',
  'model-bridge-deepseek',
  'model-bridge-lmstudio',
  'model-bridge-openai-compatible'
]);

const authenticationProvider = manifest.contributes.authentication?.[0];
assert.equal(authenticationProvider?.id, 'model-bridge-codex');
assert.match(source, /CODEX_AUTHENTICATION_PROVIDER_ID = 'model-bridge-codex'/);
assert.equal(manifest.name, 'model-bridge-for-copilot');
assert.equal(manifest.icon, 'assets/model-bridge-for-copilot.png');
assert(source.includes("getConfiguration('modelBridge.claude')"));
assert(source.includes("getConfiguration('modelBridge.codex')"));
assert(source.includes("getConfiguration('modelBridge.lmstudio')"));
assert(source.includes("OPENAI_COMPATIBLE_SECTION = 'modelBridge.openaiCompatible'"));
assert(source.includes("DEEPSEEK_SECTION = 'modelBridge.deepseek'"));
const settingKeys = Object.keys(manifest.contributes.configuration.properties);
assert(settingKeys.includes('modelBridge.openaiCompatible.endpoints'));
assert.equal(manifest.contributes.configuration.properties['modelBridge.openaiCompatible.endpoints'].scope, 'machine',
  'workspace settings must not redirect requests that carry stored API tokens');
assert.equal(manifest.contributes.configuration.properties['modelBridge.deepseek.baseURL'].scope, 'machine',
  'workspace settings must not redirect requests that carry the DeepSeek API key');
console.log('Model Bridge manifest smoke tests passed.');

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectTypeScriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  }))).flat();
}
