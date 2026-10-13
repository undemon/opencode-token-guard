/**
 * Guard: brings the assembled request down to a token budget.
 *
 * Strategy (highest to lowest priority of what to cut):
 *  1) the <recent-context> content of a checkpoint — the most common culprit
 *     (the OpenCode core slices `recent` using its underestimated chars/4);
 *  2) the oldest tool results (tool-result).
 * The newest content is preserved: inside recent-context its beginning
 * (the oldest part) is dropped, with a note about the removal.
 */

import type { GuardOutcome, TokenCounter } from "./types.js";
import { messageText, textSlots, type MessageLike } from "./text.js";

const CHECKPOINT_OPEN = "<recent-context>";
const CHECKPOINT_CLOSE = "</recent-context>";

/** Minimum number of characters kept in recent-context so it is not gutted entirely. */
const MIN_RECENT_CHARS = 400;
/** "chars per token" ratio used to convert the excess tokens into characters. */
const DEFAULT_RATIO = 3;

export interface GuardableRequest {
  system: ReadonlyArray<{ text?: string }>;
  messages: ReadonlyArray<MessageLike>;
  tools?: Record<string, unknown>;
}

export interface GuardSettings {
  budget: number;
  includeToolsInBudget: boolean;
  logger?: { info(message: string, data?: unknown): void; debug(message: string, data?: unknown): void };
}

/** Full request estimate by the counter. */
export function countRequest(counter: TokenCounter, request: GuardableRequest, includeTools: boolean): number {
  let total = 0;
  for (const part of request.system) {
    if (typeof part.text === "string") total += counter.count(part.text);
  }
  if (includeTools && request.tools) {
    for (const tool of Object.values(request.tools)) {
      total += counter.count(safeStringify(tool));
    }
  }
  for (const message of request.messages) {
    const text = messageText(message);
    if (text !== "") total += counter.count(text);
  }
  return total;
}

/**
 * Edits the request in place until it fits the budget (or until it can no
 * longer be reduced). Returns statistics.
 */
export function guardRequest(
  counter: TokenCounter,
  request: GuardableRequest,
  settings: GuardSettings,
): GuardOutcome {
  const { budget } = settings;
  let before = countRequest(counter, request, settings.includeToolsInBudget);
  const outcome: GuardOutcome = {
    before,
    after: before,
    budget,
    trimmedCheckpoints: 0,
    droppedResults: 0,
    stillOverBudget: false,
  };
  settings.logger?.debug(`request estimate: ${before} tokens, budget ${budget}`);
  if (before <= budget) return outcome;

  // Stage 1: trim recent-context inside checkpoints.
  for (let attempt = 0; attempt < 8; attempt++) {
    const excess = countRequest(counter, request, settings.includeToolsInBudget) - budget;
    if (excess <= 0) break;
    if (!trimOneRecentContext(counter, request, excess)) break;
    outcome.trimmedCheckpoints++;
  }

  // Stage 2: drop the oldest tool results.
  for (let attempt = 0; attempt < 64; attempt++) {
    const excess = countRequest(counter, request, settings.includeToolsInBudget) - budget;
    if (excess <= 0) break;
    if (!dropOldestToolResult(request)) break;
    outcome.droppedResults++;
  }

  outcome.after = countRequest(counter, request, settings.includeToolsInBudget);
  outcome.stillOverBudget = outcome.after > budget;
  if (outcome.after !== before && settings.logger) {
    settings.logger.info(
      `request trimmed: ${before} → ${outcome.after} tokens (budget ${budget}); ` +
        `checkpoints ${outcome.trimmedCheckpoints}, results ${outcome.droppedResults}` +
        (outcome.stillOverBudget ? " [STILL OVER BUDGET]" : ""),
    );
  }
  return outcome;
}

function trimOneRecentContext(counter: TokenCounter, request: GuardableRequest, excessTokens: number): boolean {
  for (const message of request.messages) {
    for (const slot of textSlots(message)) {
      const text = slot.read();
      const open = text.indexOf(CHECKPOINT_OPEN);
      if (open < 0) continue;
      const close = text.lastIndexOf(CHECKPOINT_CLOSE);
      if (close <= open) continue;
      const innerStart = open + CHECKPOINT_OPEN.length;
      const inner = text.slice(innerStart, close);
      if (inner.length <= MIN_RECENT_CHARS) continue;

      const ratio = inner.length / Math.max(1, counter.count(inner));
      const charsToRemove = Math.max(
        200,
        Math.ceil(excessTokens * (Number.isFinite(ratio) && ratio > 1 ? ratio : DEFAULT_RATIO) * 1.15),
      );
      const drop = Math.min(charsToRemove, inner.length - MIN_RECENT_CHARS);
      if (drop <= 0) continue;

      const note = `[token-guard: removed ${drop} characters of older context]\n`;
      const newInner = note + inner.slice(drop);
      slot.write(text.slice(0, innerStart) + newInner + text.slice(close));
      return true;
    }
  }
  return false;
}

const DROPPED_MARK = "[token-guard: tool output dropped to save context]";

function dropOldestToolResult(request: GuardableRequest): boolean {
  for (const message of request.messages) {
    for (const slot of textSlots(message)) {
      const text = slot.read();
      if (text.startsWith("[Tool result]:") || text.startsWith("[Tool error]:")) {
        if (text.startsWith(DROPPED_MARK)) continue;
        slot.write(DROPPED_MARK);
        return true;
      }
    }
  }
  return false;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
