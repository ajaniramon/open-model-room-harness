<div align="center">

# Open Model Room Harness

**A secure multi-provider, multimodal AI room harness for Discord.**

[![Website](https://img.shields.io/badge/Website-Open_Model_Room-CB9FE8)](https://ajaniramon.github.io/open-model-room-harness/)
[![CI](https://github.com/ajaniramon/open-model-room-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/ajaniramon/open-model-room-harness/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.11-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Providers](https://img.shields.io/badge/Providers-5-7C3AED)](#model-providers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Text, vision, image generation, ElevenLabs audio replies, guarded web tools,
model escalation, and optional local Codex delegation.

</div>

Explore the full multilingual project guide at
[ajaniramon.github.io/open-model-room-harness](https://ajaniramon.github.io/open-model-room-harness/).

> [!IMPORTANT]
> This public repository does **not** contain the original private character
> prompt, credentials, private conversation data, media, logs, or owner configuration.
> The installer creates a private local prompt and `.env` file for you.

## Features

| Capability | Implementation |
| --- | --- |
| Conversational model | Selectable NanoGPT, OpenAI, Anthropic, xAI, or Gemini provider |
| Vision | Qwen multimodal sidecar, summarized back to the main model |
| Image generation | GPT Image 2 by default, with live NanoGPT model selection |
| Prompt expansion | Every image brief is expanded and validated before generation |
| Audio mode | ElevenLabs MP3 attachments in text channels—never joins voice |
| Web research | Owner-gated Tavily search and URL extraction |
| Escalation | One-shot specialist model routing with a normal-model handoff |
| Codex | Optional owner-gated local workspace delegation |
| Organic participation | Configurable spontaneous replies with cooldown/rate limits |

The security boundary is enforced in the application, not merely described in a
prompt. Paid and local tools are exposed only for explicitly authorized turns.

## Desktop installer

The cross-platform installer is a real Electron desktop window with a restrained
reversing-tool aesthetic. It does not start a web server, open a browser, expose a
port, or contact a remote dashboard.

It provides live progress, provider selection, API-key-aware model catalogs,
searchable model inputs with a manual fallback, masked secret fields, optional
integrations, existing-config protection, and a full self-test. Secrets cross a
context-isolated Electron bridge, are validated by the main process, and are
written atomically to `.env` with private file permissions where supported. They
are never placed in browser storage or URLs.

If no graphical desktop is available, the original terminal wizard remains available:

```bash
npm run setup:cli
```

## One-command installation

The bootstrap installers can install Node.js LTS when it is missing, then launch
the local GUI to install npm dependencies, collect secrets, create a private
system prompt, optionally install Codex CLI, and run the test suite.

### Windows

Clone or download the repository and double-click:

```text
install.bat
```

The batch bootstrap installs Node.js when required, downloads the desktop runtime
and project dependencies, then opens the installer. The equivalent PowerShell
entry point is:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Node.js is installed through `winget` or Chocolatey when required.

### macOS / Linux

```bash
chmod +x install.sh
./install.sh
```

The bootstrap uses Homebrew when available, otherwise it installs `curl` through
a supported Linux package manager when necessary and installs Node.js LTS through
a pinned NVM installer.

### Already have Node.js 20+

```bash
npm run setup
```

The GUI asks for:

- Discord bot token
- Primary model provider, API key, and model
- Optional NanoGPT API key for image, vision, and built-in escalation routes
- Owner Discord user ID and/or username
- Optional Tavily API key
- Optional ElevenLabs API key and voice ID
- Optional visual identity
- Optional Codex CLI installation

Secrets are written only to `.env`, which is ignored by Git.

## Model providers

The primary conversation model is selected during setup and can be changed later
with `MODEL_PROVIDER`.

| Provider | Default model | API key variable |
| --- | --- | --- |
| [NanoGPT](https://nano-gpt.com/) | `xiaomi/mimo-v2.5-pro:thinking` | `NANOGPT_API_KEY` |
| [OpenAI](https://developers.openai.com/api/docs/overview) | `gpt-5.6-terra` | `OPENAI_API_KEY` |
| [Anthropic](https://platform.claude.com/docs/en/get-started) | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| [xAI / Grok](https://docs.x.ai/developers/quickstart) | `grok-4.5` | `XAI_API_KEY` |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/quickstart) | `gemini-3.6-flash` | `GEMINI_API_KEY` |

Each provider uses its native authentication and message/tool format. Tool calls
are normalized inside the harness, including Anthropic tool-result blocks and
Gemini function-call IDs and thought signatures. Custom model IDs and base URLs
can be configured in `.env`.

`JJ_REASONING_EFFORT` is forwarded where the provider's chat API supports it.
For OpenAI GPT-5.6 tool-enabled Chat Completions, the harness automatically uses
`none` reasoning effort to preserve function-tool compatibility.

NanoGPT remains an independent optional sidecar for the existing image generation,
vision analysis, and specialist escalation routes. A non-NanoGPT primary provider
works without it, but those auxiliary capabilities require `NANOGPT_API_KEY`.

## Discord application setup

1. Create an application in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot** and enable **Message Content Intent**.
3. Reset/copy the bot token and provide it only to the local setup wizard.
4. Under **OAuth2 → URL Generator**, select the `bot` scope.
5. Grant these minimal permissions:

   - View Channels
   - Send Messages
   - Read Message History
   - Embed Links
   - Attach Files
   - Send Messages in Threads (optional)

Do not grant Administrator, voice, channel-management, or message-management
permissions. Audio is uploaded as an MP3 attachment and does not use Discord voice
or native TTS.

## Run

```bash
npm start
```

Development mode:

```bash
npm run dev
```

By default the bot responds to DMs, direct mentions, and replies to its messages.
Set `JJ_TRIGGER_MODE=all` only if you intentionally want every human message in an
allowed channel to trigger a model request.

## Example commands

```text
@JJ search the web for the latest Node.js release notes
@JJ escalate to kimi-k3 :: review this deployment plan
@JJ spawn codex :: inspect this workspace and run the tests
@JJ CODEX YOLO :: find the target repository, implement the requested change, and run its tests
@JJ enable audio mode
@JJ draw a picture of the current situation
@JJ generate an image using model nano-banana-2-lite :: a goblin SRE
```

Web, image generation, escalation, audio mode, and Codex are owner-gated.
Audio mode sends MP3 replies only when the configured owner directly addresses the
bot; other participants continue receiving text.

`CODEX YOLO :: <task>` is an opt-in owner-only route for work across a broader
local root. It is disabled by default. To use it, set `JJ_CODEX_YOLO_ENABLED=true`
and point `JJ_CODEX_YOLO_WORKSPACE` at a directory whose contents Codex may
intentionally read and modify. This invokes Codex with approvals and sandboxing
bypassed; ordinary `spawn codex` commands remain workspace-bounded.

## Private character prompt

`src/system-prompt.txt` is intentionally excluded from this repository. Setup
copies the safe starter at `src/system-prompt.example.txt`, replaces the bot name,
and leaves the resulting file untracked.

Edit your private prompt locally:

```text
src/system-prompt.txt
```

Never commit it if it contains private personality details, memories, operational
rules, or participant information.

## Image generation and cost

Every image request is first converted from a conversational brief into a concrete
visual prompt. The compiler preserves explicit subjects, style, composition, text,
and constraints while expanding missing details from visible room context.

The default renderer is `gpt-image-2`. Image generation and prompt compilation can
incur NanoGPT charges. Pricing changes over time, so check the
[NanoGPT model catalog](https://nano-gpt.com/models/image) before enabling image
generation for an owner account.

Use `NANOGPT_IMAGE_MODEL` to change the default. Exact alternative model IDs are
validated against NanoGPT's live catalog before generation.

## Vision

Supported Discord PNG, JPEG, and WebP attachments are downloaded, encoded as
OpenAI-compatible image parts, and inspected by the configured vision model.
Visual reports and text found inside images are treated as untrusted data.

The main conversational model receives the visual report and writes the final
reply in the configured character voice.

## Security model

- Prefer immutable Discord user IDs over usernames for every allowlist.
- Keep `JJ_TRIGGER_MODE=mention` to control spend and bot-to-bot loops.
- Never enable `JJ_RESPOND_TO_BOTS` without explicit loop controls.
- Web results, image text, and delegated output are untrusted.
- Codex always receives a filtered environment. Normal delegations retain workspace
  boundaries; the separately configured YOLO route deliberately bypasses them.
- Generated media, logs, state, `.env`, and the private prompt are ignored.
- Rotate any credential that has ever appeared in Discord or Git history.

See [SECURITY.md](SECURITY.md) for operational guidance.

## Configuration

The installer writes the common settings. `.env.example` documents every supported
environment variable, including model routes, owner allowlists, rate limits,
timeouts, media limits, and spontaneous participation.

## Tests

```bash
npm run check
npm run scan:secrets
npm test
```

CI runs syntax checks and the full test suite on Node.js 20, 22, and 24.

## License

[MIT](LICENSE)
