/**
 * Shared project types.
 */

/** Token counter: a local tokenizer or backend delegation. */
export interface TokenCounter {
  readonly kind: "local" | "delegate";
  /** Number of tokens in the text. */
  count(text: string): number;
  /** Human-readable description (for logs). */
  describe(): string;
}

/** A model as reported by the backend. */
export interface BackendModel {
  id: string;
  state?: string;
  /** Actual window held by the engine (n_ctx). */
  loadedContextLength?: number;
  /** Maximum the model supports. */
  maxContextLength?: number;
}

/** The context window as seen by the backend. */
export interface BackendWindow {
  /** Backend base URL, e.g. http://127.0.0.1:1234 */
  baseURL: string;
  /** Source of the value. */
  source: "lmstudio" | "llama-server" | "config";
  /** Real window in tokens. */
  context: number;
  /** Model id, if known. */
  modelID?: string;
  /** Model maximum, if known. */
  maxContext?: number;
}

/** Result of the guard: tokens before/after and what was done. */
export interface GuardOutcome {
  before: number;
  after: number;
  budget: number;
  trimmedCheckpoints: number;
  droppedResults: number;
  /** true if the budget was never reached. */
  stillOverBudget: boolean;
}
