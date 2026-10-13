/**
 * Local type shim for `@opencode/plugin`.
 *
 * The `@opencode/plugin` package is not published to npm: it is provided by the
 * OpenCode runtime. This shim describes only the parts of the Plugin API V2 that
 * this plugin uses. Source: the documentation at
 * https://opencode.ai/v2/docs/build/plugins.
 *
 * IMPORTANT: when this diverges from the real runtime, the documentation and the
 * runtime take precedence; fix the shim.
 */
declare module "@opencode/plugin" {
  export interface Disposable {
    dispose(): Promise<void>;
  }

  export interface HookScope {
    providerID?: string;
  }

  /** A message/system part in the assembled model request. */
  export interface RequestPart {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  /** A message in the assembled request (LLMRequest.Message). */
  export interface RequestMessage {
    role: string;
    content?: RequestPart[] | string;
    [key: string]: unknown;
  }

  export interface ContextHookEvent {
    /** System parts of the request (mutable). */
    system: RequestPart[];
    /** Message history (mutable). */
    messages: RequestMessage[];
    /** Tools available to the model; deleting a key removes the tool. */
    tools: Record<string, unknown>;
    /** Generation/provider options; empty at the start of each call. */
    options: Record<string, unknown>;
  }

  export interface CompactionHookEvent {
    messages: RequestMessage[];
    /** Set a result to skip the model call. */
    result?: { summary: string; [key: string]: unknown };
  }

  export interface SessionDomain {
    hook(
      kind: "context",
      handler: (event: ContextHookEvent) => void | Promise<void>,
      scope?: HookScope,
    ): Promise<Disposable>;
    hook(
      kind: "compaction",
      handler: (event: CompactionHookEvent) => void | Promise<void>,
      scope?: HookScope,
    ): Promise<Disposable>;
    hook(
      kind: string,
      handler: (event: Record<string, unknown>) => void | Promise<void>,
      scope?: HookScope,
    ): Promise<Disposable>;
    create(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    prompt(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    compact(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    context(input: Record<string, unknown>): Promise<readonly RequestMessage[]>;
  }

  export interface ModelLimit {
    context: number;
    input?: number;
    output?: number;
  }

  export interface ModelInfo {
    providerID: string;
    id: string;
    name?: string;
    limit: ModelLimit;
    [key: string]: unknown;
  }

  export interface ModelEditor {
    list(providerID?: string): Array<ModelInfo & Record<string, unknown>>;
    get(providerID: string, modelID: string): (ModelInfo & Record<string, unknown>) | undefined;
    update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void;
    remove(providerID: string, modelID: string): void;
  }

  export interface ModelDomain {
    list(input?: Record<string, unknown>): Promise<ModelInfo[]>;
    transform(callback: (editor: ModelEditor) => void): Promise<Disposable>;
    reload(): Promise<void>;
  }

  export interface PluginStorage {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: readonly { key: string; value: unknown }[];
      next?: string;
    }>;
  }

  export interface PluginContext {
    app: { version: string };
    options: Record<string, unknown>;
    location: {
      directory: string;
      workspaceID?: string;
      project: { id: string; directory: string; canonical: string };
    };
    session: SessionDomain;
    model: ModelDomain;
    storage: PluginStorage;
    event: {
      subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; [key: string]: unknown }>;
    };
    [key: string]: unknown;
  }

  export type PluginSetupResult = void | Disposable | (() => void | Promise<void>);

  export interface PluginDefinition {
    id: string;
    setup(ctx: PluginContext): PluginSetupResult | Promise<PluginSetupResult>;
  }

  export const Plugin: {
    define(definition: PluginDefinition): PluginDefinition;
  };

  export default Plugin;
}
