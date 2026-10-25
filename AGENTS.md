# Repository Guidelines

## Structure

- `src/extension.ts`: unified VS Code activation, isolated per-provider activation, and provider management.
- `src/settingsMigration.ts`: one-time copy of legacy `anthropicForCopilot.*` and `codexModelProvider.*` settings.
- `src/providers/claude/`: Claude Code provider (`provider.ts`), process lifecycle and model catalog listing (`cli.ts`), picker entries from the catalog (`modelCatalog.ts`), stream protocol (`protocol.ts`), optional continuation (`sessionStore.ts`), append-only tool catalog (`toolCatalog.ts`), and usage display (`usageStatusBar.ts`).
- `src/providers/codex/`: full Codex provider, authentication, Responses transports, model discovery, usage, and tools. `provider.ts` owns the request flow; replay projection lives in `providerReplay.ts`, model alias/availability in `providerModelResolution.ts`, response parts and option helpers in `providerSupport.ts`, and tool-call latency/continuation tracking in `toolCallTracking.ts`.
- `src/providers/lmstudio/`: local LM Studio provider (`provider.ts`) and commands (`integration.ts`).
- `src/providers/openaiCompatible/`: shared `/v1/chat/completions` runtime (`protocol.ts` SSE and `<think>` parsing, `chatCompletions.ts` message conversion, streaming, picker options, reasoning effort) used by LM Studio, plus the OpenAI-Compatible endpoint provider (`provider.ts`), per-server model discovery (`discovery.ts`), and commands (`integration.ts`).
- `src/usage/`: usage ledger (`usageLedger.ts`, daily JSONL in global storage), report aggregation (`usageReport.ts`), provider-facing recorder (`usageRecorder.ts`), and the report webview (`usageReportPanel.ts` with `media/usageReport.js` and `.css`).
- `test/smokeManifest.mjs`: manifest and command registration checks; `test/providers/<provider>/` contains provider-specific smoke suites.
- `out/`: generated bundle; do not edit manually.

## Commands

- `npm install`: install dependencies.
- `npm run check`: TypeScript type-check.
- `npm run compile`: type-check and bundle.
- `npm run test:claude`, `npm run test:codex`, `npm run test:lmstudio`, `npm run test:openai-compatible`: provider-specific smoke suites.
- `npm run test:usage`: usage ledger, report, and webview panel.
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
