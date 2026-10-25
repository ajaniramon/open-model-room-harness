const extensionApi = globalThis.browser ?? globalThis.chrome;
const COMPOSER_SELECTORS = [
  "#prompt-textarea[contenteditable='true']",
  "textarea#prompt-textarea",
  "div[contenteditable='true'][data-virtualkeyboard='true']",
  "main form div[contenteditable='true']",
];

const SEND_BUTTON_SELECTORS = [
  "[data-testid='send-button']",
  "[data-testid='composer-send-button']",
  "[data-testid='send-prompt-button']",
  "[role='button'][aria-label='Send']",
  "[role='button'][aria-label='Send message']",
  "[role='button'][aria-label='Send prompt']",
  "button[aria-label='Send']",
  "button[aria-label='Send message']",
  "button[aria-label='Send prompt']",
];

const STOP_BUTTON_SELECTORS = [
  "button[data-testid='stop-button']",
  "button[data-testid='stop-response-button']",
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
  "[data-is-streaming='true']",
  ".result-streaming",
];

const HEARTBEAT_INTERVAL_MS = 15_000;
const OWNER_EVENT_MARKER = "Trusted owner capability event reference";
let ownerLaneSettings = { directOwnerEnabled: false, ownerTargetUrl: "" };
let ownerAttestationInFlight = false;
let lastObservedBusy = null;
let activeOrchestrationTurnKey = null;
const pendingOrchestrationTurnEvents = [];
let heartbeatIntervalId = null;

function normalizedTaskUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function refreshOwnerLaneSettings() {
  ownerLaneSettings = await extensionApi.storage.local.get({ directOwnerEnabled: false, ownerTargetUrl: "" });
  reportOwnerLaneDiagnostic(isOwnerLane() ? "armed" : ownerLaneSettings.directOwnerEnabled ? "url-mismatch" : "disabled");
}

function isOwnerLane() {
  return ownerLaneSettings.directOwnerEnabled === true &&
    normalizedTaskUrl(location.href) === normalizedTaskUrl(ownerLaneSettings.ownerTargetUrl);
}

function reportOwnerLaneDiagnostic(state, details = {}) {
  try {
    const pending = extensionApi.runtime.sendMessage({
      type: "chat-relay:owner-lane-diagnostic",
      state,
      details,
    });
    pending?.catch?.(() => {});
  } catch {}
}

function sendHeartbeat() {
  try {
    const pending = extensionApi.runtime.sendMessage({ type: "chat-relay:heartbeat" });
    pending?.catch?.(() => {});
  } catch {
    if (heartbeatIntervalId !== null) clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

heartbeatIntervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
sendHeartbeat();
refreshOwnerLaneSettings().catch(() => {});
extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.directOwnerEnabled || changes.ownerTargetUrl)) {
    refreshOwnerLaneSettings().catch(() => {});
  }
});

function firstMatch(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function composerText(composer) {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value.trim();
  }
  return (composer.textContent || "").trim();
}

function isBusy() {
  return Boolean(firstMatch(STOP_BUTTON_SELECTORS));
}

function eventElementTarget(event) {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof Element) return candidate;
  }
  return event.target instanceof Element ? event.target : null;
}

function isComposerEventTarget(target) {
  const composer = firstMatch(COMPOSER_SELECTORS);
  return composer instanceof HTMLElement && target instanceof Node &&
    (composer === target || composer.contains(target) || composer.contains(document.activeElement));
}

function hasOwnerComposerDraft() {
  const composer = firstMatch(COMPOSER_SELECTORS);
  return composer instanceof HTMLElement && Boolean(composerText(composer));
}

function interceptOwnerEnter(event) {
  if (!event.isTrusted || !isOwnerLane() || ownerAttestationInFlight || isBusy() || !hasOwnerComposerDraft()) return;
  attestAndSubmitOwnerMessage(event);
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function observeOrchestrationTurn() {
  const busy = isBusy();
  if (lastObservedBusy === null) {
    lastObservedBusy = busy;
    return;
  }

  if (busy && !lastObservedBusy) {
    activeOrchestrationTurnKey = `browser-turn-${crypto.randomUUID()}`;
    pendingOrchestrationTurnEvents.push({
      eventId: `browser-event-${crypto.randomUUID()}`,
      externalTurnKey: activeOrchestrationTurnKey,
      eventType: "started",
      evidence: { observedBusyTransition: "idle_to_busy" },
    });
  } else if (!busy && lastObservedBusy && activeOrchestrationTurnKey) {
    pendingOrchestrationTurnEvents.push({
      eventId: `browser-event-${crypto.randomUUID()}`,
      externalTurnKey: activeOrchestrationTurnKey,
      eventType: "completed",
      evidence: { observedBusyTransition: "busy_to_idle" },
    });
    activeOrchestrationTurnKey = null;
  }
  lastObservedBusy = busy;
}

function acknowledgeOrchestrationTurnEvents(eventIds) {
  const accepted = new Set(Array.isArray(eventIds) ? eventIds : []);
  for (let index = pendingOrchestrationTurnEvents.length - 1; index >= 0; index -= 1) {
    if (accepted.has(pendingOrchestrationTurnEvents[index].eventId)) {
      pendingOrchestrationTurnEvents.splice(index, 1);
    }
  }
}

function insertPrompt(composer, prompt) {
  composer.focus();

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
    if (setter) setter.call(composer, prompt);
    else composer.value = prompt;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    return composerText(composer) === prompt;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, prompt);
  } catch {
    inserted = false;
  }

  if (!inserted || composerText(composer) !== prompt) {
    composer.textContent = prompt;
  }
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  return composerText(composer) === prompt;
}

async function waitForEnabledSendButton(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = firstMatch(COMPOSER_SELECTORS);
    const form = composer instanceof HTMLElement ? composer.closest("form") : null;
    const candidates = new Set([
      ...document.querySelectorAll(SEND_BUTTON_SELECTORS.join(",")),
      ...(form ? form.querySelectorAll("button[type='submit']") : []),
    ]);
    for (const control of candidates) {
      if (control instanceof HTMLElement && control.isConnected && isVisible(control) &&
        control.getAttribute("aria-disabled") !== "true" &&
        control.getAttribute("data-disabled") !== "true" &&
        !(control instanceof HTMLButtonElement && control.disabled)) {
        return control;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function waitForComposerUpdate() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, 250);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function waitForSubmission(composer, previousUserMessageCount, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const userMessageCount = document.querySelectorAll("[data-message-author-role='user']").length;
    if (!composer.isConnected || !composerText(composer) || isBusy() || userMessageCount > previousUserMessageCount) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function handleWake({ prompt, autoSubmit }) {
  if (isBusy()) {
    return { status: "deferred", reason: "ChatGPT is currently responding" };
  }

  const composer = firstMatch(COMPOSER_SELECTORS);
  if (!(composer instanceof HTMLElement)) {
    return { status: "deferred", reason: "ChatGPT composer was not found" };
  }

  if (composerText(composer)) {
    return { status: "deferred", reason: "ChatGPT composer contains an unsent draft" };
  }

  if (!insertPrompt(composer, String(prompt || "").trim())) {
    return { status: "failed", reason: "Wake prompt could not be inserted" };
  }

  if (!autoSubmit) {
    return { status: "inserted" };
  }

  // ChatGPT can replace the composer and send control after processing the input event.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sendButton = await waitForEnabledSendButton();
  if (!sendButton) {
    return { status: "failed", reason: "ChatGPT send button did not become available" };
  }

  const previousUserMessageCount = document.querySelectorAll("[data-message-author-role='user']").length;
  if (!sendButton.isConnected || !isVisible(sendButton) || sendButton.getAttribute("aria-disabled") === "true" ||
    sendButton.getAttribute("data-disabled") === "true" ||
    (sendButton instanceof HTMLButtonElement && sendButton.disabled)) {
    return { status: "failed", reason: "ChatGPT send button was replaced before submission" };
  }
  sendButton.click();
  if (!(await waitForSubmission(composer, previousUserMessageCount))) {
    return { status: "failed", reason: "ChatGPT did not confirm prompt submission" };
  }
  return { status: "submitted" };
}

function ignoredOwnerSubmit(reason, notify) {
  if (notify) window.alert(`Attested send was not started.\n\n${reason}`);
  return { status: "ignored", reason };
}

async function attestAndSubmitOwnerDraft(event = null, { notifyIgnored = false } = {}) {
  if (!isOwnerLane()) return ignoredOwnerSubmit("This tab is not the configured owner ChatGPT conversation.", notifyIgnored);
  if (ownerAttestationInFlight) return ignoredOwnerSubmit("An owner attestation is already in progress.", notifyIgnored);
  if (isBusy()) return ignoredOwnerSubmit("ChatGPT is still generating a response.", notifyIgnored);
  const composer = firstMatch(COMPOSER_SELECTORS);
  if (!(composer instanceof HTMLElement)) return ignoredOwnerSubmit("The ChatGPT composer was not found.", notifyIgnored);
  const messageText = composerText(composer);
  if (!messageText) return ignoredOwnerSubmit("There is no message to send.", notifyIgnored);
  if (messageText.includes(OWNER_EVENT_MARKER)) return ignoredOwnerSubmit("This message already contains an owner attestation.", notifyIgnored);

  event?.preventDefault();
  event?.stopImmediatePropagation();
  ownerAttestationInFlight = true;
  reportOwnerLaneDiagnostic("intercepted");
  try {
    const attestation = await extensionApi.runtime.sendMessage({
      type: "chat-relay:attest-owner-message",
      messageText,
    });
    if (attestation?.status !== "attested" || !attestation.eventRef) {
      throw new Error(attestation?.reason || "Owner attestation was not issued");
    }

    const taggedMessage = `${messageText}\n\n[${OWNER_EVENT_MARKER}: ${attestation.eventRef}. Use this as capabilityEventRef for privileged tools in this turn.]`;
    if (!insertPrompt(composer, taggedMessage)) {
      throw new Error("Owner event reference could not be attached to the message");
    }
    await waitForComposerUpdate();
    const taggedComposer = firstMatch(COMPOSER_SELECTORS);
    const retainedMessage = taggedComposer instanceof HTMLElement ? composerText(taggedComposer) : "";
    if (!retainedMessage.includes(OWNER_EVENT_MARKER) || !retainedMessage.includes(attestation.eventRef)) {
      throw new Error("ChatGPT did not retain the owner event reference in the composer");
    }
    const sendButton = await waitForEnabledSendButton();
    if (!sendButton) throw new Error("ChatGPT send button did not become available");
    const previousUserMessageCount = document.querySelectorAll("[data-message-author-role='user']").length;
    sendButton.click();
    if (!(await waitForSubmission(taggedComposer, previousUserMessageCount))) {
      throw new Error("ChatGPT did not confirm the attested message submission");
    }
    return { status: "submitted" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    window.alert(`Owner attestation failed; the message was not sent.\n\n${reason}`);
    return { status: "failed", reason };
  } finally {
    ownerAttestationInFlight = false;
  }
}

async function attestAndSubmitOwnerMessage(event) {
  if (!event.isTrusted || !isOwnerLane()) return;
  return attestAndSubmitOwnerDraft(event);
}

document.addEventListener("click", (event) => {
  const target = eventElementTarget(event);
  const control = event.composedPath().find((candidate) =>
    candidate instanceof Element && candidate.matches("button,[role='button']"));
  if (control) {
    reportOwnerLaneDiagnostic("control-click", {
      tag: control.tagName.toLowerCase(),
      role: control.getAttribute("role") || "",
      ariaLabel: control.getAttribute("aria-label") || "",
      testId: control.getAttribute("data-testid") || "",
      sendMatch: Boolean(target?.closest(SEND_BUTTON_SELECTORS.join(","))),
    });
  }
  if (target?.closest(SEND_BUTTON_SELECTORS.join(","))) {
    reportOwnerLaneDiagnostic("send-control-matched");
    attestAndSubmitOwnerMessage(event);
  }
}, true);

window.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  if (!isComposerEventTarget(event.target) && !hasOwnerComposerDraft()) return;
  interceptOwnerEnter(event);
}, true);

window.addEventListener("beforeinput", (event) => {
  if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
  interceptOwnerEnter(event);
}, true);

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "chat-relay:attested-owner-submit") {
    attestAndSubmitOwnerDraft(null, { notifyIgnored: true }).then(sendResponse).catch((error) => {
      sendResponse({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message?.type === "chat-relay:orchestration-state") {
    const composer = firstMatch(COMPOSER_SELECTORS);
    observeOrchestrationTurn();
    sendResponse({
      observedUrl: location.href,
      busy: isBusy(),
      hasDraft: composer instanceof HTMLElement ? Boolean(composerText(composer)) : false,
      ready: !isBusy() && composer instanceof HTMLElement && !composerText(composer),
      turnEvents: pendingOrchestrationTurnEvents,
    });
    return false;
  }
  if (message?.type === "chat-relay:orchestration-turn-events-ack") {
    acknowledgeOrchestrationTurnEvents(message.eventIds);
    sendResponse({ status: "acknowledged" });
    return false;
  }
  if (message?.type !== "chat-relay:wake" && message?.type !== "chat-relay:orchestration-submit") return false;
  const payload = message?.type === "chat-relay:orchestration-submit"
    ? { ...(message.payload || {}), autoSubmit: true }
    : message.payload || {};
  handleWake(payload).then(sendResponse).catch((error) => {
    sendResponse({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
