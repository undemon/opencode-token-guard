import { test } from "node:test";
import assert from "node:assert/strict";

import { extractModels } from "../src/backend/lmstudio.ts";
import { planLimitUpdates, applyLimitUpdates } from "../src/model-limit.ts";
import { readOptions } from "../src/options.ts";
import type { ModelEditor, ModelInfo } from "@opencode/plugin";

test("extractModels: the { data: [...] } shape with snake_case", () => {
  const models = extractModels({
    data: [
      { id: "test-model", state: "loaded", max_context_length: 262144, loaded_context_length: 110592 },
      { id: "other", state: "not-loaded", max_context_length: 32768 },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0]!.loadedContextLength, 110592);
  assert.equal(models[0]!.maxContextLength, 262144);
  assert.equal(models[1]!.loadedContextLength, undefined);
});

test("extractModels: a bare array and garbage", () => {
  assert.equal(extractModels([{ key: "m", loaded_context_length: 5 }]).length, 1);
  assert.deepEqual(extractModels(null), []);
  assert.deepEqual(extractModels({}), []);
});

test("planLimitUpdates respects syncLimitDownOnly and the provider filter", () => {
  const models: ModelInfo[] = [
    { providerID: "test-provider", id: "test-model", limit: { context: 104000 } },
    { providerID: "openai", id: "gpt", limit: { context: 400000 } },
  ];
  const plans = planLimitUpdates(models, 110_592, readOptions({ providerIDs: ["test-provider"] }), (p) => p === "test-provider");
  assert.deepEqual(plans, [{ providerID: "test-provider", modelID: "test-model", from: 104000, to: 110592 }]);

  const downOnly = planLimitUpdates(
    [{ providerID: "test-provider", id: "x", limit: { context: 200000 } }],
    110_592,
    readOptions({ syncLimitDownOnly: true }),
    () => true,
  );
  assert.equal(downOnly[0]!.to, 110592);
});

test("planLimitUpdates respects maxContext (never raise above the cap)", () => {
  const plans = planLimitUpdates(
    [{ providerID: "test-provider", id: "test-model", limit: { context: 200000 } }],
    110_592,
    readOptions({ maxContext: 104000, syncLimitDownOnly: true }),
    () => true,
  );
  assert.deepEqual(plans, [{ providerID: "test-provider", modelID: "test-model", from: 200000, to: 104000 }]);
});

test("applyLimitUpdates writes limit.context", () => {
  const edited: Array<{ id: string; context: number }> = [];
  const editor = {
    list: () => [],
    get: () => undefined,
    update: (_providerID: string, modelID: string, update: (model: ModelInfo) => void) => {
      const model: ModelInfo = { providerID: "p", id: modelID, limit: { context: 0 } };
      update(model);
      edited.push({ id: modelID, context: model.limit.context });
    },
    remove: () => {},
  } as unknown as ModelEditor;

  applyLimitUpdates(editor, [{ providerID: "test-provider", modelID: "test-model", from: 104000, to: 110592 }]);
  assert.deepEqual(edited, [{ id: "test-model", context: 110592 }]);
});
