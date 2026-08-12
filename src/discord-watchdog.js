import { Events } from "discord.js";

function errorSummary(error) {
  if (!error) return null;
  return String(error.message || error).slice(0, 300);
}

export class DiscordConnectivityWatchdog {
  constructor({
    client,
    enabled = false,
    graceMs = 90_000,
    checkIntervalMs = 15_000,
    requestRestart = null,
    now = Date.now,
    logger = console,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.client = client;
    this.enabled = enabled === true;
    this.graceMs = Math.max(10_000, Number(graceMs) || 90_000);
    this.checkIntervalMs = Math.max(5_000, Number(checkIntervalMs) || 15_000);
    this.requestRestart = requestRestart;
    this.now = now;
    this.logger = logger;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.started = false;
    this.ready = false;
    this.unhealthySince = null;
    this.lastEvent = "created";
    this.lastTransitionAt = new Date(this.now()).toISOString();
    this.lastError = null;
    this.restartRequested = false;
    this.graceTimer = null;
    this.probeTimer = null;
    this.listeners = [];
  }

  start() {
    if (!this.enabled || this.started) return this;
    this.started = true;
    this.#listen(Events.ClientReady, () => this.#markHealthy("client_ready"));
    this.#listen(Events.ShardReady, () => this.#probe("shard_ready"));
    this.#listen(Events.ShardResume, () => this.#probe("shard_resume"));
    this.#listen(Events.ShardDisconnect, () => this.#markUnhealthy("shard_disconnect"));
    this.#listen(Events.ShardReconnecting, () => this.#markUnhealthy("shard_reconnecting"));
    this.#listen(Events.Invalidated, () => this.#markUnhealthy("session_invalidated"));
    this.#listen(Events.ShardError, (error) => this.#markUnhealthy("shard_error", error));
    this.probeTimer = this.setIntervalFn(
      () => this.#probe("periodic_probe"),
      this.checkIntervalMs,
    );
    this.probeTimer?.unref?.();
    this.#probe("startup");
    return this;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.#clearGraceTimer();
    if (this.probeTimer) this.clearIntervalFn(this.probeTimer);
    this.probeTimer = null;
    for (const [event, listener] of this.listeners) this.client?.off?.(event, listener);
    this.listeners = [];
  }

  status() {
    return {
      enabled: this.enabled,
      started: this.started,
      ready: this.ready,
      graceSeconds: Math.round(this.graceMs / 1_000),
      checkIntervalSeconds: Math.round(this.checkIntervalMs / 1_000),
      unhealthySince: this.unhealthySince,
      lastEvent: this.lastEvent,
      lastTransitionAt: this.lastTransitionAt,
      lastError: this.lastError,
      restartRequested: this.restartRequested,
    };
  }

  #listen(event, listener) {
    this.client?.on?.(event, listener);
    this.listeners.push([event, listener]);
  }

  #probe(event) {
    if (this.client?.isReady?.() === true) this.#markHealthy(event);
    else this.#markUnhealthy(event);
  }

  #markHealthy(event) {
    const changed = !this.ready || this.unhealthySince !== null;
    this.ready = true;
    this.unhealthySince = null;
    this.lastEvent = event;
    this.lastError = null;
    this.#clearGraceTimer();
    if (changed) {
      this.lastTransitionAt = new Date(this.now()).toISOString();
      this.logger?.info?.(`Discord watchdog healthy event=${event}`);
    }
  }

  #markUnhealthy(event, error = null) {
    if (this.client?.isReady?.() === true) {
      this.#markHealthy(`${event}_while_ready`);
      return;
    }
    const firstFailure = this.unhealthySince === null;
    this.ready = false;
    this.lastEvent = event;
    this.lastError = errorSummary(error);
    if (firstFailure) {
      this.unhealthySince = new Date(this.now()).toISOString();
      this.lastTransitionAt = this.unhealthySince;
      this.logger?.warn?.(
        `Discord watchdog detected unavailable client event=${event}; allowing ${Math.round(this.graceMs / 1_000)}s for reconnect`,
      );
      this.graceTimer = this.setTimeoutFn(() => this.#onGraceExpired(), this.graceMs);
      this.graceTimer?.unref?.();
    }
  }

  #onGraceExpired() {
    this.graceTimer = null;
    if (!this.started || this.client?.isReady?.() === true) {
      if (this.client?.isReady?.() === true) this.#markHealthy("grace_recovered");
      return;
    }
    if (this.restartRequested) return;
    this.restartRequested = true;
    this.lastEvent = "restart_requested";
    this.lastTransitionAt = new Date(this.now()).toISOString();
    this.logger?.error?.("Discord watchdog grace period expired; requesting supervised restart");
    try {
      Promise.resolve(this.requestRestart?.("Discord connectivity watchdog"))
        .catch((error) => this.logger?.error?.("Discord watchdog restart request failed", error));
    } catch (error) {
      this.logger?.error?.("Discord watchdog restart request failed", error);
    }
  }

  #clearGraceTimer() {
    if (this.graceTimer) this.clearTimeoutFn(this.graceTimer);
    this.graceTimer = null;
  }
}
