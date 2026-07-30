const HOUR_MS = 60 * 60 * 1_000;

export class SpontaneousGate {
  constructor(config, { random = Math.random, now = Date.now } = {}) {
    this.config = config;
    this.random = random;
    this.now = now;
    this.channels = new Map();
  }

  stateFor(channelId) {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, {
        messageCount: 0,
        lastResponseAt: 0,
        spontaneousAttempts: [],
      });
    }
    return this.channels.get(channelId);
  }

  consider(channelId) {
    const state = this.stateFor(channelId);
    const now = this.now();
    state.messageCount += 1;
    state.spontaneousAttempts = state.spontaneousAttempts.filter(
      (timestamp) => now - timestamp < HOUR_MS,
    );

    if (state.messageCount < this.config.spontaneousMinMessages) return false;
    if (now - state.lastResponseAt < this.config.spontaneousCooldownMs) return false;
    if (state.spontaneousAttempts.length >= this.config.spontaneousMaxPerHour) return false;

    const range = Math.max(
      1,
      this.config.spontaneousMaxMessages - this.config.spontaneousMinMessages,
    );
    const progress = Math.min(
      1,
      (state.messageCount - this.config.spontaneousMinMessages) / range,
    );
    const probability = 0.12 + 0.88 * progress;
    const selected =
      state.messageCount >= this.config.spontaneousMaxMessages ||
      this.random() < probability;

    if (selected) {
      // Reserve the slot immediately so bursts and provider errors cannot create spam.
      state.messageCount = 0;
      state.lastResponseAt = now;
      state.spontaneousAttempts.push(now);
    }
    return selected;
  }

  recordResponse(channelId) {
    const state = this.stateFor(channelId);
    state.messageCount = 0;
    state.lastResponseAt = this.now();
  }
}
