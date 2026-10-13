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

test("tool-result parts (real request shape) are droppable", () => {
  const messages: MessageLike[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        {
          type: "tool-result",
          result: { type: "content", value: [{ type: "text", text: "x".repeat(1200) }] },
        },
      ],
    },
    { role: "user", content: "current question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, { budget: 60, includeToolsInBudget: true });
  assert.ok(outcome.droppedResults >= 1, "the tool-result part must be dropped");
  assert.equal(outcome.stillOverBudget, false);

  const content = messages[0]!.content as Array<{ type: string; text?: string; result?: unknown }>;
  assert.equal(content[0]!.text, "let me check", "a sibling text part must be kept");
  const result = content[1]!.result as { type: string; value: Array<{ type: string; text: string }> };
  assert.equal(result.type, "content", "the result discriminator must be preserved");
  assert.ok(Array.isArray(result.value), "the value must stay an array");
  assert.match(result.value[0]!.text, /token-guard: tool output dropped/);
});

test("oldest whole exchanges are dropped when the budget is still exceeded", () => {
  const messages: MessageLike[] = [
    { role: "user", content: "old question " + "x".repeat(600) },
    { role: "assistant", content: [{ type: "text", text: "old answer " + "y".repeat(600) }] },
    { role: "user", content: "new question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, { budget: 40, includeToolsInBudget: true });
  assert.ok(outcome.droppedExchanges >= 1, "an exchange must be dropped");
  assert.equal(messages.length, 1, "only the newest exchange must remain");
  assert.equal(messages[0]!.content, "new question");
  assert.equal(outcome.stillOverBudget, false);
});

test("exchange trimming never removes the checkpoint or the newest exchange", () => {
  const messages: MessageLike[] = [
    checkpoint(20),
    { role: "user", content: "old question " + "x".repeat(900) },
    { role: "assistant", content: "old reply " + "y".repeat(900) },
    { role: "user", content: "new question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, { budget: 60, includeToolsInBudget: true });
  assert.ok(outcome.droppedExchanges >= 1, "an exchange must be dropped");
  assert.match(JSON.stringify(messages), /conversation-checkpoint/, "the checkpoint must survive");
  assert.equal(messages.at(-1)!.content, "new question", "the newest exchange must survive");
  assert.equal(outcome.stillOverBudget, false);
});
