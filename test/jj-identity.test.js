import assert from "node:assert/strict";
import test from "node:test";
import {
  JJ_VISUAL_IDENTITY,
  JJ_VISUAL_IDENTITY_SYSTEM_SECTION,
} from "../src/jj-identity.js";
import { IMAGE_PROMPT_SYSTEM_PROMPT } from "../src/discord-bot.js";

test("shares the customizable visual identity with conversation and image prompts", () => {
  assert.match(JJ_VISUAL_IDENTITY, /customizable adult AI team-lead character/);
  assert.match(JJ_VISUAL_IDENTITY_SYSTEM_SECTION, /customizable adult AI team-lead character/);
  assert.match(IMAGE_PROMPT_SYSTEM_PROMPT, /customizable adult AI team-lead character/);
  assert.match(IMAGE_PROMPT_SYSTEM_PROMPT, /Do not insert JJ/);
});
