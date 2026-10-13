import { test } from "node:test";
import assert from "node:assert/strict";

import { appliesToProvider, computeBudget, readOptions } from "../src/options.ts";

test("readOptions: defaults", () => {
  const options = readOptions(undefined);
  assert.equal(options.mode, "local");
  assert.equal(options.syncLimit, true);
  assert.equal(options.reservedOutputTokens, 4096);
  assert.equal(options.safetyMarginPct, 8);
  assert.deepEqual(options.providerIDs, []);
});

test("readOptions: normalizes backend and providers", () => {
  const options = readOptions({
    backend: "http://127.0.0.1:1234/",
    providerIDs: ["test-provider", "", 42],
    mode: "delegate",
    safetyMarginPct: 10,
  });
  assert.equal(options.backend, "http://127.0.0.1:1234");
  assert.deepEqual(options.providerIDs, ["test-provider"]);
  assert.equal(options.mode, "delegate");
  assert.equal(options.safetyMarginPct, 10);
});

test("computeBudget: window minus reserve and margin", () => {
  const options = readOptions({ reservedOutputTokens: 4000, safetyMarginPct: 10 });
  assert.equal(computeBudget(110_592, options), 110_592 - 4000 - Math.floor(110_592 * 0.1));
  assert.equal(computeBudget(100, readOptions({ reservedOutputTokens: 1000, safetyMarginPct: 0 })), 0);
});

test("appliesToProvider", () => {
  assert.equal(appliesToProvider(readOptions(undefined), "anything"), true);
  const scoped = readOptions({ providerIDs: ["test-provider"] });
  assert.equal(appliesToProvider(scoped, "test-provider"), true);
  assert.equal(appliesToProvider(scoped, "openai"), false);
  assert.equal(appliesToProvider(scoped, undefined), false);
});
