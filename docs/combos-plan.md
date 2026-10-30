# Plan: combo models (fallback and plan → execute)

Working plan for the next feature. Read `AGENTS.md` first; this file only adds what is specific to combos. Delete it when the feature ships and the README covers it.

## Goal

A new **Combos** model-picker group whose models route each request to one of the other Model Bridge providers (Claude, Codex, DeepSeek, LM Studio, OpenAI-Compatible):

- **Stage 1 — `fallback`:** an ordered list of targets. A conversation stays on one target; when it fails before producing output (rate limit, exhausted quota or balance, 5xx, network), the request moves to the next healthy target.
- **Stage 2 — `planExecute`:** an expensive planner writes a short plan for each new prompt, a cheaper executor does the tool steps, and the planner is consulted again only when the executor is stuck.

Ideas come from OmniRoute (combos, fallback, cooldown, cache-sticky routing) and the architect/editor pattern. Copilot's own models are out of scope: combos route only to Model Bridge providers, called in-process.

## Settings

`modelBridge.combos` (array, application scope; no secrets involved):

```json
"modelBridge.combos": [
  { "name": "Coding", "strategy": "fallback", "targets": ["claude:opus", "codex:gpt-5.5", "deepseek:deepseek-v4-pro"] },
  { "name": "Cheap agent", "strategy": "planExecute", "planner": "claude:opus", "executor": "deepseek:deepseek-flash" }
]
```

- Target syntax `provider:model`, provider one of `claude`, `codex`, `deepseek`, `lmstudio`, `openaiCompatible`. The model part matches a target model's `id`, then its `name`, case-insensitively. OpenAI-Compatible ids look like `oai::<endpoint>::<model>`; also accept `openaiCompatible:<endpoint>/<model>`.
- Invalid entries are skipped and listed by a Doctor command, like `invalidEndpoints` in `src/providers/openaiCompatible/provider.ts`.

## Architecture

- `src/providers/combos/`: `provider.ts` (the `LanguageModelChatProvider`), `routing.ts` (target resolution, error classification, cooldown, stickiness; pure and unit-testable), `planExecute.ts` (stage 2), `integration.ts` (vendor `model-bridge-combos`, commands: manage, doctor, open settings, open logs, refresh).
- **Provider registry.** Today only `activateLmStudio`, `activateOpenAICompatible`, and `activateDeepSeek` return their provider; `activateClaude` returns `void` and `activateCodex` returns `Promise<void>`. Make all five return their provider, collect them in `src/extension.ts` into a registry (`Map<'claude' | 'codex' | ..., vscode.LanguageModelChatProvider>`), and activate combos last. A provider that failed to activate is simply missing from the registry; combos must keep working with the rest.
- **Calling a target:** `provider.provideLanguageModelChatInformation({ silent: true }, token)` to find the target's `LanguageModelChatInformation`, then `provider.provideLanguageModelChatResponse(targetInfo, messages, options, progress, token)` directly — not through `vscode.lm`, which would add consent prompts and lose usage parts. Cache the model lists briefly and refresh on each provider's `onDidChangeLanguageModelChatInformation`.
- **Usage** is recorded by the target provider itself under its own name, so the report stays correct. Combos log only routing decisions (combo, target, reason, counts).
- **Model info for a combo:** `toolCalling` and `imageInput` only when every target supports them; `maxInputTokens` and `maxOutputTokens` are the minimum across targets, so a fallback never overflows a smaller window. Picker detail lists the targets.

## Stage 1: fallback

- **Fallback only before output.** Wrap `progress` to note whether any part was reported. If the target throws before reporting anything and the error is retryable, try the next target; after any output, rethrow. Never retry `vscode.CancellationError` or a cancelled token.
- **Retryable errors:** HTTP 429, 5xx, "rate limit", "quota", "usage limit", "insufficient balance", network failures and timeouts, and authentication failures (the target is unusable, so moving on is right, but log it). Match on the messages the providers already produce (`createHttpError` in `openaiCompatible/chatCompletions.ts`, Codex `responsesLimitError.ts`, Claude CLI errors); add a typed error with an optional `retryAfterMs` where a provider sees `Retry-After`.
- **Cooldown** per target: 60 s after the first failure, doubling up to 15 min, reset on success; honor `retryAfterMs`. If every target is cooling down, try the one that recovers first instead of failing outright.
- **Stickiness:** key a conversation by an in-memory hash of its first user message (like `describeRequest` in `src/usage/usageRecorder.ts`, without persisting it). Keep the chosen target in a bounded LRU (256 entries). Switch only on failure, then stick to the new target. Switching breaks the prompt cache and continuation, so it must stay rare.
- **Optional quota pre-check (stage 1b):** skip a target before calling it when its status shows it exhausted — Claude and Codex account-limit snapshots, DeepSeek `is_available`. Needs a small availability interface on those status bars; do it only if stage 1 is done.

## Stage 2: plan → execute

VS Code ends an agent turn when a response has no tool calls, so the planner cannot answer on its own. One request does both phases:

1. **New prompt** (last message is user text without tool results): call the planner with the history, no tools, and an appended instruction to write a short numbered plan without calling tools. Stream the plan to the response as visible text under a "Plan" heading, so it becomes part of the assistant message in the history.
2. In the same request, call the executor with the history plus the plan as an assistant message, with the real tools; stream its output (text and tool calls) after the plan.
3. **Tool steps** go to the executor only. The plan is already in the history, which only grows, so the executor's prompt cache keeps working.
4. **Escalation:** when `applyLoopGuard` (`src/loopGuard.ts`) reports a new `redirect` event on an executor step, run the two phases again: the planner writes a revised plan (no tools) from the history, then the executor continues. At most once per turn; afterwards behave as plain execute. Consider exporting the guard's state so escalation does not depend on `modelBridge.loopGuard.enabled`.
5. If the planner fails, continue with the executor alone; if the executor fails before output, apply stage 1 fallback to the planner.

Known interactions to test:

- **DeepSeek as executor:** the planner's message has no reasoning but also no tool calls, so DeepSeek keeps thinking on (`missingReasoning` counts only tool-call messages).
- **Codex as either role:** Codex adds a `stateful_marker` data part to its responses, and `convertMessagesToResponsesInputWithStatefulMarker` rejects a leading standalone marker from another model (`STATEFUL_MARKER_LOCAL_ERROR`). Check what Claude, DeepSeek, and the chat-completions converters do with a Codex marker in the history (Claude's `convertMessage` handles `LanguageModelDataPart`), and strip foreign markers in the combo before calling a target if needed.
- **Claude continuation** compares the history with its stored transcript; a plan streamed by another model is just assistant text, which should match.

## Tests

`test/providers/combos/smokeCombos.mjs`, with fake target providers in a registry (no network):

- fallback on 429 before output; no fallback after partial output; cancellation is not retried;
- cooldown and its reset; all targets cooling down; stickiness across requests of one conversation and a new conversation picking the first healthy target;
- capability intersection and the minimum token limits;
- invalid settings are reported, valid ones still work; a missing provider is skipped;
- plan → execute: plan streamed before the executor's tool calls in one response, tool steps go to the executor only, escalation on a loop guard redirect happens once.

Add `npm run test:combos` to `test:smoke`, the vendor to `test/smokeManifest.mjs`, and the new settings and commands to `package.json`.

## Docs

README section with both strategies, the caveat that switching models breaks the prompt cache, and an updated `docs/how-it-works.svg` (re-render the PNG as described in `AGENTS.md`); CHANGELOG entry; `AGENTS.md` structure and a "Combos constraints" section (fallback only before output, sticky routing, no persisted conversation keys, target providers record usage).
