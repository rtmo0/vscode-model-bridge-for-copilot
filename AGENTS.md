# Repository Guidelines

## Structure

- `src/anthropicExtension.ts`: VS Code activation and commands.
- `src/anthropicProvider.ts`: Language Model Provider and VS Code message conversion.
- `src/claudeCli.ts`: Claude Code discovery, authentication status, process execution, and cleanup.
- `src/claudeProtocol.ts`: pure prompt and stream protocol helpers.
- `test/smokeClaudeProtocol.mjs`: self-contained protocol smoke coverage.
- `out/`: generated bundle; do not edit manually.

## Commands

- `npm install`: install dependencies.
- `npm run check`: TypeScript type-check.
- `npm run compile`: type-check and bundle the extension.
- `npm run test:smoke`: protocol and tool-call parsing checks.
- `npm run package:vsix`: package a VSIX.

## Constraints

- Authentication must remain delegated to the official Claude Code CLI. Never read, copy, log, or store Claude credentials.
- Provider requests must keep Claude Code built-in tools disabled. VS Code owns tool execution and confirmation.
- Do not log prompts, responses, thinking, tool arguments, or tool results.
- Temporary prompt files must be permission-restricted and removed after every request, including failures and cancellation.
- Use Claude Code `--safe-mode`, not `--bare`: bare mode cannot access a saved claude.ai sign-in in current Claude Code releases.
- Keep the Marketplace technical name `antropic-for-copilot` for repository compatibility, while user-facing branding uses the correct `Anthropic` spelling.
