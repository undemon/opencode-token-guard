import { test } from "node:test";
import assert from "node:assert/strict";

import { guardRequest, type GuardSettings } from "../src/guard.ts";
import { DEFAULT_LIMITS, DIGEST_MARK, ELISION, LEDGER_GUIDANCE, LEDGER_MARK, REASONING_OMITTED, TRUNCATION_MARK } from "../src/condense.ts";
import type { TokenCounter } from "../src/types.ts";
import type { MessageLike } from "../src/text.ts";

/** Simple counter: 1 token per 3 characters. */
const fake: TokenCounter = {
  kind: "local",
  count: (text) => Math.ceil(text.length / 3),
  describe: () => "fake",
};

const settings = (budget: number): GuardSettings => ({
  budget,
  includeToolsInBudget: true,
  digestShare: 0.3,
  limits: DEFAULT_LIMITS,
});

function checkpoint(inner: string): MessageLike {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<conversation-checkpoint><summary>brief summary</summary><recent-context>${inner}</recent-context></conversation-checkpoint>`,
      },
    ],
  };
}

function slotText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("\n");
  return message.text ?? "";
}

test("within budget — nothing changes", () => {
  const request = { system: [{ text: "sys" }], messages: [checkpoint("tiny")] };
  const outcome = guardRequest(fake, request, settings(10_000));
  assert.equal(outcome.condensedCheckpoints, 0);
  assert.equal(outcome.after, outcome.before);
  assert.equal(outcome.stillOverBudget, false);
});

test("an oversized recent-context becomes a marked digest, the wrapper survives", () => {
  const inner = `[User]: hello\n[Assistant]: ${"x".repeat(9000)}`;
  const request = { system: [], messages: [checkpoint(inner)] };

  const outcome = guardRequest(fake, request, settings(2000));

  assert.equal(outcome.stillOverBudget, false);
  assert.ok(outcome.condensedCheckpoints >= 1, "the checkpoint must be condensed");
  assert.ok(outcome.after <= 2000, `after=${outcome.after} > 2000`);

  const text = slotText(request.messages[0]!);
  assert.ok(text.includes(DIGEST_MARK), "the digest must be marked");
  assert.ok(text.includes("<recent-context>") && text.includes("</recent-context>"), "the checkpoint wrapper must remain");
  assert.ok(text.includes("<summary>brief summary</summary>"), "the summary must not be touched");
  assert.ok(text.includes(ELISION), "the cut must be visible");
});

test("a checkpoint only slightly over the budget is condensed just enough to fit", () => {
  const inner = `[Assistant]: HEAD-${"x".repeat(1400)}-TAIL`;
  const messages: MessageLike[] = [checkpoint(inner), { role: "user", content: "latest question" }];

  const outcome = guardRequest(fake, { system: [], messages }, settings(480));

  assert.equal(outcome.condensedCheckpoints, 1, "the checkpoint must be condensed");
  assert.equal(outcome.truncatedResults, 0);
  assert.equal(outcome.droppedExchanges, 0, "no exchange should be dropped when condensing suffices");
  assert.equal(outcome.stillOverBudget, false, "the request must fit");
  assert.ok(outcome.after <= 480, `after=${outcome.after} > 480`);

  const text = slotText(messages[0]!);
  assert.ok(text.includes("HEAD-") && text.includes("-TAIL"), "both ends must survive");
  assert.ok(text.includes(ELISION), "the cut must be visible");
});

test("reasoning: the newest block keeps its tail, older ones are omitted", () => {
  const old1 = `OLD-ONE ${"a".repeat(3000)}`;
  const old2 = `OLD-TWO ${"b".repeat(3000)}`;
  const newest = `${"c".repeat(3000)}NEWEST-TAIL`;
  const inner = [
    "[User]: question",
    `[Assistant reasoning]: ${old1}`,
    `[Assistant reasoning]: ${old2}`,
    `[Assistant reasoning]: ${newest}`,
    "[Assistant]: answer",
  ].join("\n");
  const request = { system: [], messages: [checkpoint(inner)] };
  const limits = {
    ...DEFAULT_LIMITS,
    userTokens: 50,
    assistantTokens: 50,
    reasoningTailTokens: 100,
    miscTokens: 50,
  };

  guardRequest(fake, request, { ...settings(1500), limits });
  const text = slotText(request.messages[0]!);

  assert.ok(text.includes(REASONING_OMITTED), "older reasoning must be omitted");
  assert.ok(!text.includes("OLD-ONE") && !text.includes("OLD-TWO"), "older reasoning bodies must be gone");
  assert.ok(text.includes("NEWEST-TAIL"), "the newest reasoning must keep its tail");
  assert.ok(!text.includes("c".repeat(900)), "the newest reasoning must be trimmed from the top");
});

test("oversized tool results are truncated in place (head + tail)", () => {
  const body = "x".repeat(3000);
  const messages: MessageLike[] = [
    { role: "assistant", content: [{ type: "text", text: `[Tool result]: ${body}` }] },
    { role: "user", content: "current question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, settings(400));

  assert.equal(outcome.truncatedResults, 1);
  assert.equal(outcome.droppedExchanges, 0, "no exchange should be dropped");
  assert.equal(outcome.stillOverBudget, false);

  const text = slotText(messages[0]!);
  assert.ok(text.startsWith("[Tool result]: "), "the prefix must stay");
  assert.ok(text.includes(ELISION) && text.length < body.length);
});

test("a real tool-result part keeps its shape when truncated", () => {
  const messages: MessageLike[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-result", result: { type: "content", value: [{ type: "text", text: "y".repeat(3000) }] } },
      ],
    },
    { role: "user", content: "current question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, settings(400));
  assert.equal(outcome.truncatedResults, 1);

  const content = messages[0]!.content as Array<{ type: string; text?: string; result?: unknown }>;
  assert.equal(content[0]!.text, "let me check", "a sibling text part must be kept");
  const result = content[1]!.result as { type: string; value: Array<{ type: string; text: string }> };
  assert.equal(result.type, "content", "the result discriminator must be preserved");
  assert.ok(Array.isArray(result.value), "the value must stay an array");
  assert.ok(result.value[0]!.text.includes(ELISION));
});

test("oldest whole exchanges are dropped only as a last resort", () => {
  const messages: MessageLike[] = [
    { role: "user", content: "old question " + "x".repeat(600) },
    { role: "assistant", content: [{ type: "text", text: "old answer " + "y".repeat(600) }] },
    { role: "user", content: "new question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, settings(40));

  assert.ok(outcome.droppedExchanges >= 1, "an exchange must be dropped");
  assert.equal(messages.length, 1, "only the newest exchange must remain");
  assert.equal(messages[0]!.content, "new question");
  assert.equal(outcome.stillOverBudget, false);
});

test("dropping never removes the checkpoint or the newest exchange", () => {
  const messages: MessageLike[] = [
    checkpoint("tiny"),
    { role: "user", content: "old question " + "x".repeat(900) },
    { role: "assistant", content: "old reply " + "y".repeat(900) },
    { role: "user", content: "new question" },
  ];
  const outcome = guardRequest(fake, { system: [], messages }, settings(60));

  assert.ok(outcome.droppedExchanges >= 1, "an exchange must be dropped");
  assert.ok(slotText(messages[0]!).includes("<conversation-checkpoint>"), "the checkpoint must survive");
  assert.equal(messages.at(-1)!.content, "new question", "the newest exchange must survive");
  assert.equal(outcome.stillOverBudget, false);
});

test("condensing is idempotent: a second pass changes nothing", () => {
  const inner = `[User]: hello\n[Assistant]: ${"z".repeat(9000)}`;
  const request = { system: [], messages: [checkpoint(inner)] };

  const first = guardRequest(fake, request, settings(2000));
  const digest = slotText(request.messages[0]!);

  const second = guardRequest(fake, request, settings(2000));

  assert.ok(first.condensedCheckpoints >= 1);
  assert.equal(second.condensedCheckpoints, 0, "the digest must not be condensed again");
  assert.equal(second.after, second.before, "the second pass must be a no-op");
  assert.equal(slotText(request.messages[0]!), digest);
});

test("stage 2 truncates just enough and marks the truncation", () => {
  const messages: MessageLike[] = [
    { role: "assistant", content: [{ type: "text", text: `[Tool result]: ${"x".repeat(3000)}` }] },
    { role: "user", content: "current question" },
  ];

  const outcome = guardRequest(fake, { system: [], messages }, settings(420));

  assert.equal(outcome.truncatedResults, 1);
  assert.equal(outcome.condensedResults, 0);
  assert.equal(outcome.droppedExchanges, 0);
  assert.equal(outcome.stillOverBudget, false, "one oversized result must be cut just enough to fit");

  const text = slotText(messages[0]!);
  assert.ok(text.startsWith("[Tool result]: "), "the prefix must stay");
  assert.ok(text.includes(TRUNCATION_MARK), "the truncation must be marked");
  assert.ok(text.includes(ELISION), "the cut must be visible");
  assert.ok(text.includes("of 1000 tokens"), "the notice must report the original size");
});

test("stage 3 replaces the oldest oversized results with a ledger line", () => {
  const exchange = (file: string, letter: string): MessageLike => ({
    role: "assistant",
    content: [
      { type: "tool-call", name: "read", input: { filePath: file } },
      { type: "tool-result", result: { type: "content", value: [{ type: "text", text: letter.repeat(3000) }] } },
    ],
  });
  const messages: MessageLike[] = [
    exchange("/tmp/a.json", "A"),
    exchange("/tmp/b.json", "B"),
    exchange("/tmp/c.json", "C"),
    { role: "user", content: "latest question" },
  ];

  const outcome = guardRequest(fake, { system: [], messages }, settings(900));

  assert.equal(outcome.truncatedResults, 3, "every oversized result is truncated first");
  assert.equal(outcome.condensedResults, 1, "the oldest eligible result becomes a ledger line");
  assert.equal(outcome.droppedExchanges, 0);
  assert.equal(outcome.stillOverBudget, false);

  const all = JSON.stringify(messages);
  assert.ok(all.includes(LEDGER_MARK), "the ledger line must be present");
  assert.ok(all.includes("/tmp/a.json"), "the ledger must name the file");
  assert.match(all, /was ~1\d{3} tok/, "the ledger must report the original size, not the truncated one");
  assert.equal(all.split(LEDGER_GUIDANCE).length - 1, 1, "the guidance must appear once per request");
  assert.ok(!all.includes("A".repeat(600)), "the ledgered payload must be replaced");
  assert.ok(all.includes("B".repeat(300)) && all.includes("C".repeat(300)), "the newest results stay");
});
