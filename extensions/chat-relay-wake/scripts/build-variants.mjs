import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const sharedFiles = [
  "background.js",
  "backoff.js",
  "content.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "relay-status.js",
  "styles.css",
  "wake-prompt.js",
];

async function buildVariant(name, manifestFile) {
  const target = join(dist, name);
  await mkdir(target, { recursive: true });
  await Promise.all(sharedFiles.map((file) => cp(join(root, file), join(target, file))));
  const manifest = await readFile(join(root, manifestFile), "utf8");
  await writeFile(join(target, "manifest.json"), manifest);
}

await rm(dist, { recursive: true, force: true });
await Promise.all([
  buildVariant("chrome", "manifest.json"),
  buildVariant("firefox", "manifest.firefox.json"),
]);

console.log("Built Chrome and Firefox extension variants in dist/.");
