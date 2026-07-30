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

## Reporting a vulnerability

Please open a private GitHub security advisory instead of a public issue.
