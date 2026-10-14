/**
 * opencode-token-guard — OpenCode V2 plugin entry point.
 *
 * What it does:
 *  1) counts tokens in the assembled request with the model's real tokenizer
 *     (the core's chars/4 badly underestimates non-Latin text and dense JSON);
 *  2) trims the request down to a safe budget (first an oversized
 *     <recent-context> in a checkpoint, then the oldest tool outputs, then the
 *     oldest whole exchanges);
 *  3) syncs model.limit.context with the backend's actual window
 *     (LM Studio GET /api/v0/models), removing config/engine mismatch.
 */

import { Plugin } from "@opencode/plugin";
import type { ContextHookEvent, Disposable, PluginContext } from "@opencode/plugin";
import { appliesToProvider, computeBudget, effectiveWindow, readOptions } from "./src/options.js";
import { createLogger } from "./src/logger.js";
import { createCounter } from "./src/tokenizer/index.js";
import { guardRequest } from "./src/guard.js";
import { fetchLmStudioWindow } from "./src/backend/lmstudio.js";
import { applyLimitUpdates, planLimitUpdates } from "./src/model-limit.js";
import type { BackendWindow, TokenCounter } from "./src/types.js";

const REFRESH_INTERVAL_MS = 60_000;

export default Plugin.define({
  id: "opencode-token-guard",
  async setup(ctx: PluginContext) {
    const options = readOptions(ctx.options);
    const logger = createLogger(options.debug, options.logFile);
    logger.info(`loaded: mode=${options.mode}, backend=${options.backend ?? "(not set)"}`);

    let counter: TokenCounter | undefined;
    try {
      counter = createCounter(options);
      logger.info(`token counter: ${counter.describe()}`);
    } catch (error) {
      logger.warn(`counter unavailable, guard disabled: ${(error as Error).message}`);
    }

    const state: { window: BackendWindow | undefined } = { window: undefined };
    const disposables: Disposable[] = [];

    // --- Sync limit.context with the backend window -------------------------
    if (options.syncLimit && options.backend) {
      try {
        state.window = await fetchLmStudioWindow(options.backend);
        if (state.window) {
          logger.info(`backend window: ${state.window.context} tokens (${state.window.source})`);
          disposables.push(
            await ctx.model.transform((editor) => {
              if (!state.window) return;
              const window = state.window.context;
              const plans = planLimitUpdates(editor.list(), window, options, (providerID) =>
                appliesToProvider(options, providerID),
              );
              if (plans.length > 0) {
                logger.debug(
                  `syncing limit.context: ` +
                    plans.map((p) => `${p.providerID}/${p.modelID} ${p.from}→${p.to}`).join(", "),
                );
              }
              applyLimitUpdates(editor, plans);
            }),
          );
        } else {
          logger.warn("could not fetch the backend window — limit sync skipped");
        }
      } catch (error) {
        logger.warn(`backend request failed: ${(error as Error).message}`);
      }
    }

    // --- Refreshing the backend window --------------------------------------
    let timer: ReturnType<typeof setInterval> | undefined;
    if (options.syncLimit && options.backend) {
      timer = setInterval(() => {
        void (async () => {
          try {
            const next = await fetchLmStudioWindow(options.backend as string);
            if (next && next.context !== state.window?.context) {
              logger.info(`backend window changed: ${state.window?.context ?? "?"} → ${next.context}`);
              state.window = next;
              await ctx.model.reload();
            }
          } catch {
            /* backend unavailable — keep the previous value */
          }
        })();
      }, REFRESH_INTERVAL_MS);
    }

    // --- Hook on the assembled request --------------------------------------
    if (counter) {
      const guardCounter = counter;
      const handler = (event: ContextHookEvent) => {
        const window = state.window;
        if (!window) return; // backend window unknown — do not guess
        logger.debug(`context hook: window ${effectiveWindow(window.context, options)}, messages ${event.messages.length}`);
        const budget = computeBudget(window.context, options);
        try {
          guardRequest(
            guardCounter,
            {
              system: event.system,
              messages: event.messages,
              ...(options.includeToolsInBudget ? { tools: event.tools } : {}),
            },
            { budget, includeToolsInBudget: options.includeToolsInBudget, digestShare: options.digestShare, limits: options.condense, logger },
          );
        } catch (error) {
          logger.warn(`guard failed: ${(error as Error).message}`);
        }
      };

      if (options.providerIDs.length > 0) {
        for (const providerID of options.providerIDs) {
          disposables.push(await ctx.session.hook("context", handler, { providerID }));
        }
      } else {
        disposables.push(await ctx.session.hook("context", handler));
      }
      logger.info("context hook registered");
    }

    return async () => {
      if (timer) clearInterval(timer);
      for (const disposable of disposables) {
        try {
          await disposable.dispose();
        } catch {
          /* ignore cleanup errors */
        }
      }
      logger.info("unloaded");
    };
  },
});
