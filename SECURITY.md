# Security

## Secrets

Never commit `.env`, `src/system-prompt.txt`, logs, generated media, or
state files. The installer writes `.env` with owner-only permissions where the
platform supports them, and `.gitignore` excludes all runtime-sensitive paths.

Rotate a credential immediately if it is ever posted to Discord, included in a
commit, or exposed in logs.

## Tool authorization

Paid and local capabilities are restricted by Discord user ID or exact username.
User IDs are strongly preferred because usernames can change. Keep bot responses
in mention mode unless you intentionally want every channel message to trigger a
model request.

Codex delegation can modify files. Review its workspace settings before enabling
it, keep the owner allowlist narrow, and do not run the bot with unnecessary OS
privileges.

## Local model endpoints

Treat a local OpenAI-compatible endpoint as privileged infrastructure. Prefer a
loopback address, enable an API key if the server is reachable from a LAN, and
never expose an unauthenticated llama.cpp or vLLM server directly to the public
internet. Discord context and any enabled tool results are sent to the selected
endpoint.

The harness omits the Authorization header when `LOCAL_API_KEY` is empty and
uses the minimal Chat Completions payload for compatibility. Tool calling still
depends on the served model, chat template, and backend build supporting the
OpenAI function-tools contract.

## Reporting a vulnerability

Please open a private GitHub security advisory instead of a public issue.
