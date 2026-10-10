<div align="center">
  <img src="assets/anthropic-for-copilot.png" alt="Anthropic for Copilot logo" width="128" height="128">

  <h1>Anthropic for Copilot</h1>

  <p><strong>Use your signed-in Claude Code account in VS Code Chat and Agent mode.</strong></p>
</div>

Anthropic for Copilot is a VS Code Language Model Provider that connects the native VS Code Chat experience to the official Claude Code CLI. It does not ask for an Anthropic API key and does not copy, inspect, or store Claude credentials. Authentication remains owned by Claude Code.

> This is an independent community extension. It is not affiliated with or endorsed by Anthropic.

## Features

- Claude models appear in the native VS Code model picker.
- Uses the official Claude Code browser sign-in and locally stored session.
- Streams text and thinking from Claude Code's `stream-json` output.
- Forwards selected VS Code Agent tools through a constrained tool-call protocol; VS Code remains responsible for tool execution, confirmation, and workspace trust.
- Supports stable Claude Code model aliases: Default, Sonnet, Opus, and Haiku.
- Never stores API keys or OAuth tokens in VS Code SecretStorage.

## Requirements

- VS Code 1.104.0 or newer.
- The official [Claude Code CLI](https://code.claude.com/docs/en/setup) installed on the same host where the extension runs.
- A Claude account or another authentication method supported by Claude Code.

Remote-SSH, Dev Containers, WSL, and Codespaces run workspace extensions remotely, so Claude Code must be installed and signed in on that remote host.

## Sign in

Open the Command Palette and use either command:

- **Anthropic for Copilot: Sign in with Browser** runs `claude auth login` in a VS Code terminal. This is the shortest route to Claude Code's official browser flow.
- **Anthropic for Copilot: Sign in with Claude Code** opens the interactive `claude` terminal. Claude Code starts its official setup flow when no account is signed in.

Both commands delegate authentication entirely to Claude Code. After login, run **Anthropic for Copilot: Refresh Models** or reopen the model picker.

Use **Anthropic for Copilot: Show Sign-In Status** to run `claude auth status`, or **Anthropic for Copilot: Sign Out** to run `claude auth logout`.

## Use Claude in Chat

1. Open VS Code Chat.
2. Open the model picker.
3. Choose **Claude** and then Default, Sonnet, Opus, or Haiku.
4. Use Chat or Agent mode normally.

Each request runs Claude Code in non-interactive print mode with streamed JSON output, session persistence disabled, and Claude Code's built-in tools disabled. Selected VS Code tools are described explicitly to the model. This separation prevents the hidden CLI process from editing files or executing commands outside VS Code's normal tool confirmation flow.

## Settings

- `anthropicForCopilot.claudePath`: executable name or absolute path, default `claude`.
- `anthropicForCopilot.model`: fallback Claude Code model alias, default `default`.
- `anthropicForCopilot.instructions`: instructions appended to every request.
- `anthropicForCopilot.maxOutputTokens`: output capacity advertised to VS Code.

## Privacy and security

The extension sends the current VS Code Chat transcript and selected tool definitions to the local Claude Code process. Claude Code then communicates with Anthropic according to its own configuration and privacy terms.

The extension never reads Claude Code credential files, exports OAuth tokens, or accepts an Anthropic API key. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` from provider and sign-in process environments so requests use Claude Code's own saved sign-in. It disables Claude Code's built-in tools for provider requests, removes temporary system-prompt files after each request, and logs only request metadata and output sizes rather than prompt or response content.

## Develop locally

```bash
npm install
npm run check
npm run compile
npm run test:smoke
npm run package:vsix
```

Press `F5` in VS Code to launch an Extension Development Host. Release packaging is documented in [docs/releasing.md](docs/releasing.md).

## License

MIT. This project is based on the MIT-licensed Codex For Copilot project; attribution is retained in [LICENSE](LICENSE).
