export class BotLoopGuard {
  constructor({ enabled = true, maxConsecutive = 5, cooldownSeconds = 180 } = {}, now = Date.now) {
    this.enabled = enabled;
    this.maxConsecutive = maxConsecutive;
    this.cooldownMs = cooldownSeconds * 1_000;
    this.now = now;
    this.channels = new Map();
  }

  observeHuman(channelId) {
    if (channelId) this.channels.delete(String(channelId));
  }

  admitBotTrigger(channelId) {
    if (!this.enabled || !channelId) return { allowed: true, reason: "disabled" };

    const key = String(channelId);
    const now = this.now();
    const previous = this.channels.get(key);
    if (previous?.cooldownUntil > now) {
      return {
        allowed: false,
        reason: "bot_loop_cooldown",
        retryAt: previous.cooldownUntil,
      };
    }

    const expired = !previous || now - previous.lastBotAt >= this.cooldownMs;
    const count = (expired ? 0 : previous.count) + 1;
    const cooldownUntil = count >= this.maxConsecutive ? now + this.cooldownMs : null;
    this.channels.set(key, { count, lastBotAt: now, cooldownUntil });
    return { allowed: true, reason: "accepted", count, cooldownUntil };
  }
}
