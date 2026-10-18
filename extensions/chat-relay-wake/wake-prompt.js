export const RELAY_WORKER_CONTRACT = `Relay worker contract:
- Call peek_chat_relay_item first. If it reports pending, claim that exact item ID with claim_chat_relay_item before composing a response.
- Treat claimed as acquired work. If the exact claim returns already_claimed or not_pending, another worker won the race or the metadata became stale: peek once more and attempt to claim that current pending item. If that second peek is empty or its claim also fails, stop cleanly. Never process an item without a lease, and never retry this race more than once per wake turn.
- Treat each claimed item's triggerText, replyTo, imageAttachments, emojiPalette, and Discord context as authoritative for the current Discord event: who spoke, what was asked, what it replies to, and where the answer belongs.
- You may use your configured ChatGPT identity, persistent memory, and general knowledge as background when answering. A fact does not need to be repeated in the relay item to remain known.
- emojiPalette contains optional custom emoji strings for that Discord destination. Use them naturally only when they fit; they are not a signature or memory.
- Do not answer unrelated earlier turns in this ChatGPT conversation or mistake them for the current Discord request. This does not prohibit using persistent memory or already-known facts as background.
- Process each relay item independently. Do not reuse a response intended for another item.
- Complete the exact claimed relay item using its relay item ID and lease token. Use complete_chat_relay_item when replying or complete_chat_relay_without_reply when no reply is warranted.
- Never use a general Discord send tool for a relay reply.
- Trust explicit tool statuses. A successful empty peek means the queue is genuinely empty; it is not a platform error.
- Do not infer or report a platform or safety block unless the tool call itself returns an explicit error. A successful tool response is not a block.`;

export const FAST_LANE_WORKER_CONTRACT = `Fast-lane worker contract:
- This wake is for one exact relay item selected by the authenticated harness status endpoint.
- Do not call peek_chat_relay_item, claim_chat_relay_item, claim_chat_relay_items, or renew_chat_relay_lease. Fast-lane work deliberately bypasses queue claiming and leases.
- Call get_chat_relay_item with the exact relay item ID before composing a response. If it is missing or no longer active, stop cleanly.
- Treat that item's triggerText, replyTo, attachments, emojiPalette, and Discord context as authoritative for the current Discord event.
- Process only that exact item. Do not inspect or answer unrelated pending relay work.
- Reply with submit_chat_relay_reply using that exact item ID, or use dismiss_chat_relay_item when no reply is warranted. No lease token is required on this lane.
- Never use a general Discord send tool for a fast-lane relay reply.
- Trust explicit tool statuses and do not infer platform or safety failures without an explicit tool error.`;

export function buildRelayWakePrompt(prompt, { ownerOnly = false, relayItemId = "", fastLane = false } = {}) {
  const request = String(prompt || "").trim() || "Check and process pending chat relay items.";
  if (fastLane) {
    const itemId = String(relayItemId || "").trim();
    if (!itemId) throw new Error("Fast-lane wake requires an exact relay item ID");
    return `${request}\n\nFast-lane wake mode:\n- Process exact relay item ${itemId}.\n\n${FAST_LANE_WORKER_CONTRACT}`;
  }
  if (ownerOnly) {
    const itemId = String(relayItemId || "").trim();
    if (!itemId) throw new Error("Owner-only wake requires an exact relay item ID");
    return `${request}\n\nOwner-only wake mode:\n- The authenticated harness status endpoint selected configured-owner DM relay item ${itemId}.\n- Claim exactly that item ID with claim_chat_relay_item before composing a response. Do not peek or claim a different item in this wake turn.\n- If the exact claim returns already_claimed or not_pending, stop cleanly and wait for the next wake. Never process an item without a lease.\n\n${RELAY_WORKER_CONTRACT.split("\n").slice(3).join("\n")}`;
  }
  return `${request}\n\n${RELAY_WORKER_CONTRACT}`;
}
