# Architecture and decisions

🇷🇺 [Russian version](DESIGN.ru.md)

## Problem

A typical failure: the engine rejects the assembled request with
`exceed_context_size_error`. There are two independent defects behind it:

1. **Limit mismatch.** `model.limit.context` may not match the engine's actual
   window (`n_ctx`): the configuration promises more than the engine holds. Core
   computes the compaction threshold from `limit.context`, so compaction fires
   too late.
2. **Underestimated token count.** Core sizes the request as `chars/4`
   (`core/src/util/token.ts`: `const CHARS_PER_TOKEN = 4`). On a mix of Cyrillic,
   code, and JSON the real ratio is ≈ 2.8 chars/token, i.e. an underestimate of
   about ×1.4. During compaction core (`core/src/session/compaction.ts`,
   `splitConversation`/`recentStart`) may freeze into the checkpoint a `recent`
   that is "within `keep.tokens`" by its own estimate while being several times
   larger in real tokens. After that every request exceeds the window, and the
   session can no longer be repaired by compaction — all the content lives inside
   the frozen `recent`.

## What the plugin does

Three independent building blocks:

| Module | Purpose |
|---|---|
| `src/tokenizer/local.ts` | exact counting via `@huggingface/tokenizers` |
| `src/guard.ts` | bringing the assembled request within budget |
| `src/model-limit.ts` | syncing `limit.context` with the engine window |
| `index.ts` | registering the `context` hook and the model transform |

### Why the `context` hook

Plugin API V2 **does not allow** replacing the internal token estimate. The most
that is available is editing the assembled request in
`session.hook("context", event => …)`, where `system`, `messages`, `tools`, and
`options` are mutable. So the plugin does not "fix the formula"; it guarantees
that the outgoing request fits the real budget.

### Condense order

1. The `<recent-context>` inside `<conversation-checkpoint>` is rewritten into a
   bounded digest (at most `digestShare · budget` tokens). Entries keep their
   core-style prefixes; long ones are cut in the middle with `…`, reasoning
   blocks other than the newest `reasoningKeep` become `[reasoning omitted]`, and
   entries that still do not fit are dropped oldest-first behind a
   `[token-guard: N earlier messages condensed]` notice. The digest starts with
   `<!-- token-guard:condensed v1 -->`, which makes a repeated pass a no-op; the
   checkpoint wrapper and its `<summary>` are never touched.
2. Oversized tool results and shell outputs are shortened in place, cutting just
   enough to fit and leaving room for a one-line notice
   (`[token-guard] truncated: kept 4210 of 12940 tokens (67% elided to fit the
   context budget; re-running returns the same).`). The part shape is kept
   (`result.type`, array `value`).
3. Once per-result truncation no longer helps, the oldest oversized results —
   never the newest `ledgerKeep` (2) — are replaced by a single ledger line each:
   `[token-guard] condensed: read /tmp/big.json — was ~3400 tok, elided to fit
   the budget`, plus one shared note per request asking for narrow reads or a
   subagent instead of re-running the call.
4. Only if the request still does not fit, the oldest whole exchanges are removed.
   A checkpoint/summary, the digest, a system message, the newest `ledgerKeep`
   results and the newest exchange are never removed.

All limits are expressed in **real tokens** (the model's tokenizer) instead of
`chars/4`, and the request is recounted while the guard works. Sizes are measured
on the text the model actually reads — a result's payload (the joined
`value[*].text`) rather than its `[Tool result]: ` rendering with the JSON
escaping around it — and every edit is accounted for by re-rendering the slot on
both sides of the change.

### Limit sync

`GET {backend}/api/v0/models` → `data[].loaded_context_length` (the engine's
actual window) and `max_context_length`. The value is applied via
`ctx.model.transform` (`editor.update(providerID, modelID, m => m.limit.context = …)`).
Once a minute the window is re-read, and on change `ctx.model.reload()` is called.

## Measurements (resource rationale)

Tokenizer of the target model (`tokenizer.json` of the Qwen3 family, 11.4 MB),
Python binding `tokenizers` 0.23.3:

- loading the vocabulary: +82 MB RSS, 164 ms;
- throughput: 3.0 MB of characters/s (~500k tokens/s) on a single thread;
- 380540 characters of mixed text → 134380 tokens in 119 ms;
- GPU/VRAM: **not needed**.

`@huggingface/tokenizers` (what the plugin uses) is pure JS/TS, with no native
dependencies, ~8.3 KB gzip. The order of memory and time is the same.

## Verified facts about backends

- **LM Studio** (OpenAI-compatible API, default port 1234): there is no
  tokenization endpoint in any API group. Unknown routes answer with **HTTP
  200** and the body `{"error":"Unexpected endpoint or method."}` — not to be
  mistaken for success.
- `GET /api/v0/models` returns `state`, `max_context_length`,
  `loaded_context_length` — the window source for `syncLimit`.
- **llama.cpp server** (`llama-server.exe`): `POST /tokenize`, `POST /detokenize`,
  `GET /props` (`default_generation_settings.n_ctx`) — the basis for `delegate`
  mode.
- **vLLM** — has `/tokenize`, but does not run natively on Windows. **Ollama** —
  no public `/tokenize`.

## Open questions / plan

1. **Asynchronous `TokenCounter`** — to enable `delegate` mode and, optionally,
   to "calibrate" the estimate against reality (`prompt_tokens` from LM Studio
   responses).
2. **Live-session test** — run a long session and compare `[token-guard]` logs
   with the actual `prompt_tokens` from LM Studio.
3. **Publication** — publish to GitHub after it has been exercised.
