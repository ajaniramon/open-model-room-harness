# Chat Relay Wake Prototype

A small, build-free Manifest V3 extension that wakes one configured ChatGPT task when an external harness reports pending relay work.

This is intentionally a wake mechanism, not another relay implementation. The harness remains responsible for durable queueing, leases, retries, Discord context, and reply delivery. ChatGPT remains responsible for claiming and completing relay items through its existing MCP connector.

## Flow

```text
Discord message
  -> harness durable relay queue
  -> authenticated wake-status endpoint
  -> extension sees pendingCount > 0
  -> configured ChatGPT task receives the wake prompt
  -> ChatGPT uses MCP to claim, inspect, and complete relay items
  -> harness sends the response to Discord
```

## Load the prototype

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this folder.
5. Open the extension settings and configure the harness URL, dedicated wake status token, and exact ChatGPT task URL.

No `npm install` or build step is required.

Optional validation uses only Node's built-in test runner:

```powershell
npm run check
npm test
```

## Safety behavior

- Disabled by default.
- Targets one exact ChatGPT task URL.
- Refuses to overwrite an unsent draft.
- Defers while ChatGPT is already responding.
- Uses a configurable cooldown after successful wakeups.
- Applies a configurable progressive backoff while the same oldest relay item remains unresolved.
- Continues lightweight harness status checks during backoff without submitting ChatGPT prompts.
- Does not read ChatGPT responses, Discord messages, or MCP results.
- Does not claim relay work itself.
- Requests access to non-local harness origins only when the user saves that origin.
- Sends credentials only to HTTPS origins, except for local loopback development.

## Harness contract

The extension sends an authenticated `GET` request to the configured status URL. It expects:

```json
{
  "enabled": true,
  "pendingCount": 1,
  "leasedCount": 1,
  "activeCount": 2,
  "pendingKey": "item-124",
  "activeKey": "item-123,item-124",
  "oldestPendingId": "item-124",
  "oldestActiveId": "item-123"
}
```

The IDs are opaque. Active counts include both pending and leased items so claiming
work does not reset the unresolved-item circuit. The endpoint accepts only the
dedicated `MCP_CONTROL_WAKE_TOKEN`; it does not accept the privileged MCP bearer
token and never exposes Discord content.

## Unresolved-item circuit breaker

After a successful wake, the extension waits for the first configured backoff
period. If the same oldest relay item is still pending when that period ends, it
wakes ChatGPT once more and advances to the next period. The default schedule is
5, 15, 30, then 60 minutes; the final value is reused for later attempts.

The breaker resets as soon as the queue empties or a different item becomes the
oldest active item. A leased item remains active, so a worker crash cannot reset
the breaker before its lease expires. The popup shows the unresolved wake count and retry time.
`Save and force check` in settings is the explicit manual override.

This is outcome-based and deliberately does not scrape ChatGPT output for usage-limit
messages. Polling the small status endpoint continues while prompt submission is
paused. Configure relay retention to outlast the longest expected pause; for an
unattended deployment, `CHAT_RELAY_TTL_SECONDS=86400` is a practical starting point.

## Deliberate omissions

- No Discord client or second event queue.
- No hardcoded companion, guild, channel, or scope names.
- No reverse-engineered ChatGPT API calls.
- No personality or system prompt.
- No automatic tab activation.

This prototype uses DOM interaction only for the missing wake step. Once awake, the normal ChatGPT connector and harness relay tools take over.
