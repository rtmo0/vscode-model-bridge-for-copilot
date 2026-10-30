import * as vscode from 'vscode';
import { applyLoopGuard, getLoopGuardSettings, type LoopGuardEvent } from '../../loopGuard';

/**
 * Plan → execute: VS Code ends an agent turn on a response without tool calls, so one request runs both phases.
 * The planner's plan is streamed as visible text, so it becomes part of the assistant message and the history
 * stays append-only for the executor's prompt cache. Nothing here keeps state: every decision is recomputed
 * from the history, like the loop guard.
 */

export type PlanPhase = 'plan' | 'revise';

const PLAN_HEADING = '**Plan';
const REVISED_PLAN_HEADING = '**Revised plan';

const PLAN_INSTRUCTION = 'Another model will carry out the request above with the tools of this workspace. Write a short numbered plan for it, at most 8 steps: what to inspect, what to change, and how to check the result. Name files, symbols, and commands when you know them. Do not call tools, do not write the full code, and do not ask questions. Reply with the plan only.';
const EXECUTE_INSTRUCTION = 'Carry out the plan above. Adjust it when what you find calls for it.';
const CONTINUE_INSTRUCTION = 'Continue with the revised plan above.';

/** A new prompt of the person: user text without tool results. Everything else is a tool step. */
export function isNewPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === vscode.LanguageModelChatMessageRole.User
    && last.content.some((part) => part instanceof vscode.LanguageModelTextPart)
    && !last.content.some((part) => part instanceof vscode.LanguageModelToolResultPart);
}

/**
 * The loop-guard event that asks for a revised plan: a new redirect in this request, once per turn. The guard
 * runs here even when `modelBridge.loopGuard.enabled` is off, because escalation is part of the combo.
 */
export function escalationEvent(messages: readonly vscode.LanguageModelChatRequestMessage[]): LoopGuardEvent | undefined {
  const { event } = applyLoopGuard(messages, { enabled: true, sensitivity: getLoopGuardSettings().sensitivity });
  return event?.action === 'redirect' && !hasRevisedPlan(messages) ? event : undefined;
}

export function planHeading(phase: PlanPhase, planner: string): string {
  return `${phase === 'plan' ? PLAN_HEADING : REVISED_PLAN_HEADING} · ${planner}**\n\n`;
}

/** The history for the planner: its instruction is appended as a user message, and no tools are offered. */
export function plannerMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  phase: PlanPhase,
  event?: LoopGuardEvent
): vscode.LanguageModelChatRequestMessage[] {
  const instruction = phase === 'plan'
    ? PLAN_INSTRUCTION
    : `The model carrying out the plan looks stuck in this turn: ${event?.toolCalls ?? 0} tool calls, ${event?.errorOutputs ?? 0} failing outputs, ${event?.repeatedFailures ?? 0} repeated failures. Read what it tried above and write a revised short numbered plan, at most 8 steps, that takes a different approach from where it is now. Do not call tools, do not write the full code, and do not ask questions. Reply with the plan only.`;
  return [...messages, userText(instruction)];
}

/**
 * The history for the executor: the plan as the assistant text it already is in the response, then a short user
 * message, because some backends reject a history that ends with an assistant message.
 */
export function executorMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  phase: PlanPhase,
  plan: string
): vscode.LanguageModelChatRequestMessage[] {
  return [
    ...messages,
    { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [new vscode.LanguageModelTextPart(plan)] },
    userText(phase === 'plan' ? EXECUTE_INSTRUCTION : CONTINUE_INSTRUCTION)
  ];
}

// A revised plan already streamed in the current turn, found by its heading after the last prompt.
function hasRevisedPlan(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      if (message.content.some((part) => part instanceof vscode.LanguageModelTextPart && part.value.includes(REVISED_PLAN_HEADING))) {
        return true;
      }
    } else if (isNewPrompt([message])) {
      return false;
    }
  }
  return false;
}

function userText(text: string): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart(text)] };
}
