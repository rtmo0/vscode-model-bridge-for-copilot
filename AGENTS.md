# Repository Guidelines

## Structure

- `src/extension.ts`: unified VS Code activation, isolated per-provider activation, and provider management.
- `src/settingsMigration.ts`: one-time copy of legacy `anthropicForCopilot.*` and `codexModelProvider.*` settings.
- `src/loopGuard.ts`: opt-in failure-loop guard shared by every provider (adapted from TokenEconomizer, Apache-2.0; see `THIRD_PARTY_NOTICES.md`).
- `src/providers/claude/`: Claude Code provider (`provider.ts`), process lifecycle and model catalog listing (`cli.ts`), picker entries from the catalog (`modelCatalog.ts`), stream protocol (`protocol.ts`), optional continuation (`sessionStore.ts`), append-only tool catalog (`toolCatalog.ts`), and usage display (`usageStatusBar.ts`).
- `src/providers/codex/`: full Codex provider, authentication, Responses transports, model discovery, usage, and tools. `provider.ts` owns the request flow; replay projection lives in `providerReplay.ts`, model alias/availability in `providerModelResolution.ts`, response parts and option helpers in `providerSupport.ts`, and tool-call latency/continuation tracking in `toolCallTracking.ts`.
- `src/providers/deepseek/`: DeepSeek API provider (`provider.ts`), model table, list prices and peak hours (`models.ts`), balance status bar (`balanceStatusBar.ts`), and commands (`integration.ts`); it uses the shared chat-completions runtime.
- `src/providers/lmstudio/`: local LM Studio provider (`provider.ts`) and commands (`integration.ts`).
- `src/providers/openaiCompatible/`: shared `/v1/chat/completions` runtime (`protocol.ts` SSE and `<think>` parsing, `chatCompletions.ts` message conversion, streaming, picker options, reasoning effort) used by LM Studio, plus the OpenAI-Compatible endpoint provider (`provider.ts`), per-server model discovery (`discovery.ts`), and commands (`integration.ts`). `reasoningReplay.ts` keeps reasoning in memory for servers that need `reasoning_content` back (DeepSeek).
- `src/providers/combos/`: combos across the other providers: picker models, in-process calls to the target provider, and the fallback and plan → execute flows (`provider.ts`), settings, target matching, error classification, cooldown, and sticky routes (`routing.ts`, no VS Code imports), plan and escalation helpers (`planExecute.ts`), and commands (`integration.ts`).
- `src/providers/registry.ts`: provider IDs and `ActivatedProvider`, what every `activate*` returns: the provider and, for Claude, Codex, and DeepSeek, an availability check from their status bars. `src/extension.ts` collects them into the registry combos route to.
- `src/providers/providerError.ts`: `ProviderHttpError` (status and `Retry-After`) and the `retryAfterMs` convention combos read.
- `src/usage/`: usage ledger (`usageLedger.ts`, daily JSONL in global storage), report aggregation (`usageReport.ts`), provider-facing recorder (`usageRecorder.ts`), and the report webview (`usageReportPanel.ts` with `media/usageReport.js` and `.css`).
- `test/smokeManifest.mjs`: manifest and command registration checks; `test/smokeLoopGuard.mjs`: loop guard; `test/providers/<provider>/` contains provider-specific smoke suites.
- `docs/how-it-works.svg`, `docs/token-savings.svg`, and `docs/combos.svg`: README diagrams; re-render the matching `.png` files (920px wide at 2x, light theme, for example `rsvg-convert -z 2`) after editing them.
- `out/`: generated bundle; do not edit manually.

## Commands

- `npm install`: install dependencies.
- `npm run check`: TypeScript type-check.
- `npm run compile`: type-check and bundle.
- `npm run test:claude`, `npm run test:codex`, `npm run test:deepseek`, `npm run test:lmstudio`, `npm run test:openai-compatible`: provider-specific smoke suites.
- `npm run test:combos`: combo routing with fake target providers.
- `npm run test:usage`: usage ledger, report, and webview panel.
- `npm run test:loop-guard`: loop guard.
- `npm run test:smoke`: all suites.
- `npm run package:vsix`: package a VSIX.

## Cross-provider constraints

- Providers have independent vendor IDs, settings, authentication, status, and failures; one provider failing activation must not disable the others.
- Do not change settings that affect other providers without saying so in the confirmation UI (for example `github.copilot.chat.virtualTools.threshold`).
- VS Code owns client-tool execution, confirmation, and workspace trust.
- Never log prompts, responses, thinking, tool arguments/results, credentials, or local model attachments.
- Emit the common VS Code `usage` data shape whenever a backend supplies token usage.
- Diagnostics must be bounded and safe to copy.
- Record usage through `UsageRecorder` after a completed request: counts, model, and a salted conversation hash only; recording must never affect a response. Normalize `inputTokens` to the full prompt including cache reads and writes.
- The usage webview loads only its own `media/` files under a nonce CSP and inserts data with `textContent`.
- The loop guard is opt-in and keeps no state: it recomputes from each request's history, so its redirects land at the same place in every later request and histories stay append-only for prompt caches and continuation. It reads tool results only in memory, logs counts only, never stops a turn, and usage recording receives the original messages.

## Combos constraints

- Combos route only to Model Bridge providers, calling them in-process with the target's own `LanguageModelChatInformation` (not through `vscode.lm`); a provider that failed to activate is absent from the registry, and combos keep working with the rest.
- Fall back only before any response part reached the response, and only for retryable failures (`classifyFailure`); never retry cancellation. A leading loop-guard notice does not count as output.
- A conversation sticks to the target that answered; switch only on failure. Conversation keys are in-memory hashes in a bounded LRU, never persisted or logged.
- Target providers record usage themselves; combos log only combo, target, reason, and counts.
- List targets with `silent: true` so a combo never shows another provider's sign-in prompts.
- An availability check only reorders targets (exhausted ones last) and never throws into a request; keep it conservative, because a wrong "exhausted" skips a usable model.
- Plan → execute stays stateless: new prompt, escalation, and "once per turn" are recomputed from the history (plan headings, loop-guard events). The planner gets no tools and only its text reaches the response; the plan stays in the history unchanged so the executor's cache keeps working.

## Claude constraints

- Authentication remains delegated to the official Claude Code CLI; never read or copy its credentials.
- Use `--safe-mode`, not `--bare`, and keep built-in tools disabled.
- Temporary prompt files must be permission-restricted and removed after success, failure, timeout, and cancellation.
- Continuation is opt-in, bounded, in-memory, append-only, and requires an identical request envelope.
- List models only through Claude Code's `initialize` control request (no user message, same safe flags); fall back to the built-in aliases when it fails, and pass only efforts the model reports.

## Codex constraints

- Preserve HTTP/WebSocket callback parity and WebSocket-first `auto` fallback semantics.
- Authentication refresh and account selection must remain pinned to the correct local account key.
- Keep model-picker effort/context values, account usage, hosted Web Search, and optional Native Tool Search behavior intact.

## LM Studio constraints

- Default to `127.0.0.1`, but keep the full server URL configurable.
- Prefer native `/api/v1/models` metadata and use `/v1/chat/completions` for arbitrary VS Code tools.
- Parse SSE boundaries independently from network chunks and accumulate streamed tool-call fields by index.
- Treat `reasoning_content` as optional and never assume every model supports tools, vision, or reasoning.
- LM Studio authentication is optional and stored only in VS Code SecretStorage.
- Send `reasoning_effort` only for options the model publishes, and nothing for the model default.

## OpenAI-Compatible constraints

- Endpoints are machine-scoped settings; API tokens live only in VS Code SecretStorage, keyed by endpoint URL, and are sent only to that endpoint.
- One unreachable endpoint must not hide models from the others.
- Offer a model to Agent mode only when server metadata or an explicit endpoint override reports tool support.
- Ollama `/v1` requests cannot change `num_ctx`; advertise the loaded or configured context, never the model maximum.

## DeepSeek constraints

- The API key lives only in VS Code SecretStorage, keyed by `modelBridge.deepseek.baseURL` (machine-scoped), and is sent only to that URL.
- Capabilities and prices come from the published model table in `models.ts`; unknown models stay text-only and have no cost.
- Thinking with tools needs earlier `reasoning_content` back: keep it only in the bounded in-memory store, never log it, and run a request without thinking (not fail it) when the reasoning is unavailable or DeepSeek rejects it.
- Send `thinking: disabled` (and no effort) for Off and for required tool calls; send nothing for the model default effort.
