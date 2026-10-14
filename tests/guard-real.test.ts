import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { countRequest, guardRequest, type GuardSettings } from "../src/guard.ts";
import { DEFAULT_LIMITS, DIGEST_MARK, REASONING_OMITTED } from "../src/condense.ts";
import { createLocalCounter } from "../src/tokenizer/local.ts";
import type { MessageLike } from "../src/text.ts";

const tokenizerPath = fileURLToPath(new URL("../models/tokenizer.json", import.meta.url));
const available = existsSync(tokenizerPath);
const skip = available ? false : `tokenizer file not found: ${tokenizerPath}`;

const settings = (budget: number): GuardSettings => ({
  budget,
  includeToolsInBudget: false,
  digestShare: 0.3,
  limits: DEFAULT_LIMITS,
});

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

function slotText(message: MessageLike): string {
  const content = message.content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("\n");
  return typeof content === "string" ? content : (message.text ?? "");
}

/**
 * A realistic checkpoint tail: newline-separated entries in the core's own
 * rendering, token-dense (JSON tool output) and with several reasoning blocks —
 * exactly the shape the core's chars/4 heuristic underestimates.
 */
function bigRecent(): string {
  const lines: string[] = [];
  const json = JSON.stringify({
    status: "ok",
    items: Array.from({ length: 40 }, (_, i) => ({ id: i, tags: ["alpha", "beta"] })),
  });
  for (let i = 0; i < 25; i++) {
    lines.push(`[User]: A short prose sample used to vary token density across the fixture, round ${i}.`);
    lines.push(`[Assistant reasoning]: Thinking about round ${i}: ${"considerations ".repeat(40)}`);
    lines.push(`[Assistant tool call]: read({"filePath":"/tmp/fixture-${i}.json","limit":2000})`);
    lines.push(`[Tool result]: ${json}`);
    lines.push(`[Assistant]: Round ${i} is done; the fixture stays token-dense on purpose.`);
  }
  return lines.join("\n");
}

test("real tokenizer: an oversized checkpoint is condensed, the wrapper and tail survive", { skip }, () => {
  const counter = createLocalCounter({ tokenizerPath });
  const recent = bigRecent();
  const request = { system: [{ text: "system" }], messages: [checkpoint(recent)] };

  const before = countRequest(counter, request, false);
  const tail = recent.slice(-200); // the newest tail must survive
  const budget = Math.floor(before * 0.5);

  const outcome = guardRequest(counter, request, settings(budget));

  assert.equal(outcome.stillOverBudget, false, "must fit the budget");
  assert.ok(outcome.condensedCheckpoints >= 1, "the checkpoint must be condensed");
  assert.ok(outcome.after <= budget, `after=${outcome.after} > budget=${budget}`);
  assert.ok(outcome.after < before, "the size must shrink");

  const text = slotText(request.messages[0]!);
  assert.ok(text.includes(DIGEST_MARK), "the digest must be marked");
  assert.ok(text.includes(REASONING_OMITTED), "older reasoning must be omitted, not silently dropped");
  assert.ok(text.includes(tail), "the newest recent-context tail must be preserved");
  assert.ok(text.includes("</recent-context>"), "the checkpoint wrapper must remain");
  assert.ok(text.includes("<summary>brief summary</summary>"), "the summary must not be touched");

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

  const outcome = guardRequest(counter, request, settings(budget));

  assert.ok(outcome.droppedExchanges >= 1, "an old exchange must be dropped");
  assert.equal(outcome.stillOverBudget, false, "must fit the budget");
  assert.ok(outcome.after <= budget, `after=${outcome.after} > budget=${budget}`);
  assert.match(JSON.stringify(request.messages), /conversation-checkpoint/, "the checkpoint must survive");
  assert.equal(request.messages.at(-1)!.content, "latest question", "the newest exchange must survive");
});
