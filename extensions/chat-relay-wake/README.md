# Chat Relay Wake Prototype

A small, build-free Manifest V3 extension that routes Discord relay and autonomous work to separate ChatGPT tasks. It can also attest real user submissions in one exact owner task without exposing broker signing material to ChatGPT.

This is intentionally a wake mechanism, not another relay implementation. The harness remains responsible for durable queueing, leases, retries, Discord context, and reply delivery. ChatGPT remains responsible for claiming and completing relay items through its existing MCP connector.

## Flow

```text
Discord message
  -> harness durable relay queue
  -> authenticated wake-status endpoint
  -> extension sees pendingCount > 0
  -> configured ChatGPT task receives the wake prompt
  -> ChatGPT peeks, claims the exact opaque ID, and completes that relay item
  -> harness sends the response to Discord
```

## Load the prototype

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this folder.
5. Open the extension settings and configure the harness URL, dedicated wake status token, and exact Discord relay task URL.
6. Optionally configure a separate autonomous task URL.
7. To attest manual owner turns, configure the exact owner task URL, broker URL, and dedicated direct-ChatGPT ingress token.

No `npm install` or build step is required.

Optional validation uses only Node's built-in test runner:

```powershell
npm run check
npm test
```

## Safety behavior

- Disabled by default.
- Routes relay and autonomous queue kinds to separate exact ChatGPT task URLs.
- Can check a fast lane for direct priority relay items on the configured task
  heartbeat without exposing content or bypassing exact item claims.
- Attests owner authority only for trusted click/Enter submissions on one exact owner task URL.
- Keeps the direct ingress token in extension storage and sends only an opaque event reference into ChatGPT.
- Automated wake submissions cannot call the direct-owner attestation path.
- Refuses to overwrite an unsent draft.
- Defers while ChatGPT is already responding.
- Uses a configurable cooldown after successful wakeups.
- Can restrict automatic wakeups to configured-owner DMs. This uses the
  harness's immutable Discord owner-ID authorization and leaves public relay
  items queued without waking ChatGPT for them.
- Applies a configurable progressive backoff while the same oldest relay item remains unresolved.
- Continues lightweight harness status checks during backoff without submitting ChatGPT prompts.
- Provides an authenticated operator-only queue flush control for clearing wedged
  relay backlog without sending, editing, or deleting Discord messages.
- Defers wake submission while ChatGPT exposes a generating/streaming state. If a
  worker still loses an exact-item claim race, its contract permits one fresh
  peek so it can claim different pending work instead of processing stale data.
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
  "directPendingCount": 0,
  "spontaneousPendingCount": 1,
  "autonomousPendingCount": 0,
  "fastLanePendingCount": 0,
  "fastLaneActiveCount": 0,
  "leasedCount": 1,
  "activeCount": 2,
  "pendingKey": "item-124",
  "activeKey": "item-123,item-124",
  "oldestPendingId": "item-124",
  "oldestPendingKind": "spontaneous",
  "oldestActiveId": "item-123",
  "fastLanePendingKey": "",
  "fastLaneActiveKey": "",
  "oldestFastLanePendingId": null,
  "oldestFastLanePendingKind": null,
  "oldestFastLaneActiveId": null
}
```

The kind fields contain counts and `direct`/`spontaneous`/`autonomous` only. They select a
distinct operator-configurable wake prompt without exposing Discord message content.
Older harness responses without kind fields remain compatible and are treated as direct
relay work.

Fast-lane fields name only direct priority work. They are empty when the oldest
normal-lane item is spontaneous, autonomous, or ordinary background work.

`owner-heartbeat` items are reported as `autonomous` and routed to the autonomous
task. The harness creates their authority through its autonomous broker ingress;
the browser extension never receives the autonomous ingress token.

## Direct owner attestation

When enabled, the content script intercepts only a real user click or Enter press
on the exact configured owner conversation. The service worker hashes the original
message and exchanges the dedicated direct-ingress token for an opaque event
reference. That reference is appended to the submitted turn. Filesystem and
execution gateways resolve it directly with the broker and never expose signed
grants to the browser or model.

The owner, relay, and autonomous conversation URLs should be distinct. Relay wake
automation never targets the owner conversation, and synthetic clicks cannot invoke
the trusted-submission handler.

The IDs are opaque. Active counts include both pending and leased items so claiming
work does not reset the unresolved-item circuit. The endpoint accepts only the
dedicated `MCP_CONTROL_WAKE_TOKEN`; it does not accept the privileged MCP bearer
token and never exposes Discord content.

When owner-only mode is enabled, the extension adds `ownerOnly=true` to this
authenticated request. The harness filters the returned queue metadata to relay
items that were assigned owner priority only after an owner-ID-authorized DM.
The extension then asks ChatGPT to claim that exact opaque ID; it never trusts a
Discord display name or username for owner classification.

## Unresolved-item circuit breaker

After a successful wake, the extension waits for the first configured backoff
period. If the same oldest relay item is still pending when that period ends, it
wakes ChatGPT once more and advances to the next period. The default schedule is
5, 15, 30, then 60 minutes; the final value is reused for later attempts.

The wake cooldown applies only while retrying that same unresolved item. A newly
arrived oldest item is eligible on the next poll instead of inheriting the previous
item's cooldown.

The breaker resets as soon as the queue empties or a different item becomes the
oldest active item. A leased item remains active, so a worker crash cannot reset
the breaker before its lease expires. The popup shows the unresolved wake count and retry time.
`Save and force check` in settings is the explicit manual override.

The configured ChatGPT task tab also sends a lightweight heartbeat every 15 seconds.
When the selected poll interval is due, that heartbeat wakes the service worker to
check the harness. Chrome alarms remain as a fallback because Manifest V3 may defer
them for several minutes. The popup's `Last trigger` field identifies whether the
latest check came from `heartbeat`, `alarm`, `manual`, or `force`.

When fast-lane wakeups are enabled, the same tab heartbeat can check more often for
direct priority relay work such as owner or human fastpass items. Fast-lane checks
ignore spontaneous, autonomous, and ordinary bot/system work, use their own
unresolved-item circuit state, and still wake ChatGPT with one exact opaque relay
ID to claim. They reduce direct-response latency without bypassing the normal
claim, lease, and completion contract.

This is outcome-based and deliberately does not scrape ChatGPT output for usage-limit
messages. Polling the small status endpoint continues while prompt submission is
paused. Configure relay retention to outlast the longest expected pause; for an
unattended deployment, `CHAT_RELAY_TTL_SECONDS=86400` is a practical starting point.

## Queue flush

The settings page can call `POST /api/chat-relay/flush` using the same dedicated
wake token as the status endpoint. This removes internal pending relay work when
the queue is jammed by stale items or platform/tool failures. Leased in-progress
items are preserved unless the emergency `Flush leased/in-progress relay items too`
checkbox is selected.

The flush endpoint affects only the harness relay queue. It does not send, edit,
or delete Discord messages, and it does not expose Discord message content to the
extension.

## Deliberate omissions

- No Discord client or second event queue.
- No hardcoded companion, guild, channel, or scope names.
- No reverse-engineered ChatGPT API calls.
- No personality or system prompt.
- No automatic tab activation.

This prototype uses DOM interaction only for the missing wake step. Once awake, the normal ChatGPT connector and harness relay tools take over.

Every injected wake prompt includes a worker contract that makes the claimed Discord
item authoritative for the current Discord event and tells ChatGPT not to answer
unrelated history in the persistent task. Configured ChatGPT identity, persistent
memory, and general knowledge remain valid background for answering that event.
In the normal queue view it first uses the metadata-only `peek_chat_relay_item`,
then atomically claims that exact ID with `claim_chat_relay_item`. In owner-only
mode, the authenticated status endpoint has already selected the owner DM, so the
wake prompt claims that exact opaque ID directly and refuses to fall through to
another queue item. The authoritative conversation payload is returned only after
a successful lease. Explicit `claimed`, `already_claimed`, `not_pending`, and
empty-peek states keep queue state observable without processing unleased work.
No-reply decisions use `complete_chat_relay_without_reply` rather than the legacy
dismissal tool.
