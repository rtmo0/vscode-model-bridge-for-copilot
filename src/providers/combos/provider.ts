import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { applyLoopGuard, type LoopGuardEvent } from '../../loopGuard';
import type { ProviderAvailability, ProviderId, ProviderRegistry } from '../registry';
import { escalationEvent, executorMessages, isNewPrompt, planHeading, plannerMessages, type PlanPhase } from './planExecute';
import {
  classifyFailure,
  combineTargetWindows,
  ComboRouter,
  comboTargets,
  findTargetModel,
  parseCombos,
  type Combo,
  type ComboTarget,
  type FailureReason,
  type ParsedCombos
} from './routing';

export const COMBOS_SETTING = 'modelBridge.combos';
const MODEL_PREFIX = 'combo::';
const MODEL_LIST_TTL_MS = 30_000;
const MAX_ERROR_SUMMARY_CHARACTERS = 300;
// Codex's continuation marker means nothing to another backend; Claude would render it as an attachment.
const CODEX_MARKER_MIME = 'stateful_marker';

export interface ResolvedTarget {
  target: ComboTarget;
  provider: vscode.LanguageModelChatProvider;
  availability?: ProviderAvailability;
  info: vscode.LanguageModelChatInformation;
}

export interface ResolvedCombo {
  combo: Combo;
  targets: ResolvedTarget[];
  /** Targets left out, with the reason, for the Doctor. */
  missing: Array<{ target: ComboTarget; reason: string }>;
}

export interface ComboTargetStatus {
  label: string;
  role?: 'planner' | 'executor';
  model?: string;
  problem?: string;
  cooldown?: { remainingMs: number; reason: FailureReason };
  /** Out of quota according to the provider's own account status. */
  exhaustedForMs?: number;
}

export interface ComboStatus {
  name: string;
  strategy: Combo['strategy'];
  available: boolean;
  targets: ComboTargetStatus[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
}

interface RequestContext {
  combo: Combo;
  conversation: string;
  options: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
}

const NEVER_CANCELLED: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} })
};

/**
 * Picker models that route each request to another Model Bridge provider, called in-process so usage parts and
 * the target's own usage recording stay intact. Combos log only routing decisions.
 */
export class ComboModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChanged.event;
  private readonly modelLists = new Map<ProviderId, { expiresAt: number; models: Promise<vscode.LanguageModelChatInformation[]> }>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly router: ComboRouter;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly output: vscode.LogOutputChannel,
    private readonly readCombos: () => ParsedCombos = getComboConfig,
    private readonly now: () => number = Date.now
  ) {
    this.router = new ComboRouter(now);
    for (const [id, { provider }] of registry) {
      const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => {
        this.modelLists.delete(id);
        this.modelsChanged.fire();
      });
      if (subscription) this.subscriptions.push(subscription);
    }
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.modelsChanged.dispose();
  }

  refresh(): void {
    this.modelLists.clear();
    this.modelsChanged.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const { combos } = this.readCombos();
    if (combos.length === 0) {
      if (!options.silent) {
        // Not awaited: the model list must not wait for the notification to be dismissed.
        void vscode.window.showInformationMessage(
          `No combos are configured. Add them to ${COMBOS_SETTING}, for example a fallback from Claude to Codex.`,
          'Open Settings'
        ).then((action) => action ? vscode.commands.executeCommand('modelBridge.combos.openSettings') : undefined);
      }
      return [];
    }
    const resolved = await Promise.all(combos.map((combo) => this.resolve(combo)));
    return resolved.filter((entry) => entry.targets.length > 0).map(({ combo, targets }) => {
      const window = combineTargetWindows(targets.map((entry) => entry.info));
      return {
        id: toProviderModelId(combo.name),
        name: combo.name,
        family: 'model-bridge-combo',
        version: combo.strategy,
        tooltip: describeCombo(combo),
        detail: combo.strategy === 'fallback'
          ? targets.map((entry) => entry.info.name).join(' → ')
          : targets.map((entry) => `${entry.target === combo.planner ? 'Plan' : 'Execute'}: ${entry.info.name}`).join(' → '),
        maxInputTokens: window.maxInputTokens,
        maxOutputTokens: window.maxOutputTokens,
        capabilities: { toolCalling: window.toolCalling, imageInput: window.imageInput }
      };
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const { combo, targets } = await this.resolveByModelId(model.id);
    if (targets.length === 0) {
      throw new Error(`None of the models in the combo "${combo.name}" is available. Run "Model Bridge: Combos: Run Doctor".`);
    }
    const request: RequestContext = { combo, conversation: conversationKey(messages), options, progress, token };
    if (combo.strategy === 'fallback') {
      return this.runTargets(request, targets, messages);
    }

    // The executor does the work; when it fails before answering, the planner takes over as in a fallback.
    const executor = targets.find((entry) => entry.target === combo.executor);
    const planner = targets.find((entry) => entry.target === combo.planner);
    const candidates = [executor, planner].filter((entry): entry is ResolvedTarget => entry !== undefined);
    const phase: PlanPhase | undefined = isNewPrompt(messages) ? 'plan' : undefined;
    const event = phase ? undefined : escalationEvent(messages);
    const plannerFirst = this.order(request, candidates)[0] === planner?.target.label;
    if (!planner || (!phase && !event) || plannerFirst || this.isBlocked(planner)) {
      return this.runTargets(request, candidates, messages);
    }
    const plan = await this.runPlanner(request, planner, messages, phase ?? 'revise', event);
    return this.runTargets(request, candidates, plan ? executorMessages(messages, phase ?? 'revise', plan) : messages);
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const { combo, targets } = await this.resolveByModelId(model.id);
    const first = combo.strategy === 'planExecute'
      ? targets.find((entry) => entry.target === combo.executor) ?? targets[0]
      : targets[0];
    if (first) return first.provider.provideTokenCount(first.info, value, token);
    const text = typeof value === 'string'
      ? value
      : value.content.map((part) => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
    return Math.ceil(text.length / 4);
  }

  /** Configured combos with what each target resolves to, for the Doctor. */
  async getStatus(): Promise<{ statuses: ComboStatus[]; invalid: string[] }> {
    this.modelLists.clear();
    const { combos, invalid } = this.readCombos();
    const now = this.now();
    const statuses = await Promise.all(combos.map(async (combo): Promise<ComboStatus> => {
      const { targets, missing } = await this.resolve(combo);
      const window = targets.length > 0 ? combineTargetWindows(targets.map((entry) => entry.info)) : undefined;
      return {
        name: combo.name,
        strategy: combo.strategy,
        available: targets.length > 0,
        targets: comboTargets(combo).map((target): ComboTargetStatus => {
          const resolved = targets.find((entry) => entry.target === target);
          const cooldown = this.router.health.cooldown(target.label);
          const exhaustedUntil = resolved ? this.exhaustedUntil(resolved, now) : undefined;
          return {
            label: target.label,
            ...(combo.strategy === 'planExecute' ? { role: target === combo.planner ? 'planner' as const : 'executor' as const } : {}),
            ...(resolved ? { model: resolved.info.name } : {}),
            ...(resolved ? {} : { problem: missing.find((entry) => entry.target === target)?.reason }),
            ...(cooldown ? { cooldown: { remainingMs: cooldown.until - now, reason: cooldown.reason } } : {}),
            ...(exhaustedUntil !== undefined && exhaustedUntil > now ? { exhaustedForMs: exhaustedUntil - now } : {})
          };
        }),
        ...(window ? {
          maxInputTokens: window.maxInputTokens,
          maxOutputTokens: window.maxOutputTokens,
          toolCalling: Boolean(window.toolCalling),
          imageInput: window.imageInput
        } : {})
      };
    }));
    return { statuses, invalid };
  }

  /** Tries the targets in routing order until one answers; falls back only before any output. */
  private async runTargets(
    request: RequestContext,
    candidates: readonly ResolvedTarget[],
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): Promise<void> {
    const { combo, conversation, options, progress, token } = request;
    const byLabel = new Map(candidates.map((entry) => [entry.target.label, entry]));
    const order = this.order(request, candidates);
    // Each target shows the same loop-guard notice first; hold it back so a fallback does not show it twice.
    const notice = applyLoopGuard(messages).notice;
    const failures: Array<{ label: string; error: unknown }> = [];

    for (const [attempt, label] of order.entries()) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const { target, provider, info } = byLabel.get(label)!;
      if (attempt === 0 && this.isBlocked(byLabel.get(label)!)) {
        this.output.info('Combo targets are all unavailable; trying the one that recovers first', { combo: combo.name, target: label });
      }
      const gate = new OutputGate(progress, notice);
      try {
        await provider.provideLanguageModelChatResponse(info, forTarget(messages, target), options, gate, token);
        gate.flush();
      } catch (error) {
        if (error instanceof vscode.CancellationError || token.isCancellationRequested) throw error;
        const failure = classifyFailure(error);
        // After any output the turn belongs to this target; a failure that every target would hit is not retried.
        if (gate.started || !failure) {
          if (failure) this.router.failed(label, failure);
          this.output.warn('Combo target failed', {
            combo: combo.name,
            target: label,
            reason: failure?.reason ?? 'not-retryable',
            afterOutput: gate.started
          });
          throw error;
        }
        const cooldownMs = this.router.failed(label, failure);
        this.output.warn('Combo target failed before answering; trying the next target', {
          combo: combo.name,
          target: label,
          reason: failure.reason,
          cooldownSeconds: Math.round(cooldownMs / 1_000)
        });
        failures.push({ label, error });
        continue;
      }
      this.router.succeeded(combo.name, conversation, label);
      this.output.info('Combo request completed', {
        combo: combo.name,
        target: label,
        attempt: attempt + 1,
        fallbacks: failures.length
      });
      return;
    }
    throw summarizeFailures(combo.name, failures);
  }

  /**
   * Streams the planner's text under a heading, without tools; thinking, usage, and markers stay out of the
   * response. A failed planner never fails the request: the executor continues with whatever plan was streamed.
   */
  private async runPlanner(
    request: RequestContext,
    planner: ResolvedTarget,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    phase: PlanPhase,
    event: LoopGuardEvent | undefined
  ): Promise<string | undefined> {
    const { combo, options, progress, token } = request;
    const heading = planHeading(phase, planner.info.name);
    let text = '';
    const plannerProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
      report: (part) => {
        if (!(part instanceof vscode.LanguageModelTextPart) || !part.value) return;
        if (!text) progress.report(new vscode.LanguageModelTextPart(heading));
        text += part.value;
        progress.report(part);
      }
    };
    const startedAt = this.now();
    try {
      await planner.provider.provideLanguageModelChatResponse(
        planner.info,
        forTarget(plannerMessages(messages, phase, event), planner.target),
        { ...options, tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        plannerProgress,
        token
      );
      this.router.health.recordSuccess(planner.target.label);
      this.output.info('Combo plan written', {
        combo: combo.name,
        planner: planner.target.label,
        phase,
        planCharacters: text.length,
        durationMs: this.now() - startedAt,
        ...(event ? { toolCalls: event.toolCalls, repeatedFailures: event.repeatedFailures } : {})
      });
    } catch (error) {
      if (error instanceof vscode.CancellationError || token.isCancellationRequested) throw error;
      const failure = classifyFailure(error);
      if (failure) this.router.failed(planner.target.label, failure);
      this.output.warn('Combo planner failed; the executor continues without a plan', {
        combo: combo.name,
        planner: planner.target.label,
        phase,
        reason: failure?.reason ?? 'not-retryable',
        partialPlan: text.length > 0
      });
    }
    if (!text.trim()) return undefined;
    progress.report(new vscode.LanguageModelTextPart('\n\n'));
    return `${heading}${text}\n\n`;
  }

  private order(request: RequestContext, candidates: readonly ResolvedTarget[]): string[] {
    const now = this.now();
    const byLabel = new Map(candidates.map((entry) => [entry.target.label, entry]));
    return this.router.plan(
      request.combo.name,
      request.conversation,
      candidates.map((entry) => entry.target.label),
      (label) => this.exhaustedUntil(byLabel.get(label)!, now)
    );
  }

  private isBlocked(entry: ResolvedTarget): boolean {
    const now = this.now();
    return this.router.health.cooldown(entry.target.label) !== undefined || (this.exhaustedUntil(entry, now) ?? 0) > now;
  }

  // The provider's own account status; a failing status check never blocks a target.
  private exhaustedUntil(entry: ResolvedTarget, now: number): number | undefined {
    try {
      return entry.availability?.exhaustedUntil(entry.info.id, now);
    } catch {
      return undefined;
    }
  }

  private async resolveByModelId(id: string): Promise<ResolvedCombo> {
    const name = fromProviderModelId(id);
    const combo = this.readCombos().combos.find((entry) => entry.name === name);
    if (!combo) {
      throw new Error(`The combo "${name}" is no longer configured in ${COMBOS_SETTING}.`);
    }
    return this.resolve(combo);
  }

  private async resolve(combo: Combo): Promise<ResolvedCombo> {
    const targets: ResolvedTarget[] = [];
    const missing: ResolvedCombo['missing'] = [];
    for (const target of comboTargets(combo)) {
      const entry = this.registry.get(target.provider);
      if (!entry) {
        missing.push({ target, reason: 'provider is not active' });
        continue;
      }
      const info = findTargetModel(target, await this.listModels(target.provider, entry.provider));
      if (info) {
        targets.push({ target, provider: entry.provider, availability: entry.availability, info });
      } else {
        missing.push({ target, reason: 'model not found (the provider may be signed out or unreachable)' });
      }
    }
    return { combo, targets, missing };
  }

  // Cached briefly and shared by concurrent callers; a provider's change event drops its entry.
  private listModels(id: ProviderId, provider: vscode.LanguageModelChatProvider): Promise<vscode.LanguageModelChatInformation[]> {
    const cached = this.modelLists.get(id);
    if (cached && cached.expiresAt > this.now()) return cached.models;
    const models = Promise.resolve()
      .then(() => provider.provideLanguageModelChatInformation({ silent: true }, NEVER_CANCELLED))
      .then((list) => list ?? [])
      .catch((error: unknown) => {
        this.output.warn('Combo target models could not be listed', {
          provider: id,
          error: error instanceof Error ? error.message : String(error)
        });
        return [];
      });
    this.modelLists.set(id, { expiresAt: this.now() + MODEL_LIST_TTL_MS, models });
    return models;
  }
}

/**
 * Forwards response parts and notes whether any reached the response; fallback is possible only before that.
 * A leading loop-guard notice is held until the target reports something else or completes.
 */
export class OutputGate implements vscode.Progress<vscode.LanguageModelResponsePart> {
  started = false;
  private held?: vscode.LanguageModelResponsePart;

  constructor(
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private readonly notice?: string
  ) {}

  report(part: vscode.LanguageModelResponsePart): void {
    if (!this.started && !this.held && this.notice !== undefined
      && part instanceof vscode.LanguageModelTextPart && part.value === this.notice) {
      this.held = part;
      return;
    }
    this.flush();
    this.started = true;
    this.progress.report(part);
  }

  flush(): void {
    const held = this.held;
    this.held = undefined;
    if (held) {
      this.started = true;
      this.progress.report(held);
    }
  }
}

export function getComboConfig(): ParsedCombos {
  return parseCombos(vscode.workspace.getConfiguration('modelBridge').get<unknown>('combos', []));
}

/** In-memory key of a conversation: a hash of its first user message, never persisted or logged. */
export function conversationKey(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  const first = messages.find((message) => message.role === vscode.LanguageModelChatMessageRole.User);
  const text = first
    ? first.content.map((part) => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('\n')
    : '';
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function describeCombo(combo: Combo): string {
  return combo.strategy === 'fallback'
    ? `Fallback combo: ${combo.targets.map((target) => target.label).join(' → ')}. A conversation stays on one model and moves to the next only when it fails before answering.`
    : `Plan → execute combo: ${combo.planner.label} writes a short plan for each new prompt and ${combo.executor.label} carries it out with the tools. The planner is asked again, once per turn, when the executor looks stuck.`;
}

function forTarget(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  target: ComboTarget
): readonly vscode.LanguageModelChatRequestMessage[] {
  const isMarker = (part: unknown) => part instanceof vscode.LanguageModelDataPart && part.mimeType === CODEX_MARKER_MIME;
  if (target.provider === 'codex' || !messages.some((message) => message.content.some(isMarker))) {
    return messages;
  }
  return messages.map((message) => message.content.some(isMarker)
    ? { role: message.role, name: message.name, content: message.content.filter((part) => !isMarker(part)) }
    : message);
}

function summarizeFailures(combo: string, failures: ReadonlyArray<{ label: string; error: unknown }>): unknown {
  if (failures.length === 1) return failures[0].error;
  const details = failures.map(({ label, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    return `${label}: ${message.length > MAX_ERROR_SUMMARY_CHARACTERS ? `${message.slice(0, MAX_ERROR_SUMMARY_CHARACTERS)}…` : message}`;
  });
  const error = new Error(`No model in the combo "${combo}" could answer. ${details.join(' ')}`);
  // Chat appends the stack to third-party errors, which would repeat the message.
  error.stack = undefined;
  return error;
}

function toProviderModelId(name: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(name)}`;
}

function fromProviderModelId(id: string): string {
  return id.startsWith(MODEL_PREFIX) ? decodeURIComponent(id.slice(MODEL_PREFIX.length)) : id;
}
