# Changelog

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
