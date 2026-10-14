/**
 * Guard: brings the assembled request down to a token budget.
 *
 * Strategy (highest to lowest priority of what to change):
 *  1) condense a checkpoint's `<recent-context>` blob into a bounded digest —
 *     the core slices that tail with its underestimated chars/4, so it can be
 *     several times larger than `keep.tokens` suggests;
 *  2) truncate oversized tool results and shell outputs in place (head + tail),
 *     cutting just enough to fit and saying so in the payload;
 *  3) replace the oldest oversized results with one-line ledger entries once
 *     per-result truncation is no longer enough, so the model can see what the
 *     operation cost without paying for it again;
 *  4) drop the oldest whole exchanges (a user message plus its replies) — the
 *     last resort, always marked.
 *
 * The newest content is preserved: a checkpoint/summary, a system message, the
 * digest produced by this guard, the newest `ledgerKeep` tool results, and the
 * newest exchange are never removed.
 * Nothing is dropped silently — every shortening leaves a visible marker.
 */

import type { GuardOutcome, TokenCounter } from "./types.js";
import { messageText, partText, textSlots, writeToolResult, type MessageLike, type TextSlot } from "./text.js";
import {
  DIGEST_MARK,
  LEDGER_GUIDANCE,
  LEDGER_MARK,
  TRUNCATION_MARK,
  condenseEntries,
  ledgerNotice,
  parseEntries,
  truncationNotice,
  truncateTokens,
  type CondenseLimits,
} from "./condense.js";

const CHECKPOINT_OPEN = "<recent-context>";
const CHECKPOINT_CLOSE = "</recent-context>";
/** Marks the synthetic summary message that must survive any history trimming. */
const CHECKPOINT_MARK = "<conversation-checkpoint>";
/** A checkpoint digest is never condensed below this, so it keeps its meaning. */
const MIN_DIGEST_TOKENS = 200;

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
    condensedResults: 0,
    droppedExchanges: 0,
    stillOverBudget: false,
  };
  settings.logger?.debug(`request estimate: ${before} tokens, budget ${budget}`);
  if (total <= budget) return outcome;

  const digestBudget = Math.max(1, Math.floor(budget * settings.digestShare));

  // Stage 1: condense checkpoint recent-context blobs into bounded digests.
  for (let attempt = 0; attempt < 4 && total > budget; attempt++) {
    const delta = condenseOneCheckpoint(counter, request, settings, digestBudget, total - budget);
    if (delta === 0) break;
    total -= delta;
    outcome.condensedCheckpoints += 1;
  }

  // Stage 2: truncate oversized tool results and shell outputs in place.
  for (let attempt = 0; attempt < 64 && total > budget; attempt++) {
    const delta = truncateOneToolResult(counter, request, settings, total - budget);
    if (delta === 0) break;
    total -= delta;
    outcome.truncatedResults += 1;
  }

  // Stage 3: replace the oldest oversized results with one-line ledger entries.
  for (let attempt = 0; attempt < 64 && total > budget; attempt++) {
    const delta = condenseOneResultToLedger(counter, request, settings);
    if (delta === 0) break;
    total -= delta;
    outcome.condensedResults += 1;
  }

  // Stage 4: drop the oldest whole exchanges (last resort).
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
        `condensed results ${outcome.condensedResults}, dropped exchanges ${outcome.droppedExchanges}` +
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
  excess: number,
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
      // Aim for the smaller of the digest cap and what the excess actually needs.
      const target = Math.max(MIN_DIGEST_TOKENS, Math.min(digestBudget, innerTokens - excess));
      if (innerTokens <= target) continue;

      const result = condenseEntries(counter, parseEntries(inner), settings.limits, target);
      if (!result.changed) continue;

      const next = `${result.text}\n`;
      slot.write(text.slice(0, innerStart) + next + text.slice(close));
      return Math.max(1, innerTokens - counter.count(next));
    }
  }
  return 0;
}

/** Returns the number of tokens removed, or 0 when nothing changed. */
function truncateOneToolResult(
  counter: TokenCounter,
  request: GuardableRequest,
  settings: GuardSettings,
  excess: number,
): number {
  const { limits } = settings;
  for (const message of request.messages) {
    for (const slot of textSlots(message)) {
      const text = slot.read();
      const match = /^\[(Tool result|Tool error)\]: ([\s\S]*)$/.exec(text);
      if (!match) continue;

      const body = match[2] ?? "";
      // Already shortened or replaced by this guard: leave it alone. (For a
      // tool-result part the notice lives inside the JSON payload, so match
      // anywhere rather than only at the start.)
      if (body.includes(TRUNCATION_MARK) || body.includes(LEDGER_MARK)) continue;

      const isError = match[1] === "Tool error";
      const floor = isError ? limits.toolErrorTokens : limits.toolResultTokens;
      const tokens = counter.count(body);
      if (tokens <= floor) continue;

      // Cut just enough to fit, leaving room for the notice, but never below the floor.
      const target = Math.max(floor, tokens - excess - NOTICE_ALLOWANCE);
      if (tokens <= target) continue;

      const shortened = truncateTokens(counter, body, target, "both");
      const payload = `${truncationNotice(counter.count(shortened), tokens)}\n${shortened}`;
      // A tool-result part keeps only its payload; a plain text part keeps its prefix.
      slot.write(slot.kind === "tool-result" ? payload : `[${match[1]}]: ${payload}`);
      return Math.max(1, tokens - counter.count(payload));
    }
  }
  return 0;
}

/** Rough room reserved for the truncation notice and the part prefix when sizing the cut. */
const NOTICE_ALLOWANCE = 80;

interface ResultCandidate {
  slot: TextSlot;
  tool: string;
  target: string;
  tokens: number;
}

/**
 * Replaces one oversized tool result with a single ledger line: what was called,
 * on what, and how large it was. Only runs once per-result truncation no longer
 * helps, and never touches the newest `ledgerKeep` results, so the model keeps
 * enough recent output to act on.
 *
 * Returns the number of tokens removed, or 0 when nothing is left to condense.
 */
function condenseOneResultToLedger(counter: TokenCounter, request: GuardableRequest, settings: GuardSettings): number {
  const candidates = collectResultCandidates(counter, request);
  const keep = Math.max(0, settings.limits.ledgerKeep);
  const eligible = candidates.slice(0, Math.max(0, candidates.length - keep));
  const remaining = eligible.filter((candidate) => !candidate.slot.read().includes(LEDGER_MARK));
  if (remaining.length === 0) return 0;

  // Biggest first: one ledger line buys the most room there.
  const candidate = remaining.reduce((best, next) => (next.tokens > best.tokens ? next : best));
  const notice = ledgerNotice(candidate.tool, candidate.target, candidate.tokens);
  const payload = requestHasGuidance(request) ? notice : `${notice}\n${LEDGER_GUIDANCE}`;
  const oldText = candidate.slot.read();
  const newText = candidate.slot.kind === "tool-result" ? payload : `[Tool result]: ${payload}`;
  candidate.slot.write(newText);
  return Math.max(1, counter.count(oldText) - counter.count(newText));
}

/** Tool results in request order, paired with the tool call that produced them. */
function collectResultCandidates(counter: TokenCounter, request: GuardableRequest): ResultCandidate[] {
  const candidates: ResultCandidate[] = [];
  for (const message of request.messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    let call = { tool: "tool", target: "" };
    for (const part of content) {
      if (part.type === "tool-call") {
        call = { tool: typeof part.name === "string" && part.name !== "" ? part.name : "tool", target: toolTarget(part.input) };
        continue;
      }
      if (part.type !== "tool-result") continue;
      const slot: TextSlot = {
        kind: "tool-result",
        read: () => partText(part),
        write: (next: string) => {
          writeToolResult(part, next);
        },
      };
      const rendered = slot.read();
      candidates.push({ slot, tool: call.tool, target: call.target, tokens: originalResultTokens(counter, rendered) });
    }
  }
  return candidates;
}

/**
 * The result's original size when an earlier stage already shortened it (our own
 * truncation notice records it), otherwise its current size. Keeps the ledger
 * honest about what the call actually cost.
 */
function originalResultTokens(counter: TokenCounter, rendered: string): number {
  const match = /of (\d+) tokens/.exec(rendered);
  if (rendered.includes(TRUNCATION_MARK) && match?.[1]) return Number(match[1]);
  return counter.count(rendered);
}

/** Best-effort description of what a tool call operated on. */
function toolTarget(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["filePath", "path", "command", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function requestHasGuidance(request: GuardableRequest): boolean {
  return request.messages.some((message) => messageText(message).includes(LEDGER_GUIDANCE));
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
