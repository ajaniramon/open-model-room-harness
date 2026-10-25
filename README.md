<div align="center">

# Open Model Room Harness

**A secure multi-provider, multimodal AI room harness for Discord.**

[![Website](https://img.shields.io/badge/Website-Open_Model_Room-CB9FE8)](https://ajaniramon.github.io/open-model-room-harness/)
[![CI](https://github.com/ajaniramon/open-model-room-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/ajaniramon/open-model-room-harness/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.11-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Providers](https://img.shields.io/badge/Providers-7-7C3AED)](#model-providers)
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
| Conversational model | Selectable NanoGPT, OpenAI, Anthropic, xAI, Gemini, local OpenAI-compatible, or provider-free connectivity mode |
| Vision | Qwen multimodal sidecar, summarized back to the main model |
| Image generation | GPT Image 2 by default, with live NanoGPT model selection |
| Prompt expansion | Every image brief is expanded and validated before generation |
| Audio mode | ElevenLabs MP3 attachments in text channels—never joins voice |
| Web research | Owner-gated Tavily web tools plus keyless read-only X search/post fetch |
| Escalation | One-shot specialist model routing with a normal-model handoff |
| Codex | Optional owner-gated local workspace delegation |
| Organic participation | Configurable spontaneous replies with cooldown/rate limits |
| Participation governor | Global guild budget, conversation windows, progressive user cooldown, and temporary spam blocks |
| Runtime control | Persistent maintenance mode and optional supervisor-backed restart from Discord |
| Message timestamps | Every context message carries its post time, age, and time zone |
| Memory | Opt-in cross-channel notes with per-user opt-out, retention, export and deletion |

The security boundary is enforced in the application, not merely described in a
prompt. Paid and local tools are exposed only for explicitly authorized turns.

## Desktop installer

The cross-platform installer is a real Electron desktop window with a restrained
reversing-tool aesthetic. It does not start a web server, open a browser, expose a
port, or contact a remote dashboard.

It provides live progress, provider selection, cloud and local model catalogs,
searchable model inputs with a manual fallback, masked secret fields, optional
integrations, existing-config protection, and a full self-test. Secrets cross a
context-isolated Electron bridge, are validated by the main process, and are
written atomically to `.env` with private file permissions where supported. They
are never placed in browser storage or URLs.

The installer soundtrack is [Silicon Dreamer by Avizura](https://www.newgrounds.com/audio/listen/1464248),
included with the artist's permission. The player is opt-in, starts at `00:25` with
a fade-in, and never autoplays. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for licensing details.

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
- Primary model provider, model, and API key when required
- Local OpenAI-compatible endpoint when using llama.cpp, vLLM, or an equivalent server
- Optional NanoGPT API key for image, vision, and built-in escalation routes
- Owner Discord user ID and/or username
- Optional Tavily API key
- Keyless, read-only X/Twitter search and post fetch through FxTwitter with free search fallback
- Automatic download of X/Twitter posts linked in chat, so the bot can comment on them
- Optional ElevenLabs API key and voice ID
- Optional visual identity
- Optional Codex CLI installation

Secrets are written only to `.env`, which is ignored by Git.

The project-local `.env` is enough for a normal installation. Deployments that
already keep secrets or program settings in external environment files may point
the harness at them with `AI_WORKSPACE_SECRETS_ENV` and
`AI_WORKSPACE_PROGRAMS_ENV`. Both are optional; values already loaded from those
files take precedence, and `.env` fills any remaining settings.

Set these variables in the service manager or in the shell that starts the
harness—never in a committed launcher. For example, in a PowerShell session:

```powershell
$env:AI_WORKSPACE_SECRETS_ENV = "<absolute path to private secrets.env>"
$env:AI_WORKSPACE_PROGRAMS_ENV = "<absolute path to private programs.env>"
npm start
```

Use paths appropriate for your machine, restrict access to the files, and do not
commit either file or its path if the path reveals private infrastructure.

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
| Local OpenAI-compatible | `local-model` | Optional `LOCAL_API_KEY` |
| None / connectivity test | `none` | None |

Each provider uses its native authentication and message/tool format. Tool calls
are normalized inside the harness, including Anthropic tool-result blocks and
Gemini function-call IDs and thought signatures. Custom model IDs and base URLs
can be configured in `.env`.

For a local model, set `MODEL_PROVIDER=local`, `LOCAL_MODEL` to the served model
ID, and `LOCAL_BASE_URL` to the server address. The URL may be a bare host, an
OpenAI-compatible `/v1` base, or the complete `/v1/chat/completions` URL; the
harness normalizes all three forms. `LOCAL_API_KEY` is optional and is sent as a
Bearer token only when present.

For Discord and MCP integration testing without a model account, set
`MODEL_PROVIDER=none`. The bot still logs in, accepts deterministic owner
commands, exposes MCP controls, and replies to inference-bound turns with a short
provider-disabled message.

Typical defaults:

```dotenv
# llama.cpp server (default port)
LOCAL_BASE_URL=http://127.0.0.1:8080/v1

# vLLM OpenAI-compatible server (default port)
LOCAL_BASE_URL=http://127.0.0.1:8000/v1
```

The desktop installer queries `/v1/models` and fills the model selector when the
server exposes a catalog. Manual model entry remains available for minimal or
custom servers. Function tools require a local model/template and backend build
that support OpenAI-compatible tool calling; ordinary chat does not.

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

By default the bot responds to DMs and a direct mention opens the configured
same-user conversation window. Once that window expires, replies alone do not bypass
the new-mention requirement. `JJ_TRIGGER_MODE` remains the legacy fallback when the
participation governor is disabled.

For temporary focus locks, use `JJ_ALLOWED_GUILD_IDS` for Discord server IDs and
`JJ_ALLOWED_CHANNEL_IDS` for channel IDs. When a channel allowlist is set, messages
outside those channels are ignored before memory capture, spontaneous participation,
or command handling; DMs remain available.

## Example commands

```text
@YourBot search the web for the latest Node.js release notes
@YourBot search X for posts about local AI agents
@YourBot read https://x.com/jack/status/20
@YourBot escalate to kimi-k3 :: review this deployment plan
@YourBot escalate to grok-4.5 :: challenge the assumptions in this design
@YourBot spawn codex :: inspect this workspace and run the tests
@YourBot CODEX YOLO :: find the target repository, implement the requested change, and run its tests
@YourBot enable audio mode
@YourBot draw a picture of the current situation
@YourBot generate an image using model nano-banana-2-lite :: a goblin SRE
@YourBot maintenance on
@YourBot wake
@YourBot status
```

Web and X/Twitter research, image generation, escalation, audio mode, and Codex are owner-gated.
Audio mode sends MP3 replies only when the configured owner directly addresses the
bot; other participants continue receiving text.

Discord-only custom emoji strings can be supplied as runtime metadata instead of
memory:

```dotenv
DISCORD_EMOJI_PALETTE="<:name:123456789012345678>,<a:animated:234567890123456789>"
```

or:

```json
{
  "discord": {
    "emojiPalette": ["<:name:123456789012345678>", "<a:animated:234567890123456789>"]
  }
}
```

The palette is injected only into Discord reply context, never stored as memory.
Audio mode omits it because spoken replies forbid emojis.

`CODEX YOLO :: <task>` is an opt-in owner-only route for work across a broader
local root. It is disabled by default. To use it, set `JJ_CODEX_YOLO_ENABLED=true`
and point `JJ_CODEX_YOLO_WORKSPACE` at a directory whose contents Codex may
intentionally read and modify. This invokes Codex with approvals and sandboxing
bypassed; ordinary `spawn codex` commands remain workspace-bounded.

## Participation governor

The harness prevents a popular companion from taking over a room with one response
budget shared across all channels in each server, progressive per-user cooldowns,
and a bounded conversation window. By default, a mention opens five interactions
for that user and channel; after the window or ten minutes of inactivity, a new
mention is required. Spontaneous messages consume the same global budget and are
therefore naturally the lowest-priority participation.

Clear mention spam can trigger an internal temporary block that expires
automatically. It does not ban or timeout the Discord account and needs no moderation
permissions. Reasons and expirations are recorded without message contents in a
rotating JSONL audit log.

The owner is exempt and can change values immediately without model inference or a
restart:

```text
@YourBot limits show
@YourBot limits set budget.maxResponses 15
@YourBot limits set conversation.turns 4
@YourBot limits set cooldown.maxSeconds 90
@YourBot limits set autoban.enabled false
@YourBot limits unban @user
@YourBot limits reset
```

The desktop and CLI installers create a private, Git-ignored `config.json` from
`config.example.json`. Hot changes are validated and written there atomically;
environment variables documented in `.env.example` remain deployment fallbacks.

### Two-tier spontaneous participation

Public spontaneous participation remains event-driven: a human Discord message must
create a relevant opportunity, and behavior-mode, channel, budget, cooldown, and
anti-spam checks all apply before a relay item exists.

An optional owner-DM heartbeat provides a looser private tier. At a randomized time
inside the configured interval it captures a bounded snapshot and queues an
`owner-heartbeat` relay item. The heartbeat is a decision opportunity, never an
automatic notification. The external ChatGPT worker either completes it with a
useful owner DM or calls `complete_chat_relay_without_reply`. Recent owner activity
anywhere in Discord suppresses the opportunity, and only one heartbeat item may be
active at a time.

It is disabled by default and intended for the provider-free ChatGPT relay path:

```dotenv
MODEL_PROVIDER=none
CHAT_RELAY_ENABLED=true
JJ_OWNER_HEARTBEAT_ENABLED=true
JJ_OWNER_HEARTBEAT_USER_ID=123456789012345678
JJ_OWNER_HEARTBEAT_MIN_MINUTES=60
JJ_OWNER_HEARTBEAT_MAX_MINUTES=180
JJ_OWNER_HEARTBEAT_RECENT_INTERACTION_MINUTES=30
JJ_OWNER_HEARTBEAT_CONTEXT_MESSAGES=8
```

The configured owner heartbeat also requires the effective global behavior mode to
be `auto`. Its eventual messages consume the behavior mode's auto-response limit;
no-reply decisions do not.

### Capability broker claims

The relay can optionally obtain short-lived, audience-specific capability grants
when a worker claims an item. Discord messages enter through Discord ingress;
owner-heartbeat opportunities enter through autonomous ingress. The broker derives
authority from trusted ingress rather than relay text.

```dotenv
CAPABILITY_BROKER_ENABLED=true
CAPABILITY_BROKER_URL=http://127.0.0.1:3400
CAPABILITY_BROKER_OWNER_AUDIENCES=filesystem,execution,discord
CAPABILITY_BROKER_PUBLIC_AUDIENCES=discord
CAPABILITY_BROKER_AUTONOMOUS_AUDIENCES=filesystem,execution,discord
BROKER_DISCORD_INGRESS_TOKEN=use-the-broker-discord-ingress-secret
BROKER_AUTONOMOUS_INGRESS_TOKEN=use-the-broker-autonomous-ingress-secret
BROKER_EXCHANGE_TOKEN=use-the-broker-exchange-secret
```

Keep the three tokens in the private secrets environment, not `config.json`.
Claims persist broker lifecycle metadata so a lease reclaim renews the same event
and grants rather than creating another authority session. Signed grants are only
returned in the leased claim payload; peek and ordinary inspection never expose
them. The integration is disabled by default and legacy relay authorization remains
unchanged while it is off.

## Behavior modes

Behavior modes are the single runtime policy for Discord replies, spontaneous
participation, and passive memory capture. Existing deployments are migrated
automatically: the previous spontaneous-participation setting becomes the initial
`auto` or `manual` default, and a legacy runtime-control state is imported once.

The four modes are:

| Mode | Behavior |
| --- | --- |
| `manual` | Normal direct reply behavior; spontaneous participation is off. |
| `observe` | Silent for non-owner users, but passive memory capture can run when extraction is enabled. |
| `auto` | Event-driven spontaneous participation is allowed, still bounded by participation limits and auto cooldowns. |
| `maintenance` | Silent for non-owner users and passive capture is paused. |

Modes can be global, guild-scoped, or channel-scoped. Channel overrides win over
guild overrides, which win over the global/default mode. A global `observe` or
`maintenance` lock is a safety override and cannot be bypassed by a scoped
`manual`/`auto` entry. Overrides may include an expiry, a per-scope auto cooldown,
and a maximum number of auto replies per hour. `quiet` remains accepted as a legacy
alias for `maintenance`.

An optional MCP control server can expose only the behavior switches, not raw
Discord send/read tools:

```dotenv
MCP_CONTROL_ENABLED=true
MCP_CONTROL_BEARER_TOKEN=replace-with-a-private-token
MCP_CONTROL_WAKE_TOKEN=replace-with-a-separate-read-only-token
```

The server listens on `http://127.0.0.1:3000/sse` by default and requires
`Authorization: Bearer <token>` on every request. Streamable HTTP is also available
at `/mcp`. To use a remote MCP client, put only this local service behind a trusted
HTTPS reverse proxy or tunnel; configure the tunnel outside this repository and
keep its credentials private.

Clients that cannot send an authorization header may use the compatibility form
`https://<public-host>/token/<URL-encoded-token>/sse` (or `/mcp`) and select **No
authentication** in the client. The complete tokenized URL is a credential: never
commit it, paste it into documentation, include it in screenshots, or reuse it for
another service. Prefer the normal bearer header whenever the client supports one.

The MCP control surface includes generic behavior, participation, runtime, memory,
and audio tools:

```text
discover_mcp_tools
describe_mcp_tool
get_mcp_usage_guide
get_discord_connection_status
list_discord_guilds
list_discord_channels
resolve_discord_members
search_discord_members
send_owner_dm
list_discord_scopes
set_discord_scope
clear_discord_scope
send_scoped_discord_message
get_behavior_mode
set_behavior_mode
clear_behavior_mode
list_behavior_modes
get_runtime_status
get_capability_status
set_maintenance_mode
set_observation_mode
restart_runtime
get_participation_status
get_participation_policy
set_participation_policy
reset_participation_policy
unban_participant
get_memory_status
run_memory_digest
get_audio_mode
set_audio_mode
get_pending_chat_relay
get_chat_relay_item
get_chat_relay_attachment
get_chat_relay_text_attachment
submit_chat_relay_reply
dismiss_chat_relay_item
```

If the MCP client UI cannot send a bearer header, put the same token in the server
URL for the SSE handshake:

```text
https://example-tunnel/sse?access_token=<token>
```

The server authorizes the resulting SSE session and still rejects unknown tokens.
If the client strips query parameters, use the token-in-path form instead:

```text
https://example-tunnel/token/<token>/sse
```

For a control-only test, create `.env.control` with the MCP and behavior-mode
settings, then run the MCP switchboard without Discord, a model API key, or a
system prompt:

```bash
npm run mcp:control
```

This edits the behavior-mode state file. A separate running bot process using the
same `BEHAVIOR_MODE_STATE_PATH` watches that file and hot-reloads changes, so MCP
control and the Discord runtime can run as separate processes.

When `MODEL_PROVIDER=none`, a ChatGPT-mediated relay can queue model-bound Discord
turns instead of posting the provider-disabled test message:

```dotenv
CHAT_RELAY_ENABLED=true
CHAT_RELAY_STATE_PATH=state/chat-relay.json
CHAT_RELAY_TTL_SECONDS=86400
CHAT_RELAY_MAX_ITEMS=50
CHAT_RELAY_LEASE_SECONDS=120
CHAT_RELAY_MAX_ATTEMPTS=3
CHAT_RELAY_OWNER_PRIORITY_BURST=3
CHAT_RELAY_HUMAN_PRIORITY_BURST=5
CHAT_RELAY_MAX_IMAGE_ATTACHMENTS=4
CHAT_RELAY_MAX_AUDIO_ATTACHMENTS=2
CHAT_RELAY_MAX_TEXT_ATTACHMENTS=4
CHAT_RELAY_MAX_ATTACHMENT_BYTES=8000000
CHAT_RELAY_MAX_AUDIO_ATTACHMENT_BYTES=8000000
CHAT_RELAY_AUDIO_FETCH_TIMEOUT_MS=30000
```

The harness still owns Discord events, scope checks, cooldowns, and participation
reservations. Relay items are persisted and recovered after a restart. An external
ChatGPT worker should call `peek_chat_relay_item`, then atomically acquire that exact
opaque ID with `claim_chat_relay_item`. The successful claim returns the authoritative
payload and lease token. Complete it with `complete_chat_relay_item`, or use
`complete_chat_relay_without_reply` when no Discord reply is warranted. Exact claims
report `claimed`, `already_claimed`, or `not_pending`, so an empty queue, a harmless
worker race, and a blocked tool call remain distinguishable. The older batch and
dismissal tools remain available for compatibility. Claims have expiring leases so
overlapping task runs cannot answer the same Discord message. This is not a raw
Discord send tool.

Direct messages from a configured owner receive the highest durable queue priority,
other human-authored messages receive the human fastpass, and bot/system work remains
the ordinary tier. `CHAT_RELAY_OWNER_PRIORITY_BURST` bounds how many owner DMs may run
before a waiting human item. `CHAT_RELAY_HUMAN_PRIORITY_BURST` bounds the combined
owner/human run before a waiting bot/system item. Already leased work is never
preempted, FIFO order is preserved within each class, and owner-heartbeat opportunities
are not elevated. Queue priority never grants tool or capability authorization.

Relay items expose bounded metadata for direct image uploads, Discord-proxied embed
images, GIF previews, and stickers. Use `get_chat_relay_attachment` with the relay
item ID and advertised zero-based index to return that image directly to the MCP
client. The tool accepts no URL argument: it can fetch only references captured from
the Discord message, permits approved Discord CDN/proxy hosts over HTTPS, rejects
redirects, and enforces the configured byte limit. This lets an external multimodal
chat provider inspect Discord images without configuring the harness vision sidecar.
Safe UTF-8 text-like Discord file attachments are exposed separately as
`textAttachments`; use `get_chat_relay_text_attachment` with the advertised index
to fetch bounded Markdown, plaintext, JSON, code, patch, log, CSV, XML, YAML, and
similar files captured from the same relay item. Metadata is visible in the claim
payload, but the Discord CDN URL is never exposed.

Audio Discord file attachments are exposed as bounded `audioAttachments` metadata
for MP3, WAV, and OGG files. Use `get_chat_relay_audio_attachment` with the
advertised index to fetch bytes from the captured relay item. The tool accepts no
URL argument, permits only approved Discord CDN/proxy hosts over HTTPS, rejects
redirects, enforces the configured byte limit, sniffs the audio container, and
returns base64 audio plus derived metadata such as MIME type, SHA-256, size, and
duration where it can be determined safely. It does not join voice channels or run
automatic transcription. Audio retrieval has its own optional
`CHAT_RELAY_MAX_AUDIO_ATTACHMENT_BYTES` and `CHAT_RELAY_AUDIO_FETCH_TIMEOUT_MS`
settings so operators can tune slow CDN fetches separately from image/text limits.

For environments where scheduled tasks are too infrequent, the optional build-free
browser prototype in [`extensions/chat-relay-wake`](extensions/chat-relay-wake/README.md)
can wake one configured ChatGPT conversation when relay work is pending. It polls the
authenticated `/api/chat-relay/wake-status` endpoint, which exposes only a pending
count and opaque relay IDs. The status also exposes a fast lane containing only
direct priority work, such as owner or human fastpass items; spontaneous,
autonomous, and ordinary bot/system work stay on the normal lane. The extension can
use the configured ChatGPT tab heartbeat to check that fast lane more frequently,
but it still only inserts a prompt for one exact server-selected relay ID. It does
not receive Discord content, claim items, generate replies, or maintain a second
queue; normal MCP relay tools remain responsible for processing and delivery. A
configurable unresolved-item circuit breaker progressively pauses repeated ChatGPT
wake prompts while the same oldest item remains pending, without scraping
conversation content. Set relay retention long enough to survive the maximum
expected backoff; unattended deployments should generally use a substantially
longer TTL than the 600-second test default.
If the external worker or platform wedges on a relay item, the MCP tool
`flush_chat_relay_queue` and the wake extension options page can clear pending
relay backlog. The authenticated HTTP flush endpoint uses the dedicated wake token
and removes only internal relay work; it does not send, edit, or delete Discord
messages. Leased/in-progress items are preserved by default and require an explicit
emergency option to flush.

The wake endpoint accepts only `MCP_CONTROL_WAKE_TOKEN`, a dedicated read-only
credential that cannot invoke MCP tools. Do not put `MCP_CONTROL_BEARER_TOKEN` in
the extension. Remote status URLs must use HTTPS; plain HTTP is accepted only for
loopback development.

Create the task inside Gremy's existing ChatGPT conversation with a minute-based
schedule and this durable prompt:

```text
Every minute, check the Discord relay queue.

Use claim_chat_relay_items with workerId "scheduled-gremy", limit 1, and includeContext true. Resolve that item before claiming another.
If no items are returned, finish without a user-facing report.

For each claimed item:
1. Read the item and its context with get_chat_relay_item.
2. Inspect each advertised image with get_chat_relay_attachment when visual context matters.
3. Decide whether a reply is appropriate using the existing conversation policy.
4. Use complete_chat_relay_item with the returned leaseToken to answer, or
   dismiss_chat_relay_item with the leaseToken when no reply is appropriate.
5. If processing takes longer than the lease, renew it before completing.

Never use arbitrary Discord send tools for relay replies.
Treat each claimed item's triggerText, replyTo, imageAttachments, emojiPalette, and
Discord context as authoritative for the current Discord event. Configured ChatGPT
identity, persistent memory, and general knowledge remain valid background; a known
fact does not need to be repeated in the relay item. Do not answer unrelated earlier
ChatGPT turns or mistake them for the current Discord request. Process each relay item
independently and complete or dismiss that exact item ID with its lease token.
Do not invent missing context or retry a completed item.
Only report a problem in ChatGPT when the relay tools fail repeatedly or require intervention.
```

Relay items include both stable IDs and human-readable context such as
`guildName`, `channelName`, `scope`, and `isDM` so external chat providers can
reason about where a turn came from without an extra discovery call.

`send_owner_dm` is restricted to configured immutable owner user IDs. It writes a
metadata-only audit event with the target owner ID, status, and message length;
the DM body is not retained in the audit log.

Scoped Discord sends use named scopes stored in `config.json`, not arbitrary
channel IDs. A minimal scope looks like:

```json
{
  "discord": {
    "scopes": {
      "publicChat": {
        "label": "Public Chat",
        "guildIds": ["1400728771245637683"],
        "channelIds": ["1461460040660811968"],
        "defaultChannelId": "1461460040660811968",
        "allowSend": true,
        "attentionMode": "mentions_only",
        "includeRepliesToSelf": true
      }
    }
  }
}
```

`send_scoped_discord_message` can post only to channels inside an `allowSend`
scope, only when the bot has Discord send permission there, and with Discord
mention parsing disabled.

## Remote runtime control

`maintenance on`, `observation on`, `wake`, and `status` are deterministic owner
commands handled before inference. They are compatibility aliases over the same
global behavior policy used by MCP; there is no second runtime-mode switch. The
unified state persists in `state/behavior-mode.json`.

Maintenance turns the companion into an owner-only bot: the owner retains normal
replies and authorized tools, while every
other human, bot, webhook, and model call is discarded before inference. Spontaneous
participation stops in every channel, including for the owner, because it speaks to
the whole room rather than answering the owner. The command sets a global safety
override, and it is re-checked when a queued turn starts and again before the bot speaks, so
turns admitted in another channel before the toggle never land afterwards.

`restart runtime` is disabled by default. The desktop installer can enable it when
a numeric owner ID is present, but only do so behind WinSW, systemd, Docker, or
another supervisor. The command flushes state and audit logs, acknowledges the
request, and exits non-zero for the supervisor to relaunch. Restart never accepts
the username fallback. Control events are written without message bodies to a
rotating `logs/runtime-control.jsonl` audit log.

`kill discord` is also disabled by default. When explicitly enabled with
`JJ_RUNTIME_CONTROL_SHUTDOWN_ENABLED=true`, the exact command `@Bot kill discord`
(or `kill discord` in a DM) flushes state and logs, disconnects Discord, and exits
with code 0. The bundled supervisor treats that as an intentional stop and does
not relaunch the harness. Shutdown requires the configured numeric owner ID and
never accepts the username fallback.

### Discord connectivity watchdog

Discord.js normally reconnects on its own. An optional watchdog handles the case
where the process remains alive but the Discord client stays unavailable. It listens
for Discord connection events and performs a periodic readiness probe. After one
continuous grace period it flushes state and exits with the configured supervised
restart code. Repeated disconnect events do not extend the deadline.

Enable it only when an external supervisor will relaunch the process:

```dotenv
DISCORD_WATCHDOG_ENABLED=true
DISCORD_WATCHDOG_GRACE_SECONDS=90
DISCORD_WATCHDOG_CHECK_INTERVAL_SECONDS=15
```

For a local Windows deployment, stop the manually launched harness and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-supervised.ps1
```

Alternatively, double-click `start-supervised.bat` from Explorer. It invokes the
same PowerShell supervisor and keeps an error window open when supervision stops.
The launcher contains no machine-specific paths. If you use external environment
files, define `AI_WORKSPACE_SECRETS_ENV` and `AI_WORKSPACE_PROGRAMS_ENV` in the
launching account or service environment first; otherwise the harness uses its
Git-ignored `.env`.

The wrapper restarts only the intentional exit code `75` and stops after more than
five restart requests in ten minutes. Other exit codes remain visible instead of
being hidden in a crash loop.

On a VPS, use the host service manager. A minimal `systemd` service has the same
ownership boundary:

```ini
[Unit]
Description=Open Model Room Harness
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/opt/open-model-room-harness
EnvironmentFile=-/etc/open-model-room-harness/secrets.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Adjust the directory and executable path for the VPS. The watchdog state is exposed
by `get_discord_connection_status`, including the last connection event, outage
start time, and whether a restart has been requested.

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

If the main chat model is multimodal, set `vision.mode` to `native` and list its
exact model ID (plus the fallback model, when configured) in `vision.nativeModels`
or `JJ_VISION_NATIVE_MODELS`. The triggering message's images are then attached
directly within the same count and byte limits. Native mode is limited to
OpenAI-compatible providers (`nanogpt`, `openai`, `xai`, and `local`); unsupported
providers, escalations, and models outside the allowlist keep the sidecar path.

## X/Twitter link prefetch

When a message links to a public X/Twitter post, the harness downloads that post
before calling the model and attaches its text to the triggering message. The bot can
then comment on the post without deciding to call a tool, including on spontaneous
turns, so a link dropped into a room is never answered blind.

- Enabled by default; set `xPrefetch.enabled` (or `JJ_X_PREFETCH_ENABLED`) to `false`
  to turn it off, and tune `maxPosts` and `maxChars` to bound how much text is added.
- Works for any participant in a channel the bot already answers in. In direct
  messages it is restricted to the configured owner, so a stranger's DM cannot drive
  outbound requests.
- Only hosts on the `x.com`, `twitter.com`, `fxtwitter.com`, and `fixupx.com` allowlist
  are recognized, and only `/<handle>/status/<id>` paths. Links are parsed as URLs
  rather than pattern-matched, so a host that merely contains an allowed name is
  ignored.
- Post text is injected as untrusted data with an explicit instruction that it is never
  an instruction. A download failure is reported inside the block, so the model states
  it could not open the post instead of inventing its contents.
- A bare link does not expose `web_search` or `web_fetch`; those still require an
  explicit request from an authorized participant.

## Security model

- Prefer immutable Discord user IDs over usernames for every allowlist.
- Keep `JJ_TRIGGER_MODE=mention` to control spend and bot-to-bot loops.
- Configure `JJ_BOT_FILTER_MODE=allowlist` with `JJ_BOT_USER_IDS` to admit only
  specific bots, or use `blocklist` to admit every bot except those IDs. A
  permitted bot can address this bot with a Discord mention or its server display,
  global, or user name in plain text. Bot-authored messages remain excluded from
  spontaneous participation. `JJ_RESPOND_TO_BOTS` and `JJ_ALLOWED_BOT_USER_IDS`
  remain available for compatibility with older configurations.
- Keep `JJ_BOT_LOOP_GUARD_ENABLED=true` to cap consecutive qualifying bot turns
  per channel. The default admits five turns, then suppresses bot triggers for
  180 seconds; any human message in that channel resets the guard immediately.
- Web results, image text, and delegated output are untrusted.
- X/Twitter requests use FxTwitter's public third-party API. If FxTwitter search is
  unavailable, Yahoo Search HTML with DuckDuckGo failover discovers candidate post
  URLs and FxTwitter fetches only validated public post IDs. No official X or paid
  search API key is needed.
- Codex always receives a filtered environment. Normal delegations retain workspace
  boundaries; the separately configured YOLO route deliberately bypasses them.
- Generated media, logs, state, `.env`, and the private prompt are ignored.
- Rotate any credential that has ever appeared in Discord or Git history.

See [SECURITY.md](SECURITY.md) for operational guidance.

## Configuration

The installer writes the common settings. `.env.example` documents every supported
environment variable, including model routes, owner allowlists, rate limits,
timeouts, media limits, and spontaneous participation.

### Message timestamps

Context messages reach the model with the moment they were posted and their age at
that turn, and the system message states the current time:

```
[Discord message from Operator at 2026-08-01 13:48:00 Europe/Madrid (12m ago)]
```

The bot's own turns stay clean so it does not start writing timestamps itself, and
the system message marks the headers as metadata it must never echo. Set
`JJ_CONTEXT_TIMESTAMPS=false` to turn the feature off, and `JJ_TIME_ZONE` to any
IANA name (empty uses the host time zone). The installer asks for the time zone and
defaults to this machine's.

## Memory

**Disabled by default, and enabling it makes you a data controller for your server.**
Memory stores content distilled from a shared room, so read this whole section before
switching `memory.enabled` on.

Two independent switches:

1. `memory.enabled` — the store plus explicit owner commands. Nothing is captured
   unless somebody types a command.
2. `memory.extraction.enabled` — passive capture. When a channel has been idle for
   `idleMinutes`, one bounded model call turns that conversation into at most
   `maxFacts` short notes. The installer keeps this locked until switch 1 is on.

```text
@bot remember that we deploy on Fridays    → readable across the server
@bot remember only here: <text>            → that channel only
@bot remember privately: <text>            → owner turns only
@bot what do you remember                  → everything readable here, by person
@bot what do you remember about me         → only notes about you
@bot forget <id|words>                     @bot forget everything about me
@bot export my memory                      @bot memory off | memory on
@bot digest now                            → force a capture pass
```

Commands are matched before inference, so storing, listing and deleting never spend
provider credit. `npm run memory:panel` serves a loopback-only dashboard of everything
stored, with charts and a searchable table.

At reply time, readable notes are split into two labelled **user-role** blocks. A
stable core is ordered by recency, capped per subject, and placed before the live
conversation so its bytes remain cacheable between turns. Notes that do not fit the
core may enter a small focus tail after the conversation when they concern the
speaker, somebody present in the recent room history, or share meaningful terms
with the current message. The focus tail sharpens recall without invalidating the
cached core. Anything omitted from either block remains stored, and prompt-budget
evictions are logged; retrieval never deletes a note.

### What participants get

- **Opt-out** with `memory off`. It is honoured everywhere: nothing is stored about them,
  nothing about them is recalled, and passive capture skips their messages.
- **Inspection** with `what do you remember about me`, and **export** as a JSON file.
- **Deletion** of a single note or all of their notes, immediately.
- **Scoping**: every note is `room`, `guild` or `owner`. Notes never cross servers. The
  single exception is the owner's own DM, where they can review what the bot picked up in
  their own guilds.

### What you take on as the operator

- **Tell your members.** A bot that quietly remembers a room is a surprise nobody
  consented to. Say it has memory, what it keeps, and how to opt out.
- **Publish a privacy policy.** Discord's Developer Policy requires one, requires you to
  honour modification and deletion requests, and forbids using message content to train
  models. This harness trains on nothing, but answering those requests is your job.
- **Keep retention short.** The default is 90 days. Lower it unless you have a reason.
- **Consider leaving capture off.** Explicit commands deliver most of the value with no
  surprises; passive capture reads everyone in the channel.

### Privacy review

- **Storage**: append-only JSONL under `state/`, Git-ignored, self-compacting. Deleting a
  note drops it from the index and appends a tombstone; the next compaction removes it.
- **Retention**: enforced on load and on every write, plus a per-user cap that evicts the
  least significant notes first.
- **Guild removal**: leaving a server purges every note scoped to it, as the policy
  requires.
- **Audit**: every write, deletion, eviction and consent change is recorded in
  `logs/memory-events.jsonl` **without message bodies**.
- **Injection surface**: notes are flattened to a single line with brackets neutralised,
  so a stored note cannot forge an application header; they are delivered as a user turn,
  never in the system message; they never authorise a tool. Extractor output is
  schema-validated, and unknown subjects, oversized text, links and anything shaped like
  an instruction are discarded. Malformed model output stores nothing.
- **Abstention**: when nothing is stored, the block explicitly tells the model to say it
  does not remember rather than invent a recollection.

## Tests

```bash
npm run check
npm run scan:secrets
npm test
```

CI runs syntax checks and the full test suite on Node.js 20, 22, and 24.

## Contributors

- [Ramón Martínez](https://github.com/ajaniramon) — project creator and maintainer.
- [reppie1986](https://github.com/reppie1986) — contributed the MCP runtime controls,
  scoped Discord actions, and the original ChatGPT relay foundation.
- **Codex (OpenAI)** — implemented and verified this fork's upstream reconciliation
  and public-release cleanup.

## License

[MIT](LICENSE)
