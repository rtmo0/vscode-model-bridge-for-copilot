

import { stableSerialize, type ResponsesInputMessage } from './convertMessages';

const REPORTED_TOOL_CALL_TTL_MS = 10 * 60_000;
const MAX_PENDING_REPORTED_TOOL_CALLS = 200;
const TOOL_OUTPUT_CONTINUATION_CAPABILITY_TTL_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT_CONTINUATION_CAPABILITIES = 64;

interface ReportedToolCall {
  callId: string;
  name: string;
  reportedAt: number;
  responseCompletedAt?: number;
}

interface ToolOutputContinuationCapability {
  supported: boolean;
  observedAt: number;
}

export interface ObservedToolResult {
  callId: string;
  name: string;
  reportedToResultObservedMs: number;
  responseCompletedToResultObservedMs?: number;
  resultBytes: number;
  resultObservedAt: number;
}

/** Tracks tool calls reported to VS Code until their results come back, for latency diagnostics. */
export class ReportedToolCallTracker {
  private readonly pending = new Map<string, ReportedToolCall>();

  remember(callId: string, name: string, reportedAt = Date.now()): void {
    this.prune(reportedAt);
    this.pending.set(callId, { callId, name, reportedAt });

    while (this.pending.size > MAX_PENDING_REPORTED_TOOL_CALLS) {
      const oldestCallId = this.pending.keys().next().value;
      if (typeof oldestCallId !== 'string') {
        return;
      }
      this.pending.delete(oldestCallId);
    }
  }

  markResponseCompleted(callIds: ReadonlySet<string>, completedAt = Date.now()): void {
    for (const callId of callIds) {
      const reportedCall = this.pending.get(callId);
      if (reportedCall) {
        reportedCall.responseCompletedAt = completedAt;
      }
    }
  }

  consumeResults(input: readonly ResponsesInputMessage[]): ObservedToolResult[] {
    const now = Date.now();
    this.prune(now);
    const observed = [];

    for (const item of input) {
      if (item.type !== 'function_call_output') {
        continue;
      }

      const callId = typeof item.call_id === 'string' ? item.call_id.trim() : '';
      if (!callId) {
        continue;
      }
      const reportedCall = this.pending.get(callId);
      if (!reportedCall) {
        continue;
      }

      this.pending.delete(callId);
      observed.push({
        callId: reportedCall.callId,
        name: reportedCall.name,
        reportedToResultObservedMs: Math.max(0, now - reportedCall.reportedAt),
        responseCompletedToResultObservedMs: reportedCall.responseCompletedAt === undefined
          ? undefined
          : Math.max(0, now - reportedCall.responseCompletedAt),
        resultBytes: Buffer.byteLength(stableSerialize(item.output)),
        resultObservedAt: now
      });
    }

    return observed;
  }

  private prune(now: number): void {
    for (const [callId, reportedCall] of this.pending) {
      if (now - reportedCall.reportedAt > REPORTED_TOOL_CALL_TTL_MS) {
        this.pending.delete(callId);
      }
    }
  }
}

/** Bounded, expiring memory of whether an endpoint accepts tool-output continuation. */
export class ToolOutputContinuationCapabilities {
  private readonly capabilities = new Map<string, ToolOutputContinuationCapability>();

  get(key: string): boolean | undefined {
    const capability = this.capabilities.get(key);
    if (!capability) {
      return undefined;
    }
    if (Date.now() - capability.observedAt > TOOL_OUTPUT_CONTINUATION_CAPABILITY_TTL_MS) {
      this.capabilities.delete(key);
      return undefined;
    }
    return capability.supported;
  }

  record(key: string, supported: boolean): void {
    this.capabilities.set(key, { supported, observedAt: Date.now() });
    while (this.capabilities.size > MAX_TOOL_OUTPUT_CONTINUATION_CAPABILITIES) {
      const oldestKey = this.capabilities.keys().next().value;
      if (typeof oldestKey !== 'string') {
        return;
      }
      this.capabilities.delete(oldestKey);
    }
  }
}
