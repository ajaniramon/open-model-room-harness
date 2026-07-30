import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "coverage",
  "artifacts",
  "assets",
  "logs",
  "state",
  "codex-workspace",
  "site-dist",
]);
const forbiddenNames = new Set([".env", "system-prompt.txt"]);
const forbiddenMedia = new Set([".gif", ".jpeg", ".jpg", ".mp3", ".png", ".webp"]);
const allowedPublicMedia = new Set([
  "site/public/luca.png",
  "site/public/og.png",
  "site/public/open-model-room-mark.png",
]);
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["xAI API key", /\bxai-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ["Tavily API key", /\btvly-[A-Za-z0-9_-]{20,}\b/],
  ["Discord bot token", /\b(?:M|N)[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/],
  ["64-character hexadecimal secret", /\b[a-f0-9]{64}\b/i],
];

const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const absolutePath = resolve(directory, entry.name);
    const displayPath = relative(root, absolutePath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      await walk(absolutePath);
      continue;
    }

    if (forbiddenNames.has(entry.name)) {
      findings.push(`${displayPath}: forbidden private file`);
      continue;
    }

    if (
      forbiddenMedia.has(extname(entry.name).toLowerCase()) &&
      !allowedPublicMedia.has(displayPath)
    ) {
      findings.push(`${displayPath}: media files must not be committed`);
      continue;
    }

    const contents = await readFile(absolutePath, "utf8").catch(() => "");
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(contents)) findings.push(`${displayPath}: possible ${label}`);
    }
  }
}

await walk(root);

if (findings.length) {
  console.error("Secret scan failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Secret scan passed.");
}
