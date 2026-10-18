const extensionApi = globalThis.browser ?? globalThis.chrome;
function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "-";
}

function render(status = {}) {
  document.querySelector("#state").textContent = status.state || "idle";
  document.querySelector("#state").dataset.state = status.state || "idle";
  document.querySelector("#status").textContent = status.message || "No status available";
  document.querySelector("#queue-view").textContent = status.ownerOnly ? "Owner DMs only" : "All relay work";
  document.querySelector("#pending").textContent = Number.isInteger(status.pendingCount) ? status.pendingCount : "-";
  document.querySelector("#direct").textContent = Number.isInteger(status.directPendingCount) ? status.directPendingCount : "-";
  document.querySelector("#spontaneous").textContent = Number.isInteger(status.spontaneousPendingCount) ? status.spontaneousPendingCount : "-";
  document.querySelector("#autonomous").textContent = Number.isInteger(status.autonomousPendingCount) ? status.autonomousPendingCount : "-";
  document.querySelector("#kind").textContent = status.oldestPendingKind || "-";
  document.querySelector("#checked").textContent = formatTime(status.checkedAt);
  document.querySelector("#trigger").textContent = status.lastTrigger || "-";
  document.querySelector("#next").textContent = formatTime(status.nextAlarmAt);
  document.querySelector("#retry").textContent = formatTime(status.backoffUntil);
  document.querySelector("#attempts").textContent = Number(status.unresolvedAttempts || 0);
  const ownerDiagnostic = status.ownerLaneDiagnostic;
  document.querySelector("#owner-lane").textContent = ownerDiagnostic
    ? `${ownerDiagnostic.state} ${JSON.stringify(ownerDiagnostic.details || {})}`
    : "-";
}

document.querySelector("#check").addEventListener("click", async () => {
  document.querySelector("#status").textContent = "Checking...";
  render(await extensionApi.runtime.sendMessage({ type: "chat-relay:check-now" }));
});

async function openSettingsPage() {
  if (typeof extensionApi.runtime.openOptionsPage === "function") {
    try {
      await extensionApi.runtime.openOptionsPage();
      return;
    } catch {
      // Temporary Firefox add-ons may not surface the options UI consistently.
    }
  }
  const url = extensionApi.runtime.getURL("options.html");
  globalThis.open(url, "_blank", "noopener");
}

document.querySelector("#settings").addEventListener("click", () => {
  openSettingsPage().catch((error) => {
    document.querySelector("#status").textContent = error instanceof Error ? error.message : String(error);
  });
});

extensionApi.runtime.sendMessage({ type: "chat-relay:get-status" }).then(render);
