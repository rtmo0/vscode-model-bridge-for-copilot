# Changelog

## 1.3.1

### All providers

- **Model Bridge: Support the Project on Boosty**, the menu item, and the **Sponsor** button now open Boosty instead of Buy Me a Coffee.

## 1.3.0

### All providers

- New **Model Bridge: Support the Project** command and a **Support the Project** item in the provider and Manage menus, which open Buy Me a Coffee. The extension page in VS Code and the Marketplace now shows a **Sponsor** button.

## 1.1.0

### Claude

- Lower account usage when VS Code changes the tool list mid-conversation (Virtual Tool groups, MCP servers). The system-prompt tool catalog now stays fixed per conversation and additions, removals, or changed definitions are appended as a catalog update at the point where they happened, so the cached history after the catalog is no longer rewritten.
- New **Claude Code Default** thinking effort, now the default for `modelBridge.claude.defaultEffort`. It omits `--effort` so Claude Code applies its own `effortLevel`, matching the official extension. Choose an explicit effort in the model picker to override it.
- Session continuation now tolerates whitespace differences in replayed assistant turns, so compatible follow-ups resume the Claude Code session (and keep its thinking) more often.

### Codex

- Full-history replays (HTTP transport, or a dropped WebSocket) now keep the encrypted reasoning of the current tool loop in every tool mode, not only with Native Tool Search, so the model continues its reasoning instead of re-deriving it. Reasoning items without encrypted content, which the backend ignores, are no longer sent.
- `prompt_cache_key` is now one key per conversation, derived from the conversation root and the signed-in account, as the official Codex client does, instead of a new random key after every continuation miss, fork, or window reload.
- Requests with many tools show a one-time suggestion to enable Native Tool Search. Enabling still goes through the existing confirmation, which explains the effect on other chat models.

## 1.0.0

### Claude

- Lower account usage per request. Conversation history is sent as one stream-json message with a content block per chat message, so tool-loop requests reuse the prompt cache for the unchanged prefix instead of rewriting the whole history.
- New `modelBridge.claude.systemPrompt` setting. The default `minimal` replaces Claude Code's coding-agent system prompt, whose cwd, environment, and git status sections changed between requests and invalidated the cached tool catalog. `claudeCode` keeps the default prompt with those sections moved out (`--exclude-dynamic-system-prompt-sections`).
- The VS Code tool catalog is sorted by name and JSON Schema annotations (`$schema`, `title`, `examples`, …) are removed, keeping the system prompt smaller and byte-stable.
- Default context size is now 200K and the advertised output reservation is 32K, so Copilot summarizes long conversations instead of resending up to 1M tokens of history.
- The request log now includes input, cache-write, cache-read, and output token counts.

### Codex

- New `modelBridge.codex.textVerbosity` setting (default `medium`). `low` shortens final answers.

## 0.2.0

### Codex

- Fixed `502 The '<model>' model requires a newer version of Codex` for newer models such as `gpt-6-astra` and `gpt-5.6-sol`. Requests now declare the current Codex protocol version (`0.162.1`) in the `version` header, as the official Codex CLI does, instead of the extension's own version. The `codexCliCompatible` identity profile now sends this header as well.
- The model picker now hides models whose catalog `minimal_client_version` is newer than the declared Codex version.
- Models the backend rejects for this client or account (for example `is not supported when using Codex with a ChatGPT account`) are hidden from the model picker after the first rejection and reported with a clear error instead of a raw 502. The rejection is remembered per account for 7 days and retried automatically after a Codex version update.

### Claude

- Models that Claude Code refuses for the signed-in account (for example `Fable 5.1 requires usage credits`) are hidden from the model picker after the first refusal. A Fable refusal hides both Fable and Best, because Best resolves to Fable. Hidden models return after 24 hours or after Refresh in the Claude Manage menu.

### Notes

- Copilot agent sessions send model requests through the first open VS Code window. After updating, reload every VS Code window so agent sessions use the new version.

## 0.1.0

- Rebranded the extension as Model Bridge for Copilot with independent Claude, Codex, and LM Studio provider groups.
- Added the complete ChatGPT Codex OAuth, model discovery, Responses streaming, WebSocket, usage, continuation, and tool integration.
- Added local LM Studio native model discovery, OpenAI-compatible streaming chat, reasoning, vision metadata, token usage, and VS Code function tools.
- Rebuilt the original provider as a Claude language model provider backed by the official Claude Code CLI.
- Added Claude Code and browser sign-in commands without API-key storage.
- Added streamed text, thinking, model aliases, and VS Code tool-call bridging.
- Added per-request thinking-effort and context-size model controls.
- Added token usage reporting plus persisted 5-hour and 7-day account utilization in the status bar.
- Added Doctor diagnostics, Claude Code version checks and updates, request timeout, robust cancellation, and actionable runtime errors.
- Added Best and Fable model aliases, configurable model visibility, and quick model defaults.
- Added opt-in compatible Claude Code session continuation and improved required/multiple VS Code tool calls.
- Updated publishing metadata for `rtmo0/vscode-model-bridge-for-copilot`.
- Migrated settings from the previous `anthropicForCopilot.*` and `codexModelProvider.*` namespaces. Sign-ins are not migrated because VS Code SecretStorage is scoped to the extension ID; sign in to Codex again after upgrading.
- Renamed the hosted web search reference to `#codexWebSearch` to avoid conflicts with other extensions.
- Aligned Claude and Codex usage: Claude account limits now load on startup and every 5 minutes through Claude Code's `/usage` command, use the same `Claude: 5h … · Weekly …` status bar format and details picker as Codex, and both tooltips show the latest request's token usage.
- Added `Show Account Limits`/`Refresh Account Limits` for Claude and `Run Doctor` for Codex; all providers share one Manage menu layout and Doctor report.
