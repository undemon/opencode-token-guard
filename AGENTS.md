# AGENTS.md — opencode-token-guard

Guidance for AI agents and developers working on this repository.

## What this project is

An **OpenCode V2** plugin that prevents context overflow on local models. It:

1. counts the assembled request with the model's real tokenizer;
2. trims the outgoing request to a safe budget in the `context` hook;
3. syncs `model.limit.context` with the backend engine window.

The problem it solves: the OpenCode core estimates tokens as `chars/4`, which
underestimates non-Latin text and dense structured data, and the configured
`limit.context` can diverge from the engine's real `n_ctx`.

## Layout

- `index.ts` — plugin entry point (`Plugin.define`); registers the `context` hook
  and the model transform.
- `src/options.ts` — option parsing and budget computation.
- `src/guard.ts` — request condensing (stage 1: a checkpoint's `<recent-context>`
  into a bounded digest; stage 2: oversized tool results truncated just enough,
  with a notice; stage 3: a one-line ledger entry per oldest oversized result;
  stage 4: oldest whole exchanges dropped as a last resort).
- `src/condense.ts` — entry parsing, per-kind token limits and the digest builder.
- `src/text.ts` — text extraction and editable text slots (text parts,
  `tool-result` parts, string/`text` message content).
- `src/tokenizer/` — `local.ts` (real tokenizer via `@huggingface/tokenizers`),
  `delegate.ts` (llama-server skeleton), `index.ts` (factory).
- `src/backend/` — `lmstudio.ts` (`GET /api/v0/models`),
  `llamaserver.ts` (`GET /props`, `POST /tokenize`).
- `src/model-limit.ts` — computing and applying `limit.context` updates.
- `types/opencode-plugin.d.ts` — local type shim for `@opencode/plugin`
  (not published to npm).
- `tests/` — `node:test` suites.
- `docs/DESIGN.md` — architecture and rationale (Russian mirror:
  `docs/DESIGN.ru.md`).

## Commands

- `npm run check` — typecheck + tests. Run this before every commit.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — `node --import tsx --test tests/*.test.ts`.

`tests/guard-real.test.ts` runs only when `models/tokenizer.json` exists; that
file is gitignored (~11 MB). Copy your model's `tokenizer.json` there to exercise
the real-tokenizer path.

## Hard constraints

- The core token estimate (`chars/4`) cannot be changed from a plugin. The only
  levers are the `context` hook (edit the outgoing request), the `compaction` hook
  (supply a summary), and `model.transform` (patch `limit.context`). Do not
  attempt to "fix the formula".
- The guard condenses instead of cutting: when a `<recent-context>` is too large,
  build a bounded digest (head + tail for long entries, `[reasoning omitted]` for
  all but the newest `reasoningKeep` blocks) rather than deleting its beginning.
  Never remove a checkpoint/summary, the digest, a system message or the newest
  exchange.
- Every shortening must stay visible (`…`, `[reasoning omitted]`,
  `[token-guard: N earlier messages condensed]`, `[token-guard] truncated: kept X
  of Y tokens`, `[token-guard] condensed: <tool> <target> — was ~N tok`), and
  condensing must be idempotent: the digest starts with `DIGEST_MARK` and the
  notice markers are detected, so a second pass is a no-op.
- When editing a `tool-result` part, keep its shape (the `result` discriminator
  and an array `value`) and only swap the payload for a text stub, so the request
  stays valid for the provider adapters.
- Measure and shorten the payload text of a result (`toolResultText`, the joined
  `value[*].text`), never the `[Tool result]: ` rendered form with its JSON
  escaping — that inflates the apparent size. Account for an edit with the slot's
  rendered size before and after, and re-measure at stage boundaries before
  escalating: per-string counting drifts.
- Keep trimming conservative and idempotent: after edits the request is
  recounted, and trimming stops as soon as it fits.
- The request budget is `W − reservedOutputTokens − safetyMarginPct% · W`, where
  `W = min(backend window, maxContext)`. `maxContext` caps both `limit.context`
  and the budget, so the two stay consistent.
- LM Studio has no tokenization endpoint; unknown routes answer **HTTP 200** with
  `{"error":"Unexpected endpoint or method."}` — do not treat 200 as success.
- `@opencode/plugin` is provided by the runtime, not npm. When it diverges from
  `types/opencode-plugin.d.ts`, the runtime and docs win — update the shim.

## Conventions

- TypeScript, ESM, strict mode. Relative imports carry a `.js` extension.
- Comments and user-facing strings are English. Russian is kept only in the
  `*.ru.md` mirrors.
- Keep tests hermetic: no network, no real backend. Use fakes; the single
  real-tokenizer test skips when the tokenizer file is absent.
- Do not commit `models/`, `node_modules/`, or `*.local.json`.

## Git

The author identity is anonymized (`undemon@users.noreply.github.com`). History
is a single root commit until the first public release.
