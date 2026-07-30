import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AudioModeState,
  ElevenLabsTtsClient,
  prepareSpeechText,
} from "../src/audio-mode.js";

test("persists the global audio mode flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "jj-audio-state-"));
  const path = join(root, "state", "audio-mode.json");
  try {
    const state = new AudioModeState(path);
    assert.equal(await state.load(), false);
    assert.equal(await state.set(true), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true });
    assert.equal(await new AudioModeState(path).load(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calls ElevenLabs v3 and returns an MP3 buffer", async () => {
  let request;
  const mockFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(Uint8Array.from([0x49, 0x44, 0x33, 0x03]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };
  const client = new ElevenLabsTtsClient(
    {
      elevenLabsApiKey: "xi-test",
      elevenLabsVoiceId: "voice-id",
      elevenLabsModelId: "eleven_v3",
      elevenLabsOutputFormat: "mp3_44100_128",
      elevenLabsTimeoutMs: 5_000,
      audioMaxChars: 1_200,
      audioMaxBytes: 8_000_000,
    },
    mockFetch,
  );
  const audio = await client.synthesize("[giggles] That build actually passed.");
  assert.equal(
    request.url,
    "https://api.elevenlabs.io/v1/text-to-speech/voice-id?output_format=mp3_44100_128",
  );
  assert.equal(request.options.headers["xi-api-key"], "xi-test");
  assert.deepEqual(request.body, {
    text: "[giggles] That build actually passed.",
    model_id: "eleven_v3",
  });
  assert.deepEqual([...audio], [0x49, 0x44, 0x33, 0x03]);
});

test("caps spoken scripts without cutting the final upload contract", () => {
  const speech = prepareSpeechText(`${"Short sentence. ".repeat(100)}Final.`, 240);
  assert.ok(speech.length <= 240);
  assert.match(speech, /…$/);
});
