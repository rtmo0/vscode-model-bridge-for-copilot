import { createHmac, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { UsageLedger, UsageRecord } from './usageLedger';

export const USAGE_SECTION = 'modelBridge.usage';
const SALT_KEY = 'modelBridge.usage.conversationSalt';

export type UsageEntry = Omit<UsageRecord, 'v' | 'ts' | 'conversation' | 'step' | 'kind' | 'messages'>;

/** What providers call after a completed request. Implementations never throw. */
export interface UsageRecorder {
  recordRequest(messages: readonly vscode.LanguageModelChatRequestMessage[], entry: UsageEntry): void;
}

export interface RequestShape {
  conversation: string;
  step: number;
  kind: 'user' | 'tool';
  messages: number;
}

export function createUsageRecorder(
  context: vscode.ExtensionContext,
  ledger: UsageLedger,
  onRecorded?: () => void
): UsageRecorder {
  return {
    recordRequest(messages, entry) {
      try {
        if (!vscode.workspace.getConfiguration(USAGE_SECTION).get<boolean>('recordRequests', true)) return;
        const record: UsageRecord = {
          v: 1,
          ts: Date.now(),
          ...describeRequest(messages, getSalt(context)),
          ...entry
        };
        void ledger.append(record).then(onRecorded);
      } catch {
        // Usage recording must never affect a chat response.
      }
    }
  };
}

/**
 * Identifies the conversation by a salted hash of its first user message (stable while VS Code replays the
 * history), and the step by the number of earlier assistant turns. The salt stays on this machine, so the
 * hash cannot be matched against known text.
 */
export function describeRequest(messages: readonly vscode.LanguageModelChatRequestMessage[], salt: string): RequestShape {
  const firstUser = messages.find((message) => message.role === vscode.LanguageModelChatMessageRole.User);
  const firstText = firstUser
    ? firstUser.content.map((part) => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('\n')
    : '';
  const last = messages.at(-1);
  const hasToolResults = Boolean(last?.content.some((part) => part instanceof vscode.LanguageModelToolResultPart));
  return {
    conversation: createHmac('sha256', salt).update(firstText).digest('hex').slice(0, 16),
    step: messages.filter((message) => message.role === vscode.LanguageModelChatMessageRole.Assistant).length + 1,
    kind: hasToolResults ? 'tool' : 'user',
    messages: messages.length
  };
}

function getSalt(context: vscode.ExtensionContext): string {
  let salt = context.globalState.get<string>(SALT_KEY);
  if (!salt) {
    salt = randomBytes(32).toString('hex');
    void context.globalState.update(SALT_KEY, salt);
  }
  return salt;
}
