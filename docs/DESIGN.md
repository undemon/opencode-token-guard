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

### Trim order

1. The `<recent-context>` inside `<conversation-checkpoint>` — its beginning
   (the oldest part) is dropped, with a note
   `[token-guard: removed N characters of older context]`. The newest part is
   preserved.
2. The oldest text parts beginning with `[Tool result]:` / `[Tool error]:` are
   replaced with a short stub.

The "how many characters to remove" estimate is
`excess_tokens × (chars/tokens) × 1.15`; after each edit the request is
recounted (up to 8 iterations over checkpoints, then up to 64 over tool
results).

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
2. **Whole-history trimming** — not just `recent-context` in the checkpoint, but
   also dropping whole request/response exchanges when the overflow is large.
3. **Live-session test** — run a long session and compare `[token-guard]` logs
   with the actual `prompt_tokens` from LM Studio.
4. **Publication** — publish to GitHub after it has been exercised.
