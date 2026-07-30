import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRunner } from "../src/codex-runner.js";
import { config } from "../src/config.js";
import { parseCodexDelegation } from "../src/discord-bot.js";

const exactDiscordMessage =
  "@JJ please spawn codex agent to assess memory-implementation-plan. Tell him to find selta-discord directory and cross the file with the codebase and advise if viable";
const parsed = parseCodexDelegation(exactDiscordMessage);
if (!parsed) throw new Error("The exact Discord smoke-test message did not parse.");

const runner = new CodexRunner({
  executable: config.codexExecutable,
  workspace: config.codexWorkspace,
  projectWorkspace: config.codexProjectWorkspace,
  timeoutMs: config.codexTimeoutMs,
  maxTaskChars: config.codexMaxTaskChars,
  maxResultChars: config.codexMaxResultChars,
});
const result = await runner.run(parsed.task, { useProjectWorkspace: true });
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "logs", "codex-delegation-smoke.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(
    {
      exactDiscordMessage,
      parsed,
      mode: "project-workspace-write",
      passed: result.startsWith("CODEX RESULT:"),
      result,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(outputPath);
