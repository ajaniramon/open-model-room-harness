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
5. Open the extension settings and configure the harness URL, bearer token, and exact ChatGPT task URL.

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
- Does not read ChatGPT responses, Discord messages, or MCP results.
- Does not claim relay work itself.
- Requests access to non-local harness origins only when the user saves that origin.

## Harness contract

The extension sends an authenticated `GET` request to the configured status URL. It expects:

```json
{
  "enabled": true,
  "pendingCount": 2,
  "pendingKey": "item-123,item-124"
}
```

`pendingKey` is optional diagnostic/deduplication metadata. It should be derived from opaque relay item IDs and must not include message content.

The current harness already authenticates HTTP requests before routing them. A minimal route inside `startMcpControlServer` can therefore be:

```js
if (req.method === "GET" && path === "/api/chat-relay/wake-status") {
  const pending = chatRelay?.pending?.({ includeContext: false }) || [];
  sendJson(res, 200, {
    enabled: Boolean(chatRelay?.enabled ?? chatRelay),
    pendingCount: pending.length,
    pendingKey: pending.map((item) => item.id).join(","),
  });
  return;
}
```

The endpoint should remain behind the same bearer-token check as MCP. It exposes counts and opaque IDs only, never Discord content.

## Deliberate omissions

- No Discord client or second event queue.
- No hardcoded companion, guild, channel, or scope names.
- No reverse-engineered ChatGPT API calls.
- No personality or system prompt.
- No automatic tab activation.

This prototype uses DOM interaction only for the missing wake step. Once awake, the normal ChatGPT connector and harness relay tools take over.
