import { createHash } from "node:crypto";

const AUDIENCES = new Set(["filesystem", "execution", "discord"]);

function normalizedAudiences(values, name) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name} must contain at least one audience`);
  const result = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (result.some((value) => !AUDIENCES.has(value))) throw new Error(`${name} contains an invalid audience`);
  return result;
}

function sourceEventId(item) {
  const messageId = String(item.messageId || item.id || "");
  const channelId = String(item.channelId || "unknown-channel");
  return `relay:${channelId}:${messageId}`;
}

function messageSha256(item) {
  return createHash("sha256").update(String(item.triggerText || ""), "utf8").digest("hex");
}

function grantMap(grants) {
  return Object.fromEntries(grants.map((grant) => [grant.audience, {
    grant: grant.grant,
    expiresAt: grant.expiresAt,
  }]));
}

export class RelayCapabilityBrokerClient {
  constructor({
    enabled = false,
    baseUrl = "http://127.0.0.1:3400",
    discordIngressToken = "",
    autonomousIngressToken = "",
    exchangeToken = "",
    ownerAudiences = ["filesystem", "execution", "discord"],
    publicAudiences = ["discord"],
    autonomousAudiences = ["filesystem", "execution", "discord"],
    timeoutMs = 5_000,
    minGrantRemainingMs = 15_000,
    fetchImpl = fetch,
    now = Date.now,
  } = {}) {
    this.enabled = enabled === true;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.discordIngressToken = String(discordIngressToken);
    this.autonomousIngressToken = String(autonomousIngressToken);
    this.exchangeToken = String(exchangeToken);
    this.ownerAudiences = normalizedAudiences(ownerAudiences, "ownerAudiences");
    this.publicAudiences = normalizedAudiences(publicAudiences, "publicAudiences");
    this.autonomousAudiences = normalizedAudiences(autonomousAudiences, "autonomousAudiences");
    this.timeoutMs = Math.max(500, Math.min(Number(timeoutMs) || 5_000, 30_000));
    this.minGrantRemainingMs = Math.max(0, Number(minGrantRemainingMs) || 0);
    this.fetchImpl = fetchImpl;
    this.now = now;
    if (this.enabled) {
      const parsed = new URL(this.baseUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("capability broker URL must use HTTP or HTTPS");
      if (this.discordIngressToken.length < 32 || this.autonomousIngressToken.length < 32 || this.exchangeToken.length < 32) {
        throw new Error("enabled capability broker integration requires all ingress and exchange tokens");
      }
    }
  }

  async ensureRelayAuthority(item) {
    if (!this.enabled) return null;
    const autonomous = item.kind === "owner-heartbeat";
    const ingressClass = autonomous ? "autonomous" : "discord";
    const audiences = autonomous
      ? this.autonomousAudiences
      : item.authority === "owner" ? this.ownerAudiences : this.publicAudiences;
    const sourceId = sourceEventId(item);
    const existing = item.capabilityAuthority;
    if (existing?.status === "ready" && existing.ingressClass === ingressClass && existing.sourceEventId === sourceId) {
      const expiries = Object.values(existing.grants || {}).map((grant) => Date.parse(grant.expiresAt));
      if (expiries.length === audiences.length && expiries.every((expiry) => expiry > this.now() + this.minGrantRemainingMs)) return existing;
      return this.#renew(existing, audiences);
    }
    return autonomous ? this.#issueAutonomous(sourceId, audiences) : this.#issueDiscord(item, sourceId, audiences);
  }

  async #issueDiscord(item, sourceId, audiences) {
    const ingress = await this.#request("/v1/ingress/discord", this.discordIngressToken, {
      authorId: String(item.author?.id || ""),
      audiences,
      sourceEventId: sourceId,
      messageSha256: messageSha256(item),
    });
    return this.#exchange(ingress, "discord", sourceId);
  }

  async #issueAutonomous(sourceId, audiences) {
    const ingress = await this.#request("/v1/ingress/autonomous", this.autonomousIngressToken, {
      audiences,
      wakeId: sourceId,
    });
    return this.#exchange(ingress, "autonomous", sourceId);
  }

  async #exchange(ingress, ingressClass, sourceId) {
    const exchanged = await this.#request("/v1/grants/exchange", this.exchangeToken, { ticket: ingress.ticket });
    return {
      status: "ready",
      ingressClass,
      sourceEventId: sourceId,
      runId: exchanged.runId,
      eventId: exchanged.eventId,
      authority: ingress.authority,
      renewalCount: 0,
      grants: grantMap(exchanged.grants),
      issuedAt: new Date(this.now()).toISOString(),
    };
  }

  async #renew(existing, audiences) {
    const token = existing.ingressClass === "autonomous" ? this.autonomousIngressToken : this.discordIngressToken;
    const renewed = await this.#request(`/v1/ingress/${existing.ingressClass}/renew-grants`, token, {
      sourceEventId: existing.sourceEventId,
      eventId: existing.eventId,
      audiences,
    });
    return {
      ...existing,
      status: "ready",
      runId: renewed.runId,
      eventId: renewed.eventId,
      authority: renewed.authority,
      renewalCount: renewed.renewalCount,
      grants: grantMap(renewed.grants),
      issuedAt: new Date(this.now()).toISOString(),
    };
  }

  async #request(path, token, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(payload?.error?.message || `capability broker returned HTTP ${response.status}`);
      error.code = payload?.error?.code || "BROKER_REQUEST_FAILED";
      throw error;
    }
    return payload;
  }
}
