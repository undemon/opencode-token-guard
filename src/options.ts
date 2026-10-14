/**
 * Plugin options parsing (ctx.options from opencode.jsonc).
 *
 * Example:
 *   plugins: [{
 *     package: "/absolute/path/opencode-token-guard",
 *     options: {
 *       backend: "http://127.0.0.1:1234",
 *       mode: "local",
 *       tokenizerPath: "C:/…/tokenizer.json",
 *       reservedOutputTokens: 8192,
 *       safetyMarginPct: 8,
 *     },
 *   }]
 */

export type GuardMode = "local" | "delegate";

import { DEFAULT_LIMITS, type CondenseLimits } from "./condense.js";

export interface GuardOptions {
  /** How to count tokens: with a local tokenizer or by delegating to the backend. */
  mode: GuardMode;
  /** Backend base URL (LM Studio or llama-server), without a trailing slash. */
  backend?: string;
  /** OpenCode providers the hooks and limit sync apply to. */
  providerIDs: string[];
  /** Path to the model's tokenizer.json. */
  tokenizerPath?: string;
  /** Path to tokenizer_config.json (optional for many models). */
  tokenizerConfigPath?: string;
  /** Sync model.limit.context with the backend's actual window. */
  syncLimit: boolean;
  /** Sync limit.context downward only (never above the config value). */
  syncLimitDownOnly: boolean;
  /** Reserve for the model's reply (tokens). */
  reservedOutputTokens: number;
  /** Safety margin as a percentage of the window. */
  safetyMarginPct: number;
  /** Include tool definitions in the request budget. */
  includeToolsInBudget: boolean;
  /** Verbose logging. */
  debug: boolean;
  /** File the log lines are mirrored to (optional; handy for verification). */
  logFile?: string;
  /** Upper bound of the window: caps both limit.context and the request budget. */
  maxContext?: number;
  /** Share of the request budget used as the cap for a condensed digest (0–1). */
  digestShare: number;
  /** Per-entry token limits used while condensing. */
  condense: CondenseLimits;
}

const DEFAULTS: GuardOptions = {
  mode: "local",
  providerIDs: [],
  syncLimit: true,
  syncLimitDownOnly: false,
  reservedOutputTokens: 8192,
  safetyMarginPct: 8,
  includeToolsInBudget: true,
  debug: false,
  digestShare: 0.3,
  condense: DEFAULT_LIMITS,
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A share of the budget: a finite number strictly between 0 and 1. */
function share(value: unknown, fallback: number): number {
  const parsed = num(value, fallback);
  return parsed > 0 && parsed < 1 ? parsed : fallback;
}

function readLimits(raw: unknown): CondenseLimits {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    userTokens: num(o.userTokens, DEFAULT_LIMITS.userTokens),
    assistantTokens: num(o.assistantTokens, DEFAULT_LIMITS.assistantTokens),
    reasoningTailTokens: num(o.reasoningTailTokens, DEFAULT_LIMITS.reasoningTailTokens),
    reasoningKeep: Math.max(0, Math.floor(num(o.reasoningKeep, DEFAULT_LIMITS.reasoningKeep))),
    toolCallTokens: num(o.toolCallTokens, DEFAULT_LIMITS.toolCallTokens),
    toolResultTokens: num(o.toolResultTokens, DEFAULT_LIMITS.toolResultTokens),
    toolErrorTokens: num(o.toolErrorTokens, DEFAULT_LIMITS.toolErrorTokens),
    miscTokens: num(o.miscTokens, DEFAULT_LIMITS.miscTokens),
  };
}

export function readOptions(raw: Record<string, unknown> | undefined): GuardOptions {
  const o = raw ?? {};
  const mode = o.mode === "delegate" ? "delegate" : "local";
  const providerIDs = Array.isArray(o.providerIDs)
    ? o.providerIDs.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];

  const backend = str(o.backend)?.replace(/\/+$/, "");

  return {
    mode,
    ...(backend !== undefined ? { backend } : {}),
    providerIDs,
    ...(str(o.tokenizerPath) !== undefined ? { tokenizerPath: str(o.tokenizerPath) } : {}),
    ...(str(o.tokenizerConfigPath) !== undefined ? { tokenizerConfigPath: str(o.tokenizerConfigPath) } : {}),
    syncLimit: bool(o.syncLimit, DEFAULTS.syncLimit),
    syncLimitDownOnly: bool(o.syncLimitDownOnly, DEFAULTS.syncLimitDownOnly),
    reservedOutputTokens: num(o.reservedOutputTokens, DEFAULTS.reservedOutputTokens),
    safetyMarginPct: num(o.safetyMarginPct, DEFAULTS.safetyMarginPct),
    includeToolsInBudget: bool(o.includeToolsInBudget, DEFAULTS.includeToolsInBudget),
    debug: bool(o.debug, DEFAULTS.debug),
    ...(str(o.logFile) !== undefined ? { logFile: str(o.logFile) } : {}),
    ...(optNum(o.maxContext) !== undefined ? { maxContext: optNum(o.maxContext) } : {}),
    digestShare: share(o.digestShare, DEFAULTS.digestShare),
    condense: readLimits(o.condense),
  };
}

/**
 * The effective window used for the budget: the backend window capped by `maxContext`.
 */
export function effectiveWindow(window: number, options: GuardOptions): number {
  return options.maxContext !== undefined ? Math.min(window, options.maxContext) : window;
}

/**
 * Request budget in tokens: the effective window minus the reply reserve and the
 * safety margin. The effective window is the backend window capped by `maxContext`,
 * so the guard never lets a request grow past the model's configured limit.
 */
export function computeBudget(window: number, options: GuardOptions): number {
  const effective = effectiveWindow(window, options);
  const margin = Math.floor((effective * options.safetyMarginPct) / 100);
  const budget = effective - options.reservedOutputTokens - margin;
  return Math.max(0, budget);
}

/** Whether the plugin applies its hooks to the given provider. */
export function appliesToProvider(options: GuardOptions, providerID: string | undefined): boolean {
  if (options.providerIDs.length === 0) return true;
  return providerID !== undefined && options.providerIDs.includes(providerID);
}
