/**
 * Condensing: turns a region of the conversation into a bounded, explicitly
 * marked digest instead of cutting it off.
 *
 * The entry format mirrors the OpenCode core's own rendering of history
 * (`[User]: …`, `[Assistant]: …`, `[Assistant reasoning]: …`,
 * `[Assistant tool call]: …`, `[Tool result]: …`, `[Shell]: …`), so the same
 * rules apply to a checkpoint's `<recent-context>` blob and to rendered history.
 *
 * Nothing is dropped silently: every shortening is visible as an elision marker,
 * an omitted-reasoning marker, or the "earlier messages condensed" notice.
 */

import type { TokenCounter } from "./types.js";

/** Marks a digest produced by this plugin; used to keep condensing idempotent. */
export const DIGEST_MARK = "<!-- token-guard:condensed v1 -->";
/** Replaces a reasoning block that is not worth keeping. */
export const REASONING_OMITTED = "[reasoning omitted]";
/** Inserted where text was cut. */
export const ELISION = "…";

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "tool-error"
  | "shell"
  | "synthetic"
  | "skill"
  | "other";

export interface Entry {
  kind: EntryKind;
  /** Rendered prefix, e.g. "[Tool result]: ". */
  prefix: string;
  /** Payload after the prefix. */
  body: string;
}

export interface CondenseLimits {
  /** Max tokens kept per user message (head + tail). */
  userTokens: number;
  /** Max tokens kept per assistant message (head + tail). */
  assistantTokens: number;
  /** Max tokens kept from the tail of the newest reasoning blocks. */
  reasoningTailTokens: number;
  /** How many newest reasoning blocks keep their tail; older ones are omitted. */
  reasoningKeep: number;
  /** Max tokens kept per tool call (its arguments). */
  toolCallTokens: number;
  /** Max tokens kept per tool result or shell output (head + tail). */
  toolResultTokens: number;
  /** Max tokens kept per tool error (head + tail). */
  toolErrorTokens: number;
  /** Max tokens kept for anything else (synthetic context, skills, …). */
  miscTokens: number;
}

export const DEFAULT_LIMITS: CondenseLimits = {
  userTokens: 400,
  assistantTokens: 300,
  reasoningTailTokens: 500,
  reasoningKeep: 1,
  toolCallTokens: 120,
  toolResultTokens: 300,
  toolErrorTokens: 600,
  miscTokens: 200,
};

const PREFIXES: ReadonlyArray<{ prefix: string; kind: EntryKind }> = [
  { prefix: "[Assistant reasoning]: ", kind: "reasoning" },
  { prefix: "[Assistant tool call]: ", kind: "tool-call" },
  { prefix: "[Synthetic context]: ", kind: "synthetic" },
  { prefix: "[Skill activated]: ", kind: "skill" },
  { prefix: "[Tool result]: ", kind: "tool-result" },
  { prefix: "[Tool error]: ", kind: "tool-error" },
  { prefix: "[Assistant]: ", kind: "assistant" },
  { prefix: "[User]: ", kind: "user" },
  { prefix: "[Shell]: ", kind: "shell" },
];

export function entryLine(entry: Entry): string {
  return `${entry.prefix}${entry.body}`;
}

export function renderEntries(entries: readonly Entry[]): string {
  return entries.map(entryLine).join("\n");
}

/**
 * Splits a rendered history blob into entries. Lines without a known prefix
 * continue the previous entry (message bodies may contain newlines).
 */
export function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    const match = PREFIXES.find((candidate) => line.startsWith(candidate.prefix));
    if (match) {
      entries.push({ kind: match.kind, prefix: match.prefix, body: line.slice(match.prefix.length) });
      continue;
    }
    const last = entries.at(-1);
    if (last) last.body += `\n${line}`;
    else if (line.trim() !== "") entries.push({ kind: "other", prefix: "", body: line });
  }
  return entries;
}

/** Keeps at most `maxTokens` tokens of `text`: the head, the tail, or both. */
export function truncateTokens(
  counter: TokenCounter,
  text: string,
  maxTokens: number,
  mode: "head" | "tail" | "both",
): string {
  if (maxTokens <= 0) return ELISION;
  if (counter.count(text) <= maxTokens) return text;

  const codePoints = Array.from(text);
  if (mode === "head") return `${takeHead(counter, codePoints, maxTokens).text}${ELISION}`;
  if (mode === "tail") return `${ELISION}${takeTail(counter, codePoints, maxTokens).text}`;

  const half = Math.max(1, Math.floor(maxTokens / 2));
  const head = takeHead(counter, codePoints, half);
  const tail = takeTail(counter, codePoints.slice(head.used), Math.max(1, maxTokens - half));
  return `${head.text}${ELISION}${tail.text}`;
}

interface Slice {
  text: string;
  /** Code points consumed. */
  used: number;
}

function takeHead(counter: TokenCounter, codePoints: readonly string[], maxTokens: number): Slice {
  let low = 0;
  let high = codePoints.length;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (counter.count(codePoints.slice(0, mid).join("")) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { text: codePoints.slice(0, best).join(""), used: best };
}

function takeTail(counter: TokenCounter, codePoints: readonly string[], maxTokens: number): Slice {
  let low = 0;
  let high = codePoints.length;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (counter.count(codePoints.slice(codePoints.length - mid).join("")) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { text: codePoints.slice(codePoints.length - best).join(""), used: best };
}

function condenseEntry(counter: TokenCounter, entry: Entry, limits: CondenseLimits, keepReasoningTail: boolean): Entry {
  switch (entry.kind) {
    case "reasoning":
      // The conclusion of a thinking block sits at its end, so the newest block
      // keeps its tail instead of disappearing.
      return keepReasoningTail
        ? { ...entry, body: truncateTokens(counter, entry.body, limits.reasoningTailTokens, "tail") }
        : { ...entry, body: REASONING_OMITTED };
    case "user":
      return { ...entry, body: truncateTokens(counter, entry.body, limits.userTokens, "both") };
    case "assistant":
      return { ...entry, body: truncateTokens(counter, entry.body, limits.assistantTokens, "both") };
    case "tool-call":
      return { ...entry, body: truncateTokens(counter, entry.body, limits.toolCallTokens, "both") };
    case "tool-error":
      return { ...entry, body: truncateTokens(counter, entry.body, limits.toolErrorTokens, "both") };
    case "tool-result":
    case "shell":
      return { ...entry, body: truncateTokens(counter, entry.body, limits.toolResultTokens, "both") };
    default:
      return { ...entry, body: truncateTokens(counter, entry.body, limits.miscTokens, "both") };
  }
}

export interface CondenseResult {
  text: string;
  /** Entries dropped entirely because even condensed they did not fit. */
  dropped: number;
  /** True when anything was shortened, marked or dropped. */
  changed: boolean;
}

/**
 * Condenses entries into a digest of at most `budgetTokens` tokens.
 *
 * Rules are applied per entry kind first; if the digest is still too large, the
 * oldest entries are dropped (never all of them), and as a last resort the whole
 * digest is cut in the middle — always with a visible marker.
 */
export function condenseEntries(
  counter: TokenCounter,
  entries: readonly Entry[],
  limits: CondenseLimits,
  budgetTokens: number,
): CondenseResult {
  if (entries.length === 0) return { text: "", dropped: 0, changed: false };

  const reasoningIndexes = entries.flatMap((entry, index) => (entry.kind === "reasoning" ? [index] : []));
  const keepTail = new Set(reasoningIndexes.slice(-Math.max(0, limits.reasoningKeep)));

  let changed = false;
  const condensed = entries.map((entry, index) => {
    const next = condenseEntry(counter, entry, limits, keepTail.has(index));
    if (next.body !== entry.body) changed = true;
    return next;
  });

  // Budget accounting costs one tokenizer call per entry, so the digest can be
  // trimmed without recounting the whole blob on every drop.
  const lineTokens = condensed.map((entry) => counter.count(entryLine(entry)) + 1);
  let total = counter.count(DIGEST_MARK) + lineTokens.reduce((sum, value) => sum + value, 0);
  let dropped = 0;
  while (total > budgetTokens && dropped < condensed.length - 1) {
    total -= lineTokens[dropped] ?? 0;
    dropped += 1;
  }

  const notice = dropped > 0 ? `[token-guard: ${dropped} earlier messages condensed]\n` : "";
  let text = `${DIGEST_MARK}\n${notice}${renderEntries(condensed.slice(dropped))}`;
  if (dropped > 0) changed = true;

  if (dropped + 1 >= condensed.length && counter.count(text) > budgetTokens) {
    // Even one entry does not fit: cut the digest itself, keeping both ends.
    text = truncateTokens(counter, text, budgetTokens, "both");
    changed = true;
  }

  return { text, dropped, changed };
}
