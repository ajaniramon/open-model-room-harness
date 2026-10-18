import { DEFAULT_BACKOFF_SCHEDULE, normalizeBackoffSchedule } from "./backoff.js";

const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  enabled: false,
  ownerOnly: false,
  statusUrl: "http://127.0.0.1:3000/api/chat-relay/wake-status",
  wakeToken: "",
  relayTargetUrl: "",
  fastLaneTargetUrl: "",
  autonomousTargetUrl: "",
  directOwnerEnabled: false,
  ownerTargetUrl: "",
  brokerUrl: "http://127.0.0.1:3400",
  directChatgptToken: "",
  directOwnerAudiences: ["filesystem", "execution", "discord"],
  targetUrl: "",
  pollMinutes: 1,
  fastLaneEnabled: true,
  fastLanePollSeconds: 15,
  cooldownSeconds: 180,
  backoffScheduleMinutes: DEFAULT_BACKOFF_SCHEDULE,
  wakePrompt: "Check and process pending chat relay items.",
  spontaneousWakePrompt: "Check and process pending spontaneous chat relay items. Claim the authoritative item and decide whether to participate or dismiss it.",
  autonomousWakePrompt: "Check and process the pending autonomous opportunity. Claim the authoritative item, inspect its context, and independently decide whether to act or do nothing.",
  autoSubmit: true,
  openIfMissing: false,
  orchestrationDeliveryEnabled: false,
  orchestrationDeliveryUrl: "",
  orchestrationDeliveryToken: "",
};

const form = document.querySelector("#settings-form");
const message = document.querySelector("#message");

function showMessage(text, kind = "success") {
  message.textContent = text;
  message.dataset.kind = kind;
}

async function loadSettings() {
  const settings = await extensionApi.storage.local.get(DEFAULTS);
  settings.relayTargetUrl ||= settings.targetUrl;
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
    else input.value = Array.isArray(value) ? value.join(", ") : String(value);
  }
}

function readSettings() {
  return {
    enabled: form.enabled.checked,
    ownerOnly: form.ownerOnly.checked,
    statusUrl: form.statusUrl.value.trim(),
    wakeToken: form.wakeToken.value.trim(),
    relayTargetUrl: form.relayTargetUrl.value.trim(),
    fastLaneTargetUrl: form.fastLaneTargetUrl.value.trim(),
    autonomousTargetUrl: form.autonomousTargetUrl.value.trim(),
    directOwnerEnabled: form.directOwnerEnabled.checked,
    ownerTargetUrl: form.ownerTargetUrl.value.trim(),
    brokerUrl: form.brokerUrl.value.trim(),
    directChatgptToken: form.directChatgptToken.value.trim(),
    directOwnerAudiences: form.directOwnerAudiences.value.split(",").map((value) => value.trim()).filter(Boolean),
    pollMinutes: Number(form.pollMinutes.value),
    fastLaneEnabled: form.fastLaneEnabled.checked,
    fastLanePollSeconds: Number(form.fastLanePollSeconds.value),
    cooldownSeconds: Number(form.cooldownSeconds.value),
    backoffScheduleMinutes: normalizeBackoffSchedule(form.backoffScheduleMinutes.value),
    wakePrompt: form.wakePrompt.value.trim(),
    spontaneousWakePrompt: form.spontaneousWakePrompt.value.trim(),
    autonomousWakePrompt: form.autonomousWakePrompt.value.trim(),
    autoSubmit: form.autoSubmit.checked,
    openIfMissing: form.openIfMissing.checked,
    orchestrationDeliveryEnabled: form.orchestrationDeliveryEnabled.checked,
    orchestrationDeliveryUrl: form.orchestrationDeliveryUrl.value.trim(),
    orchestrationDeliveryToken: form.orchestrationDeliveryToken.value.trim(),
  };
}

async function requestHarnessPermission(statusUrl) {
  const url = new URL(statusUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote harness status URLs must use HTTPS");
  }
  if (loopback) return true;
  return extensionApi.permissions.request({ origins: [`${url.origin}/*`] });
}

function apiUrlFromStatusUrl(statusUrl, path) {
  const url = new URL(statusUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

async function requestServicePermission(serviceUrl, label = "service") {
  const url = new URL(serviceUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Remote ${label} URLs must use HTTPS`);
  }
  if (loopback) return true;
  return extensionApi.permissions.request({ origins: [`${url.origin}/*`] });
}

async function saveSettings() {
  const settings = readSettings();
  if (!settings.wakePrompt) throw new Error("Wake prompt cannot be empty");
  if (!settings.spontaneousWakePrompt) throw new Error("Spontaneous wake prompt cannot be empty");
  if (!settings.wakeToken) throw new Error("A dedicated wake status token is required");
  if (!settings.autonomousWakePrompt) throw new Error("Autonomous wake prompt cannot be empty");
  for (const [label, value, required] of [
    ["Discord relay", settings.relayTargetUrl, true],
    ["Fast lane", settings.fastLaneTargetUrl, false],
    ["Autonomous", settings.autonomousTargetUrl, false],
  ]) {
    if (!value && !required) continue;
    const targetUrl = new URL(value);
    if (!["chatgpt.com", "chat.openai.com"].includes(targetUrl.hostname) || !targetUrl.pathname.includes("/c/")) {
      throw new Error(`${label} URL must point to an existing ChatGPT conversation`);
    }
  }
  if (settings.directOwnerEnabled) {
    const ownerUrl = new URL(settings.ownerTargetUrl);
    if (!["chatgpt.com", "chat.openai.com"].includes(ownerUrl.hostname) || !ownerUrl.pathname.includes("/c/")) {
      throw new Error("Owner URL must point to an existing ChatGPT conversation");
    }
    if (!settings.directChatgptToken) throw new Error("A direct ChatGPT ingress token is required");
    const allowedAudiences = new Set(["filesystem", "execution", "discord"]);
    if (settings.directOwnerAudiences.length === 0 || settings.directOwnerAudiences.some((value) => !allowedAudiences.has(value))) {
      throw new Error("Direct owner audiences may contain only filesystem, execution, and discord");
    }
    if (!(await requestServicePermission(settings.brokerUrl, "broker"))) {
      throw new Error("Permission to contact the capability broker was not granted");
    }
  }
  if (settings.orchestrationDeliveryEnabled) {
    if (!settings.orchestrationDeliveryUrl) throw new Error("An orchestration delivery URL is required");
    if (!settings.orchestrationDeliveryToken) throw new Error("An orchestration delivery token is required");
    if (!(await requestServicePermission(settings.orchestrationDeliveryUrl, "orchestration delivery"))) {
      throw new Error("Permission to contact the orchestration delivery service was not granted");
    }
  }
  const permissionGranted = await requestHarnessPermission(settings.statusUrl);
  if (!permissionGranted) throw new Error("Permission to contact the harness URL was not granted");
  await extensionApi.storage.local.set(settings);
  return settings;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveSettings();
    showMessage("Settings saved.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), "error");
  }
});

document.querySelector("#test").addEventListener("click", async () => {
  try {
    await saveSettings();
    showMessage("Checking harness...");
    const status = await extensionApi.runtime.sendMessage({ type: "chat-relay:check-now", force: true });
    showMessage(status?.message || "Check completed.", status?.state === "error" ? "error" : "success");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), "error");
  }
});

document.querySelector("#flushQueue").addEventListener("click", async () => {
  try {
    const settings = await saveSettings();
    const includeLeased = form.flushLeased.checked;
    const warning = includeLeased
      ? "Flush all pending and leased relay items? Any in-progress worker will fail to complete its current item."
      : "Flush all pending relay items?";
    if (!confirm(warning)) return;
    const url = apiUrlFromStatusUrl(settings.statusUrl, "/api/chat-relay/flush");
    showMessage("Flushing relay queue...");
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${settings.wakeToken}`,
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "chat-relay-wake",
      },
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({
        reason: "operator_flush_from_wake_options",
        includeLeased,
      }),
    });
    if (!response.ok) throw new Error(`Harness returned HTTP ${response.status}`);
    const result = await response.json();
    showMessage(`Relay queue flushed: removed ${result.removed || 0} item(s).`);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), "error");
  }
});

loadSettings().catch((error) => showMessage(String(error), "error"));
