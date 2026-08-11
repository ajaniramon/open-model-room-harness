export const DEFAULT_BACKOFF_SCHEDULE = Object.freeze([5, 15, 30, 60]);

export function normalizeBackoffSchedule(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const entries = values
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
    .map((entry) => Math.min(1440, Math.max(0.5, entry)))
    .slice(0, 8);

  if (entries.length === 0) return [...DEFAULT_BACKOFF_SCHEDULE];

  const schedule = [];
  for (const entry of entries) {
    schedule.push(Math.max(entry, schedule.at(-1) || 0.5));
  }
  return schedule;
}

export function backoffMinutesForAttempt(schedule, attempt) {
  const normalized = normalizeBackoffSchedule(schedule);
  const index = Math.min(normalized.length - 1, Math.max(0, Math.trunc(Number(attempt) || 1) - 1));
  return normalized[index];
}

export function activeCircuitForItem(previous, itemId) {
  return itemId && previous?.itemId === itemId ? previous : null;
}

export function createWakeCircuitState({ previous, itemId, now, schedule }) {
  if (!itemId) return null;
  const active = activeCircuitForItem(previous, itemId);
  const attempts = Number(active?.attempts || 0) + 1;
  return {
    itemId,
    attempts,
    lastWakeAt: now,
    backoffUntil: now + backoffMinutesForAttempt(schedule, attempts) * 60_000,
  };
}
