import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  isApprovedExternalUrl,
  SILICON_DREAMER_URL,
} from "../scripts/external-links.js";

const root = resolve(import.meta.dirname, "..");

test("ships the opt-in Silicon Dreamer keygen soundtrack", async () => {
  const [html, app, styles, scanner, notices, audio] = await Promise.all([
    readFile(resolve(root, "installer", "index.html"), "utf8"),
    readFile(resolve(root, "installer", "app.js"), "utf8"),
    readFile(resolve(root, "installer", "styles.css"), "utf8"),
    readFile(resolve(root, "scripts", "check-secrets.js"), "utf8"),
    readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    stat(resolve(root, "silicon-dreamer.mp3")),
  ]);
  assert.ok(audio.size > 1_000_000, "soundtrack asset is unexpectedly small");
  assert.match(html, /Open Model Room/);
  assert.match(html, /Avizura - Silicon Dreamer/);
  assert.match(html, /id="soundtrack-toggle"/);
  assert.doesNotMatch(html, /<audio[^>]+autoplay/i);
  assert.match(app, /TRACK_CUE_SECONDS = 25/);
  assert.match(app, /TRACK_FADE_MS = 2_200/);
  assert.match(app, /1 - Math\.cos\(progress \* Math\.PI\)/);
  assert.match(styles, /keygen-wordmark/);
  assert.match(styles, /mini-spectrum/);
  assert.match(scanner, /"silicon-dreamer\.mp3"/);
  assert.match(notices, /included.+artist's\s+permission/is);
});

test("allows only the credited Newgrounds page through the Electron bridge", () => {
  assert.equal(isApprovedExternalUrl(SILICON_DREAMER_URL), true);
  assert.equal(isApprovedExternalUrl(`${SILICON_DREAMER_URL}?utm_source=spoof`), false);
  assert.equal(isApprovedExternalUrl("https://example.com/"), false);
  assert.equal(isApprovedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isApprovedExternalUrl(null), false);
});
