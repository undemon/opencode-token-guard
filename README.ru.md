# opencode-token-guard

🇬🇧 [English version](README.md)

Плагин для **OpenCode V2**, который убирает переполнение контекста на локальных
моделях: считает токены настоящим токенизатором модели и подрезает запрос под
безопасный бюджет, а также синхронизирует `model.limit.context` с фактическим
окном движка.

## Зачем

Ядро OpenCode оценивает токены по формуле **`chars / 4`**
(`Token.estimate` в `core/src/util/token.ts`, константа `CHARS_PER_TOKEN = 4`).
Для локальных моделей это сильно занижает:

| Тип текста | chars/token | ошибка `chars/4` |
|---|---|---|
| Русская проза | 3.13 | недооценка ×1.28 |
| Английский/код | 4.45 | почти норма |
| Плотный JSON | 2.18 | недооценка ×1.84 |
| Смесь (RU + код + JSON) | 2.83 | **недооценка ×1.41** |

Из-за этого OpenCode держит в контексте больше, чем реально влезает в движок, и
запрос падает с HTTP 400 `exceed_context_size_error`. Плагин исправляет и оценку
объёма, и рассинхрон лимита конфига с окном движка (`n_ctx`).

## Что делает

1. **Точный подсчёт** — токенизирует собранный запрос (system + история +
   инструменты) настоящим `tokenizer.json` модели.
2. **Guard** — если запрос не укладывается в бюджет, режет по приоритету:
   сначала раздутый `<recent-context>` внутри чекпоинта (самый частый виновник),
   затем старейшие выводы инструментов, затем старейшие целые обмены. Новейшая
   часть контекста, summary чекпоинта и новейший обмен сохраняются.
3. **Синхронизация лимита** — читает `GET /api/v0/models` у LM Studio и
   выставляет `model.limit.context` равным реальному окну движка, убирая
   рассинхрон (конфиг-лимит может не совпадать с фактическим окном движка).

## Требования

- OpenCode V2 (`plugins` в `opencode.jsonc`).
- LM Studio с OpenAI-совместимым API (режим `local`), либо llama.cpp server
  (режим `delegate`, каркас — см. «Ограничения»).
- Node.js ≥ 20 **только для разработки** (сборка/тесты). В рантайме зависимостей
  нет: `@huggingface/tokenizers` — чистый JS.

## Установка

```bash
# 1. Зависимости (один раз, в каталоге плагина)
cd /path/to/opencode-token-guard
npm install

# 2. Найти tokenizer.json в папке модели (лежит рядом с GGUF) и указать путь
#    в tokenizerPath. Для тестов положите файл как models/tokenizer.json.
#    Пример Windows: C:/Users/<user>/.lmstudio/models/<publisher>/<repo>/tokenizer.json

# 3. Подключить плагин в ~/.config/opencode/opencode.jsonc (см. opencode.example.jsonc)

# 4. Перезагрузить конфиг
opencode reload
```

## Опции

| Опция | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `backend` | string | — | База URL бэкенда, например `http://127.0.0.1:1234` |
| `providerIDs` | string[] | `[]` | Провайдеры, к которым применяются хуки (пусто = все) |
| `mode` | `"local"` \| `"delegate"` | `"local"` | Как считать токены |
| `tokenizerPath` | string | — | Путь к `tokenizer.json` |
| `tokenizerConfigPath` | string | — | Путь к `tokenizer_config.json` (необязательно) |
| `syncLimit` | boolean | `true` | Синхронизировать `model.limit.context` с окном движка |
| `syncLimitDownOnly` | boolean | `false` | Только понижать лимит, не повышать |
| `maxContext` | number | — | Верхняя граница для `limit.context` (необязательно) |
| `reservedOutputTokens` | number | `4096` | Резерв под ответ модели |
| `safetyMarginPct` | number | `8` | Запас безопасности, % от окна |
| `includeToolsInBudget` | boolean | `true` | Учитывать определения инструментов |
| `debug` | boolean | `false` | Подробные логи |
| `logFile` | string | — | Дублировать логи в файл (необязательно) |

Бюджет запроса = `окно − reservedOutputTokens − safetyMarginPct% · окно`.

## Режимы

- **`local`** (рекомендуется) — локальный `tokenizer.json`. Никаких сетевых
  вызовов для подсчёта; окно контекста читается у LM Studio. Память ~100 МБ,
  CPU-only, десятки миллисекунд на запрос.
- **`delegate`** — подсчёт на стороне `llama-server` (`POST /tokenize`,
  `GET /props`). Требует смены движка: **LM Studio такого эндпоинта не
  предоставляет** (проверено: `/tokenize`, `/v1/tokenize`, `/api/v0/tokenize`,
  `/api/v0/count_tokens` возвращают `200` с телом
  `{"error":"Unexpected endpoint or method."}`). В текущей версии — каркас.

## Проверка

Логи плагина помечаются префиксом `[token-guard]`. Они идут в stdout сервиса
OpenCode либо в `logFile`, если он задан. Плагин сообщает загруженный режим,
используемый токенизатор, окно бэкенда и каждое выполненное урезание:

```
[token-guard] INFO loaded: mode=local, backend=http://127.0.0.1:1234
[token-guard] INFO token counter: local(.../tokenizer.json)
[token-guard] INFO backend window: 110592 tokens (lmstudio)
[token-guard] INFO request trimmed: 108300 → 96100 tokens (budget 97728); checkpoints 2, results 0, exchanges 1
```

Последняя строка сообщает, что именно срезано: `checkpoints` (подрезанный
`<recent-context>`), `results` (выброшенные выводы инструментов), `exchanges`
(удалённые целые обмены).

## Разработка

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test tests/*.test.ts
npm run check       # и то, и другое
```

Типы `@opencode/plugin` предоставляются рантаймом OpenCode и в npm не
публикуются; для локальной проверки используется шим
`types/opencode-plugin.d.ts`.

## Ограничения и что дальше

- Формулу оценки ядра (`chars/4`) плагин не меняет — он правит **исходящий
  запрос** в хуке `context`. Это единственный доступный рычаг.
- Режим `delegate` требует асинхронного `TokenCounter` (делегирование — сетевой
  вызов); сейчас включён только `local`.
- См. `docs/DESIGN.ru.md` — архитектура, замеры и план.

## Лицензия

MIT. © 2026 Dmitriy Sopin.
