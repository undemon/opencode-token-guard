/**
 * llama.cpp server (llama-server) client.
 *
 * Used when the user switches the engine from LM Studio to llama-server.
 * Contracts:
 *   GET  /props      → { default_generation_settings: { n_ctx, ... }, ... }
 *   POST /tokenize   → { content, add_special?, parse_special?, with_pieces? }
 *                      → { tokens: number[] } | { tokens: [{ id, piece }] }
 *   POST /detokenize → { tokens: number[] } → { content: string }
 */

import type { BackendWindow } from "../types.js";
import type { FetchLike } from "./lmstudio.js";

const defaultFetch = fetch as unknown as FetchLike;

export async function fetchLlamaServerWindow(
  baseURL: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<BackendWindow | undefined> {
  const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/props`);
  if (!response.ok) return undefined;
  const json = (await response.json()) as Record<string, unknown>;
  const settings = json.default_generation_settings as Record<string, unknown> | undefined;
  const nCtx = settings && typeof settings.n_ctx === "number" ? settings.n_ctx : undefined;
  if (!nCtx || nCtx <= 0) return undefined;
  return { baseURL, source: "llama-server", context: nCtx };
}

export interface TokenizeOptions {
  addSpecial?: boolean;
  parseSpecial?: boolean;
}

/** Exact token counting on the llama-server side. */
export async function tokenizeViaServer(
  baseURL: string,
  content: string,
  tokenizeOptions: TokenizeOptions = {},
  fetchImpl: FetchLike = defaultFetch,
): Promise<number[]> {
  const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      add_special: tokenizeOptions.addSpecial ?? false,
      parse_special: tokenizeOptions.parseSpecial ?? true,
    }),
  });
  if (!response.ok) throw new Error(`llama-server /tokenize returned HTTP ${response.status}`);
  const json = (await response.json()) as { tokens?: unknown };
  const tokens = json.tokens;
  if (!Array.isArray(tokens)) throw new Error("llama-server /tokenize: missing the tokens field");
  return tokens.map((token) => (typeof token === "number" ? token : Number((token as { id?: unknown }).id ?? NaN)));
}
