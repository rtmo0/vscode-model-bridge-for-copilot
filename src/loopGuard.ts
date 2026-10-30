import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Failure-loop guard for agent turns, adapted from the loop guard of TokenEconomizer
 * (https://github.com/microsoft/TokenEconomizer, Apache-2.0): its no-judge `is_stuck` thresholds and presets, failure
 * signatures, and redirect text.
 *
 * The guard keeps no state. Every request folds the tool calls of the current turn from the history, so a redirect
 * lands after the same tool result in every later request of the turn, and prompt caches, Claude continuation, and
 * Codex stateful markers keep seeing an append-only history. Tool results are read in memory only.
 */

export const LOOP_GUARD_SECTION = 'modelBridge.loopGuard';

export type LoopGuardSensitivity = 'conservative' | 'default' | 'aggressive';

export interface LoopGuardSettings {
  enabled: boolean;
  sensitivity: LoopGuardSensitivity;
}

export interface LoopGuardEvent {
  /** `redirect` adds a note for the model; `notice` tells the person that the turn is still stuck after it. */
  action: 'redirect' | 'notice';
  toolCalls: number;
  editedFiles: number;
  errorOutputs: number;
  repeatedFailures: number;
}

export interface LoopGuardResult {
  /** The messages to send: the history with any redirect inserted. */
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  /** Set only on the request whose newest tool results crossed a threshold. */
  event?: LoopGuardEvent;
  /** Text to show at the start of the response when `event.action` is `notice`. */
  notice?: string;
}

interface Thresholds {
  minToolCalls: number;
  editChurn: number;
  distinctEditFiles: number;
  errorOutputs: number;
  stagnation: number;
}

// TokenEconomizer's DEFAULT_THRESHOLDS and SPIRAL_LEVELS for the strict heuristic: churn or scatter, AND sustained
// errors, AND repeated identical failures, which separates a loop from hard but productive work.
const THRESHOLDS: Record<LoopGuardSensitivity, Thresholds> = {
  conservative: { minToolCalls: 28, editChurn: 5, distinctEditFiles: 3, errorOutputs: 8, stagnation: 0.3 },
  default: { minToolCalls: 20, editChurn: 4, distinctEditFiles: 3, errorOutputs: 6, stagnation: 0.2 },
  aggressive: { minToolCalls: 14, editChurn: 3, distinctEditFiles: 3, errorOutputs: 4, stagnation: 0.12 }
};
const SENSITIVITIES: readonly LoopGuardSensitivity[] = ['conservative', 'default', 'aggressive'];

const ERROR_PATTERN = new RegExp([
  'Traceback \\(most recent call last\\)', '\\b\\w*Error\\b', '\\bFAILED\\b', '\\bassert\\b', 'Exception',
  'errors during collection', '^# fail [1-9]', '^not ok \\d', '\\b[1-9]\\d* (?:failing|failures?)\\b', 'Failures: [1-9]'
].join('|'), 'im');
// Go's `--- FAIL: T` and `FAIL<tab>pkg` are case-sensitive, so unittest's `FAIL: test_x` keeps its own signature.
const GO_FAIL_PATTERN = /^(?:--- FAIL: |FAIL\t|FAIL$)/m;
const TEST_RUN_PATTERN = new RegExp([
  'runtests', '\\bpytest\\b', 'py\\.test', 'manage\\.py\\s+test', 'python\\s+-m\\s+unittest', '\\btox\\b', '\\bnox\\b',
  '\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test', '\\b(?:jest|vitest|mocha)\\b', 'node\\s+--test', '\\bgo\\s+test\\b',
  '\\bcargo\\s+test\\b', '\\bdotnet\\s+test\\b', '\\bmvn\\b.*\\btest\\b', '\\bgradlew?\\b.*\\btest\\b'
].join('|'), 'i');
const PATCH_FILE_PATTERN = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
const MAX_SCANNED_RESULT_CHARACTERS = 32_768;

type ToolKind = 'edit' | 'shell' | 'test' | 'content' | 'other';

const TOOL_KINDS: Record<string, ToolKind> = {
  replace_string_in_file: 'edit',
  multi_replace_string_in_file: 'edit',
  insert_edit_into_file: 'edit',
  create_file: 'edit',
  apply_patch: 'edit',
  edit_notebook_file: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  run_in_terminal: 'shell',
  run_task: 'shell',
  bash: 'shell',
  runtests: 'test',
  run_tests: 'test',
  read_file: 'content',
  grep_search: 'content',
  file_search: 'content',
  semantic_search: 'content',
  list_dir: 'content',
  list_code_usages: 'content',
  fetch_webpage: 'content',
  read: 'content',
  grep: 'content',
  glob: 'content'
};

interface ToolCallInfo {
  name: string;
  input: unknown;
}

interface FoldedCall {
  messageIndex: number;
  kind: ToolKind;
  editedFiles: string[];
  command: string;
  resultText: string;
}

class SegmentState {
  toolCalls = 0;
  readonly editCounts = new Map<string, number>();
  errorOutputs = 0;
  testRuns = 0;
  readonly failureSignatures = new Map<string, number>();
  repeatedFailures = 0;

  fold(call: FoldedCall): void {
    this.toolCalls += 1;
    for (const file of call.editedFiles) {
      this.editCounts.set(file, (this.editCounts.get(file) ?? 0) + 1);
    }
    if (call.kind === 'test' || (call.command && TEST_RUN_PATTERN.test(call.command))) {
      this.testRuns += 1;
    }
    // File contents and search results are not outcomes: a test file full of `assert` read back is not a failure.
    const canFail = call.kind === 'content' ? /^\s*ERROR\b/.test(call.resultText) : !/\bexit code:? 0\b/i.test(call.resultText);
    if (!canFail || !hasErrorMarker(call.resultText)) {
      return;
    }
    this.errorOutputs += 1;
    const signature = failureSignature(call.resultText);
    if (signature) {
      const count = this.failureSignatures.get(signature) ?? 0;
      if (count > 0) this.repeatedFailures += 1;
      this.failureSignatures.set(signature, count + 1);
    }
  }

  get editChurn(): number {
    return Math.max(0, ...this.editCounts.values());
  }

  get stagnation(): number {
    let failures = 0;
    for (const count of this.failureSignatures.values()) failures += count;
    return failures === 0 ? 0 : this.repeatedFailures / failures;
  }

  isStuck(thresholds: Thresholds): boolean {
    if (this.toolCalls < thresholds.minToolCalls) return false;
    const churny = this.editChurn >= thresholds.editChurn || this.editCounts.size >= thresholds.distinctEditFiles;
    return churny && this.errorOutputs >= thresholds.errorOutputs && this.stagnation >= thresholds.stagnation;
  }

  toEvent(action: LoopGuardEvent['action'], toolCalls: number): LoopGuardEvent {
    return {
      action,
      toolCalls,
      editedFiles: this.editCounts.size,
      errorOutputs: this.errorOutputs,
      repeatedFailures: this.repeatedFailures
    };
  }
}

export function getLoopGuardSettings(): LoopGuardSettings {
  const configuration = vscode.workspace.getConfiguration(LOOP_GUARD_SECTION);
  const sensitivity = configuration.get<string>('sensitivity', 'default');
  return {
    enabled: configuration.get<boolean>('enabled', false) === true,
    sensitivity: SENSITIVITIES.includes(sensitivity as LoopGuardSensitivity) ? sensitivity as LoopGuardSensitivity : 'default'
  };
}

export function applyLoopGuard(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  settings: LoopGuardSettings = getLoopGuardSettings()
): LoopGuardResult {
  if (!settings.enabled) {
    return { messages };
  }
  const thresholds = THRESHOLDS[settings.sensitivity];
  // Results after the last assistant message are the ones this request adds; earlier triggers were handled before.
  let lastAssistantIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) lastAssistantIndex = index;
  });

  // Redirects of earlier turns stay in place too, so the history the backend sees only ever grows.
  const turns = foldTurns(messages);
  const redirects: Redirect[] = [];
  let latest: TurnOutcome = {};
  turns.forEach((calls, index) => {
    const outcome = guardTurn(calls, thresholds, index === turns.length - 1 ? lastAssistantIndex : Infinity);
    if (outcome.redirect) redirects.push(outcome.redirect);
    latest = outcome;
  });
  return {
    messages: insertRedirects(messages, redirects),
    ...(latest.event ? { event: latest.event } : {}),
    ...(latest.event?.action === 'notice' ? { notice: noticeText(latest.event) } : {})
  };
}

interface Redirect {
  messageIndex: number;
  text: string;
}

interface TurnOutcome {
  redirect?: Redirect;
  event?: LoopGuardEvent;
}

/** One redirect per turn, then one notice; `newAfterIndex` marks the results this request adds. */
function guardTurn(calls: readonly FoldedCall[], thresholds: Thresholds, newAfterIndex: number): TurnOutcome {
  let segment = new SegmentState();
  let redirect: Redirect | undefined;
  for (const [index, call] of calls.entries()) {
    segment.fold(call);
    if (!segment.isStuck(thresholds)) continue;
    const isNew = call.messageIndex > newAfterIndex;
    if (!redirect) {
      redirect = { messageIndex: call.messageIndex, text: redirectText(segment) };
      if (isNew) return { redirect, event: segment.toEvent('redirect', index + 1) };
      // A redirect starts a fresh segment, so the agent gets a fair window to recover before the notice.
      segment = new SegmentState();
      continue;
    }
    return { redirect, ...(isNew ? { event: segment.toEvent('notice', index + 1) } : {}) };
  }
  return { redirect };
}

/** Logs a new event (counts only) and shows its notice at the start of the response. */
export function reportLoopGuard(
  result: LoopGuardResult,
  logger: { info(message: string, fields: Record<string, unknown>): void },
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
  if (result.event) {
    logger.info('Loop guard', { ...result.event });
  }
  if (result.notice) {
    progress.report(new vscode.LanguageModelTextPart(result.notice));
  }
}

// A turn starts at each prompt of the person: a user message with text and no tool results.
function foldTurns(messages: readonly vscode.LanguageModelChatRequestMessage[]): FoldedCall[][] {
  const turns: FoldedCall[][] = [[]];
  const pending = new Map<string, ToolCallInfo>();
  messages.forEach((message, index) => {
    if (message.role === vscode.LanguageModelChatMessageRole.User
      && message.content.some((part) => part instanceof vscode.LanguageModelTextPart)
      && !message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart)) {
      turns.push([]);
      pending.clear();
      return;
    }
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        pending.set(part.callId, { name: part.name, input: part.input });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        const call = pending.get(part.callId);
        pending.delete(part.callId);
        turns[turns.length - 1].push(foldCall(index, call, readResultText(part.content)));
      }
    }
  });
  return turns;
}

function foldCall(messageIndex: number, call: ToolCallInfo | undefined, resultText: string): FoldedCall {
  const name = call?.name ?? '';
  const input = isRecord(call?.input) ? call.input : {};
  const kind = TOOL_KINDS[name.toLowerCase()] ?? 'other';
  return {
    messageIndex,
    kind,
    editedFiles: kind === 'edit' ? readEditedFiles(input) : [],
    command: kind === 'shell' && typeof input.command === 'string' ? input.command : '',
    resultText
  };
}

function readEditedFiles(input: Record<string, unknown>): string[] {
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) files.add(basename(value.trim()));
  };
  add(input.filePath ?? input.path ?? input.file_path);
  if (Array.isArray(input.replacements)) {
    for (const replacement of input.replacements) {
      if (isRecord(replacement)) add(replacement.filePath);
    }
  }
  if (typeof input.input === 'string') {
    for (const match of input.input.matchAll(PATCH_FILE_PATTERN)) add(match[1]);
  }
  return [...files];
}

function readResultText(content: readonly unknown[]): string {
  const text = content.map((part) => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('\n');
  // Bounded scan: the head carries the first error line, the tail the failing-test summary.
  return text.length <= MAX_SCANNED_RESULT_CHARACTERS
    ? text
    : `${text.slice(0, MAX_SCANNED_RESULT_CHARACTERS / 2)}\n${text.slice(-MAX_SCANNED_RESULT_CHARACTERS / 2)}`;
}

function hasErrorMarker(text: string): boolean {
  return ERROR_PATTERN.test(text) || GO_FAIL_PATTERN.test(text);
}

/** A hash of the first failing line without numbers, addresses, and paths, so the same failure matches across runs. */
function failureSignature(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((value) => hasErrorMarker(value));
  if (!line) return undefined;
  const normalized = line.replace(/0x[0-9a-f]+|\d+|\/\S+/gi, '').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// Mirrors only the agent's own actions back at it and never tells it to stop.
function redirectText(state: SegmentState): string {
  let busiest = 'one file';
  let edits = 0;
  let busiestCount = 0;
  for (const [file, count] of state.editCounts) {
    edits += count;
    if (count > busiestCount) {
      busiest = `\`${file}\``;
      busiestCount = count;
    }
  }
  return [
    `Process check (automated by Model Bridge): in this turn you have made ${edits} edit(s) across`,
    `${state.editCounts.size} file(s) (most to ${busiest}) and run ${state.testRuns} verification(s), and the same failure`,
    `has recurred ${state.repeatedFailures} time(s) without the checks passing. This looks like a repetitive loop.`,
    'Do not stop. Step back and try a materially different hypothesis: re-read the failing check\'s expectation,',
    'consider a different file or root cause than the ones you have been editing, and verify the new hypothesis',
    'directly before editing again.'
  ].join(' ');
}

function noticeText(event: LoopGuardEvent): string {
  return `> **Model Bridge loop guard:** this turn still looks stuck after a redirect (${event.toolCalls} tool calls, `
    + `the same failure repeated ${event.repeatedFailures} times). Stop the request if it is not making progress.\n\n`;
}

function insertRedirects(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  redirects: readonly Redirect[]
): readonly vscode.LanguageModelChatRequestMessage[] {
  if (redirects.length === 0) {
    return messages;
  }
  const result = [...messages];
  // From the end, so earlier insertion points keep their indexes.
  for (const redirect of [...redirects].reverse()) {
    result.splice(redirect.messageIndex + 1, 0, vscode.LanguageModelChatMessage.User(redirect.text));
  }
  return result;
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
