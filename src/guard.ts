/**
 * Guard: brings the assembled request down to a token budget.
 *
 * Strategy (highest to lowest priority of what to change):
 *  1) condense a checkpoint's `<recent-context>` blob into a bounded digest —
 *     the core slices that tail with its underestimated chars/4, so it can be
 *     several times larger than `keep.tokens` suggests;
 *  2) truncate oversized tool results and shell outputs in place (head + tail);
 *  3) drop the oldest whole exchanges (a user message plus its replies) — the
 *     last resort, always marked.
 *
 * The newest content is preserved: a checkpoint/summary, a system message, the
 * digest produced by this guard, and the newest exchange are never removed.
 * Nothing is dropped silently — every shortening leaves a visible marker.
 */

import type { GuardOutcome, TokenCounter } from "./types.js";
import { messageText, textSlots, type MessageLike } from "./text.js";
import { DIGEST_MARK, condenseEntries, parseEntries, truncateTokens, type CondenseLimits } from "./condense.js";

const CHECKPOINT_OPEN = "<recent-context>";
const CHECKPOINT_CLOSE = "</recent-context>";
/** Marks the synthetic summary message that must survive any history trimming. */
const CHECKPOINT_MARK = "<conversation-checkpoint>";

export interface GuardableRequest {
  system: ReadonlyArray<{ text?: string }>;
  messages: MessageLike[];
  tools?: Record<string, unknown>;
}

export interface GuardSettings {
  budget: number;
  includeToolsInBudget: boolean;
  /** Share of the budget used as the cap for a condensed checkpoint digest. */
  digestShare: number;
  /** Per-entry token limits used while condensing. */
  limits: CondenseLimits;
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
    total += messageTokens(counter, message);
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
  let total = countRequest(counter, request, settings.includeToolsInBudget);
  const before = total;
  const outcome: GuardOutcome = {
    before,
    after: before,
    budget,
    condensedCheckpoints: 0,
    truncatedResults: 0,
    droppedExchanges: 0,
    stillOverBudget: false,
  };
  settings.logger?.debug(`request estimate: ${before} tokens, budget ${budget}`);
  if (total <= budget) return outcome;

  const digestBudget = Math.max(1, Math.floor(budget * settings.digestShare));

  // Stage 1: condense checkpoint recent-context blobs into bounded digests.
  for (let attempt = 0; attempt < 4 && total > budget; attempt++) {
    const delta = condenseOneCheckpoint(counter, request, settings, digestBudget);
    if (delta === 0) break;
    total -= delta;
    outcome.condensedCheckpoints += 1;
  }

  // Stage 2: truncate oversized tool results and shell outputs in place.
  for (let attempt = 0; attempt < 64 && total > budget; attempt++) {
    const delta = truncateOneToolResult(counter, request, settings);
    if (delta === 0) break;
    total -= delta;
    outcome.truncatedResults += 1;
  }

  // Stage 3: drop the oldest whole exchanges (last resort).
  for (let attempt = 0; attempt < 64 && total > budget; attempt++) {
    const delta = dropOldestExchange(counter, request);
    if (delta === 0) break;
    total -= delta;
    outcome.droppedExchanges += 1;
  }

  outcome.after = countRequest(counter, request, settings.includeToolsInBudget);
  outcome.stillOverBudget = outcome.after > budget;
  if (outcome.after !== before && settings.logger) {
    settings.logger.info(
      `request condensed: ${before} → ${outcome.after} tokens (budget ${budget}); ` +
        `checkpoints ${outcome.condensedCheckpoints}, truncated results ${outcome.truncatedResults}, ` +
        `dropped exchanges ${outcome.droppedExchanges}` +
        (outcome.stillOverBudget ? " [STILL OVER BUDGET]" : ""),
    );
  }
  return outcome;
}

function messageTokens(counter: TokenCounter, message: MessageLike): number {
  const text = messageText(message);
  return text === "" ? 0 : counter.count(text);
}

/** Returns the number of tokens removed, or 0 when nothing changed. */
function condenseOneCheckpoint(
  counter: TokenCounter,
  request: GuardableRequest,
  settings: GuardSettings,
  digestBudget: number,
): number {
  for (const message of request.messages) {
    for (const slot of textSlots(message)) {
      const text = slot.read();
      const open = text.indexOf(CHECKPOINT_OPEN);
      if (open < 0) continue;
      const close = text.lastIndexOf(CHECKPOINT_CLOSE);
      if (close <= open) continue;

      const innerStart = open + CHECKPOINT_OPEN.length;
      const inner = text.slice(innerStart, close);
      if (inner.includes(DIGEST_MARK)) continue; // already condensed in this pass
      const innerTokens = counter.count(inner);
      if (innerTokens <= digestBudget) continue;

      const result = condenseEntries(counter, parseEntries(inner), settings.limits, digestBudget);
      if (!result.changed) continue;

      const next = `${result.text}\n`;
      slot.write(text.slice(0, innerStart) + next + text.slice(close));
      return Math.max(1, innerTokens - counter.count(next));
    }
  }
  return 0;
}

/** Returns the number of tokens removed, or 0 when nothing changed. */
function truncateOneToolResult(counter: TokenCounter, request: GuardableRequest, settings: GuardSettings): number {
  const { limits } = settings;
  for (const message of request.messages) {
    for (const slot of textSlots(message)) {
      const text = slot.read();
      const match = /^\[(Tool result|Tool error)\]: ([\s\S]*)$/.exec(text);
      if (!match) continue;

      const body = match[2] ?? "";
      const isError = match[1] === "Tool error";
      const limit = isError ? limits.toolErrorTokens : limits.toolResultTokens;
      const tokens = counter.count(body);
      if (tokens <= limit) continue;

      const shortened = truncateTokens(counter, body, limit, "both");
      // A tool-result part keeps only its payload; a plain text part keeps its prefix.
      slot.write(slot.kind === "tool-result" ? shortened : `[${match[1]}]: ${shortened}`);
      return Math.max(1, tokens - counter.count(shortened));
    }
  }
  return 0;
}

/**
 * Removes the oldest whole exchange (a user message and the replies grouped with
 * it). Returns the number of tokens removed, or 0 when nothing is droppable.
 */
function dropOldestExchange(counter: TokenCounter, request: GuardableRequest): number {
  const messages = request.messages;
  const groups = buildExchangeGroups(messages);
  if (groups.length <= 1) return 0;

  const last = groups.length - 1;
  for (let g = 0; g < last; g++) {
    const group = groups[g]!;
    if (group.some((index) => isProtected(messages[index]!))) continue;
    const removed = group.reduce((sum, index) => sum + messageTokens(counter, messages[index]!), 0);
    messages.splice(group[0]!, group.length);
    return Math.max(1, removed);
  }
  return 0;
}

/**
 * Groups messages into exchanges: a new group starts at a user message, after a
 * checkpoint/system message, or at the very beginning.
 */
function buildExchangeGroups(messages: ReadonlyArray<MessageLike>): number[][] {
  const groups: number[][] = [];
  let forceNew = true;
  messages.forEach((message, index) => {
    if (forceNew || message.role === "user" || groups.length === 0) {
      groups.push([index]);
    } else {
      groups[groups.length - 1]!.push(index);
    }
    forceNew = isProtected(message);
  });
  return groups;
}

/** A message that must survive history trimming: a checkpoint/summary, the digest, or a system message. */
function isProtected(message: MessageLike): boolean {
  if (message.role === "system") return true;
  const text = messageText(message);
  return text.includes(CHECKPOINT_MARK) || text.includes(DIGEST_MARK);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
