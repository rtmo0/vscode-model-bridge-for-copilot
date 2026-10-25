import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  buildClaudeStreamJsonInput,
  ClaudeStreamJsonParser,
  ClaudeToolProtocolParser,
  type ClaudeEffort,
  type ClaudeStreamCallbacks
} from './protocol';

export interface ClaudeCliStatus {
  installed: boolean;
  authenticated: boolean;
  compatible: boolean;
  version?: string;
  authMethod?: string;
  account?: string;
  subscriptionType?: string;
  error?: string;
}

export const MINIMUM_CLAUDE_CODE_VERSION = '2.1.259';

export interface ClaudeCliRequest {
  executable: string;
  model: string;
  effort: ClaudeEffort;
  contextSize: number;
  /** Conversation blocks sent as one stream-json user message; block boundaries enable prompt-cache prefix matches. */
  promptBlocks: readonly string[];
  systemPrompt: string;
  /** `minimal` replaces Claude Code's default system prompt; `claudeCode` appends to it without per-machine sections. */
  systemPromptMode: ClaudeSystemPromptMode;
  markerNonce: string;
  allowedTools: ReadonlySet<string>;
  cwd?: string;
  callbacks: ClaudeStreamCallbacks;
  token: vscode.CancellationToken;
  timeoutMs: number;
  persistSession?: boolean;
  sessionId?: string;
  resumeSession?: boolean;
}

export type ClaudeSystemPromptMode = 'minimal' | 'claudeCode';

const MAX_ERROR_LENGTH = 4_096;

export async function getClaudeCliStatus(executable: string): Promise<ClaudeCliStatus> {
  const versionResult = await runCommand(executable, ['--version']);
  if (versionResult.kind === 'missing') {
    return { installed: false, authenticated: false, compatible: false, error: `Claude Code was not found at "${executable}".` };
  }
  if (versionResult.kind === 'error') {
    return { installed: false, authenticated: false, compatible: false, error: versionResult.message };
  }

  const version = firstLine(versionResult.stdout);
  const compatible = isClaudeVersionAtLeast(version, MINIMUM_CLAUDE_CODE_VERSION);
  const authResult = await runCommand(executable, ['auth', 'status']);
  if (authResult.kind === 'missing') {
    return { installed: false, authenticated: false, compatible: false, error: `Claude Code was not found at "${executable}".` };
  }

  if (authResult.kind === 'error') {
    return {
      installed: true,
      authenticated: false,
      compatible,
      version,
      error: authResult.message
    };
  }

  const payload = parseJsonRecord(authResult.stdout);
  const authMethod = typeof payload?.authMethod === 'string' ? payload.authMethod : undefined;
  const account = firstString(payload?.email, payload?.accountName);
  const subscriptionType = firstString(payload?.subscriptionType);
  const usesApiKey = authMethod === 'api_key' || authMethod === 'api_key_helper';
  return {
    installed: true,
    authenticated: authResult.exitCode === 0 && authMethod !== 'none' && !usesApiKey,
    compatible,
    version,
    authMethod,
    account,
    subscriptionType,
    ...(!compatible
      ? { error: `Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer is required. Run “claude update”.` }
      : usesApiKey
        ? { error: 'Claude Code is using API-key authentication. Sign in with a Claude account instead.' }
        : {})
  };
}

/**
 * Reads account limits through Claude Code's local `/usage` command. It makes no model
 * request and leaves the CLI's credentials with the CLI.
 */
export async function fetchClaudeUsageReport(executable: string): Promise<string> {
  const result = await runCommand(executable, [
    '-p', '/usage',
    '--output-format', 'json',
    '--safe-mode',
    '--tools', '',
    '--no-session-persistence'
  ], 30_000);
  if (result.kind === 'missing') {
    throw new Error(`Claude Code was not found at "${executable}".`);
  }
  if (result.kind === 'error') {
    throw new Error(result.message);
  }
  const payload = parseJsonRecord(result.stdout);
  if (payload?.is_error === true || typeof payload?.result !== 'string') {
    throw new Error('Claude Code did not return account usage.');
  }
  return payload.result;
}

/** A model Claude Code offers to the signed-in account, as its `initialize` control response lists it. */
export interface ClaudeModelOption {
  /** Value for `--model`: an alias (`opus`) or a full model ID (`claude-opus-4-8`). */
  value: string;
  /** The model ID the value currently resolves to. */
  resolvedModel?: string;
  displayName: string;
  description?: string;
  /** Effort levels the model accepts; undefined when it accepts no `--effort`. */
  effortLevels?: string[];
}

const MODEL_CATALOG_REQUEST_ID = 'model-bridge-models';

/**
 * Lists the models Claude Code offers to the signed-in account, the same catalog its own model picker uses.
 * Only the `initialize` control request is sent and the process ends once it answers, so no model request
 * is made and no tokens are used.
 */
export function fetchClaudeModelOptions(executable: string, cwd?: string, timeoutMs = 15_000): Promise<ClaudeModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--safe-mode',
      '--tools', '',
      '--no-session-persistence'
    ], {
      cwd,
      env: getClaudeSignInEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | undefined, models?: ClaudeModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timeout = setTimeout(() => finish(new Error('Timed out while listing Claude Code models.')), timeoutMs);
    timeout.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const message = line ? parseJsonRecord(line) : undefined;
        const response = isRecord(message?.response) ? message.response : undefined;
        if (message?.type === 'control_response' && response?.request_id === MODEL_CATALOG_REQUEST_ID) {
          if (response.subtype === 'success') {
            finish(undefined, parseClaudeModelOptions(response.response));
          } else {
            finish(new Error(typeof response.error === 'string' ? sanitizeCliError(response.error) : 'Claude Code did not list its models.'));
          }
          return;
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_ERROR_LENGTH) stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === 'ENOENT' ? `Claude Code was not found at "${executable}".` : error.message));
    });
    child.once('close', (code) => {
      finish(new Error(sanitizeCliError(stderr) || `Claude Code exited with code ${code ?? -1} before listing its models.`));
    });
    child.stdin.write(`${JSON.stringify({
      type: 'control_request',
      request_id: MODEL_CATALOG_REQUEST_ID,
      request: { subtype: 'initialize' }
    })}\n`);
  });
}

export function parseClaudeModelOptions(payload: unknown): ClaudeModelOption[] {
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set<string>();
  return models.flatMap((entry): ClaudeModelOption[] => {
    if (!isRecord(entry) || typeof entry.value !== 'string' || !/^[\w.:[\]-]{1,128}$/.test(entry.value) || seen.has(entry.value)) {
      return [];
    }
    seen.add(entry.value);
    const levels = Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
      : [];
    return [{
      value: entry.value,
      resolvedModel: typeof entry.resolvedModel === 'string' && entry.resolvedModel ? entry.resolvedModel : undefined,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : entry.value,
      description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined,
      effortLevels: entry.supportsEffort === true && levels.length > 0 ? levels : undefined
    }];
  });
}

export async function streamClaudeResponse(request: ClaudeCliRequest): Promise<void> {
  if (request.token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'model-bridge-for-copilot-'));
  const systemPromptPath = join(temporaryDirectory, 'system-prompt.txt');

  try {
    await writeFile(systemPromptPath, request.systemPrompt, { encoding: 'utf8', mode: 0o600 });
    await runClaudeProcess(request, systemPromptPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runClaudeProcess(request: ClaudeCliRequest, systemPromptPath: string): Promise<void> {
  const args = [
    '-p',
    '--safe-mode',
    '--tools', '',
    '--permission-prompts', 'none',
    '--max-turns', '1',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(request.effort === 'auto' ? [] : ['--effort', request.effort]),
    '--autocompact', formatContextSizeArgument(request.contextSize),
    // Claude Code's default prompt embeds cwd, environment, and git status; they change while
    // an agent edits files and would invalidate the cached tool catalog and history after them.
    ...(request.systemPromptMode === 'minimal'
      ? ['--system-prompt-file', systemPromptPath]
      : ['--append-system-prompt-file', systemPromptPath, '--exclude-dynamic-system-prompt-sections'])
  ];
  if (!request.persistSession) {
    args.push('--no-session-persistence');
  } else if (request.sessionId) {
    args.push(request.resumeSession ? '--resume' : '--session-id', request.sessionId);
    args.push('--system-prompt-snapshot', 'off');
  }
  if (request.model !== 'default') {
    args.push('--model', request.model);
  }

  const child = spawn(request.executable, args, {
    cwd: request.cwd,
    env: getClaudeSignInEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const toolParser = new ClaudeToolProtocolParser(
    request.markerNonce,
    request.allowedTools,
    request.callbacks
  );
  const streamParser = new ClaudeStreamJsonParser(toolParser, request.callbacks);
  let stderr = '';
  let cancelled = request.token.isCancellationRequested;
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill();
    forceKillTimer ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 2_000);
    forceKillTimer.unref();
  };
  const cancellation = request.token.onCancellationRequested(() => {
    cancelled = true;
    terminate();
  });
  if (cancelled) {
    terminate();
  }
  const requestTimeout = request.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs)
    : undefined;
  requestTimeout?.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const complete = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        error === undefined ? resolve() : reject(error);
      };
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          complete(new Error(`Claude Code was not found at "${request.executable}". Install it or update the Claude Code path in settings.`));
          return;
        }
        complete(error);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => streamParser.push(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_ERROR_LENGTH) {
          stderr += chunk.slice(0, MAX_ERROR_LENGTH - stderr.length);
        }
      });
      child.once('close', (code, signal) => {
        if (cancelled) {
          complete(new vscode.CancellationError());
          return;
        }
        if (timedOut) {
          complete(new Error(`Claude Code did not finish within ${formatDuration(request.timeoutMs)}. Increase the request timeout in Model Bridge: Claude settings and retry.`));
          return;
        }
        try {
          streamParser.finish();
        } catch (error) {
          complete(normalizeClaudeError(error));
          return;
        }
        if (code !== 0) {
          const detail = sanitizeCliError(stderr);
          complete(new Error(detail || `Claude Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`));
          return;
        }
        complete();
      });
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          complete(error);
        }
      });
      child.stdin.end(buildClaudeStreamJsonInput(request.promptBlocks), 'utf8');
    });
  } finally {
    cancellation.dispose();
    if (requestTimeout) clearTimeout(requestTimeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

type CommandResult =
  | { kind: 'success'; stdout: string; stderr: string; exitCode: number }
  | { kind: 'error'; stdout: string; stderr: string; exitCode: number; message: string }
  | { kind: 'missing'; message: string };

async function runCommand(executable: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: getClaudeSignInEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        kind: 'error',
        stdout,
        stderr,
        exitCode: -1,
        message: 'Timed out while checking Claude Code.'
      });
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === 'ENOENT') {
        resolve({ kind: 'missing', message: error.message });
      } else {
        resolve({ kind: 'error', stdout, stderr, exitCode: -1, message: error.message });
      }
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        resolve({ kind: 'success', stdout, stderr, exitCode });
      } else {
        resolve({
          kind: 'error',
          stdout,
          stderr,
          exitCode,
          message: sanitizeCliError(stderr) || `Claude Code exited with code ${exitCode}.`
        });
      }
    });
  });
}

function formatContextSizeArgument(contextSize: number): string {
  return contextSize >= 1_000_000 && contextSize % 1_000_000 === 0
    ? `${contextSize / 1_000_000}m`
    : `${Math.round(contextSize / 1_000)}k`;
}

export function isClaudeVersionAtLeast(version: string | undefined, minimum: string): boolean {
  const currentParts = version?.match(/\d+\.\d+\.\d+/)?.[0].split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  if (!currentParts || currentParts.length !== 3 || minimumParts.some((part) => !Number.isFinite(part))) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (currentParts[index] !== minimumParts[index]) {
      return currentParts[index] > minimumParts[index];
    }
  }
  return true;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) {
    return `${milliseconds / 60_000} minute${milliseconds === 60_000 ? '' : 's'}`;
  }
  return `${Math.ceil(milliseconds / 1_000)} seconds`;
}

function normalizeClaudeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not logged in|please run \/login/i.test(message)) {
    return new Error('Claude Code is not signed in. Run “Model Bridge: Claude: Sign in with Browser”.');
  }
  if (/rate limit|usage limit|limit reached/i.test(message)) {
    return new Error('Claude account usage limit reached. Check the Claude usage status bar for reset times.');
  }
  if (/model.+(?:not available|not found|unsupported)|does not support this model/i.test(message)) {
    return new Error('The selected Claude model is unavailable for this account. Choose another model or update Claude Code.');
  }
  if (/prompt.+too long|context.+(?:limit|length)|maximum context/i.test(message)) {
    return new Error('The conversation exceeds the selected Claude context size. Choose a larger context or start a new chat.');
  }
  return error instanceof Error ? error : new Error(message);
}

export function getClaudeSignInEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.CLAUDE_CODE_OAUTH_TOKEN;
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/, 1)[0]?.trim() || undefined;
}

function sanitizeCliError(value: string): string {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!normalized) {
    return '';
  }
  if (/not logged in|please run \/login|not authenticated|authentication (?:failed|required)|invalid (?:oauth|access) token/i.test(normalized)) {
    return 'Claude Code is not signed in. Run “Model Bridge: Claude: Sign in with Browser”.';
  }
  return normalized.slice(0, MAX_ERROR_LENGTH);
}
