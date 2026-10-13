/**
 * Sync model.limit.context with the backend's real window.
 *
 * Rationale: the OpenCode config can diverge from the engine's n_ctx (e.g. 108544
 * versus 106496 — which is what caused an overflow). The core computes the
 * compaction threshold from limit.context, so it must be kept equal to the real
 * window.
 */

import type { ModelEditor, ModelInfo } from "@opencode/plugin";
import type { GuardOptions } from "./options.js";

export interface LimitPlan {
  providerID: string;
  modelID: string;
  from: number;
  to: number;
}

export function planLimitUpdates(
  models: ReadonlyArray<ModelInfo>,
  window: number,
  options: GuardOptions,
  applies: (providerID: string) => boolean,
): LimitPlan[] {
  const plans: LimitPlan[] = [];
  for (const model of models) {
    if (!applies(model.providerID)) continue;
    const from = model.limit?.context ?? 0;
    if (from <= 0) continue;
    const cap = options.maxContext ?? Number.POSITIVE_INFINITY;
    const target = Math.min(window, cap);
    const to = options.syncLimitDownOnly ? Math.min(from, target) : target;
    if (to !== from) plans.push({ providerID: model.providerID, modelID: model.id, from, to });
  }
  return plans;
}

export function applyLimitUpdates(editor: ModelEditor, plans: ReadonlyArray<LimitPlan>): void {
  for (const plan of plans) {
    editor.update(plan.providerID, plan.modelID, (model) => {
      model.limit.context = plan.to;
    });
  }
}
