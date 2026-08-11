import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { collectRelayImageAttachments, publicRelayImageAttachment } from "./chat-relay-attachments.js";

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

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export class ChatRelayQueue {
  constructor({
    enabled = false,
    statePath = null,
    ttlMs = 10 * 60_000,
    maxItems = 50,
    maxContextChars = 12_000,
    leaseSeconds = 120,
    maxAttempts = 3,
    maxImageAttachments = 4,
    now = Date.now,
    logger = console,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    deliveryHandlers = null,
  } = {}) {
    this.enabled = enabled === true;
    this.statePath = statePath;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10 * 60_000);
    this.maxItems = Math.max(1, Math.min(Number(maxItems) || 50, 500));
    this.maxContextChars = Math.max(500, Math.min(Number(maxContextChars) || 12_000, 100_000));
    this.leaseSeconds = Math.max(10, Math.min(Number(leaseSeconds) || 120, 3_600));
    this.maxAttempts = Math.max(1, Math.min(Number(maxAttempts) || 3, 20));
    const requestedImageLimit = Number(maxImageAttachments);
    this.maxImageAttachments = Math.max(0, Math.min(Number.isFinite(requestedImageLimit) ? requestedImageLimit : 4, 10));
    this.now = now;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.items = new Map();
    this.persisting = Promise.resolve();
    this.deliveryHandlers = deliveryHandlers || {};
  }

  async load() {
    if (!this.enabled || !this.statePath) return this;
    try {
      const payload = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const raw of Array.isArray(payload.items) ? payload.items : []) {
        if (!raw?.id || !raw.expiresAt || Date.parse(raw.expiresAt) <= this.now()) continue;
        if (!["pending", "leased"].includes(raw.status || "pending")) continue;
        // A process restart invalidates in-flight ownership. Requeue rather than
        // leaving the item stuck behind a worker that no longer exists.
        this.items.set(raw.id, {
          ...raw,
          status: "pending",
          leaseToken: null,
          leaseUntil: null,
          imageAttachments: Array.isArray(raw.imageAttachments) ? raw.imageAttachments.slice(0, this.maxImageAttachments) : [],
          onReply: null,
          onDismiss: null,
        });
      }
      this.sweep();
      await this.#persist();
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.logger?.error?.("Could not load chat relay state", error);
      }
    }
    return this;
  }

  setDeliveryHandlers(deliveryHandlers = {}) {
    this.deliveryHandlers = { ...this.deliveryHandlers, ...deliveryHandlers };
    return this;
  }

  async flush() {
    await this.persisting;
  }

  get size() {
    this.sweep();
    return [...this.items.values()].filter((item) => ["pending", "leased"].includes(item.status)).length;
  }

  get leasedSize() {
    this.sweep();
    return [...this.items.values()].filter((item) => item.status === "leased").length;
  }

  oldestPendingAgeSeconds() {
    this.sweep();
    const oldest = this.#activeItems().find((item) => item.status === "pending");
    return oldest ? Math.max(0, Math.floor((this.now() - Date.parse(oldest.createdAt)) / 1_000)) : null;
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
    const duplicate = [...this.items.values()].find(
      (item) => item.messageId && item.messageId === (message.id || null) && item.status === "pending",
    );
    if (duplicate) return duplicate.id;
    const id = createRelayId();
    const createdAtMs = this.now();
    const item = {
      id,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      status: "pending",
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
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
      imageAttachments: collectRelayImageAttachments(message, this.maxImageAttachments),
      context: compactContext(context || [], this.maxContextChars),
      onReply,
      onDismiss,
    };
    this.items.set(id, item);
    item.expiryTimer = this.setTimer(() => {
      void this.#expire(item);
    }, this.ttlMs);
    item.expiryTimer?.unref?.();
    while (this.#activeItems().length > this.maxItems) {
      const oldest = this.#activeItems()[0];
      this.#remove(oldest);
      void this.#notifyDismiss(oldest, "evicted");
    }
    void this.#persist().catch((error) => this.logger?.error?.("Could not persist chat relay enqueue", error));
    return id;
  }

  pending({ includeContext = false } = {}) {
    this.sweep();
    return this.#activeItems()
      .filter((item) => item.status === "pending")
      .map((item) => this.#publicItem(item, { includeContext }));
  }

  wakeStatus() {
    this.sweep();
    const active = this.#activeItems();
    const pending = active.filter((item) => item.status === "pending");
    const leased = active.filter((item) => item.status === "leased");
    return {
      pendingCount: pending.length,
      leasedCount: leased.length,
      activeCount: active.length,
      pendingKey: pending.map((item) => item.id).join(","),
      activeKey: active.map((item) => item.id).join(","),
      oldestPendingId: pending[0]?.id || null,
      oldestActiveId: active[0]?.id || null,
    };
  }

  get(id, { includeContext = true } = {}) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    return item && ["pending", "leased"].includes(item.status)
      ? this.#publicItem(item, { includeContext })
      : null;
  }

  getImageAttachment(id, index) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) return null;
    const attachmentIndex = Number(index);
    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) return null;
    return item.imageAttachments?.[attachmentIndex] || null;
  }

  async claim({ workerId = "worker", limit = 3, leaseSeconds = this.leaseSeconds, includeContext = true } = {}) {
    this.sweep();
    const count = Math.max(1, Math.min(Number(limit) || 3, 50));
    const duration = Math.max(10, Math.min(Number(leaseSeconds) || this.leaseSeconds, 3_600));
    const leaseUntil = new Date(this.now() + duration * 1_000).toISOString();
    const claimed = [];
    for (const item of this.#activeItems().filter((candidate) => candidate.status === "pending").slice(0, count)) {
      item.status = "leased";
      item.attempts += 1;
      item.leaseToken = `${workerId}:${randomUUID()}`;
      item.leaseUntil = leaseUntil;
      claimed.push(this.#publicItem(item, { includeContext, includeLease: true }));
    }
    await this.#persist();
    return claimed;
  }

  async renewLease(id, leaseToken, leaseSeconds = this.leaseSeconds) {
    const item = this.#ownedItem(id, leaseToken);
    if (!item) return { ok: false, error: "Relay item is not leased by this worker." };
    item.leaseUntil = new Date(this.now() + Math.max(10, Number(leaseSeconds) || this.leaseSeconds) * 1_000).toISOString();
    await this.#persist();
    return { ok: true, id: item.id, leaseUntil: item.leaseUntil };
  }

  async submit(id, reply, leaseToken = null) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) {
      return { ok: false, error: "Relay item was not found or expired." };
    }
    if (item.status === "leased" && item.leaseToken !== leaseToken) {
      return { ok: false, error: "Relay item is leased by another worker." };
    }
    const content = String(reply || "").trim();
    if (!content) return { ok: false, error: "Reply must not be empty." };
    if (content.length > 8_000) return { ok: false, error: "Reply is too long." };
    if (item.status === "pending") item.attempts += 1;
    this.#remove(item);
    try {
      if (typeof item.onReply === "function") await item.onReply(content);
      else if (typeof this.deliveryHandlers.onReply === "function") await this.deliveryHandlers.onReply(item, content);
      else throw new Error("Relay item has no reply handler.");
    } catch (error) {
      if (item.attempts < this.maxAttempts) {
        item.status = "pending";
        item.leaseToken = null;
        item.leaseUntil = null;
        this.items.set(item.id, item);
        item.expiryTimer = this.setTimer(() => void this.#expire(item), Math.max(1_000, Date.parse(item.expiresAt) - this.now()));
        item.expiryTimer?.unref?.();
        await this.#persist();
      } else {
        await this.#notifyDismiss(item, "reply_failed");
        await this.#persist();
      }
      this.logger?.error?.("Chat relay reply delivery failed", error);
      return { ok: false, error: "Relay reply could not be delivered." };
    }
    await this.#persist();
    return { ok: true, id: item.id, channelId: item.channelId, messageId: item.messageId };
  }

  async dismiss(id, reason = "", leaseToken = null) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) {
      return { ok: false, error: "Relay item was not found or expired." };
    }
    if (item.status === "leased" && item.leaseToken !== leaseToken) {
      return { ok: false, error: "Relay item is leased by another worker." };
    }
    this.#remove(item);
    await this.#notifyDismiss(item, String(reason || "").slice(0, 500));
    await this.#persist();
    return { ok: true, id: item.id };
  }

  sweep() {
    const now = this.now();
    for (const item of [...this.items.values()]) {
      if (Date.parse(item.expiresAt) <= now) void this.#expire(item);
      else if (item.status === "leased" && Date.parse(item.leaseUntil || 0) <= now) {
        item.status = "pending";
        item.leaseToken = null;
        item.leaseUntil = null;
        void this.#persist();
      }
    }
  }

  async #expire(item) {
    if (!this.items.has(item.id)) return;
    this.#remove(item);
    await this.#notifyDismiss(item, "expired");
    await this.#persist();
  }

  #activeItems() {
    return [...this.items.values()].filter((item) => ["pending", "leased"].includes(item.status));
  }

  #ownedItem(id, leaseToken) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    return item?.status === "leased" && item.leaseToken === leaseToken ? item : null;
  }

  #remove(item) {
    if (!item || !this.items.delete(item.id)) return false;
    this.clearTimer(item.expiryTimer);
    return true;
  }

  async #notifyDismiss(item, reason) {
    try {
      if (typeof item.onDismiss === "function") await item.onDismiss(reason);
      else await this.deliveryHandlers.onDismiss?.(item, reason);
    } catch (error) {
      this.logger?.error?.(`Chat relay dismissal failed reason=${reason}`, error);
    }
  }

  #publicItem(item, { includeContext, includeLease = false }) {
    return {
      id: item.id,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      status: item.status,
      attempts: item.attempts,
      leaseUntil: item.leaseUntil,
      ...(includeLease ? { leaseToken: item.leaseToken } : {}),
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
      imageAttachments: (item.imageAttachments || []).map(publicRelayImageAttachment),
      ...(includeContext ? { context: item.context } : {}),
    };
  }

  #persist() {
    if (!this.statePath) return Promise.resolve();
    const snapshot = {
      items: [...this.items.values()].map(({ expiryTimer, onReply, onDismiss, ...item }) => item),
    };
    this.persisting = this.persisting
      .catch(() => undefined)
      .then(() => atomicWrite(this.statePath, snapshot));
    return this.persisting;
  }
}
