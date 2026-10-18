import { randomUUID } from "node:crypto";

const MINUTE_MS = 60_000;

function boundedText(value, limit = 2_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function recentDmContext(messages, botUserId) {
  return [...messages.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .filter((message) => message.content || message.attachments?.size)
    .map((message) => {
      const name =
        message.author?.globalName || message.author?.username ||
        (message.author?.id === botUserId ? "assistant" : "owner");
      const attachments = [...(message.attachments?.values?.() || [])]
        .map((attachment) => `[attachment: ${attachment.name || "file"}]`)
        .join(" ");
      const content = boundedText([message.content, attachments].filter(Boolean).join("\n"));
      return {
        role: message.author?.id === botUserId ? "assistant" : "user",
        content: `[Recent owner DM from ${boundedText(name, 100)}]\n${content || "[empty message]"}`,
      };
    });
}

export class OwnerHeartbeat {
  constructor({
    config,
    client,
    chatRelay,
    canRun = () => true,
    logger = console,
    now = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.config = config;
    this.client = client;
    this.chatRelay = chatRelay;
    this.canRun = canRun;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.lastOwnerInteractionAt = 0;
    this.lastOpportunityAt = 0;
    this.nextOpportunityAt = null;
  }

  get enabled() {
    return this.config?.enabled === true && Boolean(this.config.ownerUserId) && this.chatRelay?.enabled === true;
  }

  start() {
    if (this.running || !this.enabled) return false;
    this.running = true;
    this.#scheduleNext();
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextOpportunityAt = null;
  }

  recordOwnerInteraction(author) {
    if (String(author?.id || "") !== this.config?.ownerUserId) return false;
    this.lastOwnerInteractionAt = this.now();
    return true;
  }

  recordContact() {
    this.lastOwnerInteractionAt = this.now();
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      ownerConfigured: Boolean(this.config?.ownerUserId),
      lastOwnerInteractionAt: this.lastOwnerInteractionAt || null,
      lastOpportunityAt: this.lastOpportunityAt || null,
      nextOpportunityAt: this.nextOpportunityAt,
    };
  }

  async evaluate() {
    if (!this.enabled || !this.client?.isReady?.()) return { outcome: "unavailable" };
    const now = this.now();
    const recentWindowMs = this.config.recentInteractionMinutes * MINUTE_MS;
    if (this.lastOwnerInteractionAt && now - this.lastOwnerInteractionAt < recentWindowMs) {
      return { outcome: "recent_interaction" };
    }
    if (!this.canRun()) return { outcome: "behavior_mode" };
    if (this.chatRelay.hasActiveKind?.("owner-heartbeat")) return { outcome: "already_pending" };

    const owner = await this.client.users.fetch(this.config.ownerUserId);
    const channel = await owner.createDM();
    const recent = await channel.messages
      .fetch({ limit: this.config.contextMessages })
      .catch(() => new Map());
    const idleMinutes = this.lastOwnerInteractionAt
      ? Math.max(0, Math.floor((now - this.lastOwnerInteractionAt) / MINUTE_MS))
      : null;
    const context = [
      {
        role: "user",
        content:
          "[Application owner-heartbeat snapshot; trusted event metadata]\n" +
          `Generated: ${new Date(now).toISOString()}\n` +
          `Minutes since observed owner interaction: ${idleMinutes ?? "unknown"}\n` +
          "This is only an opportunity to decide. Sending a DM is optional.",
      },
      ...recentDmContext(recent, this.client.user.id),
    ];
    const relayId = this.chatRelay.enqueue({
      message: {
        id: `owner-heartbeat-${randomUUID()}`,
        content:
          "Owner-DM heartbeat opportunity. Review the attached snapshot and recent DM context. " +
          "Contact the owner only if there is a genuine, contextually useful reason; otherwise complete this item without a reply.",
        createdTimestamp: now,
        guildId: null,
        guild: null,
        channelId: channel.id,
        channel,
        author: owner,
        member: null,
        attachments: new Map(),
      },
      context,
      kind: "owner-heartbeat",
      directResponse: false,
      spontaneous: true,
      audioEnabled: false,
      emojiPalette: [],
      deliveryIdentity: {
        id: this.client.user.id,
        username: this.client.user.username,
        displayName: this.client.user.globalName || this.client.user.username,
        bot: true,
      },
    });
    if (!relayId) return { outcome: "not_queued" };
    this.lastOpportunityAt = now;
    this.logger?.info?.(`Owner heartbeat queued id=${relayId}`);
    return { outcome: "queued", relayId };
  }

  #scheduleNext() {
    if (!this.running) return;
    const minimum = this.config.minMinutes * MINUTE_MS;
    const maximum = this.config.maxMinutes * MINUTE_MS;
    const delay = Math.round(minimum + (maximum - minimum) * this.random());
    this.nextOpportunityAt = this.now() + delay;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try {
        const result = await this.evaluate();
        this.logger?.info?.(`Owner heartbeat outcome=${result.outcome}`);
      } catch (error) {
        this.logger?.error?.("Owner heartbeat evaluation failed", error);
      } finally {
        this.#scheduleNext();
      }
    }, delay);
    this.timer?.unref?.();
  }
}
