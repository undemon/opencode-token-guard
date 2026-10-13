import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { countRequest, guardRequest } from "../src/guard.ts";
import { createLocalCounter } from "../src/tokenizer/local.ts";
import type { MessageLike } from "../src/text.ts";

const tokenizerPath = fileURLToPath(new URL("../models/tokenizer.json", import.meta.url));
const available = existsSync(tokenizerPath);
const skip = available ? false : `tokenizer file not found: ${tokenizerPath}`;

function checkpoint(recent: string): MessageLike {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<conversation-checkpoint><summary>brief summary</summary><recent-context>${recent}</recent-context></conversation-checkpoint>`,
      },
    ],
  };
}

/**
 * A realistic "recent": token-dense structured data plus some prose. Structured
 * data and non-Latin scripts are exactly where the core's chars/4 heuristic
 * underestimates the most.
 */
function bigRecent(): string {
  const json = JSON.stringify({
    status: "ok",
    items: Array.from({ length: 40 }, (_, i) => ({ id: i, tags: ["alpha", "beta"] })),
  });
  const prose = "A short prose sample used to vary token density across the fixture. ";
  return (json.repeat(70) + prose.repeat(150)).slice(0, 120_000);
}

test("real tokenizer: an oversized checkpoint is trimmed to the budget, the tail is preserved", { skip }, () => {
  const counter = createLocalCounter({ tokenizerPath });
  const recent = bigRecent();
  const request = { system: [{ text: "system" }], messages: [checkpoint(recent)] };

  const before = countRequest(counter, request, false);
  const tail = recent.slice(-200); // the newest tail must survive
  const budget = Math.floor(before * 0.5);

  const outcome = guardRequest(counter, request, { budget, includeToolsInBudget: false });

  assert.equal(outcome.stillOverBudget, false, "must fit the budget");
  assert.ok(outcome.trimmedCheckpoints >= 1, "the checkpoint must be trimmed");
  assert.ok(outcome.after <= budget, `after=${outcome.after} > budget=${budget}`);
  assert.ok(outcome.after < before, "the size must shrink");

  const text = ((request.messages[0]?.content as Array<{ text?: string }>)[0]?.text) ?? "";
  assert.match(text, /token-guard: removed/, "a removal note must be present");
  assert.ok(text.includes(tail), "the newest recent-context tail must be preserved");
  assert.match(text, /<\/recent-context>/, "the checkpoint wrapper must remain");

  // chars/4 (the core estimate) underestimates: the real token count is clearly higher.
  const coreEstimate = Math.round(recent.length / 4);
  assert.ok(before > coreEstimate, `real ${before} must exceed the core estimate ${coreEstimate}`);
});

test("real tokenizer: oldest exchanges are dropped, the checkpoint survives", { skip }, () => {
  const counter = createLocalCounter({ tokenizerPath });
  const big = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  const request = {
    system: [{ text: "system" }],
    messages: [
      checkpoint("small recent"),
      { role: "user", content: big },
      { role: "assistant", content: [{ type: "text", text: big }] },
      { role: "user", content: "latest question" },
    ],
  };

  const before = countRequest(counter, request, false);
  const budget = Math.floor(before * 0.35);

  const outcome = guardRequest(counter, request, { budget, includeToolsInBudget: false });

  assert.ok(outcome.droppedExchanges >= 1, "an old exchange must be dropped");
  assert.equal(outcome.stillOverBudget, false, "must fit the budget");
  assert.ok(outcome.after <= budget, `after=${outcome.after} > budget=${budget}`);
  assert.match(JSON.stringify(request.messages), /conversation-checkpoint/, "the checkpoint must survive");
  assert.equal(request.messages.at(-1)!.content, "latest question", "the newest exchange must survive");
});
