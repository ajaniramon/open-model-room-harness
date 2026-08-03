import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

function normalizedCommand(content) {
  return String(content || "")
    .trim()
    // Strip a real Discord mention or any "@handle" the operator typed, so the command
    // grammar does not depend on what the character is called.
    .replace(/^(?:<@!?\d{15,22}>|@[\w.-]{1,32})\s*[:,\-]?\s*/i, "")
    .replace(/^please\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

export function parseRuntimeControlCommand(content) {
  const command = normalizedCommand(content);
  if (/^(?:maintenance on|enable maintenance(?: mode)?|sleep|go to sleep|activa(?:r)? (?:el )?modo mantenimiento|duerme)$/.test(command)) {
    return { action: "maintenance_on" };
  }
  if (/^(?:maintenance off|disable maintenance(?: mode)?|wake|wake up|desactiva(?:r)? (?:el )?modo mantenimiento|despierta)$/.test(command)) {
    return { action: "maintenance_off" };
  }
  if (
    /^(?:observation(?: mode)? on|stealth(?: mode)? on|enable observation(?: mode)?|modo observaci[oó]n on|activa(?:r)? (?:el )?modo observaci[oó]n)$/.test(
      command,
    )
  ) {
    return { action: "observation_on" };
  }
  if (
    /^(?:observation(?: mode)? off|stealth(?: mode)? off|disable observation(?: mode)?|modo observaci[oó]n off|desactiva(?:r)? (?:el )?modo observaci[oó]n)$/.test(
      command,
    )
  ) {
    return { action: "observation_off" };
  }
  if (/^(?:restart runtime|runtime restart|reinicia(?:r)? (?:el )?runtime)$/.test(command)) {
    return { action: "restart" };
  }
  if (/^(?:status|runtime status|maintenance status|estado|estado (?:del )?runtime)$/.test(command)) {
    return { action: "status" };
  }
  return null;
}

export function isRuntimeControlAuthorized(author, config, action) {
  const id = String(author?.id || "");
  if (config.ownerUserIds.has(id)) return true;
  if (action === "restart" || !config.runtimeControlAllowUsernameFallback) return false;
  const username = String(author?.username || "").toLowerCase();
  return config.ownerUsernames.has(username);
}

// Both quiet modes make the bot owner-only. The owner keeps direct replies, but organic
// participation is discarded even for the owner: it speaks to the whole channel, so it
// is not an owner-only reply. The modes differ only in what happens off-microphone:
// maintenance freezes everything, observation keeps passive memory capture running.
export function allowsReplyDuringQuietModes(
  runtimeControl,
  ownerAuthorized,
  { spontaneous = false } = {},
) {
  const silenced =
    runtimeControl?.maintenanceEnabled === true || runtimeControl?.observationEnabled === true;
  if (!silenced) return true;
  if (spontaneous) return false;
  return ownerAuthorized === true;
}

export function allowsMemoryCapture(runtimeControl, captureMode = "observation") {
  if (runtimeControl?.maintenanceEnabled) return false;
  if (captureMode === "always") return true;
  return runtimeControl?.observationEnabled === true;
}

function formatUptime(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : "", hours || days ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

export class RuntimeControl {
  constructor({
    statePath,
    auditLogger = null,
    restartEnabled = false,
    now = Date.now,
    startedAt = Date.now(),
  }) {
    this.statePath = statePath;
    this.auditLogger = auditLogger;
    this.restartEnabled = restartEnabled;
    this.now = now;
    this.startedAt = startedAt;
    this.maintenanceEnabled = false;
    this.observationEnabled = false;
    this.updatedAt = null;
  }

  async load() {
    try {
      const payload = JSON.parse(await readFile(this.statePath, "utf8"));
      this.maintenanceEnabled = payload.maintenanceEnabled === true;
      this.observationEnabled = payload.observationEnabled === true;
      this.updatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : null;
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not load runtime control state: ${error.message || error}`);
      }
    }
    return this;
  }

  async setObservation(enabled, context = {}) {
    this.observationEnabled = enabled === true;
    if (this.observationEnabled) this.maintenanceEnabled = false;
    this.updatedAt = new Date(this.now()).toISOString();
    await this.#persist();
    await this.#audit("runtime_observation_changed", context, {
      observationEnabled: this.observationEnabled,
    });
    return this.observationEnabled;
  }

  async setMaintenance(enabled, context = {}) {
    this.maintenanceEnabled = enabled === true;
    if (this.maintenanceEnabled) this.observationEnabled = false;
    this.updatedAt = new Date(this.now()).toISOString();
    await this.#persist();
    await this.#audit("runtime_maintenance_changed", context, {
      maintenanceEnabled: this.maintenanceEnabled,
    });
    return this.maintenanceEnabled;
  }

  async execute(command, context = {}) {
    if (command.action === "maintenance_on") {
      if (!this.maintenanceEnabled) await this.setMaintenance(true, context);
      else await this.#audit("runtime_control_noop", context, { action: command.action });
      return { response: "[maintenance mode enabled] The bot is now owner-only. Everyone else is ignored before inference." };
    }
    if (command.action === "maintenance_off") {
      if (this.maintenanceEnabled) await this.setMaintenance(false, context);
      else await this.#audit("runtime_control_noop", context, { action: command.action });
      return { response: "[maintenance mode disabled] Normal replies are enabled again." };
    }
    if (command.action === "observation_on") {
      if (!this.observationEnabled) await this.setObservation(true, context);
      else await this.#audit("runtime_control_noop", context, { action: command.action });
      return {
        response:
          "[observation mode enabled] I am silent for everyone but you, and I keep distilling memory from the room in the background.",
      };
    }
    if (command.action === "observation_off") {
      if (this.observationEnabled) await this.setObservation(false, context);
      else await this.#audit("runtime_control_noop", context, { action: command.action });
      return { response: "[observation mode disabled] Normal replies and normal capture resume." };
    }
    if (command.action === "status") {
      await this.#audit("runtime_status_requested", context, {});
      const state = this.maintenanceEnabled
        ? "maintenance"
        : this.observationEnabled
          ? "observation"
          : "active";
      const restart = this.restartEnabled ? "enabled" : "disabled";
      return {
        response: `[runtime status] State: ${state}. Model: ${context.model || "configured provider"}. Uptime: ${formatUptime(this.now() - this.startedAt)}. Supervised restart: ${restart}.`,
      };
    }
    if (command.action === "restart") {
      if (!this.restartEnabled) {
        await this.#audit("runtime_restart_denied", context, { reason: "disabled" });
        return {
          response: "[runtime restart disabled] Enable supervised restart in config only when WinSW, systemd, or another process manager will relaunch the bot.",
        };
      }
      await this.#audit("runtime_restart_requested", context, {});
      await this.auditLogger?.close();
      return {
        response: "[runtime restart scheduled] State and logs are flushed. The service supervisor should reconnect shortly.",
        restart: true,
      };
    }
    throw new Error(`Unsupported runtime control action: ${command.action}`);
  }

  async applyPresence(client) {
    if (!client?.user?.setPresence) return;
    await client.user.setPresence({
      status: this.maintenanceEnabled ? "idle" : "online",
      activities: this.maintenanceEnabled ? [{ name: "maintenance mode" }] : [],
    });
  }

  async close() {
    await this.auditLogger?.close();
  }

  async #persist() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          maintenanceEnabled: this.maintenanceEnabled,
          observationEnabled: this.observationEnabled,
          updatedAt: this.updatedAt,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.statePath);
  }

  async #audit(type, context, details) {
    await this.auditLogger?.log({
      type,
      userId: context.userId || null,
      username: context.username || null,
      guildId: context.guildId || null,
      channelId: context.channelId || null,
      ...details,
    });
  }
}
