import { test } from "node:test";
import assert from "node:assert/strict";

import { guardRequest } from "../src/guard.ts";
import type { TokenCounter } from "../src/types.ts";
import type { MessageLike } from "../src/text.ts";

/** Simple counter: 1 token per 3 characters. */
const fake: TokenCounter = {
  kind: "local",
  count: (text) => Math.ceil(text.length / 3),
  describe: () => "fake",
};

function checkpoint(recentChars: number): MessageLike {
  const recent = "x".repeat(recentChars);
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

test("within budget — nothing changes", () => {
  const request = { system: [{ text: "sys" }], messages: [checkpoint(30)] };
  const outcome = guardRequest(fake, request, { budget: 10_000, includeToolsInBudget: true });
  assert.equal(outcome.trimmedCheckpoints, 0);
  assert.equal(outcome.after, outcome.before);
  assert.equal(outcome.stillOverBudget, false);
});

test("an oversized recent-context is trimmed down to the budget", () => {
  const request = { system: [], messages: [checkpoint(3000)] };
  const outcome = guardRequest(fake, request, { budget: 200, includeToolsInBudget: true });
  assert.equal(outcome.stillOverBudget, false);
  assert.ok(outcome.trimmedCheckpoints >= 1);
  assert.ok(outcome.after <= 200);
  const text = JSON.stringify(request.messages);
  assert.match(text, /token-guard: removed/);
  assert.match(text, /<recent-context>/);
  assert.match(text, /<\/recent-context>/);
});

test("when the budget is short, the oldest tool results are dropped as well", () => {
  const messages: MessageLike[] = [
    { role: "assistant", content: [{ type: "text", text: "[Tool result]: " + "x".repeat(900) }] },
    { role: "assistant", content: [{ type: "text", text: "[Tool result]: " + "y".repeat(900) }] },
    { role: "user", content: "current question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, { budget: 80, includeToolsInBudget: true });
  assert.equal(outcome.droppedResults, 2);
  assert.ok(outcome.after <= 80);
  assert.equal(outcome.stillOverBudget, false);
});
