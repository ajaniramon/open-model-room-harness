import assert from "node:assert/strict";
import test from "node:test";
import { RelayCapabilityBrokerClient } from "../src/capability-broker-client.js";

const TOKEN = "test-token-".padEnd(40, "x");

test("relay broker client exchanges once and renews the same event when grants approach expiry", async () => {
  let now = Date.parse("2026-08-16T10:00:00.000Z");
  const calls = [];
  const responses = [
    { ok: true, authority: "owner", runId: "run-1", eventId: "event-1", ticket: "ticket" },
    { ok: true, runId: "run-1", eventId: "event-1", grants: [{ audience: "filesystem", grant: "grant-v1", expiresAt: "2026-08-16T10:01:00.000Z" }] },
    { ok: true, authority: "owner", runId: "run-1", eventId: "event-1", renewalCount: 1, grants: [{ audience: "filesystem", grant: "grant-v2", expiresAt: "2026-08-16T10:03:00.000Z" }] },
  ];
  const client = new RelayCapabilityBrokerClient({
    enabled: true,
    baseUrl: "http://127.0.0.1:3400",
    discordIngressToken: TOKEN,
    autonomousIngressToken: `${TOKEN}a`,
    exchangeToken: `${TOKEN}e`,
    ownerAudiences: ["filesystem"],
    publicAudiences: ["discord"],
    autonomousAudiences: ["filesystem"],
    minGrantRemainingMs: 15_000,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const item = {
    id: "relay-1",
    messageId: "message-1",
    channelId: "channel-1",
    kind: "direct",
    authority: "owner",
    author: { id: "1503782009791844463" },
    triggerText: "inspect the workspace",
  };

  const first = await client.ensureRelayAuthority(item);
  assert.equal(first.eventId, "event-1");
  assert.equal(first.grants.filesystem.grant, "grant-v1");
  item.capabilityAuthority = first;
  assert.equal(await client.ensureRelayAuthority(item), first);

  now = Date.parse("2026-08-16T10:00:50.000Z");
  const renewed = await client.ensureRelayAuthority(item);
  assert.equal(renewed.eventId, "event-1");
  assert.equal(renewed.renewalCount, 1);
  assert.equal(renewed.grants.filesystem.grant, "grant-v2");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/v1/ingress/discord",
    "/v1/grants/exchange",
    "/v1/ingress/discord/renew-grants",
  ]);
});

test("owner heartbeat uses autonomous ingress rather than owner Discord authority", async () => {
  const paths = [];
  const responses = [
    { ok: true, authority: "autonomous", runId: "run-auto", eventId: "event-auto", ticket: "ticket" },
    { ok: true, runId: "run-auto", eventId: "event-auto", grants: [{ audience: "execution", grant: "auto-grant", expiresAt: "2026-08-16T10:05:00.000Z" }] },
  ];
  const client = new RelayCapabilityBrokerClient({
    enabled: true,
    discordIngressToken: TOKEN,
    autonomousIngressToken: `${TOKEN}a`,
    exchangeToken: `${TOKEN}e`,
    ownerAudiences: ["filesystem"],
    publicAudiences: ["discord"],
    autonomousAudiences: ["execution"],
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.ensureRelayAuthority({
    id: "heartbeat-1",
    messageId: "owner-heartbeat-1",
    channelId: "dm-1",
    kind: "owner-heartbeat",
    authority: "owner",
    author: { id: "1503782009791844463" },
    triggerText: "decision opportunity",
  });
  assert.equal(result.authority, "autonomous");
  assert.deepEqual(paths, ["/v1/ingress/autonomous", "/v1/grants/exchange"]);
});
