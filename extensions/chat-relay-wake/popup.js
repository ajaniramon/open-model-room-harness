function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "-";
}

function render(status = {}) {
  document.querySelector("#state").textContent = status.state || "idle";
  document.querySelector("#state").dataset.state = status.state || "idle";
  document.querySelector("#status").textContent = status.message || "No status available";
  document.querySelector("#pending").textContent = Number.isInteger(status.pendingCount) ? status.pendingCount : "-";
  document.querySelector("#checked").textContent = formatTime(status.checkedAt);
  document.querySelector("#trigger").textContent = status.lastTrigger || "-";
  document.querySelector("#next").textContent = formatTime(status.nextAlarmAt);
  document.querySelector("#retry").textContent = formatTime(status.backoffUntil);
  document.querySelector("#attempts").textContent = Number(status.unresolvedAttempts || 0);
}

document.querySelector("#check").addEventListener("click", async () => {
  document.querySelector("#status").textContent = "Checking...";
  render(await chrome.runtime.sendMessage({ type: "chat-relay:check-now" }));
});

document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.sendMessage({ type: "chat-relay:get-status" }).then(render);
