import { randomBytes } from "node:crypto";

function createRelayId() {
  return `relay_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function compactContext(messages, maxChars) {
  const shaped = [];
  let total = 0;
  for (const message of messages.slice(-20)) {
    const content = String(message.content || "");
    const remaining = Math.max(0, maxChars - total);
    if (!remaining) break;
    const clipped = content.length > remaining ? `${content.slice(0, remaining - 1)}…` : content;
    shaped.push({ role: message.role, content: clipped });
    total += clipped.length;
  }
  return shaped;
}

export class ChatRelayQueue {
  constructor({
    enabled = false,
    ttlMs = 10 * 60_000,
    maxItems = 50,
    maxContextChars = 12_000,
    now = Date.now,
    logger = console,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.enabled = enabled === true;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10 * 60_000);
    this.maxItems = Math.max(1, Math.min(Number(maxItems) || 50, 500));
    this.maxContextChars = Math.max(500, Math.min(Number(maxContextChars) || 12_000, 100_000));
    this.now = now;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.items = new Map();
  }

  get size() {
    this.sweep();
    return this.items.size;
  }

  enqueue({
    message,
    context,
    kind = "direct",
    directResponse = true,
    spontaneous = false,
    audioEnabled = false,
    onReply,
    onDismiss,
  }) {
    if (!this.enabled) return null;
    this.sweep();
    const id = createRelayId();
    const createdAtMs = this.now();
    const item = {
      id,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      kind,
      directResponse: directResponse === true,
      spontaneous: spontaneous === true,
      audioEnabled: audioEnabled === true,
      guildId: message.guildId || null,
      guildName: message.guild?.name || null,
      channelId: message.channelId || null,
      channelName: message.channel?.name || null,
      messageId: message.id || null,
      scope: message.guildId ? "guild" : "dm",
      isDM: !message.guildId,
      author: {
        id: String(message.author?.id || ""),
        username: String(message.author?.username || ""),
        displayName:
          message.member?.displayName ||
          message.author?.globalName ||
          message.author?.username ||
          "",
      },
      triggerText: String(message.content || "").slice(0, 2_000),
      context: compactContext(context || [], this.maxContextChars),
      onReply,
      onDismiss,
    };
    this.items.set(id, item);
    item.expiryTimer = this.setTimer(() => {
      if (!this.#remove(item)) return;
      void this.#notifyDismiss(item, "expired");
    }, this.ttlMs);
    item.expiryTimer?.unref?.();
    while (this.items.size > this.maxItems) {
      const oldest = this.items.get(this.items.keys().next().value);
      this.#remove(oldest);
      void this.#notifyDismiss(oldest, "evicted");
    }
    return id;
  }

  pending({ includeContext = false } = {}) {
    this.sweep();
    return [...this.items.values()].map((item) => this.#publicItem(item, { includeContext }));
  }

  get(id, { includeContext = true } = {}) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    return item ? this.#publicItem(item, { includeContext }) : null;
  }

  async submit(id, reply) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item) return { ok: false, error: "Relay item was not found or expired." };
    const content = String(reply || "").trim();
    if (!content) return { ok: false, error: "Reply must not be empty." };
    if (content.length > 8_000) return { ok: false, error: "Reply is too long." };
    this.#remove(item);
    try {
      if (typeof item.onReply !== "function") {
        throw new Error("Relay item has no reply handler.");
      }
      await item.onReply(content);
    } catch (error) {
      await this.#notifyDismiss(item, "reply_failed");
      this.logger?.error?.("Chat relay reply delivery failed", error);
      return { ok: false, error: "Relay reply could not be delivered." };
    }
    return { ok: true, id: item.id, channelId: item.channelId, messageId: item.messageId };
  }

  async dismiss(id, reason = "") {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item) return { ok: false, error: "Relay item was not found or expired." };
    this.#remove(item);
    await this.#notifyDismiss(item, String(reason || "").slice(0, 500));
    return { ok: true, id: item.id };
  }

  sweep() {
    const now = this.now();
    for (const item of this.items.values()) {
      if (Date.parse(item.expiresAt) <= now) {
        this.#remove(item);
        void this.#notifyDismiss(item, "expired");
      }
    }
  }

  #remove(item) {
    if (!item || !this.items.delete(item.id)) return false;
    this.clearTimer(item.expiryTimer);
    return true;
  }

  async #notifyDismiss(item, reason) {
    try {
      await item.onDismiss?.(reason);
    } catch (error) {
      this.logger?.error?.(`Chat relay dismissal failed reason=${reason}`, error);
    }
  }

  #publicItem(item, { includeContext }) {
    return {
      id: item.id,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      kind: item.kind,
      directResponse: item.directResponse,
      spontaneous: item.spontaneous,
      audioEnabled: item.audioEnabled,
      guildId: item.guildId,
      guildName: item.guildName,
      channelId: item.channelId,
      channelName: item.channelName,
      messageId: item.messageId,
      scope: item.scope,
      isDM: item.isDM,
      author: item.author,
      triggerText: item.triggerText,
      ...(includeContext ? { context: item.context } : {}),
    };
  }
}
