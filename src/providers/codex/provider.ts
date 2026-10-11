import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import {
  createStatefulMarkerPayload,
  convertMessagesToResponsesInput,
  convertMessagesToResponsesInputWithStatefulMarker,
  estimateTokenCount,
  stableSerialize,
  type ResponsesInputMessage
} from './convertMessages';
import { ResponsesQuotaExceededError, ResponsesRateLimitedError, toChatLimitError } from './responsesLimitError';
import { getProviderConfig, type ProviderConfig } from './config';
import {
  buildFallbackModel,
  buildProviderModels,
  fetchAvailableModels,
  isProviderModelIdentifier,
  parseModelIdentifier,
  type ParsedModelIdentifier,
  type ResolvedProviderModel
} from './models';
import { toResponsesReasoning } from './reasoningEffort';
import {
  countInputTokens,
  disposeReusableResponsesWebSockets,
  isResponsesContinuationMissError,
  normalizeBaseURL,
  preconnectCodexResponsesWebSocket,
  streamResponseText
} from './responsesClient';
import { ResponseBranchStore } from './responseBranchStore';
import { getApiCredentials } from './secrets';
import type { CodexAuthManager } from './auth/codexAuthManager';
import { CodexIdentityManager, inputStartsNewTurn } from './codexIdentity';
import { getCodexCompatibilityProfile, type CodexRequestIdentity } from './codexProtocol';
import { resolveRequestIdentity } from './codexRequestIdentity';
import { resetCodexFetchCapabilities } from './codexFetchAdapter';
import { buildCodexResponsesRequest, type CodexRequestEnvelopeOptions } from './codexRequestBuilder';
import type { CodexBranchState } from './responseBranchStore';
import { shortHash } from './codexTelemetry';
import { type CodexLogSink, CodexLogger, createCodexLogger } from './codexLogger';
import { CodexLatencyRecorder } from './codexLatency';
import { createCodexContinuationSnapshot } from './codexContinuation';
import { resolveCodexToolPlan } from './nativeToolSearch/nativeToolCatalog';
import { mapNativeToolCall } from './nativeToolSearch/nativeToolCallMapper';
import { hasNativeToolGroupingBridgeOwnership } from './nativeToolSearch/nativeToolGroupingBridge';
import {
  canUseNativeToolSearch,
  isNativeToolSearchUnsupportedError,
  markNativeToolSearchUnsupported,
  nativeToolSearchCapabilityKey
} from './nativeToolSearch/nativeToolCapabilities';
import { getVirtualToolPlaceholderNames } from './nativeToolSearch/nativeToolPolicy';
import { buildCanonicalReplayInput, createCanonicalReplayRequest } from './nativeToolSearch/nativeToolReplay';
import { summarizeNativeToolSearchItem } from './nativeToolSearch/nativeToolLogging';
import { recordNativeToolSearchRuntimeStatus } from './nativeToolSearch/nativeToolSearchStatus';
import { resolveHostedToolPlan } from './hostedTools/hostedToolPlan';
import { WebSearchStatusPresenter, type HostedToolLifecycleEvent } from './hostedTools/hostedToolEvents';
import { StreamPresenter, mergeStreamPresentationMetrics } from './streamPresenter';
import { ReasoningStreamPresenter } from './reasoningStreamPresenter';
import {
  CodexModelCache,
  MODEL_CACHE_FRESH_TTL_MS,
  MODEL_CACHE_STALE_TTL_MS,
  type CodexModelCacheState
} from './codexModelCache';
import {
  RuntimeModelAvailability,
  TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS,
  buildModelCacheKey,
  createBackendRejectedModelError,
  createTemporarilyUnavailableModelError,
  getBackendModelRejection,
  getExactModelNotFoundName,
  isClientVersionSupported,
  getRequestServiceTier,
  resolveModelAliasTarget
} from './providerModelResolution';
import {
  buildLegacyFallbackReplayInput,
  buildResponseBranchReuseEnvelope,
  getExactLocalBranchHistoryStatus,
  hasCanonicalReplayContinuationIntegrity,
  projectSafeRawReplayItem
} from './providerReplay';
import {
  type RuntimeProvideLanguageModelChatResponseOptions,
  buildCodexUserAgent,
  combineRequestInstructions,
  createAbortError,
  createMemoryMemento,
  createStatefulMarkerDataPart,
  createThinkingPart,
  createUsageDataPart,
  getCredentialIdentity,
  getExtensionVersion,
  getReasoningEffort,
  getToolModeName,
  isAbortError,
  readLatencyContextFromTransportMetrics,
  resolveConfiguredContextSize,
  summarizeToolNames,
  supportsOfficialTokenCounting,
  waitForPromiseWithCancellation
} from './providerSupport';
import { ReportedToolCallTracker, ToolOutputContinuationCapabilities } from './toolCallTracking';

export { buildResponseBranchReuseEnvelope, buildResponseBranchToolSignatures, hasCanonicalReplayContinuationIntegrity } from './providerReplay';
export { getReasoningEffort } from './providerSupport';

interface ResolvedRequestModel extends ParsedModelIdentifier {
  effectiveInputBudget?: number;
}

interface ProviderModelCatalog {
  models: ResolvedProviderModel[];
  authoritative: boolean;
}

const MODEL_DISCOVERY_FALLBACK_TTL_MS = 60_000;
const MAX_LOCAL_TOKEN_ESTIMATE_DIAGNOSTICS = 64;
const STATEFUL_MARKER_LOCAL_ERROR = 'Stateful continuation marker could not be resolved locally.';
const TEXT_STREAM_MIN_REPORT_INTERVAL_MS = 80;
const TEXT_STREAM_MAX_REPORT_INTERVAL_MS = 100;
const TEXT_STREAM_TARGET_REPORT_CHARACTERS = 20;
const TEXT_STREAM_MAX_REPORT_CHARACTERS = 64;
const TOOL_BOUNDARY_MAX_REPORT_CHARACTERS = 512;
const TEXT_STREAM_SMOOTHING_BUFFER_CHARACTERS = 1_024;
const WEB_SEARCH_STATUS_DETAIL_GRACE_MS = 300;

// The WebSocket tool-output continuation path passed the real-backend release
// gate: five consecutive store:false tool loops completed with a matching
// previous_response_id and a single incremental function_call_output.
const TOOL_OUTPUT_CONTINUATION_ENABLED = true;

const NON_CANCELLABLE_TOKEN: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new vscode.Disposable(() => {})
};

function getToolOutputFullReplayReason(options: {
  hasOnlyToolOutputAppend: boolean;
  transport: ProviderConfig['transport'];
  capability: boolean | undefined;
}): string {
  if (!options.hasOnlyToolOutputAppend) {
    return 'non-tool-output-append';
  }
  if (options.transport === 'http') {
    return 'http-transport';
  }
  if (!TOOL_OUTPUT_CONTINUATION_ENABLED) {
    return 'release-gated';
  }
  if (options.capability === false) {
    return 'capability-unsupported';
  }
  return 'continuation-ineligible';
}

export interface UsageSink {
  record(event: {
    model: string;
    usage: ResponseUsage;
    completedAt: number;
  }): void;
}

export interface SelectedModelSink {
  setSelectedModel(model: string): void;
}

export interface AccountUsageRefreshSink {
  refresh(): Promise<void>;
}

export class CodexModelProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  private readonly responseBranchStore = new ResponseBranchStore();
  private readonly runtimeAvailability: RuntimeModelAvailability;
  private readonly identityManager: CodexIdentityManager;
  private readonly reportedToolCalls = new ReportedToolCallTracker();
  private readonly toolOutputContinuationCapabilities = new ToolOutputContinuationCapabilities();
  private readonly localTokenEstimateDiagnostics = new Set<string>();
  private localTokenEstimateCount = 0;
  private localTokenEstimateDurationMs = 0;
  private readonly modelCache = new CodexModelCache<ProviderModelCatalog>({
    freshTtlMs: MODEL_CACHE_FRESH_TTL_MS,
    staleTtlMs: MODEL_CACHE_STALE_TTL_MS
  });
  private lastConnectionConfigurationKey?: string;
  private lastVirtualToolFallbackSignature?: string;
  private readonly logger: CodexLogger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    logger: CodexLogger | CodexLogSink,
    private readonly usageSink?: UsageSink,
    private readonly accountUsageRefreshSink?: AccountUsageRefreshSink,
    private readonly selectedModelSink?: SelectedModelSink,
    private readonly authManager?: CodexAuthManager
  ) {
    this.logger = logger instanceof CodexLogger ? logger : createCodexLogger(logger, 'provider');
    const runtimeContext = context as vscode.ExtensionContext & {
      globalState?: vscode.Memento;
    };
    this.identityManager = new CodexIdentityManager(runtimeContext.globalState ?? createMemoryMemento());
    this.runtimeAvailability = new RuntimeModelAvailability(runtimeContext.globalState);
    this.onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    this.context.subscriptions.push(
      this.modelInfoChangedEmitter,
      new vscode.Disposable(() => disposeReusableResponsesWebSockets()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('modelBridge.codex')) {
          disposeReusableResponsesWebSockets();
          resetCodexFetchCapabilities();
          this.lastConnectionConfigurationKey = undefined;
          this.localTokenEstimateDiagnostics.clear();
          this.modelCache.clear();
          this.modelInfoChangedEmitter.fire();
        }
      })
    );
  }

  // Keeps the existing provider diagnostics compact while routing every event
  // through the safe structured logger.
  private get outputChannel(): CodexLogger {
    return this.logger;
  }

  handleAuthenticationChanged(): void {
    disposeReusableResponsesWebSockets();
    resetCodexFetchCapabilities();
    this.lastConnectionConfigurationKey = undefined;
    this.localTokenEstimateDiagnostics.clear();
    this.modelCache.clear();
    this.modelInfoChangedEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);

    this.outputChannel.debug('provideLanguageModelChatInformation start', {
      silent: options.silent,
      baseURL: normalizeBaseURL(config.baseURL),
      clientVersion: config.clientVersion,
      hasCredentials: Boolean(credentials)
    });

    if (!credentials) {
      if (!options.silent) {
        const action = await vscode.window.showWarningMessage(
          'Codex browser sign-in is required.',
          { modal: true },
          'Sign in with Browser',
          'Cancel'
        );

        if (action === 'Sign in with Browser') {
          await vscode.commands.executeCommand('modelBridge.codex.auth.signInWithBrowser');
        }
      }

      return [];
    }

    const { models } = await this.getAvailableModelCatalog(config, credentials, token);
    this.scheduleWebSocketPreconnection(config, credentials, getCredentialIdentity(credentials));
    this.outputChannel.debug('provideLanguageModelChatInformation complete', {
      modelCount: models.length,
      models: models.map((model) => ({
        id: model.info.id,
        name: model.info.name,
        maxInputTokens: model.info.maxInputTokens,
        maxOutputTokens: model.info.maxOutputTokens
      }))
    });
    return models.map((model) => model.info);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const requestLogger = this.logger.operation('chat.response');
    const latency = new CodexLatencyRecorder();
    const config = getProviderConfig();
    const credentials = await getApiCredentials(this.context, this.authManager);
    latency.mark('credentialsResolved');

    if (!credentials) {
      throw new Error('Codex is not signed in. Run "Model Bridge: Codex: Sign in with Browser".');
    }

    const convertedMessages = convertMessagesToResponsesInputWithStatefulMarker(messages);
    if (convertedMessages.statefulMarker.kind === 'invalid'
      && convertedMessages.statefulMarker.isLeadingStandalone) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    if (convertedMessages.statefulMarker.kind === 'valid'
      && convertedMessages.statefulMarker.isLeadingStandalone
      && convertedMessages.statefulMarker.modelId !== model.id) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }

    const authIdentity = getCredentialIdentity(credentials);
    this.handleConnectionConfiguration(config, authIdentity);
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials, config.protocol.profile);
    const modelCacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    const cachedCatalog = this.modelCache.peek(modelCacheKey);
    const directModel = cachedCatalog?.authoritative
      ? undefined
      : this.resolveDirectRequestModel(model, config, authIdentity);
    let selectedModel: ResolvedRequestModel;
    if (directModel) {
      selectedModel = directModel;
      latency.recordContext({ modelDiscoveryCacheState: 'direct' });
      requestLogger.debug('request model resolved from provider model id', {
        modelId: model.id,
        requestModel: selectedModel.requestModel
      });
    } else {
      const catalog = await this.getAvailableModelCatalog(config, credentials, token, (state) => {
        latency.recordContext({ modelDiscoveryCacheState: state });
      });
      selectedModel = this.resolveRequestModel(model.id, config, catalog.models, catalog.authoritative);
    }
    selectedModel = {
      ...selectedModel,
      effectiveInputBudget: resolveConfiguredContextSize(
        selectedModel.effectiveInputBudget,
        model,
        options as RuntimeProvideLanguageModelChatResponseOptions
      )
    };
    this.scheduleWebSocketPreconnection(config, credentials, authIdentity);
    latency.mark('modelResolved');
    this.selectedModelSink?.setSelectedModel(selectedModel.requestModel);
    const reasoning = getReasoningEffort(
      selectedModel.reasoningEffort,
      options as RuntimeProvideLanguageModelChatResponseOptions,
      config.defaultReasoningEffort
    );
    const reasoningEffort = reasoning.effort;
    const requestStartedAt = latency.entryAt;
    const input = convertedMessages.input;
    const observedToolResults = this.reportedToolCalls.consumeResults(input);
    latency.mark('messagesConverted');
    const requestBuildStartedAt = performance.now();
    const hostedToolPlan = resolveHostedToolPlan(options.tools, config.webSearch);
    const selectedClientTools = hostedToolPlan.clientTools;
    const nativeToolSearchKey = nativeToolSearchCapabilityKey(
      normalizeBaseURL(config.baseURL), authIdentity, selectedModel.requestModel
    );
    let toolPlan = resolveCodexToolPlan({
      tools: selectedClientTools,
      model: selectedModel.requestModel,
      compatibilityEnabled: compatibilityProfile.enabled,
      nativeToolSearch: config.nativeToolSearch,
      maxToolsPerNamespace: config.nativeToolSearchMaxToolsPerNamespace,
      extensions: (vscode as typeof vscode & { extensions?: { all?: readonly vscode.Extension<any>[] } }).extensions?.all ?? [],
      nativeToolSearchSupported: canUseNativeToolSearch(selectedModel.requestModel, nativeToolSearchKey)
    });
    const virtualToolPlaceholderNames = getVirtualToolPlaceholderNames(selectedClientTools);
    if (virtualToolPlaceholderNames.length > 0) {
      this.outputChannel.warn('native Tool Search falling back to VS Code Virtual Tools', {
        virtualPlaceholderCount: virtualToolPlaceholderNames.length,
        virtualToolPlaceholderNames
      });
      this.notifyVirtualToolFallback(
        config.nativeToolSearch,
        hasNativeToolGroupingBridgeOwnership(this.context),
        virtualToolPlaceholderNames
      );
    } else {
      this.lastVirtualToolFallbackSignature = undefined;
    }
    recordNativeToolSearchRuntimeStatus({
      model: selectedModel.requestModel,
      setting: config.nativeToolSearch,
      plan: toolPlan,
      virtualToolPlaceholderCount: virtualToolPlaceholderNames.length
    });
    if (toolPlan.mode === 'native-hosted') {
      this.outputChannel.debug('native Tool Search plan', {
        requestModel: selectedModel.requestModel,
        catalogHash: toolPlan.catalogHash,
        nativeToolCatalogCacheHit: toolPlan.nativeToolCatalogCacheHit,
        immediateFunctionCount: toolPlan.immediateToolCount,
        deferredFunctionCount: toolPlan.deferredToolCount,
        includesToolSearch: toolPlan.responseTools.some((tool) => tool.type === 'tool_search'),
        namespaces: toolPlan.responseTools.flatMap((tool) => {
          if (tool.type !== 'namespace') {
            return [];
          }
          return [{
            name: tool.name,
            functionCount: tool.tools.length,
            deferredFunctionCount: tool.tools.filter((nestedTool) => nestedTool.defer_loading === true).length,
            // Names make a private/workspace namespace auditable without exposing
            // its schemas, arguments, or tool results in the extension log.
            functionNames: tool.tools.map((nestedTool) => nestedTool.name)
          }];
        })
      });
    }
    const clientIdentity = resolveRequestIdentity({
      ...config.requestIdentity,
      extensionVersion: getExtensionVersion(this.context),
      extensionUserAgent: buildCodexUserAgent(getExtensionVersion(this.context))
    });
    let requestOptions: CodexRequestEnvelopeOptions = {
      compatibilityEnabled: compatibilityProfile.enabled,
      model: selectedModel.requestModel,
      instructions: combineRequestInstructions(config.instructions, convertedMessages.systemInstructions),
      tools: selectedClientTools,
      hostedTools: hostedToolPlan.responseTools,
      toolPlan,
      toolMode: options.toolMode,
      reasoning: reasoningEffort ? toResponsesReasoning(reasoningEffort) : undefined,
      serviceTier: getRequestServiceTier(config.defaultServiceTier),
      store: false,
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens,
      textVerbosity: 'medium',
      includeEncryptedReasoning: true,
      protocolSettings: config.protocol,
      clientIdentity
    };
    const toolSchemas = toolPlan;
    latency.recordContext({
      fullInputCount: input.length,
      toolCount: selectedClientTools.length,
      hostedToolCount: hostedToolPlan.responseTools.length,
      hostedWebSearch: hostedToolPlan.webSearchEnabled,
      toolSchemaBytes: toolSchemas.toolSchemaBytes,
      legacyToolSchemaCacheHit: toolPlan.legacyToolSchemaCacheHit,
      nativeToolCatalogCacheHit: toolPlan.nativeToolCatalogCacheHit,
      toolPlanMode: toolPlan.mode,
      originalToolCount: toolPlan.originalToolCount,
      immediateToolCount: toolPlan.immediateToolCount,
      deferredToolCount: toolPlan.deferredToolCount,
      namespaceCount: toolPlan.namespaceCount,
      catalogHash: toolPlan.catalogHash,
      reasoningEffort: reasoningEffort ?? null,
      serviceTier: config.defaultServiceTier ?? 'auto'
    });
    let reuseEnvelope = buildResponseBranchReuseEnvelope({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      toolSignatures: toolPlan.toolSignatures,
      effectiveInputBudget: selectedModel.effectiveInputBudget,
      ...requestOptions
    });
    latency.recordContext({ requestBuildMs: Math.max(0, performance.now() - requestBuildStartedAt) });
    const statefulMarker = convertedMessages.statefulMarker;
    const markerHint = statefulMarker.kind === 'valid'
      && statefulMarker.isLeadingStandalone
      ? {
          responseId: statefulMarker.previousResponseId,
          incrementalInput: statefulMarker.incrementalInput
        }
      : undefined;
    const useHistoryFallback = !markerHint
      && (statefulMarker.kind === 'none' || !statefulMarker.isLeadingStandalone);
    const candidateReusableBranch = markerHint
      ? this.responseBranchStore.findReusableBranch(reuseEnvelope, input, markerHint)
      : useHistoryFallback
        ? this.responseBranchStore.findReusableBranch(reuseEnvelope, input)
        : undefined;
    const localHistoryStatus = !markerHint && candidateReusableBranch
      ? getExactLocalBranchHistoryStatus(
          candidateReusableBranch.state?.continuation,
          input,
          candidateReusableBranch.comparison.appendedInput
        )
      : undefined;
    const reusableBranch = markerHint || !candidateReusableBranch
      ? candidateReusableBranch
      : localHistoryStatus === 'compatible'
        ? candidateReusableBranch
        : undefined;
    if (markerHint && !reusableBranch) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    const reuseMissDiagnostic = reusableBranch || markerHint
      ? undefined
      : this.responseBranchStore.explainReuseMiss(reuseEnvelope, input);
    latency.mark('branchResolved');
    const requiresFullInputForToolOutput = Boolean(
      reusableBranch?.comparison.appendedInput.some((item) => item.type === 'function_call_output')
    );
    const appendedInput = reusableBranch?.comparison.appendedInput ?? [];
    const isMarkerContinuation = Boolean(markerHint && reusableBranch);
    const markerContinuationSnapshot = isMarkerContinuation
      ? reusableBranch?.state?.continuation
      : undefined;
    if (isMarkerContinuation && (!markerContinuationSnapshot
      || !hasCanonicalReplayContinuationIntegrity(markerContinuationSnapshot.responseItems, appendedInput))) {
      throw new Error(STATEFUL_MARKER_LOCAL_ERROR);
    }
    const markerCanonicalReplayInput = isMarkerContinuation
      ? buildCanonicalReplayInput({
          previousSnapshot: markerContinuationSnapshot,
          convertedInput: input,
          appendedInput
        })
      : undefined;
    const hasOnlyToolOutputAppend = requiresFullInputForToolOutput
      && appendedInput.length > 0
      && appendedInput.every((item) => item.type === 'function_call_output');
    const toolOutputContinuationCapabilityKey = hasOnlyToolOutputAppend && reusableBranch
      ? this.createToolOutputContinuationCapabilityKey(config, authIdentity, selectedModel.requestModel, requestOptions.store ?? false)
      : undefined;
    const toolOutputContinuationCapability = toolOutputContinuationCapabilityKey
      ? this.toolOutputContinuationCapabilities.get(toolOutputContinuationCapabilityKey)
      : undefined;
    const shouldAttemptToolOutputContinuation = hasOnlyToolOutputAppend
      && config.transport !== 'http'
      && TOOL_OUTPUT_CONTINUATION_ENABLED
      && toolOutputContinuationCapability !== false;
    if (requiresFullInputForToolOutput && !shouldAttemptToolOutputContinuation) {
      latency.recordContext({
        toolContinuationStrategy: 'full-replay',
        fullReplayReason: getToolOutputFullReplayReason({
          hasOnlyToolOutputAppend,
          transport: config.transport,
          capability: toolOutputContinuationCapability
        })
      });
    }
    const usePreviousResponseId = appendedInput.length > 0
      && (!requiresFullInputForToolOutput || shouldAttemptToolOutputContinuation);
    const canonicalReplaySnapshot = reusableBranch?.state?.continuation;
    const canonicalReplayAppendedInput = reusableBranch?.comparison.appendedInput ?? [];
    const fullReplayInput = toolPlan.mode === 'native-hosted'
      ? buildCanonicalReplayInput({
          previousSnapshot: canonicalReplaySnapshot,
          convertedInput: input,
          appendedInput: canonicalReplayAppendedInput,
          catalogHash: toolPlan.catalogHash
        })
      : input;
    const recoveryReplayInput = markerCanonicalReplayInput ?? fullReplayInput;
    const initialRequestInput = usePreviousResponseId
      ? appendedInput
      : recoveryReplayInput;
    const initialPreviousResponseId = usePreviousResponseId
      ? reusableBranch?.responseId
      : undefined;
    let activeBranchId = initialPreviousResponseId || requiresFullInputForToolOutput
      ? reusableBranch?.branchId
      : undefined;
    let legacyFallbackReplayInput: ResponsesInputMessage[] | undefined;
    let completedResponseId: string | undefined;
    const replayResponseItems: unknown[] = [];
    const requestIdentity = await this.resolveRequestIdentity(
      reusableBranch?.state,
      reuseMissDiagnostic?.comparison.kind === 'fork' && reuseMissDiagnostic.comparison.matchedPrefixCount > 0
        ? reuseMissDiagnostic.state
        : undefined,
      reusableBranch?.comparison.appendedInput ?? input
    );
    latency.mark('identityResolved');
    let branchState: CodexBranchState = {
      identity: {
        installationId: requestIdentity.installationId,
        sessionId: requestIdentity.sessionId,
        threadId: requestIdentity.threadId,
        windowId: requestIdentity.windowId,
        parentThreadId: requestIdentity.parentThreadId,
        parentTurnId: requestIdentity.parentTurnId,
        rootTurnId: requestIdentity.rootTurnId
      },
      turn: {
        id: requestIdentity.turnId,
        stickyState: reusableBranch?.state?.turn.id === requestIdentity.turnId
          ? reusableBranch.state.turn.stickyState
          : undefined,
        startedAt: reusableBranch?.state?.turn.id === requestIdentity.turnId
          ? reusableBranch.state.turn.startedAt
          : Date.now(),
        completed: false
      },
      updatedAt: Date.now()
    };
    let reportedVisibleOutput = false;
    let toolContinuationProbeStartedAt: number | undefined;
    if (shouldAttemptToolOutputContinuation) {
      toolContinuationProbeStartedAt = Date.now();
      latency.recordContext({
        toolOutputContinuation: 'attempted',
        toolContinuationStrategy: 'incremental'
      });
    }
    latency.mark('requestReady');

    requestLogger.debug('provideLanguageModelChatResponse start', {
      modelId: model.id,
      requestModel: selectedModel.requestModel,
      transport: config.transport,
      reuse: shouldAttemptToolOutputContinuation
        ? {
            strategy: 'tool-output-continuation',
            branchId: reusableBranch?.branchId,
            matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
            appendedInputCount: reusableBranch?.comparison.appendedInput.length,
            capability: toolOutputContinuationCapability === true ? 'supported' : 'unknown'
          }
        : initialPreviousResponseId
        ? {
            strategy: 'previous-response',
            branchId: reusableBranch?.branchId,
            matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
            appendedInputCount: reusableBranch?.comparison.appendedInput.length
          }
        : requiresFullInputForToolOutput
          ? {
              strategy: 'full-replay-tool-output',
              branchId: reusableBranch?.branchId,
              matchedPrefixCount: reusableBranch?.comparison.matchedPrefixCount,
              appendedInputCount: reusableBranch?.comparison.appendedInput.length
            }
        : null,
      serviceTier: config.defaultServiceTier ?? 'auto',
      reasoningEffort: reasoningEffort ?? null,
      reasoningEffortSource: reasoning.source,
      reasoningEffortInputConflict: reasoning.hasExplicitConflict,
      messageCount: messages.length,
      inputItemCount: input.length,
      observedToolResults: observedToolResults.map(({ resultObservedAt: _resultObservedAt, ...toolResult }) => toolResult),
      toolCount: selectedClientTools.length,
      hostedToolCount: hostedToolPlan.responseTools.length,
      hostedWebSearch: hostedToolPlan.webSearchEnabled,
      toolMode: getToolModeName(options.toolMode),
      toolNames: summarizeToolNames(selectedClientTools),
      localTokenEstimatesSinceActivation: {
        count: this.localTokenEstimateCount,
        durationMs: this.localTokenEstimateDurationMs
      },
      omitMaxOutputTokens: credentials.omitMaxOutputTokens,
      maxOutputTokens: config.maxOutputTokens
    });

    requestLogger.debug('response continuation eligibility', {
      markerKind: statefulMarker.kind,
      markerIsLeadingStandalone: statefulMarker.kind === 'none' ? false : statefulMarker.isLeadingStandalone,
      markerContinuation: Boolean(markerHint),
      historyFallback: useHistoryFallback,
      candidateBranchFound: Boolean(candidateReusableBranch),
      localHistoryStatus: localHistoryStatus ?? null,
      reusableBranchFound: Boolean(reusableBranch)
    });

    if (reuseMissDiagnostic) {
      this.outputChannel.debug('response reuse miss', {
        requestModel: selectedModel.requestModel,
        branchId: reuseMissDiagnostic.branchId,
        previousResponseId: reuseMissDiagnostic.responseId,
        comparisonKind: reuseMissDiagnostic.comparison.kind,
        matchedPrefixCount: reuseMissDiagnostic.comparison.matchedPrefixCount,
        previousInputCount: reuseMissDiagnostic.previousInputCount,
        currentInputCount: reuseMissDiagnostic.currentInputCount,
        appendedInputCount: reuseMissDiagnostic.comparison.appendedInput.length,
        mismatchIndex: reuseMissDiagnostic.comparison.mismatch?.index ?? null,
        mismatchPreviousItem: reuseMissDiagnostic.comparison.mismatch?.previousItemSummary ?? reuseMissDiagnostic.previousNextItemSummary,
        mismatchCurrentItem: reuseMissDiagnostic.comparison.mismatch?.currentItemSummary ?? reuseMissDiagnostic.currentNextItemSummary,
        requestFingerprintMatches: reuseMissDiagnostic.requestFingerprintMatches,
        previousEffectiveInputBudget: reuseMissDiagnostic.previousEffectiveInputBudget ?? null,
        currentEffectiveInputBudget: reuseMissDiagnostic.currentEffectiveInputBudget ?? null,
        inputBudgetCompatible: reuseMissDiagnostic.inputBudgetCompatible,
        toolCompatibility: reuseMissDiagnostic.toolCompatibility ?? null
      });
    }

    const streamRequest = async (
      requestInput: ResponsesInputMessage[],
      previousResponseId?: string,
      allowToolOutputContinuation = false
    ) => {
      let pendingResponseText = '';
      let reportedWebSearchStatusCount = 0;
      const webSearchStatusPresenter = new WebSearchStatusPresenter(config.webSearch);
      const webSearchFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
      const attemptInitialBranchState: CodexBranchState = {
        ...branchState,
        identity: { ...branchState.identity },
        turn: { ...branchState.turn }
      };
      const resetAttemptState = () => {
        replayResponseItems.length = 0;
        pendingResponseText = '';
        reportedWebSearchStatusCount = 0;
        for (const timer of webSearchFallbackTimers.values()) {
          clearTimeout(timer);
        }
        webSearchFallbackTimers.clear();
        webSearchStatusPresenter.reset();
        completedResponseId = undefined;
        branchState = {
          ...attemptInitialBranchState,
          identity: { ...attemptInitialBranchState.identity },
          turn: { ...attemptInitialBranchState.turn, completed: false },
          updatedAt: Date.now()
        };
      };
      const flushReplayText = () => {
        if (!pendingResponseText) {
          return;
        }
        replayResponseItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: pendingResponseText }]
        });
        pendingResponseText = '';
      };
      const streamStartedAt = Date.now();
      let actualTransport: 'http' | 'http-fallback' | 'websocket-fresh' | 'websocket-reused' = config.transport === 'http'
        ? 'http'
        : 'http-fallback';
      let firstVisibleOutput:
        | {
            kind: 'text' | 'reasoning' | 'tool_call';
            latencyMs: number;
          }
        | undefined;
      let previousResponseIdUsed = false;
      if (config.transport === 'http') {
        latency.mark('connectionAcquired');
      }
      latency.recordContext({
        previousResponseIdUsed: Boolean(previousResponseId),
        incrementalInputCount: previousResponseId ? requestInput.length : 0,
        transportActual: actualTransport
      });
      latency.mark('requestSent');
      if (observedToolResults.length > 0) {
        const requestSentAt = Date.now();
        this.outputChannel.trace('tool result recovery timing', {
          requestModel: selectedModel.requestModel,
          toolResults: observedToolResults.map(({ resultObservedAt, ...toolResult }) => ({
            ...toolResult,
            resultObservedToRequestSentMs: Math.max(0, requestSentAt - resultObservedAt)
          }))
        });
      }

      const toolCallLifecycleAt = new Map<string, {
        addedAt?: number;
        argumentsDeltaAt?: number;
        argumentsDoneAt?: number;
      }>();
      const reportedToolCallIds = new Set<string>();

      const recordFirstVisibleOutput = (
        kind: 'text' | 'reasoning' | 'tool_call',
        reportedAt = Date.now()
      ) => {
        if (firstVisibleOutput) {
          return;
        }

        firstVisibleOutput = {
          kind,
          latencyMs: Math.max(0, reportedAt - streamStartedAt)
        };
      };

      const reportVisiblePart = (
        kind: 'text' | 'reasoning' | 'tool_call',
        part: vscode.LanguageModelResponsePart,
        reportedAt = Date.now()
      ) => {
        progress.report(part);
        latency.recordProgressReport(reportedAt);
        reportedVisibleOutput = true;
        recordFirstVisibleOutput(kind, reportedAt);
        if (kind === 'text') {
          latency.mark('firstText', reportedAt);
        } else if (kind === 'reasoning') {
          latency.mark('firstReasoning', reportedAt);
        }
      };

      const reportWebSearchStatus = (webSearchStatus: ReturnType<WebSearchStatusPresenter['present']>) => {
        if (!webSearchStatus) {
          return;
        }
        // VS Code groups consecutive ThinkingParts into one expandable section.
        // Keep individual hosted searches visually distinct inside that group.
        const value = `${reportedWebSearchStatusCount > 0 ? '\n\n' : ''}${webSearchStatus.value}`;
        reportedWebSearchStatusCount += 1;
        const thinkingPart = createThinkingPart(
          value,
          `hosted-tool:web_search:${webSearchStatus.itemId}`,
          {
            source: 'hosted-tool',
            tool: 'web_search',
            phase: 'completed',
            itemId: webSearchStatus.itemId,
            ...(webSearchStatus.actionType ? { actionType: webSearchStatus.actionType } : {})
          }
        );
        if (thinkingPart) {
          reportVisiblePart('reasoning', thinkingPart);
        }
      };

      const scheduleWebSearchLifecycleFallback = (event: HostedToolLifecycleEvent) => {
        if (!webSearchStatusPresenter.noteCompletedLifecycle(event)) {
          return;
        }
        const timer = setTimeout(() => {
          webSearchFallbackTimers.delete(event.itemId);
          if (!token.isCancellationRequested) {
            reportWebSearchStatus(webSearchStatusPresenter.presentLifecycleFallback(event.itemId));
          }
        }, WEB_SEARCH_STATUS_DETAIL_GRACE_MS);
        webSearchFallbackTimers.set(event.itemId, timer);
      };

      const presenter = new StreamPresenter(
        (_kind, receivedAt) => latency.recordBackendDelta(receivedAt),
        undefined,
        {
          minReportIntervalMs: TEXT_STREAM_MIN_REPORT_INTERVAL_MS,
          maxReportIntervalMs: TEXT_STREAM_MAX_REPORT_INTERVAL_MS,
          targetReportCharacters: TEXT_STREAM_TARGET_REPORT_CHARACTERS,
          maxReportCharacters: TEXT_STREAM_MAX_REPORT_CHARACTERS,
          smoothingBufferCharacters: TEXT_STREAM_SMOOTHING_BUFFER_CHARACTERS
        }
      );
      let loggedMissingThinkingPart = false;
      const reasoningPresenter = new ReasoningStreamPresenter((update) => {
        const thinkingPart = createThinkingPart(update.value, update.id, {
          source: update.source,
          itemId: update.itemId,
          outputIndex: update.outputIndex,
          phase: update.phase
        });
        if (thinkingPart) {
          reportVisiblePart('reasoning', thinkingPart);
        } else if (!loggedMissingThinkingPart) {
          loggedMissingThinkingPart = true;
          this.outputChannel.debug('Reasoning output received, but LanguageModelThinkingPart is unavailable.');
        }
      }, {
        onBackendDelta: (receivedAt) => latency.recordBackendDelta(receivedAt)
      });
      let presentationMetricsRecorded = false;
      let completedUsagePart: vscode.LanguageModelResponsePart | undefined;
      const recordPresentationMetrics = () => {
        if (presentationMetricsRecorded) {
          return;
        }
        presentationMetricsRecorded = true;
        const metrics = mergeStreamPresentationMetrics(presenter.metrics(), reasoningPresenter.metrics());
        latency.recordContext({
          metricVersion: 4,
          backendDeltaCount: metrics.backendDeltaCount,
          progressReportCount: metrics.progressReportCount,
          coalescedDeltaCount: metrics.coalescedDeltaCount,
          coalescingDelayP95Ms: metrics.coalescingDelayP95Ms,
          coalescingDelayMaxMs: metrics.coalescingDelayMaxMs,
          largestReportCharacters: metrics.largestReportCharacters,
          boundaryDrainReportCount: metrics.boundaryDrainReportCount,
          boundaryDrainDurationMs: metrics.boundaryDrainDurationMs
        });
        this.outputChannel.trace('response stream presentation', { ...metrics });
      };

      try {
        const streamOptions: Parameters<typeof streamResponseText>[0] = {
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        authManager: credentials.authManager,
        accountKey: credentials.accountKey,
        transport: config.transport,
        compatibilityProfile,
        identity: requestIdentity,
        turnState: branchState.turn.stickyState,
        authIdentity,
        extensionVersion: getExtensionVersion(this.context),
        userAgent: buildCodexUserAgent(getExtensionVersion(this.context)),
        protocolSettings: config.protocol,
        clientIdentity,
        turnStartedAtUnixMs: branchState.turn.startedAt,
        websocketPrewarm: config.websocketPrewarm,
        requestCompression: config.requestCompression,
        previousResponseId,
        allowToolOutputContinuation,
        store: requestOptions.store,
        omitMaxOutputTokens: requestOptions.omitMaxOutputTokens,
        model: requestOptions.model,
        instructions: requestOptions.instructions,
        serviceTier: requestOptions.serviceTier,
        input: requestInput,
        tools: requestOptions.tools,
        toolPlan: requestOptions.toolPlan,
        hostedTools: requestOptions.hostedTools,
        toolMode: requestOptions.toolMode,
        reasoning: requestOptions.reasoning,
        maxOutputTokens: requestOptions.maxOutputTokens,
        token,
        hasProviderVisibleOutput: () => reportedVisibleOutput,
        onTextDelta: (text) => {
          pendingResponseText += text;
          if (text) {
            reasoningPresenter.close();
          }
          presenter.push({
            kind: 'text',
            identity: 'text',
            text,
            emit: (presentedText) => {
              reportVisiblePart('text', new vscode.LanguageModelTextPart(presentedText));
            }
          });
        },
        onReasoningDelta: (delta) => {
          reasoningPresenter.push(delta);
        },
        onReasoningLifecycleEvent: (event) => {
          this.outputChannel.trace('response reasoning lifecycle', {
            requestModel: selectedModel.requestModel,
            ...event
          });
        },
        onToolCallAdded: (callId) => {
          toolCallLifecycleAt.set(callId, { addedAt: Date.now() });
          latency.mark('firstToolCallAdded');
        },
        onToolCallArgumentsDelta: (callId) => {
          const lifecycle = toolCallLifecycleAt.get(callId) ?? {};
          lifecycle.argumentsDeltaAt ??= Date.now();
          toolCallLifecycleAt.set(callId, lifecycle);
          latency.mark('firstToolCallArgumentsDelta');
        },
        onToolCallArgumentsDone: (callId) => {
          const lifecycle = toolCallLifecycleAt.get(callId) ?? {};
          lifecycle.argumentsDoneAt ??= Date.now();
          toolCallLifecycleAt.set(callId, lifecycle);
          latency.mark('firstToolCallArgumentsDone');
        },
        onToolCall: (call) => {
          const mapped = mapNativeToolCall(toolPlan, call);
          const { callId, input: toolInput, vscodeName: name } = mapped;
          const itemId = call.itemId.trim();
          if (toolPlan.mode === 'native-hosted'
            && (!itemId || itemId === callId)) {
            throw new Error('Responses returned a Native Tool Search function call without an item id.');
          }
          flushReplayText();
          const serializedToolInput = stableSerialize(toolInput);
          replayResponseItems.push({
            ...(toolPlan.mode === 'native-hosted' ? { id: itemId } : {}),
            type: 'function_call',
            call_id: callId,
            name: toolPlan.mode === 'native-hosted' ? call.name : name,
            ...(toolPlan.mode === 'native-hosted' && call.namespace ? { namespace: call.namespace } : {}),
            arguments: serializedToolInput
          });
          const pendingPresentationCharacters = presenter.pendingCharacters;
          presenter.flushBoundary(TOOL_BOUNDARY_MAX_REPORT_CHARACTERS);
          const discardedReasoningCharacters = reasoningPresenter.startNextPhase();
          const reportedAt = Date.now();
          latency.mark('firstToolCall', reportedAt);
          reportVisiblePart('tool_call', new vscode.LanguageModelToolCallPart(callId, name, toolInput), reportedAt);
          latency.mark('firstToolCallReported', reportedAt);
          this.reportedToolCalls.remember(callId, name, reportedAt);
          reportedToolCallIds.add(callId);
          latency.recordContext({
            pendingPresentationCharactersAtToolCall: pendingPresentationCharacters,
            discardedReasoningCharactersAtToolCall: discardedReasoningCharacters
          });
          const lifecycle = toolCallLifecycleAt.get(callId);
          this.outputChannel.trace('response tool call timing', () => ({
            callId,
            name,
            backendName: call.name,
            namespace: call.namespace ?? null,
            toolPlanMode: toolPlan.mode,
            pendingPresentationCharacters,
            discardedReasoningCharacters,
            toolArgumentsDoneToReportedMs: lifecycle?.argumentsDoneAt === undefined
              ? null
              : Math.max(0, reportedAt - lifecycle.argumentsDoneAt)
          }));
          if (this.outputChannel.isEnabled('trace')) {
            setImmediate(() => {
              this.outputChannel.trace('response tool call', () => ({
                requestModel: selectedModel.requestModel,
                callId,
                name,
                inputPresent: true,
                inputBytes: Buffer.byteLength(serializedToolInput),
                inputHash: shortHash(serializedToolInput)
              }));
            });
          }
        },
        onHostedToolLifecycleEvent: (event) => {
          this.outputChannel.trace('response hosted tool lifecycle', {
            requestModel: selectedModel.requestModel,
            ...event
          });
          scheduleWebSearchLifecycleFallback(event);
        },
        onRawResponseItem: (item) => {
          const webSearchStatus = webSearchStatusPresenter.present(item);
          if (webSearchStatus) {
            const fallbackTimer = webSearchFallbackTimers.get(webSearchStatus.itemId);
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              webSearchFallbackTimers.delete(webSearchStatus.itemId);
            }
            reportWebSearchStatus(webSearchStatus);
          }
          const toolSearchEvent = summarizeNativeToolSearchItem(item);
          if (toolSearchEvent) {
            this.outputChannel.debug('native Tool Search event', toolSearchEvent);
          }
          const replayItem = projectSafeRawReplayItem(item, toolPlan);
          if (replayItem) {
            flushReplayText();
            replayResponseItems.push(replayItem);
          }
        },
        onTurnState: (turnState) => {
          branchState = {
            ...branchState,
            turn: { ...branchState.turn, stickyState: turnState },
            updatedAt: Date.now()
          };
        },
        onWebSocketHandshake: (handshake) => {
          this.outputChannel.trace('response websocket handshake', {
            turnStateReceived: Boolean(handshake.turnState),
            modelsEtagPresent: Boolean(handshake.modelsEtag),
            reasoningIncluded: handshake.reasoningIncluded,
            serverModel: handshake.serverModel ?? null
          });
        },
        onTransportMetrics: (metrics) => {
          if (metrics.retryReason === 'websocket_unauthorized_recovered'
            || metrics.retryReason === 'websocket_connection_limit_reached'
            || metrics.retryReason === 'websocket_prewarm_continuation_miss'
            || metrics.retryReason === 'stream_rate_limit_exceeded') {
            resetAttemptState();
          }
          previousResponseIdUsed ||= metrics.previousResponseIdUsed === true;
          if (typeof metrics.websocketConnectedAt === 'number') {
            latency.mark('websocketConnected', metrics.websocketConnectedAt);
          }
          if (typeof metrics.prewarmStartedAt === 'number') {
            latency.mark('prewarmStarted', metrics.prewarmStartedAt);
          }
          if (typeof metrics.prewarmCompletedAt === 'number') {
            latency.mark('prewarmCompleted', metrics.prewarmCompletedAt);
          }
          latency.recordContext(readLatencyContextFromTransportMetrics(metrics));
          this.outputChannel.trace('response transport metrics', metrics);
        },
        onResponseCreated: (response) => {
          latency.mark('responseCreated');
          this.outputChannel.trace('response created', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            status: response.status,
            serviceTier: response.service_tier ?? null,
            previousResponseId: previousResponseId ?? null
          });
        },
        onResponseCompleted: (response) => {
          flushReplayText();
          reasoningPresenter.close();
          this.reportedToolCalls.markResponseCompleted(reportedToolCallIds);
          if (allowToolOutputContinuation && previousResponseIdUsed) {
            latency.recordContext({
              toolOutputContinuation: 'supported',
              toolContinuationStrategy: 'incremental',
              toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
                ? undefined
                : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
            });
          }
          latency.mark('responseCompleted');
          branchState = {
            ...branchState,
            turn: { ...branchState.turn, completed: true },
            updatedAt: Date.now()
          };
          completedResponseId = response.id ?? completedResponseId;
          requestLogger.info('response completed', {
            requestModel: selectedModel.requestModel,
            responseId: response.id,
            durationMs: Date.now() - requestStartedAt,
            streamDurationMs: Date.now() - streamStartedAt,
            actualTransport,
            firstVisibleOutputLatencyMs: firstVisibleOutput?.latencyMs ?? null,
            firstVisibleOutputKind: firstVisibleOutput?.kind ?? null,
            usage: response.usage ?? null,
            previousResponseId: previousResponseId ?? null
          });
          requestLogger.debug('response latency', {
            ...latency.snapshot(),
            transportConfigured: config.transport
          });

          completedUsagePart = createUsageDataPart(response.usage);

          if (response.usage) {
            this.usageSink?.record({
              model: selectedModel.requestModel,
              usage: response.usage,
              completedAt: Date.now()
            });
          }

          void this.accountUsageRefreshSink?.refresh();
        },
        onResponseFailed: (message) => {
          reasoningPresenter.close();
          if (token.isCancellationRequested) {
            requestLogger.debug('response.cancelled', { requestModel: selectedModel.requestModel });
            return;
          }
          requestLogger.error('response.failed', new Error(message), {
            requestModel: selectedModel.requestModel,
            previousResponseId: previousResponseId ?? null
          });
        },
        onTransportFallback: ({ from, to, reason }) => {
          resetAttemptState();
          if (allowToolOutputContinuation && previousResponseId) {
            streamOptions.input = recoveryReplayInput;
            streamOptions.previousResponseId = undefined;
            streamOptions.allowToolOutputContinuation = false;
            previousResponseIdUsed = false;
            activeBranchId = undefined;
          }
          reasoningPresenter.flush();
          actualTransport = 'http-fallback';
          latency.mark('connectionAcquired');
          latency.recordContext({ transportActual: actualTransport });
          requestLogger.nextAttempt().warn('response transport fallback', {
            requestModel: selectedModel.requestModel,
            from,
            to,
            reason,
            previousResponseId: previousResponseId ?? null
          });
        },
        onWebSocketSession: ({ reused, origin }) => {
          actualTransport = reused ? 'websocket-reused' : 'websocket-fresh';
          latency.mark('connectionAcquired');
          latency.recordContext({
            connectionOrigin: origin ?? (reused ? 'previous-response' : 'fresh'),
            connectionReused: reused,
            transportActual: actualTransport
          });
          this.outputChannel.debug('response websocket session', {
            requestModel: selectedModel.requestModel,
            reused,
            previousResponseId: previousResponseId ?? null
          });
        }
        };
        try {
          await streamResponseText(streamOptions);
        } catch (error) {
          resetAttemptState();
          if (error instanceof ResponsesQuotaExceededError || error instanceof ResponsesRateLimitedError) {
            requestLogger.warn('response limit reached', { error });
            void this.accountUsageRefreshSink?.refresh();
            throw toChatLimitError(error);
          }
          throw error;
        }
      } finally {
        reasoningPresenter.close();
        for (const timer of webSearchFallbackTimers.values()) {
          clearTimeout(timer);
        }
        webSearchFallbackTimers.clear();
        if (token.isCancellationRequested) {
          presenter.flushBoundary();
        } else {
          await presenter.drainBoundary(() => token.isCancellationRequested);
        }
        if (completedUsagePart) {
          progress.report(completedUsagePart);
        }
        recordPresentationMetrics();
      }
      return { previousResponseIdUsed };
    };

    try {
      const initialStream = await streamRequest(
        initialRequestInput,
        initialPreviousResponseId,
        shouldAttemptToolOutputContinuation
      );
      if (shouldAttemptToolOutputContinuation && toolOutputContinuationCapabilityKey) {
        if (!initialStream.previousResponseIdUsed) {
          this.toolOutputContinuationCapabilities.record(toolOutputContinuationCapabilityKey, false);
          latency.recordContext({
            toolOutputContinuation: 'unsupported',
            toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
          });
          this.outputChannel.warn('response tool-output continuation was not applied', {
            requestModel: selectedModel.requestModel,
            branchId: reusableBranch?.branchId ?? null,
            previousResponseId: initialPreviousResponseId
          });
        } else {
          this.toolOutputContinuationCapabilities.record(toolOutputContinuationCapabilityKey, true);
          latency.recordContext({
            toolOutputContinuation: 'supported',
            toolContinuationStrategy: 'incremental',
            toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - toolContinuationProbeStartedAt)
          });
        }
      }
    } catch (error) {
      if (toolPlan.mode === 'native-hosted' && !reportedVisibleOutput && isNativeToolSearchUnsupportedError(error)) {
        markNativeToolSearchUnsupported(nativeToolSearchKey);
        toolPlan = resolveCodexToolPlan({
          tools: selectedClientTools,
          model: selectedModel.requestModel,
          compatibilityEnabled: compatibilityProfile.enabled,
          nativeToolSearch: 'disabled',
          maxToolsPerNamespace: config.nativeToolSearchMaxToolsPerNamespace,
          extensions: (vscode as typeof vscode & { extensions?: { all?: readonly vscode.Extension<any>[] } }).extensions?.all ?? []
        });
        requestOptions = { ...requestOptions, toolPlan };
        reuseEnvelope = buildResponseBranchReuseEnvelope({
          baseURL: normalizeBaseURL(config.baseURL),
          authIdentity,
          toolSignatures: toolPlan.toolSignatures,
          effectiveInputBudget: selectedModel.effectiveInputBudget,
          ...requestOptions
        });
        replayResponseItems.length = 0;
        completedResponseId = undefined;
        activeBranchId = undefined;
        latency.recordContext({
          toolPlanMode: 'legacy',
          legacyToolSchemaCacheHit: toolPlan.legacyToolSchemaCacheHit,
          nativeToolCatalogCacheHit: false
        });
        recordNativeToolSearchRuntimeStatus({
          model: selectedModel.requestModel,
          setting: config.nativeToolSearch,
          plan: toolPlan,
          virtualToolPlaceholderCount: virtualToolPlaceholderNames.length,
          reason: 'backend-rejected'
        });
        this.outputChannel.warn('native Tool Search unsupported; retrying once with selected legacy function tools', {
          requestModel: selectedModel.requestModel,
          nativeToolSearchFallback: true
        });
        legacyFallbackReplayInput = buildLegacyFallbackReplayInput(markerCanonicalReplayInput ?? input);
        await streamRequest(legacyFallbackReplayInput);
      } else if (shouldAttemptToolOutputContinuation && isResponsesContinuationMissError(error)) {
        if (reportedVisibleOutput) {
          this.responseBranchStore.invalidateResponseId(error.previousResponseId);
          if (reusableBranch) {
            this.responseBranchStore.invalidate(reusableBranch.branchId);
          }
          throw error;
        }

        if (toolOutputContinuationCapabilityKey) {
          this.toolOutputContinuationCapabilities.record(toolOutputContinuationCapabilityKey, false);
        }
        latency.recordContext({
          toolOutputContinuation: 'fallback-full-replay',
          toolContinuationStrategy: 'incremental-recovered',
          toolContinuationProbeMs: toolContinuationProbeStartedAt === undefined
            ? undefined
            : Math.max(0, Date.now() - toolContinuationProbeStartedAt),
          fullReplayReason: 'continuation-miss'
        });
        this.outputChannel.warn('response tool-output continuation reset', {
          requestModel: selectedModel.requestModel,
          branchId: reusableBranch?.branchId ?? null,
          previousResponseId: initialPreviousResponseId,
          reason: error.message,
          reuseDisabledUntilExpiry: error.disableReuseUntilExpiry
        });

        completedResponseId = undefined;
        replayResponseItems.length = 0;
        this.responseBranchStore.disableReuse(reuseEnvelope, !error.disableReuseUntilExpiry);
        this.responseBranchStore.invalidateResponseId(error.previousResponseId);
        if (reusableBranch) {
          this.responseBranchStore.invalidate(reusableBranch.branchId);
        }
        activeBranchId = undefined;
        await streamRequest(recoveryReplayInput);
      } else {
        if (!initialPreviousResponseId || !isResponsesContinuationMissError(error)) {
          const backendRejection = getBackendModelRejection(error, selectedModel.requestModel);
          const unavailableModel = backendRejection?.model ?? getExactModelNotFoundName(error, selectedModel.requestModel);
          if (!unavailableModel) {
            throw error;
          }

          this.markModelUnavailable(unavailableModel, config, credentials, authIdentity, backendRejection !== undefined);

          this.outputChannel.warn('response model unavailable', {
            rejectedModel: unavailableModel,
            reason: backendRejection?.reason ?? 'model-not-found',
            requestIdentityProfile: config.requestIdentity.profile,
            previousResponseId: initialPreviousResponseId ?? null
          });

          throw backendRejection
            ? createBackendRejectedModelError(unavailableModel, backendRejection.reason, error)
            : createTemporarilyUnavailableModelError(unavailableModel, error);
        }

        if (reportedVisibleOutput) {
          this.responseBranchStore.invalidateResponseId(error.previousResponseId);
          if (reusableBranch) {
            this.responseBranchStore.invalidate(reusableBranch.branchId);
          }
          throw error;
        }

        this.outputChannel.warn('response continuation reset', {
          requestModel: selectedModel.requestModel,
          branchId: reusableBranch?.branchId ?? null,
          previousResponseId: initialPreviousResponseId,
          reason: error.message,
          reuseDisabledUntilExpiry: error.disableReuseUntilExpiry
        });

        this.outputChannel.warn(error.disableReuseUntilExpiry
          ? 'response reuse disabled until branch cache expiry after HTTP continuation rejection'
          : 'response reuse temporarily disabled until next full-input success', {
          requestModel: selectedModel.requestModel,
          previousResponseId: initialPreviousResponseId,
          branchId: reusableBranch?.branchId ?? null
        });

        this.responseBranchStore.disableReuse(reuseEnvelope, !error.disableReuseUntilExpiry);
        this.responseBranchStore.invalidateResponseId(initialPreviousResponseId);

        if (reusableBranch) {
          this.responseBranchStore.invalidate(reusableBranch.branchId);
        }

        completedResponseId = undefined;
        replayResponseItems.length = 0;
        activeBranchId = undefined;
        await streamRequest(recoveryReplayInput);
      }
    }

    const finalResponseId = completedResponseId;
    const statefulMarkerPayload = finalResponseId
      ? createStatefulMarkerPayload(model.id, finalResponseId)
      : undefined;
    if (finalResponseId && statefulMarkerPayload) {
      const continuationSnapshotStartedAt = performance.now();
      const recordedInput = markerCanonicalReplayInput ?? input;
      const builtFullRequest = buildCodexResponsesRequest({
        ...requestOptions,
        identity: requestIdentity,
        input: legacyFallbackReplayInput ?? recordedInput,
      });
      const fullRequest = isMarkerContinuation
        ? builtFullRequest
        : toolPlan.mode === 'native-hosted'
        ? createCanonicalReplayRequest(builtFullRequest, fullReplayInput)
        : builtFullRequest;
      branchState = {
        ...branchState,
        continuation: createCodexContinuationSnapshot(
          fullRequest,
          finalResponseId,
          replayResponseItems,
          requestIdentity.turnId,
          {
            clone: false,
            requestFingerprint: reuseEnvelope.requestFingerprint,
            catalogHash: toolPlan.catalogHash,
            toolPlanMode: toolPlan.mode
          }
        ),
        updatedAt: Date.now()
      };
      const continuationSnapshotMs = Math.max(0, performance.now() - continuationSnapshotStartedAt);
      const continuationStoreStartedAt = performance.now();
      activeBranchId = this.responseBranchStore.recordSuccess(
        reuseEnvelope,
        recordedInput,
        finalResponseId,
        activeBranchId,
        branchState
      );
      latency.recordContext({
        continuationSnapshotMs,
        continuationStoreMs: Math.max(0, performance.now() - continuationStoreStartedAt)
      });
      if (!token.isCancellationRequested && !this.responseBranchStore.isReuseDisabled(reuseEnvelope)) {
        progress.report(createStatefulMarkerDataPart(statefulMarkerPayload));
      }
    } else if (finalResponseId) {
      requestLogger.warn('response continuation metadata rejected', {
        requestModel: selectedModel.requestModel
      });
    }
    const providerReturnedAt = Date.now();
    latency.mark('providerReturned', providerReturnedAt);
    const providerTail = latency.snapshot(providerReturnedAt);
    requestLogger.debug('response provider tail', {
      responseCompletedToProviderReturnMs: providerTail.trace.responseCompletedToProviderReturnMs ?? null,
      progressReportCount: providerTail.context.progressReportCount ?? null,
      largestReportCharacters: providerTail.context.largestReportCharacters ?? null,
      boundaryDrainReportCount: providerTail.context.boundaryDrainReportCount ?? null,
      boundaryDrainDurationMs: providerTail.context.boundaryDrainDurationMs ?? null,
      continuationSnapshotMs: providerTail.context.continuationSnapshotMs ?? null,
      continuationStoreMs: providerTail.context.continuationStoreMs ?? null
    });
  }

  private notifyVirtualToolFallback(
    nativeToolSearch: 'auto' | 'enabled' | 'disabled',
    nativeToolSearchGroupingBridgeEnabled: boolean,
    virtualToolPlaceholderNames: readonly string[]
  ): void {
    if (nativeToolSearch === 'disabled' || (nativeToolSearch === 'auto' && !nativeToolSearchGroupingBridgeEnabled)) {
      return;
    }
    const signature = JSON.stringify(virtualToolPlaceholderNames);
    if (this.lastVirtualToolFallbackSignature === signature) {
      return;
    }
    this.lastVirtualToolFallbackSignature = signature;
    const groupCount = virtualToolPlaceholderNames.length;
    const groupLabel = groupCount === 1 ? 'group' : 'groups';
    void vscode.window.showWarningMessage(
      `Native Tool Search is unavailable for this request because VS Code supplied ${groupCount} Virtual Tool ${groupLabel}. The request is falling back to VS Code Virtual Tools.`
    );
  }

  private async resolveRequestIdentity(
    reusableState: CodexBranchState | undefined,
    forkState: CodexBranchState | undefined,
    appendedInput: readonly ResponsesInputMessage[]
  ): Promise<CodexRequestIdentity> {
    if (reusableState) {
      const current: CodexRequestIdentity = {
        ...reusableState.identity,
        turnId: reusableState.turn.id
      };
      const inCurrentWindow = this.identityManager.bindToCurrentWindow(current);
      return inputStartsNewTurn(appendedInput)
        ? this.identityManager.createNextTurn(inCurrentWindow)
        : inCurrentWindow;
    }
    const parentThreadId = forkState?.identity.threadId;
    return this.identityManager.createThread(parentThreadId);
  }

  private handleConnectionConfiguration(config: ProviderConfig, authIdentity: string): void {
    const key = stableSerialize({
      baseURL: normalizeBaseURL(config.baseURL),
      authIdentity,
      transport: config.transport,
      websocketPrewarm: config.websocketPrewarm,
      requestCompression: config.requestCompression,
      protocol: config.protocol
    });
    if (this.lastConnectionConfigurationKey && this.lastConnectionConfigurationKey !== key) {
      disposeReusableResponsesWebSockets();
      resetCodexFetchCapabilities();
    }
    this.lastConnectionConfigurationKey = key;
  }

  private scheduleWebSocketPreconnection(
    config: ProviderConfig,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    authIdentity: string
  ): void {
    if (config.transport === 'http') {
      return;
    }
    this.handleConnectionConfiguration(config, authIdentity);
    const compatibilityProfile = getCodexCompatibilityProfile(config.baseURL, credentials, config.protocol.profile);
    const clientIdentity = resolveRequestIdentity({
      ...config.requestIdentity,
      extensionVersion: getExtensionVersion(this.context),
      extensionUserAgent: buildCodexUserAgent(getExtensionVersion(this.context))
    });
    const started = compatibilityProfile.enabled && preconnectCodexResponsesWebSocket({
      baseURL: config.baseURL,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
      compatibilityProfile,
      authIdentity,
      extensionVersion: getExtensionVersion(this.context),
      userAgent: buildCodexUserAgent(getExtensionVersion(this.context)),
      protocolSettings: config.protocol,
      clientIdentity
    });
    if (started) {
      this.outputChannel.debug('response WebSocket preconnection started', {
        baseURL: normalizeBaseURL(config.baseURL),
        transport: config.transport
      });
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    const config = getProviderConfig();
    if (!supportsOfficialTokenCounting(config.baseURL)) {
      const estimated = this.estimateTokenCountLocally(text);
      this.logLocalTokenEstimateDiagnosticOnce({
        baseURL: config.baseURL,
        modelId: model.id,
        requestModel: parseModelIdentifier(model.id || config.model).requestModel,
        count: estimated,
        reason: 'official-counting-unavailable-for-backend'
      });
      return estimated;
    }

    const credentials = await getApiCredentials(this.context, this.authManager);
    if (!credentials) {
      const estimated = this.estimateTokenCountLocally(text);
      this.logLocalTokenEstimateDiagnosticOnce({
        baseURL: config.baseURL,
        modelId: model.id,
        requestModel: parseModelIdentifier(model.id || config.model).requestModel,
        count: estimated,
        reason: 'missing-credentials'
      });
      return estimated;
    }

    const startedAt = Date.now();

    try {
      const catalog = await this.getAvailableModelCatalog(config, credentials, token);
      const selectedModel = this.resolveRequestModel(model.id, config, catalog.models, catalog.authoritative);
      const input = typeof text === 'string' ? text : convertMessagesToResponsesInput([text]);
      const count = await countInputTokens({
        baseURL: config.baseURL,
        apiKey: credentials.apiKey,
        headers: credentials.headers,
        authManager: credentials.authManager,
        accountKey: credentials.accountKey,
        model: selectedModel.requestModel,
        input,
        token
      });
      this.outputChannel.debug('provideTokenCount official count', {
        modelId: model.id,
        requestModel: selectedModel.requestModel,
        count,
        durationMs: Date.now() - startedAt
      });
      return count;
    } catch (error) {
      if (token.isCancellationRequested || isAbortError(error)) {
        throw error;
      }
      const estimated = this.estimateTokenCountLocally(text);
      const requestModel = parseModelIdentifier(model.id || config.model).requestModel;
      this.outputChannel.warn('provideTokenCount fell back to local estimate after counting request failure', {
        modelId: model.id,
        requestModel,
        count: estimated,
        source: 'local-estimate',
        officialCountingAvailable: true,
        durationMs: Date.now() - startedAt
      });
      return estimated;
    }
  }

  private estimateTokenCountLocally(text: string | vscode.LanguageModelChatRequestMessage): number {
    const startedAt = performance.now();
    const estimated = estimateTokenCount(text);
    this.localTokenEstimateCount += 1;
    this.localTokenEstimateDurationMs += Math.max(0, performance.now() - startedAt);
    return estimated;
  }

  private logLocalTokenEstimateDiagnosticOnce(options: {
    baseURL: string;
    modelId: string;
    requestModel: string;
    count: number;
    reason: 'official-counting-unavailable-for-backend' | 'missing-credentials';
  }): void {
    const diagnosticKey = JSON.stringify([
      normalizeBaseURL(options.baseURL),
      options.requestModel,
      options.reason
    ]);
    if (this.localTokenEstimateDiagnostics.has(diagnosticKey)) {
      return;
    }
    if (this.localTokenEstimateDiagnostics.size >= MAX_LOCAL_TOKEN_ESTIMATE_DIAGNOSTICS) {
      this.localTokenEstimateDiagnostics.clear();
    }
    this.localTokenEstimateDiagnostics.add(diagnosticKey);
    this.outputChannel.trace('provideTokenCount using local estimate (first occurrence)', {
      modelId: options.modelId,
      requestModel: options.requestModel,
      count: options.count,
      source: 'local-estimate',
      officialCountingAvailable: false,
      reason: options.reason,
      subsequentOccurrencesSuppressed: true
    });
  }

  private async getAvailableModelCatalog(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    onCacheState?: (state: CodexModelCacheState | 'fallback') => void
  ): Promise<ProviderModelCatalog> {
    const logger = this.logger.operation('model-discovery');
    const authIdentity = getCredentialIdentity(credentials);
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    try {
      if (token.isCancellationRequested) {
        throw createAbortError();
      }
      const lookup = await waitForPromiseWithCancellation(
        this.modelCache.get(
          cacheKey,
          () => this.discoverAvailableModels(config, credentials, NON_CANCELLABLE_TOKEN, authIdentity)
        ),
        token
      );
      logger.debug('getAvailableModels cache result', {
        modelDiscoveryCacheState: lookup.state,
        modelCount: lookup.value.models.length,
        refreshStarted: lookup.refreshStarted
      });
      onCacheState?.(lookup.state);
      if (lookup.state === 'stale' && lookup.refreshStarted && lookup.refresh) {
        void lookup.refresh.then(
          () => this.modelInfoChangedEmitter.fire(),
          (error) => logger.warn('getAvailableModels background refresh failed, retaining stale models', { modelDiscoveryCacheState: 'stale', error })
        );
      }
      return lookup.value;
    } catch (error) {
      if (token.isCancellationRequested || isAbortError(error)) {
        throw error;
      }

      const cachedCatalog = this.modelCache.peek(cacheKey);
      if (cachedCatalog?.authoritative) {
        this.modelCache.set(cacheKey, cachedCatalog, {
          freshTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS,
          staleTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS
        });
        logger.warn('getAvailableModels discovery failed, retaining authoritative catalog', { modelCount: cachedCatalog.models.length, error });
        onCacheState?.('fallback');
        return cachedCatalog;
      }

      const fallbackModels = this.applyModelDiscoveryPolicy([buildFallbackModel(config, credentials.kind)], config, authIdentity);
      const fallbackCatalog = { models: fallbackModels, authoritative: false };
      this.modelCache.set(cacheKey, fallbackCatalog, {
        freshTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS,
        staleTtlMs: MODEL_DISCOVERY_FALLBACK_TTL_MS
      });
      logger.warn('getAvailableModels discovery failed, using fallback model', { fallbackModel: config.model, error });
      onCacheState?.('fallback');
      return fallbackCatalog;
    }
  }

  private async discoverAvailableModels(
    config: ReturnType<typeof getProviderConfig>,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    token: vscode.CancellationToken,
    authIdentity: string
  ): Promise<ProviderModelCatalog> {
    const logger = this.logger.operation('model-discovery.fetch');
    const clientIdentity = resolveRequestIdentity({
      ...config.requestIdentity,
      extensionVersion: getExtensionVersion(this.context),
      extensionUserAgent: buildCodexUserAgent(getExtensionVersion(this.context))
    });
    const upstreamModels = await fetchAvailableModels(config, credentials, token, clientIdentity);
    const callableModels = upstreamModels.filter((model) => isClientVersionSupported(model.minimal_client_version, clientIdentity.version));
    const models = this.applyModelDiscoveryPolicy(buildProviderModels(config, callableModels, credentials.kind), config, authIdentity);
    logger.debug('getAvailableModels discovery success', {
      catalogClientVersion: config.clientVersion,
      discoveredCount: upstreamModels.length,
      declaredClientVersion: clientIdentity.version ?? null,
      hiddenByClientVersion: upstreamModels.filter((model) => !callableModels.includes(model)).map((model) => model.slug),
      returnedCount: models.length,
      minimumClientVersions: upstreamModels.flatMap((model) => {
        const version = model.minimal_client_version;
        return typeof version === 'string' && version.trim()
          ? [{ slug: model.slug, minimalClientVersion: version.trim() }]
          : [];
      }),
      models: models.map((model) => ({
        requestModel: model.requestModel,
        activeRawContextWindow: model.rawContextWindow,
        maximumRawContextWindow: model.maximumRawContextWindow ?? null,
        effectiveInputBudget: model.effectiveInputBudget,
        maximumEffectiveInputBudget: model.info.maxInputTokens
      }))
    });
    return { models, authoritative: true };
  }

  private markModelUnavailable(
    model: string,
    config: ProviderConfig,
    credentials: NonNullable<Awaited<ReturnType<typeof getApiCredentials>>>,
    authIdentity: string,
    persistent = false
  ): void {
    if (persistent) {
      this.runtimeAvailability.markRejectedByBackend(model, config, authIdentity);
    } else {
      this.runtimeAvailability.markTemporarilyUnavailable(model, config, authIdentity);
    }
    const cacheKey = buildModelCacheKey(config, credentials.source, credentials.kind, authIdentity);
    const cachedCatalog = this.modelCache.peek(cacheKey);
    if (cachedCatalog?.authoritative) {
      this.modelCache.invalidate(cacheKey);
      this.modelCache.set(cacheKey, {
        models: cachedCatalog.models.filter((candidate) => candidate.requestModel !== model),
        authoritative: true
      }, {
        freshTtlMs: 0,
        staleTtlMs: TEMPORARILY_UNAVAILABLE_MODEL_TTL_MS
      });
    } else {
      this.modelCache.invalidate(cacheKey);
    }
    this.modelInfoChangedEmitter.fire();
    this.outputChannel.warn('model marked unavailable after responses rejection', {
      model,
      transport: config.transport,
      authIdentity,
      baseURL: normalizeBaseURL(config.baseURL)
    });
    void this.getAvailableModelCatalog(config, credentials, NON_CANCELLABLE_TOKEN).then(
      () => this.modelInfoChangedEmitter.fire(),
      () => this.outputChannel.warn('model refresh failed after responses model rejection', { model })
    );
  }

  private createToolOutputContinuationCapabilityKey(
    config: ProviderConfig,
    authIdentity: string,
    model: string,
    store: boolean
  ): string {
    return [normalizeBaseURL(config.baseURL), authIdentity, model, store ? 'store' : 'no-store'].join('|');
  }

  private resolveRequestModel(
    modelId: string | undefined,
    config: ProviderConfig,
    availableModels: readonly ResolvedProviderModel[],
    authoritative = false
  ): ResolvedRequestModel {
    if (availableModels.length === 0) {
      throw new Error('No Codex models are available after applying the configured discovery policy.');
    }

    const parsedModel = parseModelIdentifier(modelId || config.model);
    const exactAvailableModel = modelId
      ? availableModels.find((candidate) => candidate.info.id === modelId)
      : undefined;
    const requestedModel = {
      requestModel: exactAvailableModel?.requestModel ?? parsedModel.requestModel,
      reasoningEffort: parsedModel.reasoningEffort
    };
    const aliasResolution = resolveModelAliasTarget(requestedModel.requestModel, config.modelAliases);
    if (aliasResolution.kind === 'cycle') {
      throw new Error(`Model alias cycle detected for "${requestedModel.requestModel}".`);
    }
    const aliasedModel = aliasResolution.kind === 'target'
      ? availableModels.find((candidate) => candidate.requestModel === aliasResolution.targetModel)
      : undefined;
    if (aliasedModel) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: aliasedModel.requestModel
      });
      return {
        requestModel: aliasedModel.requestModel,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: aliasedModel.effectiveInputBudget
      };
    }

    const requestedAvailableModel = exactAvailableModel
      ?? availableModels.find((candidate) => candidate.requestModel === requestedModel.requestModel);
    if (requestedAvailableModel) {
      return {
        ...requestedModel,
        effectiveInputBudget: requestedAvailableModel.effectiveInputBudget
      };
    }

    if (authoritative) {
      throw new Error(`Selected Codex model "${requestedModel.requestModel}" is not available in the authoritative model catalog.`);
    }

    const prefixMatch = availableModels
      .filter((candidate) => requestedModel.requestModel.startsWith(`${candidate.requestModel}-`))
      .sort((left, right) => right.requestModel.length - left.requestModel.length)[0];

    if (prefixMatch) {
      this.outputChannel.warn('request model remapped from stale model identifier', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: prefixMatch.requestModel
      });
      return {
        requestModel: prefixMatch.requestModel,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: prefixMatch.effectiveInputBudget
      };
    }

    const configuredModel = availableModels.find((candidate) => candidate.requestModel === config.model);
    if (configuredModel) {
      this.outputChannel.warn('request model fell back to configured model', {
        requestedModelId: modelId ?? null,
        requestedModel: requestedModel.requestModel,
        resolvedModel: config.model
      });
      return {
        requestModel: config.model,
        reasoningEffort: requestedModel.reasoningEffort,
        effectiveInputBudget: configuredModel.effectiveInputBudget
      };
    }

    const fallbackModel = availableModels[0];
    this.outputChannel.warn('request model fell back to first available model', {
      requestedModelId: modelId ?? null,
      requestedModel: requestedModel.requestModel,
      resolvedModel: fallbackModel.requestModel
    });
    return {
      requestModel: fallbackModel.requestModel,
      reasoningEffort: requestedModel.reasoningEffort,
      effectiveInputBudget: fallbackModel.effectiveInputBudget
    };
  }

  private resolveDirectRequestModel(
    model: vscode.LanguageModelChatInformation,
    config: ProviderConfig,
    authIdentity: string
  ): ResolvedRequestModel | undefined {
    if (!isProviderModelIdentifier(model.id)) {
      return undefined;
    }

    const requestedModel = parseModelIdentifier(model.id);
    const aliasResolution = resolveModelAliasTarget(requestedModel.requestModel, config.modelAliases);
    if (aliasResolution.kind === 'cycle') {
      throw new Error(`Model alias cycle detected for "${requestedModel.requestModel}".`);
    }
    const alias = aliasResolution.kind === 'target' ? aliasResolution.targetModel : undefined;
    const resolvedModel = alias
      ? { ...requestedModel, requestModel: alias }
      : requestedModel;
    const unavailableModels = new Set([
      ...config.disabledModels,
      ...this.runtimeAvailability.getTemporarilyUnavailableModels(config, authIdentity)
    ]);
    if (unavailableModels.has(resolvedModel.requestModel)) {
      return undefined;
    }

    if (alias) {
      this.outputChannel.warn('request model remapped from configured model alias', {
        requestedModelId: model.id,
        requestedModel: requestedModel.requestModel,
        resolvedModel: alias
      });
    }
    const effectiveInputBudget = alias ? undefined : model.maxInputTokens;
    return { ...resolvedModel, effectiveInputBudget };
  }

  private applyModelDiscoveryPolicy(models: ResolvedProviderModel[], config: ProviderConfig, authIdentity: string): ResolvedProviderModel[] {
    const disabledModels = new Set([
      ...config.disabledModels,
      ...this.runtimeAvailability.getTemporarilyUnavailableModels(config, authIdentity)
    ]);
    const availableModelNames = new Set(models.map((model) => model.requestModel));
    const aliasedSources = new Set(
      Object.keys(config.modelAliases)
        .filter((source) => {
          const resolution = resolveModelAliasTarget(source, config.modelAliases);
          return resolution.kind === 'cycle'
            || (resolution.kind === 'target' && availableModelNames.has(resolution.targetModel));
        })
    );
    const filteredModels = models.filter((model) => !disabledModels.has(model.requestModel) && !aliasedSources.has(model.requestModel));

    if (models.length > 0 && filteredModels.length === 0) {
      this.outputChannel.warn('model discovery policy filtered every discovered model', {
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    if (filteredModels.length !== models.length) {
      this.outputChannel.debug('model discovery policy filtered models', {
        before: models.map((model) => model.requestModel),
        after: filteredModels.map((model) => model.requestModel),
        disabledModels: [...disabledModels],
        modelAliases: config.modelAliases
      });
    }

    return filteredModels;
  }
}
