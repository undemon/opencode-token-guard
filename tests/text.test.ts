import { test } from "node:test";
import assert from "node:assert/strict";

import { messageText, partText, textSlots, type MessageLike } from "../src/text.ts";

test("partText: text and service parts", () => {
  assert.equal(partText({ type: "text", text: "hello" }), "hello");
  assert.equal(partText({ type: "reasoning", text: "thinking" }), "thinking");
  assert.equal(partText({ type: "media" }), "[media]");
  assert.equal(partText({ type: "tool-call", name: "read", input: { file: "a" } }), '[Assistant tool call]: read({"file":"a"})');
  assert.equal(partText(null), "");
  assert.equal(partText("string"), "string");
});

test("messageText: string, array of parts, text field", () => {
  assert.equal(messageText({ role: "user", content: "abc" }), "abc");
  assert.equal(
    messageText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    "a\nb",
  );
  assert.equal(messageText({ role: "synthetic", text: "ctx" }), "ctx");
  assert.equal(messageText({ role: "user" }), "");
});

test("textSlots: editing string and array content", () => {
  const asArray: MessageLike = { role: "user", content: [{ type: "text", text: "old" }] };
  const arraySlots = textSlots(asArray);
  assert.equal(arraySlots.length, 1);
  arraySlots[0]!.write("new");
  assert.equal(messageText(asArray), "new");

  const asString: MessageLike = { role: "user", content: "old" };
  const stringSlots = textSlots(asString);
  stringSlots[0]!.write("new");
  assert.equal(asString.content, "new");

  const asField: MessageLike = { role: "synthetic", text: "old" };
  textSlots(asField)[0]!.write("new");
  assert.equal(asField.text, "new");
});
