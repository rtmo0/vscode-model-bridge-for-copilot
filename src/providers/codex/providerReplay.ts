import * as vscode from 'vscode';
import type { NamespaceTool, ResponseReasoningItem } from 'openai/resources/responses/responses';
import { stableSerialize, type ResponsesInputMessage } from './convertMessages';
import type { ResponseBranchReuseEnvelope, ResponseBranchToolSignatures } from './responseBranchStore';
import { fingerprintCodexRequestEnvelope, type CodexRequestEnvelopeOptions } from './codexRequestBuilder';
import type { CodexBranchState } from './responseBranchStore';
import { resolveCodexToolSchemas } from './codexToolSchemaCache';
import { createToolCallMappingKey, type CodexToolPlan } from './nativeToolSearch/nativeToolTypes';
import { projectWebSearchReplayItem } from './hostedTools/hostedToolEvents';

export function buildResponseBranchReuseEnvelope(options: {
  baseURL: string;
  authIdentity: string;
  toolSignatures?: ResponseBranchToolSignatures;
  effectiveInputBudget?: number;
} & CodexRequestEnvelopeOptions): ResponseBranchReuseEnvelope {
  const { baseURL, authIdentity, toolSignatures, effectiveInputBudget, ...requestOptions } = options;
  const requestFingerprint = fingerprintCodexRequestEnvelope(requestOptions);
  const scopeKey = stableSerialize({ baseURL, authIdentity });
  return {
    identityKey: stableSerialize({
      scopeKey,
      requestFingerprint
    }),
    scopeKey,
    requestFingerprint,
    effectiveInputBudget,
    toolSignatures: toolSignatures ?? buildResponseBranchToolSignatures(requestOptions.tools),
    catalogHash: requestOptions.toolPlan?.catalogHash,
    toolPlanMode: requestOptions.toolPlan?.mode
  };
}

export function hasCanonicalReplayContinuationIntegrity(
  responseItems: readonly unknown[],
  appendedInput: readonly ResponsesInputMessage[]
): boolean {
  const functionCallIds = new Set<string>();
  for (const item of responseItems) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const callId = typeof record.call_id === 'string' ? record.call_id.trim() : '';
    if (record.type === 'function_call') {
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!callId || !name || functionCallIds.has(callId)) {
        return false;
      }
      functionCallIds.add(callId);
    }
  }
  const outputCounts = new Map<string, number>();
  for (const item of appendedInput) {
    if (item.type !== 'function_call_output') {
      continue;
    }
    const callId = typeof item.call_id === 'string' ? item.call_id.trim() : '';
    if (!callId || !functionCallIds.has(callId) || outputCounts.has(callId)) {
      return false;
    }
    outputCounts.set(callId, 1);
  }
  return [...functionCallIds].every((callId) => outputCounts.get(callId) === 1);
}

export const OMIT_LOCAL_REPLAY_ITEM = Symbol('omit-local-replay-item');
export const INVALID_LOCAL_REPLAY_ITEM = Symbol('invalid-local-replay-item');

export function projectSafeRawReplayItem(item: unknown, toolPlan: CodexToolPlan): ResponsesInputMessage | undefined {
  if (!isReplayRecord(item)) {
    return undefined;
  }
  const webSearchItem = projectWebSearchReplayItem(item);
  if (webSearchItem) {
    return webSearchItem;
  }
  if (item.type === 'reasoning') {
    const summary = projectReasoningSummary(item.summary);
    if (!isNonEmptyString(item.id) || !summary) {
      return undefined;
    }
    return {
      type: 'reasoning',
      id: item.id,
      summary,
      ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {})
    } satisfies ResponseReasoningItem;
  }
  if (toolPlan.mode !== 'native-hosted'
    || !isNonEmptyString(item.id)
    || item.execution !== 'server'
    || item.status !== 'completed') {
    return undefined;
  }
  if (item.type === 'tool_search_call') {
    return isReplayRecord(item.arguments)
      ? {
          type: 'tool_search_call',
          id: item.id,
          execution: 'server',
          status: 'completed',
          arguments: structuredClone(item.arguments)
        }
      : undefined;
  }
  if (item.type !== 'tool_search_output' || !Array.isArray(item.tools)) {
    return undefined;
  }
  const tools: NamespaceTool[] = [];
  const namespaceNames = new Set<string>();
  for (const namespace of item.tools) {
    if (!isReplayRecord(namespace)
      || namespace.type !== 'namespace'
      || !isNonEmptyString(namespace.name)
      || !Array.isArray(namespace.tools)
      || namespaceNames.has(namespace.name)) {
      return undefined;
    }
    const trustedNamespace = toolPlan.responseTools.find(
      (candidate): candidate is NamespaceTool => candidate.type === 'namespace' && candidate.name === namespace.name
    );
    if (!trustedNamespace) {
      return undefined;
    }
    namespaceNames.add(namespace.name);
    const namespaceTools: NamespaceTool['tools'] = [];
    const toolNames = new Set<string>();
    for (const tool of namespace.tools) {
      if (!isReplayRecord(tool)
        || tool.type !== 'function'
        || !isNonEmptyString(tool.name)
        || toolNames.has(tool.name)
        || !toolPlan.callMappings.has(createToolCallMappingKey(namespace.name, tool.name))) {
        return undefined;
      }
      const trustedTool = trustedNamespace.tools.find(
        (candidate) => candidate.type === 'function' && candidate.name === tool.name
      );
      if (!trustedTool) {
        return undefined;
      }
      toolNames.add(tool.name);
      namespaceTools.push(structuredClone(trustedTool));
    }
    tools.push({
      type: 'namespace',
      name: trustedNamespace.name,
      description: trustedNamespace.description,
      tools: namespaceTools
    });
  }
  return {
    type: 'tool_search_output',
    id: item.id,
    execution: 'server',
    status: 'completed',
    tools
  } satisfies ResponsesInputMessage;
}

export function projectReasoningSummary(value: unknown): ResponseReasoningItem['summary'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const summary: ResponseReasoningItem['summary'] = [];
  for (const part of value) {
    if (!isReplayRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string') {
      return undefined;
    }
    summary.push({ type: 'summary_text', text: part.text });
  }
  return summary;
}

export function isReplayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildLegacyFallbackReplayInput(input: readonly ResponsesInputMessage[]): ResponsesInputMessage[] {
  const replay: ResponsesInputMessage[] = [];
  for (const item of input) {
    if (item.type === 'tool_search_call'
      || item.type === 'tool_search_output'
      || item.type === 'reasoning') {
      continue;
    }
    if (item.type === 'function_call') {
      replay.push({
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments
      });
      continue;
    }
    replay.push(item);
  }
  return replay;
}

export type ExactLocalBranchHistoryStatus =
  | 'compatible'
  | 'missing-snapshot'
  | 'empty-appended-input'
  | 'appended-input-out-of-range'
  | 'function-call-integrity-mismatch'
  | 'appended-input-mismatch'
  | 'previous-input-invalid'
  | 'response-items-invalid'
  | 'current-history-invalid'
  | 'history-mismatch';

export function getExactLocalBranchHistoryStatus(
  snapshot: CodexBranchState['continuation'],
  currentInput: readonly ResponsesInputMessage[],
  appendedInput: readonly ResponsesInputMessage[]
): ExactLocalBranchHistoryStatus {
  if (!snapshot) {
    return 'missing-snapshot';
  }
  if (appendedInput.length === 0) {
    return 'empty-appended-input';
  }
  if (appendedInput.length > currentInput.length) {
    return 'appended-input-out-of-range';
  }
  if (!hasCanonicalReplayContinuationIntegrity(snapshot.responseItems, appendedInput)) {
    return 'function-call-integrity-mismatch';
  }

  const currentSuffix = currentInput.slice(currentInput.length - appendedInput.length);
  if (!haveEquivalentLocalReplayItems(currentSuffix, appendedInput)) {
    return 'appended-input-mismatch';
  }

  const previousLocalInput = normalizeLocalReplayItems(snapshot.fullRequest.input as readonly unknown[]);
  if (!previousLocalInput) {
    return 'previous-input-invalid';
  }
  const responseLocalInput = normalizeLocalReplayItems(snapshot.responseItems);
  if (!responseLocalInput || responseLocalInput.length === 0) {
    return 'response-items-invalid';
  }
  const currentLocalHistory = normalizeLocalReplayItems(
    currentInput.slice(0, currentInput.length - appendedInput.length)
  );
  if (!currentLocalHistory) {
    return 'current-history-invalid';
  }
  return stableSerialize([...previousLocalInput, ...responseLocalInput]) === stableSerialize(currentLocalHistory)
    ? 'compatible'
    : 'history-mismatch';
}

export function haveEquivalentLocalReplayItems(
  left: readonly unknown[],
  right: readonly unknown[]
): boolean {
  const normalizedLeft = normalizeLocalReplayItems(left);
  const normalizedRight = normalizeLocalReplayItems(right);
  return Boolean(normalizedLeft
    && normalizedRight
    && stableSerialize(normalizedLeft) === stableSerialize(normalizedRight));
}

export function normalizeLocalReplayItems(items: readonly unknown[]): unknown[] | undefined {
  const normalized: unknown[] = [];
  for (const item of items) {
    const normalizedItem = normalizeLocalReplayItem(item);
    if (normalizedItem === INVALID_LOCAL_REPLAY_ITEM) {
      return undefined;
    }
    if (normalizedItem !== OMIT_LOCAL_REPLAY_ITEM) {
      normalized.push(normalizedItem);
    }
  }
  return normalized;
}

export function normalizeLocalReplayItem(
  item: unknown
): unknown | typeof OMIT_LOCAL_REPLAY_ITEM | typeof INVALID_LOCAL_REPLAY_ITEM {
  if (typeof item !== 'object' || item === null) {
    return INVALID_LOCAL_REPLAY_ITEM;
  }
  const record = item as Record<string, unknown>;
  if (record.type === 'tool_search_call'
    || record.type === 'tool_search_output'
    || record.type === 'web_search_call'
    || record.type === 'reasoning') {
    return OMIT_LOCAL_REPLAY_ITEM;
  }
  if (record.type === 'message') {
    if ((record.role !== 'user' && record.role !== 'assistant')) {
      return INVALID_LOCAL_REPLAY_ITEM;
    }
    const content = normalizeLocalReplayMessageContent(record.content);
    return content === undefined
      ? INVALID_LOCAL_REPLAY_ITEM
      : { type: 'message', role: record.role, content };
  }
  if (record.type === 'function_call') {
    return typeof record.call_id === 'string'
      && record.call_id.trim().length > 0
      && typeof record.name === 'string'
      && record.name.trim().length > 0
      && typeof record.arguments === 'string'
      ? {
          type: 'function_call',
          call_id: record.call_id,
          name: record.name,
          arguments: record.arguments
        }
      : INVALID_LOCAL_REPLAY_ITEM;
  }
  if (record.type === 'function_call_output') {
    return typeof record.call_id === 'string' && record.call_id.trim().length > 0
      ? { type: 'function_call_output', call_id: record.call_id, output: record.output }
      : INVALID_LOCAL_REPLAY_ITEM;
  }
  return INVALID_LOCAL_REPLAY_ITEM;
}

export function normalizeLocalReplayMessageContent(content: unknown): unknown[] | undefined {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const normalized = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      return undefined;
    }
    const record = part as Record<string, unknown>;
    if ((record.type === 'input_text' || record.type === 'output_text') && typeof record.text === 'string') {
      normalized.push({ type: 'text', text: record.text });
      continue;
    }
    if (record.type === 'input_image'
      && (typeof record.image_url === 'string' || typeof record.file_id === 'string')) {
      normalized.push({
        type: 'image',
        detail: record.detail ?? 'auto',
        image_url: record.image_url,
        file_id: record.file_id
      });
      continue;
    }
    return undefined;
  }
  return normalized;
}

export function buildResponseBranchToolSignatures(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ResponseBranchToolSignatures {
  return resolveCodexToolSchemas(tools).toolSignatures;
}
