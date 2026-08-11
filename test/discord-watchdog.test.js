import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Events } from "discord.js";
import { DiscordConnectivityWatchdog } from "../src/discord-watchdog.js";

function harness({ ready = false } = {}) {
  const client = new EventEmitter();
  client.ready = ready;
  client.isReady = () => client.ready;
  const timeouts = new Map();
  const intervals = new Map();
  const restarts = [];
  let timerId = 0;
  let now = 1_000;
  const watchdog = new DiscordConnectivityWatchdog({
    client,
    enabled: true,
    graceMs: 10_000,
    checkIntervalMs: 5_000,
    requestRestart: (reason) => restarts.push(reason),
    now: () => now,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    setTimeoutFn: (callback) => {
      timerId += 1;
      timeouts.set(timerId, callback);
      return timerId;
    },
    clearTimeoutFn: (id) => timeouts.delete(id),
    setIntervalFn: (callback) => {
      timerId += 1;
      intervals.set(timerId, callback);
      return timerId;
    },
    clearIntervalFn: (id) => intervals.delete(id),
  });
  return {
    client,
    watchdog,
    restarts,
    timeouts,
    intervals,
    advance(ms) {
      now += ms;
    },
    expireGrace() {
      const callback = [...timeouts.values()][0];
      assert.ok(callback, "expected an active grace timer");
      callback();
    },
    probe() {
      const callback = [...intervals.values()][0];
      assert.ok(callback, "expected an active probe timer");
      callback();
    },
  };
}

test("allows Discord to reconnect during the grace period", () => {
  const testHarness = harness();
  testHarness.watchdog.start();
  assert.equal(testHarness.timeouts.size, 1);
  assert.equal(testHarness.watchdog.status().ready, false);

  testHarness.client.ready = true;
  testHarness.client.emit(Events.ClientReady, testHarness.client);

  assert.equal(testHarness.timeouts.size, 0);
  assert.equal(testHarness.watchdog.status().ready, true);
  assert.deepEqual(testHarness.restarts, []);
});

test("requests one supervised restart after Discord remains unavailable", () => {
  const testHarness = harness({ ready: true });
  testHarness.watchdog.start();
  testHarness.client.ready = false;
  testHarness.advance(1_000);
  testHarness.client.emit(Events.ShardDisconnect, {}, 0);
  testHarness.client.emit(Events.ShardReconnecting, 0);

  assert.equal(testHarness.timeouts.size, 1, "repeat events must not extend the grace period");
  testHarness.expireGrace();
  testHarness.probe();

  assert.deepEqual(testHarness.restarts, ["Discord connectivity watchdog"]);
  assert.equal(testHarness.watchdog.status().restartRequested, true);
});

test("periodic readiness probes catch a silent Discord outage", () => {
  const testHarness = harness({ ready: true });
  testHarness.watchdog.start();
  testHarness.client.ready = false;
  testHarness.probe();

  assert.equal(testHarness.watchdog.status().lastEvent, "periodic_probe");
  assert.equal(testHarness.timeouts.size, 1);
  testHarness.expireGrace();
  assert.equal(testHarness.restarts.length, 1);
});

test("stopping the watchdog removes timers and Discord listeners", () => {
  const testHarness = harness();
  testHarness.watchdog.start();
  assert.ok(testHarness.client.listenerCount(Events.ShardDisconnect));
  testHarness.watchdog.stop();

  assert.equal(testHarness.timeouts.size, 0);
  assert.equal(testHarness.intervals.size, 0);
  assert.equal(testHarness.client.listenerCount(Events.ShardDisconnect), 0);
});

test("a disabled watchdog remains inert", () => {
  const client = new EventEmitter();
  client.isReady = () => false;
  const watchdog = new DiscordConnectivityWatchdog({ client, enabled: false }).start();
  assert.deepEqual(watchdog.status(), {
    enabled: false,
    started: false,
    ready: false,
    graceSeconds: 90,
    checkIntervalSeconds: 15,
    unhealthySince: null,
    lastEvent: "created",
    lastTransitionAt: watchdog.status().lastTransitionAt,
    lastError: null,
    restartRequested: false,
  });
});
