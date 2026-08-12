export const RELAY_WORKER_CONTRACT = `Relay worker contract:
- Claim pending work before composing a response.
- Treat each claimed item's triggerText, replyTo, imageAttachments, and Discord context as the authoritative conversation.
- Ignore unrelated earlier turns in this ChatGPT conversation, including unanswered questions and prior topics.
- Process each relay item independently. Do not reuse a response intended for another item.
- Complete or dismiss the exact claimed relay item using its relay item ID and lease token.
- Never use a general Discord send tool for a relay reply.`;

export function buildRelayWakePrompt(prompt) {
  const request = String(prompt || "").trim() || "Check and process pending chat relay items.";
  return `${request}\n\n${RELAY_WORKER_CONTRACT}`;
}
