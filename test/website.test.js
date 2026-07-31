import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localeNames, locales } from "../site/src/translations.js";

const root = resolve(import.meta.dirname, "..");

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
  }
  return typeof value;
}

test("ships every requested website locale with the complete English structure", () => {
  assert.deepEqual(Object.keys(locales), ["en", "ko", "ja", "pt", "de"]);
  assert.deepEqual(Object.keys(localeNames), Object.keys(locales));
  const englishShape = shape(locales.en);
  for (const [code, locale] of Object.entries(locales)) {
    assert.deepEqual(shape(locale), englishShape, `${code} must cover every translated field`);
    assert.equal(locale.providers.items.length, 6);
    assert.equal(locale.features.items.length, 8);
    assert.equal(locale.how.steps.length, 4);
    assert.equal(locale.faq.items.length, 5);
  }
});

test("website copy is substantial in every language", () => {
  for (const [code, locale] of Object.entries(locales)) {
    const characters = JSON.stringify(locale).length;
    assert.ok(characters > 4_500, `${code} copy is unexpectedly thin (${characters})`);
  }
});

test("website includes Luca, the wordmark, social card, and Pages marker", async () => {
  for (const file of [
    "site/public/luca.png",
    "site/public/open-model-room-mark.png",
    "site/public/og.png",
    "site/public/.nojekyll",
  ]) {
    await access(resolve(root, file));
  }
  const html = await readFile(resolve(root, "site", "index.html"), "utf8");
  assert.match(html, /Open Model Room/);
  assert.match(html, /github\.io\/open-model-room-harness\/og\.png/);
});

test("website and desktop installer expose the local OpenAI-compatible route", async () => {
  const copy = JSON.stringify(locales.en);
  const installer = await readFile(resolve(root, "installer", "index.html"), "utf8");
  const installerApp = await readFile(resolve(root, "installer", "app.js"), "utf8");
  assert.match(copy, /llama\.cpp/);
  assert.match(copy, /vLLM/);
  assert.match(installer, /local-base-url/);
  assert.match(installerApp, /provider === "local"/);
});
