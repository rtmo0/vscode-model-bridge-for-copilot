import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  ClaudeStreamJsonParser,
  ClaudeToolProtocolParser,
  type ClaudeEffort,
  type ClaudeStreamCallbacks
} from './claudeProtocol';

export interface ClaudeCliStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  authMethod?: string;
  account?: string;
  error?: string;
}

export interface ClaudeCliRequest {
  executable: string;
  model: string;
  effort: ClaudeEffort;
  contextSize: number;
  prompt: string;
  systemPrompt: string;
  markerNonce: string;
  allowedTools: ReadonlySet<string>;
  cwd?: string;
  callbacks: ClaudeStreamCallbacks;
  token: vscode.CancellationToken;
}

const MAX_ERROR_LENGTH = 4_096;

export async function getClaudeCliStatus(executable: string): Promise<ClaudeCliStatus> {
  const versionResult = await runCommand(executable, ['--version']);
  if (versionResult.kind === 'missing') {
    return { installed: false, authenticated: false, error: `Claude Code was not found at "${executable}".` };
  }
  if (versionResult.kind === 'error') {
    return { installed: false, authenticated: false, error: versionResult.message };
  }

  const authResult = await runCommand(executable, ['auth', 'status']);
  if (authResult.kind === 'missing') {
    return { installed: false, authenticated: false, error: `Claude Code was not found at "${executable}".` };
  }

  const version = firstLine(versionResult.stdout);
  if (authResult.kind === 'error') {
    return {
      installed: true,
      authenticated: false,
      version,
      error: authResult.message
    };
  }

  const payload = parseJsonRecord(authResult.stdout);
  const authMethod = typeof payload?.authMethod === 'string' ? payload.authMethod : undefined;
  const account = firstString(payload?.email, payload?.accountName, payload?.subscriptionType);
  const usesApiKey = authMethod === 'api_key' || authMethod === 'api_key_helper';
  return {
    installed: true,
    authenticated: authResult.exitCode === 0 && authMethod !== 'none' && !usesApiKey,
    version,
    authMethod,
    account,
    ...(usesApiKey ? { error: 'Claude Code is using API-key authentication. Sign in with a Claude account instead.' } : {})
  };
}

export async function streamClaudeResponse(request: ClaudeCliRequest): Promise<void> {
  if (request.token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'anthropic-for-copilot-'));
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
    '--max-turns', '1',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--effort', request.effort,
    '--autocompact', formatContextSizeArgument(request.contextSize),
    '--append-system-prompt-file', systemPromptPath
  ];
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

  const cancellation = request.token.onCancellationRequested(() => {
    cancelled = true;
    child.kill();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(new Error(`Claude Code was not found at "${request.executable}". Install it or update the Claude Code path in settings.`));
          return;
        }
        reject(error);
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
          reject(new vscode.CancellationError());
          return;
        }
        try {
          streamParser.finish();
        } catch (error) {
          reject(error);
          return;
        }
        if (code !== 0) {
          const detail = sanitizeCliError(stderr);
          reject(new Error(detail || `Claude Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`));
          return;
        }
        resolve();
      });
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          reject(error);
        }
      });
      child.stdin.end(request.prompt, 'utf8');
    });
  } finally {
    cancellation.dispose();
  }
}

type CommandResult =
  | { kind: 'success'; stdout: string; stderr: string; exitCode: number }
  | { kind: 'error'; stdout: string; stderr: string; exitCode: number; message: string }
  | { kind: 'missing'; message: string };

async function runCommand(executable: string, args: string[]): Promise<CommandResult> {
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
    }, 10_000);
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

export function getClaudeSignInEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.CLAUDE_CODE_OAUTH_TOKEN;
  return environment;
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
  if (/not logged in|authentication|login/i.test(normalized)) {
    return 'Claude Code is not signed in. Run “Anthropic for Copilot: Sign in with Browser”.';
  }
  return normalized.slice(0, MAX_ERROR_LENGTH);
}
