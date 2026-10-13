/**
 * Delegating token counting to a llama.cpp server backend (POST /tokenize).
 *
 * Status: skeleton. The TokenCounter.count interface is synchronous, while
 * delegation is a network call. OpenCode hooks may be async, so the next step is
 * to move TokenCounter to an asynchronous interface (see docs/DESIGN.md).
 *
 * LM Studio does NOT expose such an endpoint (verified): /tokenize, /v1/tokenize,
 * /api/v0/tokenize, /api/v0/count_tokens all answer 200 with the body
 * {"error":"Unexpected endpoint or method."}.
 */

import type { TokenCounter } from "../types.js";

export function createDelegateCounter(baseURL: string): TokenCounter {
  return {
    kind: "delegate",
    count(): number {
      throw new Error(
        `Delegate mode is not wired up yet. The backend ${baseURL} must be a llama.cpp server (llama-server) ` +
          `with the /tokenize endpoint; see src/backend/llamaserver.ts and docs/DESIGN.md. ` +
          `For now use mode: "local" with a local tokenizer.json.`,
      );
    },
    describe(): string {
      return `delegate(${baseURL})`;
    },
  };
}
