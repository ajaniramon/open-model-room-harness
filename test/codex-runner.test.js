import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildCodexArgs,
  CodexRunner,
  DELEGATE_CODEX_SYSTEM_PROMPT,
  sanitizedCodexEnvironment,
} from "../src/codex-runner.js";

test("builds an ephemeral workspace-write Codex invocation", () => {
  const args = buildCodexArgs("C:\\bounded-workspace", "create demo.txt");
  assert.deepEqual(args.slice(0, 4), [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
    "--sandbox",
    "workspace-write",
  ]);
  assert.equal(args[args.indexOf("-C") + 1], "C:\\bounded-workspace");
  assert.match(args.at(-1), new RegExp(DELEGATE_CODEX_SYSTEM_PROMPT.slice(0, 30)));
  assert.match(args.at(-1), /create demo\.txt/);
});

test("builds project work with a workspace-write sandbox", () => {
  const args = buildCodexArgs(
    "C:\\workspace\\jj-discord-bot",
    "assess the implementation plan",
    "workspace-write",
  );
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
    "--sandbox",
    "workspace-write",
  ]);
  assert.equal(args[args.indexOf("-C") + 1], "C:\\workspace\\jj-discord-bot");
});

test("does not pass JJ credentials to delegated Codex", () => {
  const sanitized = sanitizedCodexEnvironment({
    PATH: "safe-path",
    DISCORD_TOKEN: "discord-secret",
    NANOGPT_API_KEY: "nano-secret",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    XAI_API_KEY: "xai-secret",
    GEMINI_API_KEY: "gemini-secret",
    TAVILY_API_KEY: "tavily-secret",
    UNRELATED_SETTING: "kept",
  });
  assert.deepEqual(sanitized, {
    PATH: "safe-path",
    UNRELATED_SETTING: "kept",
  });
});

test("routes named project work to the real project with write access", async () => {
  let invocation;
  const projectWorkspace = process.cwd();
  const fakeSpawn = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    queueMicrotask(() => {
      child.stdout.write("Implemented requested change");
      child.stdout.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const runner = new CodexRunner({
    executable: "codex.exe",
    workspace: projectWorkspace,
    projectWorkspace,
    spawnImplementation: fakeSpawn,
  });

  const result = await runner.run("implement the plan", { useProjectWorkspace: true });
  assert.equal(invocation.options.cwd, projectWorkspace);
  assert.deepEqual(
    invocation.args.slice(
      invocation.args.indexOf("--sandbox"),
      invocation.args.indexOf("--sandbox") + 2,
    ),
    ["--sandbox", "workspace-write"],
  );
  assert.equal(result, "CODEX RESULT:\nImplemented requested change");
});
