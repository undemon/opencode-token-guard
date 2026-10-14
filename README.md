# opencode-token-guard

🇷🇺 [Russian version](README.ru.md)

An **OpenCode V2** plugin that prevents context overflow on local models: it
counts tokens with the model's real tokenizer, trims the outgoing request to a
safe budget, and synchronizes `model.limit.context` with the engine's actual
window.

## Why

OpenCode core estimates tokens with the formula **`chars / 4`**
(`Token.estimate` in `core/src/util/token.ts`, constant `CHARS_PER_TOKEN = 4`).
For local models this underestimates badly:

| Text type | chars/token | `chars/4` error |
|---|---|---|
| Russian prose | 3.13 | underestimate ×1.28 |
| English/code | 4.45 | almost accurate |
| Dense JSON | 2.18 | underestimate ×1.84 |
| Mixed (RU + code + JSON) | 2.83 | **underestimate ×1.41** |

As a result OpenCode keeps more in context than actually fits the engine, and the
request fails with HTTP 400 `exceed_context_size_error`. The plugin fixes both the
size estimate and the mismatch between the configured limit and the engine
window (`n_ctx`).

## What it does

1. **Exact counting** — tokenizes the assembled request (system + history +
   tools) with the model's real `tokenizer.json`.
2. **Guard** — if the request does not fit the budget, it condenses by priority:
   first an oversized `<recent-context>` inside the checkpoint (the usual
   culprit), then oversized tool results and shell outputs (cut just enough to
   fit, saying so in the payload), then — once per-result truncation no longer
   helps — a one-line ledger entry per result, and only as a last resort the
   oldest whole exchanges. Nothing is dropped silently: every shortening leaves
   a visible marker, and the checkpoint summary, the newest reasoning tail, the
   newest `ledgerKeep` results and the newest exchange are preserved.
3. **Limit sync** — reads `GET /api/v0/models` from LM Studio and sets
   `model.limit.context` to the engine's real window, removing the mismatch
   (the configured limit may not match the engine's actual window).

## Requirements

- OpenCode V2 (`plugins` in `opencode.jsonc`).
- LM Studio with an OpenAI-compatible API (`local` mode), or a llama.cpp server
  (`delegate` mode, skeleton only — see "Limitations").
- Node.js ≥ 20 **for development only** (build/tests). At runtime there are no
  dependencies: `@huggingface/tokenizers` is pure JS.

## Installation

```bash
# 1. Dependencies (once, inside the plugin directory)
cd /path/to/opencode-token-guard
npm install

# 2. Find tokenizer.json in the model folder (it sits next to the GGUF) and set
#    its path in tokenizerPath. For tests, place the file as models/tokenizer.json.
#    Windows example: C:/Users/<user>/.lmstudio/models/<publisher>/<repo>/tokenizer.json

# 3. Register the plugin in ~/.config/opencode/opencode.jsonc (see opencode.example.jsonc)

# 4. Reload the configuration
opencode reload
```

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `backend` | string | — | Backend base URL, e.g. `http://127.0.0.1:1234` |
| `providerIDs` | string[] | `[]` | Providers the hooks apply to (empty = all) |
| `mode` | `"local"` \| `"delegate"` | `"local"` | How tokens are counted |
| `tokenizerPath` | string | — | Path to `tokenizer.json` |
| `tokenizerConfigPath` | string | — | Path to `tokenizer_config.json` (optional) |
| `syncLimit` | boolean | `true` | Sync `model.limit.context` with the engine window |
| `syncLimitDownOnly` | boolean | `false` | Only lower the limit, never raise it |
| `maxContext` | number | — | Upper bound for the window: caps both `limit.context` and the request budget (optional) |
| `reservedOutputTokens` | number | `8192` | Reserve for the model's reply |
| `safetyMarginPct` | number | `8` | Safety margin, % of the window |
| `includeToolsInBudget` | boolean | `true` | Count tool definitions |
| `digestShare` | number | `0.3` | Share of the request budget used as the cap for a condensed checkpoint digest |
| `condense` | object | see below | Per-entry token limits used while condensing |
| `debug` | boolean | `false` | Verbose logging |
| `logFile` | string | — | Duplicate logs to a file (optional) |

Request budget = `W − reservedOutputTokens − safetyMarginPct% · W`, where `W = min(window, maxContext)`.

`condense` defaults: `userTokens 400`, `assistantTokens 300`, `reasoningTailTokens 500`, `reasoningKeep 1`, `toolCallTokens 120`, `toolResultTokens 300`, `toolErrorTokens 600`, `miscTokens 200`, `ledgerKeep 2`.

## Modes

- **`local`** (recommended) — a local `tokenizer.json`. No network calls for
  counting; the context window is read from LM Studio. Memory ~100 MB, CPU-only,
  tens of milliseconds per request.
- **`delegate`** — counting on the `llama-server` side (`POST /tokenize`,
  `GET /props`). Requires switching the engine: **LM Studio does not expose such
  an endpoint** (verified: `/tokenize`, `/v1/tokenize`, `/api/v0/tokenize`,
  `/api/v0/count_tokens` return `200` with a body of
  `{"error":"Unexpected endpoint or method."}`). Currently a skeleton.

## Verification

Plugin logs are prefixed with `[token-guard]`. They go to the OpenCode service
stdout, or to `logFile` if set. The plugin reports the loaded mode, the tokenizer
in use, the backend window, and every condense pass it performs:

```
[token-guard] INFO loaded: mode=local, backend=http://127.0.0.1:1234
[token-guard] INFO token counter: local(.../tokenizer.json)
[token-guard] INFO backend window: 110592 tokens (lmstudio)
[token-guard] INFO request condensed: 108300 → 96100 tokens (budget 97728); checkpoints 2, truncated results 0, condensed results 1, dropped exchanges 1
```

The last line reports what was changed: `checkpoints` (condensed
`<recent-context>` blobs), `truncated results` (shortened tool outputs),
`condensed results` (results replaced by a one-line ledger entry),
`dropped exchanges` (whole exchanges removed as a last resort).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test tests/*.test.ts
npm run check       # both of the above
```

The `@opencode/plugin` types are provided by the OpenCode runtime and are not
published to npm; for local checks a shim is used:
`types/opencode-plugin.d.ts`.

## Limitations and roadmap

- The plugin does not change the core estimate formula (`chars/4`) — it edits the
  **outgoing request** in the `context` hook. That is the only available lever.
- `delegate` mode needs an asynchronous `TokenCounter` (delegation is a network
  call); currently only `local` is enabled.
- See `docs/DESIGN.md` — architecture, measurements, and plan.

## License

MIT. © 2026 Dmitriy Sopin.
