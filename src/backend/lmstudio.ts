/**
 * LM Studio client: reads the actual context window of the loaded model.
 *
 * GET {base}/api/v0/models → { data: [ { id, state, max_context_length,
 * loaded_context_length, ... } ] }
 */

import type { BackendModel, BackendWindow } from "../types.js";

export type FetchLike = (
  input: string,
  init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch = fetch as unknown as FetchLike;

export async function fetchLmStudioWindow(baseURL: string, fetchImpl: FetchLike = defaultFetch): Promise<BackendWindow | undefined> {
  const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/api/v0/models`);
  if (!response.ok) return undefined;
  const json = await response.json();
  const models = extractModels(json);
  const loaded = models.find((model) => model.state === "loaded") ?? models[0];
  if (!loaded) return undefined;
  const context = loaded.loadedContextLength ?? loaded.maxContextLength;
  if (!context || context <= 0) return undefined;
  return {
    baseURL,
    source: "lmstudio",
    context,
    ...(loaded.id ? { modelID: loaded.id } : {}),
    ...(loaded.maxContextLength ? { maxContext: loaded.maxContextLength } : {}),
  };
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractModels(json: unknown): BackendModel[] {
  const list = Array.isArray(json)
    ? json
    : json !== null && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
      ? ((json as { data: unknown[] }).data)
      : [];
  return list
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => {
      const id = typeof item.id === "string" ? item.id : typeof item.key === "string" ? item.key : "";
      const loaded = toNumber(item.loaded_context_length) ?? toNumber(item.loadedContextLength);
      const max = toNumber(item.max_context_length) ?? toNumber(item.maxContextLength);
      const state = typeof item.state === "string" ? item.state : undefined;
      return {
        id,
        ...(state !== undefined ? { state } : {}),
        ...(loaded !== undefined ? { loadedContextLength: loaded } : {}),
        ...(max !== undefined ? { maxContextLength: max } : {}),
      } satisfies BackendModel;
    });
}
