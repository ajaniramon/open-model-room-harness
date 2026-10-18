export function normalizeRelayStatus(payload = {}) {
  const pendingCount = Number(payload.pendingCount);
  const activeCount = Number(payload.activeCount ?? payload.pendingCount);
  const leasedCount = Number(payload.leasedCount ?? Math.max(0, activeCount - pendingCount));
  if (!Number.isInteger(pendingCount) || pendingCount < 0) {
    throw new Error("Harness response does not contain a valid pendingCount");
  }
  if (!Number.isInteger(activeCount) || !Number.isInteger(leasedCount) || leasedCount < 0 || pendingCount + leasedCount !== activeCount) {
    throw new Error("Harness response does not contain valid active relay counts");
  }

  const spontaneousPendingCount = Number(payload.spontaneousPendingCount ?? 0);
  const autonomousPendingCount = Number(payload.autonomousPendingCount ?? 0);
  const directPendingCount = Number(
    payload.directPendingCount ?? (pendingCount - spontaneousPendingCount - autonomousPendingCount),
  );
  if (
    !Number.isInteger(spontaneousPendingCount) || spontaneousPendingCount < 0 ||
    !Number.isInteger(autonomousPendingCount) || autonomousPendingCount < 0 ||
    !Number.isInteger(directPendingCount) || directPendingCount < 0 ||
    spontaneousPendingCount + autonomousPendingCount + directPendingCount !== pendingCount
  ) {
    throw new Error("Harness response contains invalid pending-kind counts");
  }

  const pendingKey = String(payload.pendingKey || "");
  const oldestPendingId = payload.oldestPendingId ? String(payload.oldestPendingId) : pendingKey.split(",")[0];
  const fastLanePendingCount = Number(payload.fastLanePendingCount ?? 0);
  const fastLaneActiveCount = Number(payload.fastLaneActiveCount ?? fastLanePendingCount);
  if (
    !Number.isInteger(fastLanePendingCount) || fastLanePendingCount < 0 ||
    !Number.isInteger(fastLaneActiveCount) || fastLaneActiveCount < 0
  ) {
    throw new Error("Harness response contains invalid fast-lane counts");
  }
  const fastLanePendingKey = String(payload.fastLanePendingKey || "");
  const oldestFastLanePendingId = payload.oldestFastLanePendingId
    ? String(payload.oldestFastLanePendingId)
    : fastLanePendingKey.split(",")[0];
  return {
    enabled: payload.enabled !== false,
    pendingCount,
    directPendingCount,
    spontaneousPendingCount,
    autonomousPendingCount,
    fastLanePendingCount,
    fastLaneActiveCount,
    leasedCount,
    activeCount,
    pendingKey,
    oldestPendingId,
    oldestPendingKind: ["spontaneous", "autonomous"].includes(payload.oldestPendingKind)
      ? payload.oldestPendingKind
      : oldestPendingId
        ? "direct"
        : null,
    activeKey: String(payload.activeKey || payload.pendingKey || ""),
    oldestActiveId: payload.oldestActiveId
      ? String(payload.oldestActiveId)
      : String(payload.oldestPendingId || payload.pendingKey || "").split(",")[0],
    fastLanePendingKey,
    fastLaneActiveKey: String(payload.fastLaneActiveKey || payload.fastLanePendingKey || ""),
    oldestFastLanePendingId,
    oldestFastLanePendingKind: oldestFastLanePendingId ? "direct" : null,
    oldestFastLaneActiveId: payload.oldestFastLaneActiveId
      ? String(payload.oldestFastLaneActiveId)
      : String(payload.oldestFastLanePendingId || payload.fastLanePendingKey || "").split(",")[0],
  };
}

export function relayForFastLane(relay) {
  if (!relay || relay.fastLanePendingCount <= 0 || !relay.oldestFastLanePendingId) return null;
  return {
    ...relay,
    pendingCount: relay.fastLanePendingCount,
    directPendingCount: relay.fastLanePendingCount,
    spontaneousPendingCount: 0,
    autonomousPendingCount: 0,
    activeCount: relay.fastLaneActiveCount,
    pendingKey: relay.fastLanePendingKey,
    activeKey: relay.fastLaneActiveKey,
    oldestPendingId: relay.oldestFastLanePendingId,
    oldestPendingKind: "direct",
    oldestActiveId: relay.oldestFastLaneActiveId || relay.oldestFastLanePendingId,
  };
}

export function wakePromptForRelay(settings, relay) {
  if (relay.oldestPendingKind === "spontaneous") {
    return settings.spontaneousWakePrompt || settings.wakePrompt;
  }
  if (relay.oldestPendingKind === "autonomous") {
    return settings.autonomousWakePrompt || settings.wakePrompt;
  }
  return settings.wakePrompt;
}

export function targetUrlForRelay(settings, relay) {
  return relay.oldestPendingKind === "autonomous"
    ? settings.autonomousTargetUrl
    : settings.relayTargetUrl;
}
