import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  collectRelayImageAttachments,
  collectRelayAudioAttachments,
  collectRelayTextAttachments,
  publicRelayImageAttachment,
  publicRelayAudioAttachment,
  publicRelayTextAttachment,
} from "./chat-relay-attachments.js";

function createRelayId() {
  return `relay_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function compactIdentity(identity) {
  if (!identity) return null;
  return {
    id: String(identity.id || ""),
    username: String(identity.username || "").slice(0, 100),
    displayName: String(identity.displayName || "").slice(0, 100),
    bot: identity.bot === true,
  };
}

function compactEmojiPalette(emojis = []) {
  return (Array.isArray(emojis) ? emojis : [])
    .map((emoji) => String(emoji || "").replace(/\s+/g, " ").trim())
    .filter((emoji) => emoji.length >= 2 && emoji.length <= 120)
    .slice(0, 8);
}

function normalizedTriggerText(message, deliveryIdentity) {
  const identity = compactIdentity(deliveryIdentity);
  let content = String(message.content || "");
  if (identity?.id) {
    const escapedId = identity.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const label = `@${identity.displayName || identity.username || "assistant"}`;
    content = content.replace(new RegExp(`<@!?${escapedId}>`, "g"), label);
  }
  return content.slice(0, 2_000);
}

function compactContext(messages, maxChars, deliveryIdentity = null) {
  // Fill newest-first so the turns immediately before the trigger survive tight budgets.
  const window = messages.slice(-20);
  const shaped = [];
  let total = 0;
  let dropped = false;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message.role === "system") continue;
    const rawContent = String(message.content || "");
    const deliveryName = deliveryIdentity?.displayName || deliveryIdentity?.username || "the Discord delivery bot";
    const content = message.role === "assistant"
      ? `[Earlier Discord message authored by ${deliveryName} (delivery bot account, not the external ChatGPT worker)]\n${rawContent}`
      : rawContent;
    const remaining = Math.max(0, maxChars - total);
    if (!remaining) {
      dropped = true;
      break;
    }
    const clipped = content.length > remaining ? `${content.slice(0, remaining - 1)}…` : content;
    // Relay context is Discord observational data. Preserving the harness's model roles
    // would make an external worker interpret delivery-bot messages as its own speech.
    shaped.push({ role: "user", content: clipped });
    total += clipped.length;
    if (clipped.length < content.length) dropped = true;
  }
  shaped.reverse();
  return { context: shaped, truncated: dropped };
}

function compactReplyTo(replyTo) {
  const messageId = String(replyTo?.messageId || "");
  if (!messageId) return null;
  const author = replyTo?.author;
  return {
    messageId,
    channelId: String(replyTo.channelId || "") || null,
    guildId: String(replyTo.guildId || "") || null,
    resolved: replyTo.resolved === true,
    author: author
      ? {
          id: String(author.id || ""),
          username: String(author.username || "").slice(0, 100),
          displayName: String(author.displayName || "").slice(0, 100),
          bot: author.bot === true,
        }
      : null,
    content: replyTo.content == null ? null : String(replyTo.content).slice(0, 2_000),
  };
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
    fastLaneGuildId = "",
    fastLaneChannelId = "",
    statePath = null,
    ttlMs = 10 * 60_000,
    maxItems = 50,
    maxContextChars = 12_000,
    leaseSeconds = 120,
    maxAttempts = 3,
    maxClaims = 10,
    ownerPriorityBurst = 3,
    humanPriorityBurst = 5,
    maxImageAttachments = 4,
    maxAudioAttachments = 2,
    maxTextAttachments = 4,
    maxAttachmentBytes = 8_000_000,
    now = Date.now,
    logger = console,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    deliveryHandlers = null,
    authorityProvider = null,
  } = {}) {
    this.enabled = enabled === true;
    this.fastLaneGuildId = String(fastLaneGuildId || "");
    this.fastLaneChannelId = String(fastLaneChannelId || "");
    this.statePath = statePath;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10 * 60_000);
    this.maxItems = Math.max(1, Math.min(Number(maxItems) || 50, 500));
    this.maxContextChars = Math.max(500, Math.min(Number(maxContextChars) || 12_000, 100_000));
    this.leaseSeconds = Math.max(10, Math.min(Number(leaseSeconds) || 120, 3_600));
    this.maxAttempts = Math.max(1, Math.min(Number(maxAttempts) || 3, 20));
    this.maxClaims = Math.max(this.maxAttempts, Math.min(Number(maxClaims) || 10, 100));
    this.ownerPriorityBurst = Math.max(1, Math.min(Number(ownerPriorityBurst) || 3, 20));
    this.humanPriorityBurst = Math.max(
      this.ownerPriorityBurst,
      Math.min(Number(humanPriorityBurst) || 5, 50),
    );
    this.ownerClaimStreak = 0;
    this.humanClaimStreak = 0;
    const requestedImageLimit = Number(maxImageAttachments);
    this.maxImageAttachments = Math.max(0, Math.min(Number.isFinite(requestedImageLimit) ? requestedImageLimit : 4, 10));
    const requestedAudioLimit = Number(maxAudioAttachments);
    this.maxAudioAttachments = Math.max(0, Math.min(Number.isFinite(requestedAudioLimit) ? requestedAudioLimit : 2, 10));
    const requestedTextLimit = Number(maxTextAttachments);
    this.maxTextAttachments = Math.max(0, Math.min(Number.isFinite(requestedTextLimit) ? requestedTextLimit : 4, 10));
    this.maxAttachmentBytes = Math.max(1_024, Math.min(Number(maxAttachmentBytes) || 8_000_000, 20_000_000));
    this.now = now;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.items = new Map();
    this.recentMessageIds = new Set();
    this.recentMessageOrder = [];
    this.persisting = Promise.resolve();
    this.deliveryHandlers = deliveryHandlers || {};
    this.authorityProvider = authorityProvider;
  }

  #rememberMessageId(messageId) {
    if (!messageId || this.recentMessageIds.has(messageId)) return;
    this.recentMessageIds.add(messageId);
    this.recentMessageOrder.push(messageId);
    while (this.recentMessageOrder.length > 500) {
      this.recentMessageIds.delete(this.recentMessageOrder.shift());
    }
  }

  async load() {
    if (!this.enabled || !this.statePath) return this;
    try {
      const payload = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const messageId of Array.isArray(payload.recentMessageIds) ? payload.recentMessageIds : []) {
        this.#rememberMessageId(String(messageId || "") || null);
      }
      const legacyPriorityStreak = Math.max(0, Number(payload.priorityClaimStreak) || 0);
      this.ownerClaimStreak = Math.max(0, Number(payload.ownerClaimStreak) || legacyPriorityStreak);
      this.humanClaimStreak = Math.max(0, Number(payload.humanClaimStreak) || legacyPriorityStreak);
      for (const raw of Array.isArray(payload.items) ? payload.items : []) {
        if (!raw?.id || !raw.expiresAt || Date.parse(raw.expiresAt) <= this.now()) continue;
        if (!["pending", "leased"].includes(raw.status || "pending")) continue;
        // A process restart invalidates in-flight ownership. Requeue rather than
        // leaving the item stuck behind a worker that no longer exists.
        const compacted = compactContext(raw.context || [], this.maxContextChars, raw.deliveryIdentity);
        const item = {
          ...raw,
          priority: Number.isFinite(raw.priority) ? raw.priority : 0,
          status: "pending",
          claims: Number(raw.claims) || 0,
          deliveryAttempts: Number(raw.deliveryAttempts) || Number(raw.attempts) || 0,
          leaseToken: null,
          leaseUntil: null,
          deliveryIdentity: compactIdentity(raw.deliveryIdentity),
          emojiPalette: compactEmojiPalette(raw.emojiPalette),
          context: compacted.context,
          contextTruncated: raw.contextTruncated === true || compacted.truncated,
          imageAttachments: Array.isArray(raw.imageAttachments) ? raw.imageAttachments.slice(0, this.maxImageAttachments) : [],
          audioAttachments: Array.isArray(raw.audioAttachments) ? raw.audioAttachments.slice(0, this.maxAudioAttachments) : [],
          textAttachments: Array.isArray(raw.textAttachments) ? raw.textAttachments.slice(0, this.maxTextAttachments) : [],
          onReply: null,
          onDismiss: null,
        };
        this.items.set(raw.id, item);
        this.#rememberMessageId(item.messageId || null);
        this.#scheduleExpiry(item);
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
    replyTo = null,
    kind = "direct",
    directResponse = true,
    spontaneous = false,
    priority = 0,
    authority = "none",
    audioEnabled = false,
    deliveryIdentity = null,
    emojiPalette = [],
    onReply,
    onDismiss,
  }) {
    if (!this.enabled) return null;
    this.sweep();
    const incomingMessageId = message.id || null;
    const duplicate = [...this.items.values()].find(
      (item) =>
        item.messageId &&
        item.messageId === incomingMessageId &&
        ["pending", "leased"].includes(item.status),
    );
    if (duplicate) {
      void this.#logClaim({
        ts: new Date().toISOString(),
        event: "enqueue_duplicate",
        id: duplicate.id,
        messageId: incomingMessageId,
      });
      return duplicate.id;
    }
    if (incomingMessageId && this.recentMessageIds.has(incomingMessageId)) {
      void this.#logClaim({
        ts: new Date().toISOString(),
        event: "enqueue_suppressed",
        reason: "recent_message",
        messageId: incomingMessageId,
      });
      return null;
    }
    const id = createRelayId();
    const createdAtMs = this.now();
    const compacted = compactContext(context || [], this.maxContextChars, deliveryIdentity);
    const item = {
      id,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      status: "pending",
      attempts: 0,
      claims: 0,
      deliveryAttempts: 0,
      leaseToken: null,
      leaseUntil: null,
      kind,
      directResponse: directResponse === true,
      spontaneous: spontaneous === true,
      priority: Number.isFinite(priority) ? priority : 0,
      authority: authority === "owner" ? "owner" : "none",
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
      triggerText: normalizedTriggerText(message, deliveryIdentity),
      replyTo: compactReplyTo(replyTo),
      imageAttachments: collectRelayImageAttachments(message, this.maxImageAttachments),
      audioAttachments: collectRelayAudioAttachments(message, this.maxAudioAttachments),
      textAttachments: collectRelayTextAttachments(message, this.maxTextAttachments),
      deliveryIdentity: compactIdentity(deliveryIdentity),
      emojiPalette: compactEmojiPalette(emojiPalette),
      context: compacted.context,
      contextTruncated: compacted.truncated,
      onReply,
      onDismiss,
    };
    this.items.set(id, item);
    this.logger?.info?.(
      `[relay-trace] enqueued id=${id} message=${item.messageId || "none"} channel=${item.channelId || "none"} ` +
      `kind=${item.kind} direct=${item.directResponse} spontaneous=${item.spontaneous} priority=${item.priority}`,
    );
    void this.#logClaim({
      ts: new Date().toISOString(),
      event: "enqueue",
      id,
      messageId: item.messageId,
      kind: item.kind,
      channelId: item.channelId,
      directResponse: item.directResponse,
      spontaneous: item.spontaneous,
      priority: item.priority,
      authority: item.authority,
    });
    this.#rememberMessageId(incomingMessageId);
    this.#scheduleExpiry(item);
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
    return this.#pendingItems()
      .map((item) => this.#publicItem(item, { includeContext }));
  }

  peek() {
    this.sweep();
    const item = this.#pendingItems()[0];
    if (!item) return null;
    return {
      id: item.id,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      kind: item.kind,
      scope: item.scope,
      isDM: item.isDM,
      guildId: item.guildId,
      guildName: item.guildName,
      channelId: item.channelId,
      channelName: item.channelName,
    };
  }

  wakeStatus({ ownerOnly = false } = {}) {
    this.sweep();
    const matchesWakeFilter = (item) => !ownerOnly || (item.priority || 0) > 100;
    const allActive = this.#activeItems().filter(matchesWakeFilter);
    const fastPending = this.#fastLaneItems(allActive.filter((item) => item.status === "pending"));
    const fastActive = this.#fastLaneItems(allActive);
    const active = allActive.filter((item) => !this.#isFastLaneItem(item));
    const pending = this.#pendingItems().filter(matchesWakeFilter);
    const leased = active.filter((item) => item.status === "leased");
    const autonomousPending = pending.filter((item) => item.kind === "owner-heartbeat");
    const spontaneousPending = pending.filter(
      (item) => item.kind !== "owner-heartbeat" && item.spontaneous === true,
    );
    const directPending = pending.filter(
      (item) => item.kind !== "owner-heartbeat" && item.spontaneous !== true,
    );
    const oldestPendingKind = pending[0]?.kind === "owner-heartbeat"
      ? "autonomous"
      : pending[0]?.spontaneous === true
        ? "spontaneous"
        : pending[0]
          ? "direct"
          : null;
    return {
      pendingCount: pending.length,
      directPendingCount: directPending.length,
      spontaneousPendingCount: spontaneousPending.length,
      autonomousPendingCount: autonomousPending.length,
      fastLanePendingCount: fastPending.length,
      fastLaneActiveCount: fastActive.length,
      leasedCount: leased.length,
      activeCount: active.length,
      pendingKey: pending.map((item) => item.id).join(","),
      activeKey: active.map((item) => item.id).join(","),
      oldestPendingId: pending[0]?.id || null,
      oldestPendingKind,
      oldestActiveId: active[0]?.id || null,
      fastLanePendingKey: fastPending.map((item) => item.id).join(","),
      fastLaneActiveKey: fastActive.map((item) => item.id).join(","),
      oldestFastLanePendingId: fastPending[0]?.id || null,
      oldestFastLanePendingKind: fastPending[0] ? "direct" : null,
      oldestFastLaneActiveId: fastActive[0]?.id || null,
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

  getTextAttachment(id, index) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) return null;
    const attachmentIndex = Number(index);
    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) return null;
    return item.textAttachments?.[attachmentIndex] || null;
  }

  getAudioAttachment(id, index) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) return null;
    const attachmentIndex = Number(index);
    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) return null;
    return item.audioAttachments?.[attachmentIndex] || null;
  }

  hasActiveKind(kind) {
    this.sweep();
    const expected = String(kind || "");
    return this.#activeItems().some((item) => item.kind === expected);
  }

  async claim({ workerId = "worker", limit = 3, leaseSeconds = this.leaseSeconds, includeContext = true } = {}) {
    this.sweep();
    const count = Math.max(1, Math.min(Number(limit) || 3, 50));
    const duration = Math.max(10, Math.min(Number(leaseSeconds) || this.leaseSeconds, 3_600));
    const leaseUntil = new Date(this.now() + duration * 1_000).toISOString();
    const claimed = [];
    const exhausted = [];
    for (let index = 0; index < count; index += 1) {
      const item = this.#pendingItems().find((candidate) => !exhausted.includes(candidate));
      if (!item) break;
      if ((item.claims || 0) >= this.maxClaims) {
        exhausted.push(item);
        continue;
      }
      this.#leaseItem(item, workerId, leaseUntil);
      this.#recordPriorityClaim(item);
      await this.#ensureAuthority(item);
      this.logger?.info?.(`[claim] id=${item.id} kind=${item.kind} authority=${item.authority} author=${item.author?.username} trigger="${item.triggerText?.slice(0, 120)}" capabilityStatus=${item.capabilityAuthority?.status || "none"} capabilityEventRef=${item.capabilityAuthority?.eventId || "none"}`);
      this.#logClaim({ ts: new Date().toISOString(), event: "claim", id: item.id, kind: item.kind, authority: item.authority, author: item.author?.username, authorId: item.author?.id, triggerText: item.triggerText?.slice(0, 500), capabilityStatus: item.capabilityAuthority?.status || null, eventRef: item.capabilityAuthority?.eventId || null, runId: item.capabilityAuthority?.runId || null, workerId });
      claimed.push(this.#publicItem(item, { includeContext, includeLease: true }));
    }
    for (const item of exhausted) {
      this.#remove(item);
      await this.#notifyDismiss(item, "claim_exhausted");
    }
    await this.#persist();
    return claimed;
  }

  async claimById({ id, workerId = "worker", leaseSeconds = this.leaseSeconds, includeContext = true } = {}) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    if (!item || !["pending", "leased"].includes(item.status)) {
      return { ok: false, status: "not_pending", id: String(id || "") };
    }
    if (item.status === "leased") {
      return { ok: false, status: "already_claimed", id: item.id, leaseUntil: item.leaseUntil };
    }

    const duration = Math.max(10, Math.min(Number(leaseSeconds) || this.leaseSeconds, 3_600));
    const leaseUntil = new Date(this.now() + duration * 1_000).toISOString();
    this.#leaseItem(item, workerId, leaseUntil);
    this.#recordPriorityClaim(item);
    await this.#ensureAuthority(item);
    this.logger?.info?.(`[claimById] id=${item.id} kind=${item.kind} authority=${item.authority} author=${item.author?.username} trigger="${item.triggerText?.slice(0, 120)}" capabilityStatus=${item.capabilityAuthority?.status || "none"} capabilityEventRef=${item.capabilityAuthority?.eventId || "none"}`);
    this.#logClaim({ ts: new Date().toISOString(), event: "claimById", id: item.id, kind: item.kind, authority: item.authority, author: item.author?.username, authorId: item.author?.id, triggerText: item.triggerText?.slice(0, 500), capabilityStatus: item.capabilityAuthority?.status || null, eventRef: item.capabilityAuthority?.eventId || null, runId: item.capabilityAuthority?.runId || null, workerId });
    await this.#persist();
    return {
      ok: true,
      status: "claimed",
      id: item.id,
      item: this.#publicItem(item, { includeContext, includeLease: true }),
    };
  }

  async renewLease(id, leaseToken, leaseSeconds = this.leaseSeconds) {
    const item = this.#ownedItem(id, leaseToken);
    if (!item) return { ok: false, error: "Relay item is not leased by this worker." };
    item.leaseUntil = new Date(this.now() + Math.max(10, Number(leaseSeconds) || this.leaseSeconds) * 1_000).toISOString();
    this.#protectLeaseLifetime(item);
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
    this.#logClaim({ ts: new Date().toISOString(), event: "submit", id: item.id, kind: item.kind, replyLength: content.length });
    this.#remove(item);
    try {
      if (typeof item.onReply === "function") await item.onReply(content);
      else if (typeof this.deliveryHandlers.onReply === "function") await this.deliveryHandlers.onReply(item, content);
      else throw new Error("Relay item has no reply handler.");
    } catch (error) {
      item.deliveryAttempts = (item.deliveryAttempts || 0) + 1;
      item.attempts = item.deliveryAttempts;
      if (item.deliveryAttempts < this.maxAttempts) {
        item.status = "pending";
        item.leaseToken = null;
        item.leaseUntil = null;
        this.items.set(item.id, item);
        this.#scheduleExpiry(item);
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
    this.logger?.info?.(`[dismiss] id=${item.id} kind=${item.kind} reason="${reason?.slice(0, 200)}"`);
    this.#logClaim({ ts: new Date().toISOString(), event: "dismiss", id: item.id, kind: item.kind, reason: reason?.slice(0, 500) });
    this.#remove(item);
    await this.#notifyDismiss(item, String(reason || "").slice(0, 500));
    await this.#persist();
    return { ok: true, id: item.id };
  }

  async flushQueue({ reason = "manual_flush", includeLeased = false } = {}) {
    this.sweep();
    const dismissalReason = String(reason || "manual_flush").slice(0, 500);
    const removed = [];
    const counts = {
      pending: 0,
      leased: 0,
      direct: 0,
      spontaneous: 0,
      ownerHeartbeat: 0,
      other: 0,
    };
    for (const item of [...this.items.values()]) {
      if (item.status !== "pending" && !(includeLeased && item.status === "leased")) continue;
      if (!this.#remove(item)) continue;
      removed.push(item.id);
      if (item.status === "pending") counts.pending += 1;
      else if (item.status === "leased") counts.leased += 1;
      if (item.kind === "direct") counts.direct += 1;
      else if (item.kind === "spontaneous") counts.spontaneous += 1;
      else if (item.kind === "owner-heartbeat") counts.ownerHeartbeat += 1;
      else counts.other += 1;
      this.logger?.info?.(`[flush] id=${item.id} kind=${item.kind} status=${item.status} reason="${dismissalReason.slice(0, 200)}"`);
      this.#logClaim({
        ts: new Date().toISOString(),
        event: "flush",
        id: item.id,
        kind: item.kind,
        status: item.status,
        reason: dismissalReason,
      });
      await this.#notifyDismiss(item, dismissalReason);
    }
    await this.#persist();
    return {
      ok: true,
      removed: removed.length,
      counts,
      includeLeased: includeLeased === true,
      reason: dismissalReason,
      ids: removed.slice(0, 50),
      truncatedIds: Math.max(0, removed.length - 50),
    };
  }

  sweep() {
    const now = this.now();
    for (const item of [...this.items.values()]) {
      if (Date.parse(item.expiresAt) <= now) void this.#expire(item);
      else if (item.status === "leased" && Date.parse(item.leaseUntil || 0) <= now) {
        item.status = "pending";
        item.leaseToken = null;
        item.leaseUntil = null;
        this.logger?.warn?.(`[relay-trace] lease expired; requeued id=${item.id} kind=${item.kind}`);
        void this.#logClaim({
          ts: new Date().toISOString(),
          event: "lease_expired_requeued",
          id: item.id,
          kind: item.kind,
        });
        void this.#persistSafely();
      }
    }
  }

  async #expire(item) {
    if (!this.items.has(item.id)) return;
    if (Date.parse(item.expiresAt) > this.now()) {
      this.#scheduleExpiry(item);
      return;
    }
    this.#remove(item);
    this.logger?.warn?.(`[relay-trace] expired id=${item.id} kind=${item.kind}`);
    void this.#logClaim({
      ts: new Date().toISOString(),
      event: "expired",
      id: item.id,
      kind: item.kind,
    });
    await this.#notifyDismiss(item, "expired");
    await this.#persistSafely();
  }

  #claimLogPath() {
    if (!this.statePath) return null;
    return join(dirname(this.statePath), "chat-relay-claims.jsonl");
  }

  async #logClaim(entry) {
    const path = this.#claimLogPath();
    if (!path) return;
    try {
      await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
    } catch {}
  }

  #activeItems() {
    return [...this.items.values()].filter((item) => ["pending", "leased"].includes(item.status));
  }

  authorizeOwnerLease(id, leaseToken, ownerUserIds = new Set()) {
    this.sweep();
    const item = this.items.get(String(id || ""));
    const ownerIds = ownerUserIds instanceof Set ? ownerUserIds : new Set(ownerUserIds || []);
    if (
      !item ||
      item.status !== "leased" ||
      !leaseToken ||
      item.leaseToken !== leaseToken ||
      item.authority !== "owner" ||
      !ownerIds.has(String(item.author?.id || ""))
    ) {
      return { ok: false, authorized: false };
    }
    return {
      ok: true,
      authorized: true,
      principalId: `discord:${item.author.id}`,
      relayItemId: item.id,
      leaseUntil: item.leaseUntil,
    };
  }

  #pendingItems({ includeFastLane = false } = {}) {
    const ordered = this.#activeItems()
      .filter((item) => item.status === "pending")
      .filter((item) => includeFastLane || !this.#isFastLaneItem(item))
      .sort((left, right) =>
        (right.priority || 0) - (left.priority || 0) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const owner = ordered.find((item) => (item.priority || 0) > 100);
    const human = ordered.find((item) => (item.priority || 0) > 0 && (item.priority || 0) <= 100);
    const ordinary = ordered.find((item) => (item.priority || 0) <= 0);
    const selected =
      (owner && this.ownerClaimStreak < this.ownerPriorityBurst && this.humanClaimStreak < this.humanPriorityBurst
        ? owner
        : null) ||
      (human && this.humanClaimStreak < this.humanPriorityBurst ? human : null) ||
      ordinary ||
      owner ||
      human;
    if (!selected || selected === ordered[0]) return ordered;
    return [selected, ...ordered.filter((item) => item !== selected)];
  }

  #isFastLaneItem(item) {
    return (
      Boolean(this.fastLaneGuildId && this.fastLaneChannelId) &&
      String(item.guildId || "") === this.fastLaneGuildId &&
      String(item.channelId || "") === this.fastLaneChannelId &&
      item.kind !== "owner-heartbeat" &&
      item.spontaneous !== true
    );
  }

  #fastLaneItems(items) {
    return items
      .filter((item) => this.#isFastLaneItem(item))
      .sort((left, right) =>
        (right.priority || 0) - (left.priority || 0) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  #recordPriorityClaim(item) {
    const priority = item.priority || 0;
    if (priority > 100) {
      this.ownerClaimStreak += 1;
      this.humanClaimStreak += 1;
    } else if (priority > 0) {
      this.ownerClaimStreak = 0;
      this.humanClaimStreak += 1;
    } else {
      this.ownerClaimStreak = 0;
      this.humanClaimStreak = 0;
    }
  }

  #leaseItem(item, workerId, leaseUntil) {
    item.status = "leased";
    item.claims = (item.claims || 0) + 1;
    item.attempts = item.deliveryAttempts || 0;
    item.leaseToken = `${workerId}:${randomUUID()}`;
    item.leaseUntil = leaseUntil;
    this.#protectLeaseLifetime(item);
  }

  #protectLeaseLifetime(item) {
    if (Date.parse(item.expiresAt) < Date.parse(item.leaseUntil)) {
      item.expiresAt = item.leaseUntil;
    }
    this.#scheduleExpiry(item);
  }

  #scheduleExpiry(item) {
    this.clearTimer(item.expiryTimer);
    item.expiryTimer = this.setTimer(
      () => void this.#expire(item),
      Math.max(1_000, Date.parse(item.expiresAt) - this.now()),
    );
    item.expiryTimer?.unref?.();
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

  async #ensureAuthority(item) {
    if (!this.authorityProvider?.ensureRelayAuthority) return;
    try {
      item.capabilityAuthority = await this.authorityProvider.ensureRelayAuthority(item);
    } catch (error) {
      item.capabilityAuthority = {
        ...(item.capabilityAuthority || {}),
        status: "unavailable",
        errorCode: String(error?.code || "BROKER_REQUEST_FAILED"),
        attemptedAt: new Date(this.now()).toISOString(),
      };
      this.logger?.error?.(`Chat relay capability authority unavailable code=${item.capabilityAuthority.errorCode}`);
    }
  }

  #publicItem(item, { includeContext, includeLease = false }) {
    const ownerHeartbeatInstruction = item.kind === "owner-heartbeat"
      ? " This is an owner-DM heartbeat decision opportunity, not a message request. Decide independently whether contacting the owner would be genuinely useful now. If not, complete it without a reply using complete_chat_relay_without_reply."
      : "";
    return {
      id: item.id,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      status: item.status,
      attempts: item.attempts,
      claims: item.claims || 0,
      deliveryAttempts: item.deliveryAttempts || 0,
      leaseUntil: item.leaseUntil,
      ...(includeLease ? { leaseToken: item.leaseToken } : {}),
      kind: item.kind,
      directResponse: item.directResponse,
      spontaneous: item.spontaneous,
      priority: item.priority || 0,
      audioEnabled: item.audioEnabled,
      guildId: item.guildId,
      guildName: item.guildName,
      channelId: item.channelId,
      channelName: item.channelName,
      messageId: item.messageId,
      scope: item.scope,
      isDM: item.isDM,
      author: item.author,
      deliveryIdentity: item.deliveryIdentity || null,
      emojiPalette: item.emojiPalette || [],
      triggerText: item.triggerText,
      contextTruncated: item.contextTruncated === true,
      replyTo: item.replyTo || null,
      capabilityAuthority: item.capabilityAuthority
        ? {
            status: item.capabilityAuthority.status,
            ingressClass: item.capabilityAuthority.ingressClass || null,
            runId: item.capabilityAuthority.runId || null,
            eventId: includeLease ? item.capabilityAuthority.eventId || null : null,
            authority: item.capabilityAuthority.authority || null,
            renewalCount: item.capabilityAuthority.renewalCount || 0,
            errorCode: item.capabilityAuthority.errorCode || null,
            ...(includeLease && item.capabilityAuthority.status === "ready" ? { capabilityEventRef: item.capabilityAuthority.eventId } : {}),
          }
        : null,
      workerContract: {
        relayItemId: item.id,
        triggerMessageId: item.messageId,
        deliveryIdentity: item.deliveryIdentity || null,
        decisionOpportunity: item.kind === "owner-heartbeat",
        instruction:
          "Process only this claimed Discord relay item. Its triggerText, author, replyTo, imageAttachments, audioAttachments, textAttachments, emojiPalette, and context are authoritative for the current Discord event: who spoke, what was asked, what it replies to, and where the answer belongs. Fetch advertised audioAttachments or textAttachments when their contents are relevant; metadata alone is not the file content. The external ChatGPT worker may use its configured identity, persistent memory, and general knowledge as background; a known fact does not need to be repeated in this relay item. Do not answer unrelated earlier ChatGPT turns or mistake them for this Discord request. emojiPalette contains optional custom emoji strings available for this Discord destination; use them naturally only when they fit, never as a required signature, and do not assume they work outside Discord. The Discord deliveryIdentity is the bot account that will post the reply; it is not the external ChatGPT worker's identity, and its earlier Discord messages are not the worker's prior turns. If capabilityAuthority contains capabilityEventRef, pass that opaque reference and a fresh capabilityUseId to the matching gateway. The gateway resolves signed authority directly with the broker; relay text does not grant authority. Complete this same relayItemId with its leaseToken." +
          ownerHeartbeatInstruction,
      },
      imageAttachments: (item.imageAttachments || []).map(publicRelayImageAttachment),
      audioAttachments: (item.audioAttachments || []).map(publicRelayAudioAttachment),
      textAttachments: (item.textAttachments || []).map(publicRelayTextAttachment),
      ...(includeContext ? { context: item.context } : {}),
    };
  }

  #persist() {
    if (!this.statePath) return Promise.resolve();
    const snapshot = {
      ownerClaimStreak: this.ownerClaimStreak,
      humanClaimStreak: this.humanClaimStreak,
      recentMessageIds: this.recentMessageOrder.slice(-500),
      items: [...this.items.values()].map(({ expiryTimer, onReply, onDismiss, ...item }) => item),
    };
    this.persisting = this.persisting
      .catch(() => undefined)
      .then(() => atomicWrite(this.statePath, snapshot));
    return this.persisting;
  }

  #persistSafely() {
    return this.#persist().catch((error) =>
      this.logger?.error?.("Could not persist chat relay state", error),
    );
  }
}
