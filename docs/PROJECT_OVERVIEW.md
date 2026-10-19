# Model Bridge for Copilot — обзор проекта

Состояние на версию **1.4.0** (октябрь 2026). Документ описывает назначение, архитектуру, провайдеры, инфраструктуру и предлагаемые доработки.

---

## 1. Назначение

Model Bridge for Copilot — расширение VS Code, которое регистрирует четыре независимых **Language Model Chat Provider** (`vscode.lm.registerLanguageModelChatProvider`). Благодаря этому в нативном Chat и Agent mode VS Code (Copilot Chat) появляются модели из четырёх источников:

| Провайдер | Vendor ID | Источник моделей | Аутентификация |
|---|---|---|---|
| **Claude** | `model-bridge-claude` | Официальный Claude Code CLI (`stream-json`, `--safe-mode`) | Делегирована Claude Code, расширение не видит учётных данных |
| **Codex** | `model-bridge-codex` | ChatGPT Codex Responses API (HTTP + WebSocket) | ChatGPT OAuth (PKCE, loopback), мультиаккаунт, SecretStorage |
| **LM Studio** | `model-bridge-lmstudio` | Локальный LM Studio (`/api/v1/models` + `/v1/chat/completions`) | Не нужна; опциональный токен в SecretStorage |
| **OpenAI-Compatible** | `model-bridge-openai-compatible` | Ollama, llama.cpp, vLLM и любые `/v1/chat/completions`-серверы; несколько эндпоинтов | Опциональный токен на эндпоинт в SecretStorage, привязан к URL |

Исполнение инструментов, их подтверждение и workspace trust остаются за VS Code. Расширение только транслирует сообщения, вызовы инструментов, reasoning и данные об использовании токенов.

Метаданные: publisher `samarin-aa-aka-rtm00`, лицензия MIT, `engines.vscode ^1.104.0`, `preview: true`, `extensionKind: ["workspace", "ui"]`. Codex-часть основана на MIT-проекте *Codex For Copilot* (Gaussian).

---

## 2. Архитектура

### 2.1. Активация

[src/extension.ts](../src/extension.ts):

1. Создаёт общий лог-канал `Model Bridge` и регистрирует общие команды: `modelBridge.manage`, `modelBridge.doctor`, `modelBridge.support`.
2. Выполняет одноразовую миграцию настроек `anthropicForCopilot.*` / `codexModelProvider.*` → `modelBridge.*` ([src/settingsMigration.ts](../src/settingsMigration.ts)).
3. Активирует провайдеры по очереди (Claude → LM Studio → OpenAI-Compatible → Codex). Каждый обёрнут в `activateProvider`: если один провайдер падает, пользователь видит предупреждение, а остальные продолжают работать.

События активации: `onLanguageModelChatProvider:<vendor>` для каждого провайдера и `onStartupFinished`.

### 2.2. Структура исходников

```
src/
├── extension.ts               активация, общие меню
├── settingsMigration.ts       миграция legacy-настроек
└── providers/
    ├── managementMenu.ts      общий макет Manage-меню и Doctor-отчёта (Copy Report / Open Logs)
    ├── usageSummary.ts        форматирование строки «последний запрос» для tooltip
    ├── claude/                ~2 400 строк
    ├── codex/                 ~17 000 строк (самая крупная часть)
    ├── lmstudio/              LM Studio: нативные метаданные и команды
    └── openaiCompatible/      общее ядро /v1/chat/completions + провайдер эндпоинтов
```

Объём: около **25 000 строк** TypeScript и тестов. Сборка — один бандл esbuild `out/extension.js` (CJS, node20, `vscode` external). Runtime-зависимостей нет: только devDependencies (`typescript`, `esbuild`, `@vscode/vsce`, типы).

### 2.3. Общие механизмы

- **Единое Manage-меню** для каждого провайдера с разделами Account / Usage / Models·Tools / Diagnostics.
- **Doctor-отчёт**: ограниченный по размеру текст, безопасный для копирования (без промптов, ответов и секретов).
- **Usage data part**: после ответа провайдер отправляет `LanguageModelDataPart.json(..., 'usage')` в общем формате VS Code.
- **Статус-бары лимитов аккаунта** (Claude и Codex): `Claude: 5h 74% · Weekly 65%`. Обновляются при старте, каждые 5 минут и после каждого запроса; данные старше 15 минут помечаются как устаревшие.
- **Скрытие недоступных моделей**: если бэкенд отклоняет модель для аккаунта, она исчезает из пикера на TTL (Claude — 24 часа, Codex — 7 дней или до смены версии протокола).

---

## 3. Провайдер Claude

Файлы: [src/providers/claude/](../src/providers/claude/)

| Файл | Ответственность |
|---|---|
| `provider.ts` | `ClaudeModelProvider`: список моделей, схема опций пикера (effort, context size), поток запроса, подсчёт токенов, скрытие отклонённых моделей |
| `cli.ts` | Запуск процесса `claude`: проверка версии (минимум `2.1.259`) и `auth status`, временный файл системного промпта (`0o600`, удаляется всегда), таймауты, отмена |
| `protocol.ts` | Сборка stream-json ввода, разбор stream-json вывода, маркерный протокол вызова инструментов |
| `toolCatalog.ts` | Append-only каталог инструментов: при изменении набора инструментов в середине диалога дописывается «catalog update», а не перестраивается префикс |
| `sessionStore.ts` | Опциональное продолжение сессий Claude Code: в памяти, ограниченно, только при идентичном envelope |
| `accountUsage.ts`, `usageStatusBar.ts` | Разбор `/usage`, слияние rate-limit событий, статус-бар |
| `integration.ts` | Команды, Doctor, синхронизация аккаунта, установка и обновление Claude Code |

### Как выполняется запрос

1. Сообщения VS Code переводятся в текстовые блоки (`convertMessage`). Вызовы и результаты инструментов сериализуются как `[Tool call …]` / `[Tool result …]`.
2. История отправляется **одним** stream-json user-сообщением: один content-блок на одно сообщение чата. Так префикс совпадает между шагами агента и попадает в prompt cache.
3. Системный промпт пишется во временный файл: инструкции, отсортированный каталог инструментов без JSON-Schema аннотаций и инструкция по маркерам `<start-nonce>{"name":…,"arguments":…}<end-nonce>`.
4. Аргументы CLI: `--safe-mode --tools "" --permission-prompts none --max-turns 1 --input-format stream-json --output-format stream-json --include-partial-messages`, опционально `--effort`, `--autocompact <context>`, `--system-prompt-file` (режим `minimal`) или `--append-system-prompt-file --exclude-dynamic-system-prompt-sections` (режим `claudeCode`).
5. `ClaudeToolProtocolParser` вырезает маркеры из текстового потока и превращает их в `LanguageModelToolCallPart`. Thinking транслируется в `LanguageModelThinkingPart`, если он доступен в API.
6. Usage (input / cache write / cache read / output) пишется в лог и отправляется в VS Code.

Модели: `default`, `best`, `fable`, `sonnet`, `opus`, `haiku` (`modelBridge.claude.enabledModels`). Отказ для Fable скрывает также Best, потому что Best разрешается в Fable.

### Ограничения

- `imageInput: false`: изображения заменяются текстовой заглушкой.
- Инструменты работают через текстовые маркеры, а не через нативный tool use. Это неизбежно, пока встроенные инструменты CLI отключены.
- Подсчёт токенов — эвристика «символы / 4».
- В качестве `cwd` используется только первая папка workspace.

---

## 4. Провайдер Codex

Файлы: [src/providers/codex/](../src/providers/codex/). Самая сложная часть проекта.

| Область | Файлы |
|---|---|
| Поток запроса | `provider.ts` (~2 000 строк), `providerReplay.ts`, `providerModelResolution.ts`, `providerSupport.ts`, `toolCallTracking.ts` |
| Транспорт | `responsesClient.ts` (~1 860 строк: HTTP, WebSocket, обработчик серверных событий), `codexWebSocketSession.ts`, `codexConnectionManager.ts`, `codexFetchAdapter.ts`, `proxy.ts`, `proxyFetch.ts` |
| Протокол и идентичность | `codexProtocol.ts`, `codexRequestBuilder.ts`, `codexRequestIdentity.ts`, `codexIdentity.ts`, `config.ts` |
| Конверсия и повторы | `convertMessages.ts`, `responseBranchStore.ts`, `codexContinuation.ts`, `codexToolSchemaCache.ts` |
| Модели | `models.ts`, `codexModelCache.ts`, `reasoningEffort.ts` |
| Вывод | `streamPresenter.ts`, `reasoningStreamPresenter.ts` |
| Аутентификация | `auth/*`: OAuth PKCE, loopback login, refresh токенов, блокировка, мультиаккаунт, `AuthenticationProvider` VS Code |
| Использование | `accountUsage.ts`, `accountUsageStatusBar.ts`, `responsesLimitError.ts` |
| Hosted Web Search | `hostedTools/*` (ссылка `#codexWebSearch`) |
| Native Tool Search | `nativeToolSearch/*`: загрузка схем инструментов по требованию с группировкой по namespace |
| Диагностика | `codexLogger.ts`, `codexLatency.ts`, `codexTelemetry.ts` (локальная) |

### Ключевые свойства

- **Транспорт `auto`**: сначала WebSocket, при ошибке HTTP. Колбэки обоих транспортов должны вести себя одинаково.
- **Continuation**: по WebSocket отправляются только новые элементы с `previous_response_id`. При полном повторе (HTTP или обрыв WS) сохраняется зашифрованный reasoning текущего tool-цикла.
- **`prompt_cache_key`**: один ключ на диалог (корень диалога + аккаунт), который переживает форки, правки и перезагрузку окна.
- **Модели**: автоматическое обнаружение, фильтрация по `minimal_client_version`, алиасы, скрытые и отключённые модели, опции пикера (reasoning effort, context, service tier).
- **Мультиаккаунт**: добавление, переключение и удаление аккаунтов; refresh привязан к ключу локального аккаунта.
- **Native Tool Search** меняет глобальную настройку `github.copilot.chat.virtualTools.threshold`. Перед этим показывается подтверждение, которое предупреждает, что изменение затронет другие модели.

В пользовательском интерфейсе открыт только вход через браузер. API-ключ, device code и импорт `auth.json` в коде есть (`codexAuthManager.ts`), но командами намеренно не предоставляются.

---

## 5. Провайдер LM Studio

Файлы: [src/providers/lmstudio/](../src/providers/lmstudio/)

- **Обнаружение моделей**: нативный `GET /api/v1/models`. Из него берутся тип `llm`, отображаемое имя, архитектура, квантизация, параметры, загруженные инстансы и их контекст, `vision`, `trained_for_tool_use`. Если нативный эндпоинт недоступен, используется OpenAI-совместимый `/v1/models`.
- **Контекст**: если модель загружена, берётся контекст загруженного инстанса. Для выгруженной модели — `min(max_context_length, modelBridge.lmstudio.contextSize)`, потому что JIT-загрузка использует контекст по умолчанию. Резерв на вывод — не больше половины контекста.
- **Чат**: `POST /v1/chat/completions`, `stream: true`, `stream_options.include_usage`, функции-инструменты, `tool_choice: required|auto`.
- **Общее ядро** ([chatCompletions.ts](../src/providers/openaiCompatible/chatCompletions.ts)): конверсия сообщений, стриминг, подсчёт токенов, опции пикера. Используется и LM Studio, и OpenAI-Compatible.
- **SSE-парсер** ([protocol.ts](../src/providers/openaiCompatible/protocol.ts)): границы событий определяются независимо от сетевых чанков. Поля tool-call накапливаются по `index`, повторяющиеся `id`/`name` склеиваются корректно. Лимит аргументов — 1 МБ. Битый JSON аргументов не прерывает ответ: вызов пропускается с текстовой пометкой.
- **Reasoning**: `reasoning_content` или `reasoning` → `LanguageModelThinkingPart`. Блок `<think>…</think>` в начале ответа тоже уходит в thinking, даже если тег разрезан между чанками.
- **Опции пикера**: Thinking Effort (из `capabilities.reasoning.allowed_options`, если вариантов больше одного; значение, отличное от дефолта модели, передаётся как `reasoning_effort`, `off` → `none`) и temperature (0 / 0.2 / 0.7 / 1).
- **Запасной путь** `/v1/models` (нет нативного API): модели доступны в чате, но не в Agent mode (`toolCalling: false`); Doctor предупреждает об этом.
- **Безопасность**: `isInsecureRemoteURL` предупреждает о `http://` на нелокальный хост. Токен хранится только в SecretStorage.

---

## 5a. Провайдер OpenAI-Compatible

Файлы: [src/providers/openaiCompatible/](../src/providers/openaiCompatible/) — `provider.ts`, `discovery.ts`, `integration.ts`.

- **Эндпоинты** задаются в `modelBridge.openaiCompatible.endpoints` (machine scope, поэтому workspace не может их переопределить) или командой **Add Endpoint**. Поля: `name`, `type` (`ollama` | `llamacpp` | `vllm` | `openai`), `baseURL`, опционально `contextSize`, `toolCalling`, `vision`, `models` (allow-list).
- **Обнаружение моделей по типу сервера**:
  - Ollama: `/api/tags` + `/api/show` (capabilities `tools`/`vision`/`thinking`, `<arch>.context_length`; кэш по digest, до 4 запросов параллельно) + `/api/ps` (контекст загруженной модели). Embedding-модели скрываются.
  - llama.cpp: `/v1/models` + `/props` (`n_ctx` слота, `modalities.vision`, `chat_template_caps`).
  - vLLM и прочие: `/v1/models` (`max_model_len`, `context_length`, `supported_parameters`, `architecture.input_modalities`).
- **Agent mode** — только при подтверждённой поддержке инструментов; переопределения эндпоинта имеют приоритет.
- **Токены** хранятся в SecretStorage с ключом по `baseURL` и отправляются только своему эндпоинту.
- **Ошибки изолированы**: недоступный эндпоинт не скрывает модели остальных; одно неблокирующее предупреждение.
- **ID модели**: `oai::<endpoint>::<model>`. Thinking Effort для thinking-моделей Ollama: `on` (по умолчанию) / `off` / `low` / `medium` / `high`.

---

## 5b. Журнал расхода и отчёт

Файлы: [src/usage/](../src/usage/), [media/usageReport.js](../media/usageReport.js), [media/usageReport.css](../media/usageReport.css).

- **Запись**: после каждого завершённого запроса провайдер вызывает `UsageRecorder`. Хранятся только числа: токены (input — полный промпт, включая чтение и запись кэша), модель, шаг, тип шага (`user`/`tool`), длительность, транспорт, effort, continuation, оценка стоимости. Диалог определяется HMAC первого user-сообщения с локальной солью.
- **Хранение**: JSONL-файл на каждый UTC-день в `globalStorageUri/usage`, ротация по `modelBridge.usage.retentionDays` (90 дней).
- **Отчёт** (**Show Usage Report**, webview): KPI (запросы, input с долей кэша, output, промахи кэша, API-эквивалент стоимости), токены по дням и по моделям, самые тяжёлые диалоги и запросы, пошаговый график выбранного диалога. Фильтры по периоду и провайдеру; при открытой панели обновляется вживую.
- **Промах кэша**: tool-шаг Claude или Codex с input ≥ 8K, где из кэша прочитано меньше половины.
- **Стоимость**: Claude — `totalCostUsd` от Claude Code; Codex — по `modelBridge.codex.modelPricingUsdPerMTok`.
- Экспорт в CSV (с нейтрализацией формул) и очистка истории.

---

## 6. Команды

| Группа | Команды |
|---|---|
| Общие | Manage Providers, Open Provider Diagnostics, Show Usage Report, Export Usage as CSV, Clear Usage History, Support the Project |
| Claude | Manage, Sign in with Claude Code / Browser, Show Status, Sign Out, Refresh Models, Show/Refresh Account Limits, Install/Update Claude Code, Open Settings/Logs, Doctor, Quick Configure, Test Connection |
| Codex | Manage, Sign in with Browser, Add/Switch/Remove Account, Show Status, Sign Out, Show/Refresh Account Limits, Enable Native Tool Search, Restore VS Code Tool Grouping, Show Native Tool Search Status, Show Effective Protocol, Open Debug Logs/Settings, Doctor, Test Connection |
| LM Studio | Manage, Doctor, Refresh Models, Set/Clear API Token, Open Settings/Documentation/Logs, Test Connection |
| OpenAI-Compatible | Manage, Add/Remove Endpoint, Set/Clear API Token, Refresh Models, Test Connection, Doctor, Open Settings/Logs |

---

## 7. Настройки (основные)

**Claude** (`modelBridge.claude.*`): `claudePath`, `model`, `enabledModels`, `instructions`, `systemPrompt` (`minimal` | `claudeCode`), `defaultEffort` (`auto` = effortLevel Claude Code), `defaultContextSize` (200 000), `maxOutputTokens` (32 000), `requestTimeoutSeconds` (600), `sessionContinuation` (false), `usageStatusBar`.

**Codex** (`modelBridge.codex.*`): `model` (`gpt-5.5`), `transport` (`auto`), `websocketPrewarm`, `requestCompression`, `defaultReasoningEffort`, `defaultServiceTier`, `textVerbosity`, `maxOutputTokens`, `includeHiddenModels`, `disabledModels`, `modelAliases`, `webSearch*`, `nativeToolSearch*`, `protocolProfile`, `requestIdentityProfile`, переопределения заголовков и метаданных (защищены `allowUnsafeProtocolOverrides`), `modelPricingUsdPerMTok`, `accountUsageShowAccountName`.

**LM Studio** (`modelBridge.lmstudio.*`): `baseURL` (`http://127.0.0.1:1234/v1`), `contextSize` (32 768), `maxOutputTokens` (8 192), `temperature` (0.2), `requestTimeoutSeconds` (600).

**Usage** (`modelBridge.usage.*`): `recordRequests` (true), `retentionDays` (90).

**OpenAI-Compatible** (`modelBridge.openaiCompatible.*`): `endpoints` ([]), `contextSize` (32 768), `maxOutputTokens` (8 192), `temperature` (0.2), `requestTimeoutSeconds` (600).

---

## 8. Безопасность и приватность

Правила зафиксированы в [AGENTS.md](../AGENTS.md):

- Не логируются промпты, ответы, thinking, аргументы и результаты инструментов, учётные данные, локальные вложения.
- Учётные данные Claude не читаются и не копируются. Из окружения дочернего процесса удаляются переменные с API-ключами.
- Встроенные инструменты Claude Code отключены (`--tools ""`), используется `--safe-mode`, а не `--bare`.
- Временные файлы промпта создаются с правами `0o600` и удаляются при успехе, ошибке, таймауте и отмене.
- Секреты Codex и LM Studio хранятся только в VS Code SecretStorage.
- Изменение настроек, влияющих на другие провайдеры, требует явного подтверждения.

---

## 9. Сборка, тесты, CI/CD

| Скрипт | Действие |
|---|---|
| `npm run check` | `tsc --noEmit` (strict) |
| `npm run compile` | check + esbuild-бандл |
| `npm run test:smoke` | проверки манифеста + наборы `test:claude`, `test:codex`, `test:lmstudio`, `test:openai-compatible`, `test:usage` |
| `npm run package:vsix` | `vsce package --no-dependencies` |

- **Тесты**: 20 smoke-скриптов на `node:assert` (около 750 проверок), запускаются цепочкой `&&` поверх собранного бандла. Больше всего покрыт Codex: транспорты, reuse, auth. Тестов, которые запускают расширение внутри VS Code, нет.
- **Состояние**: на момент написания `npm run check` и `npm run test:smoke` проходят полностью.
- **CI** ([ci.yml](../.github/workflows/ci.yml)): ubuntu, Node 22, `npm ci` → `npm audit` → compile → smoke → VSIX-артефакт.
- **Release** ([release.yml](../.github/workflows/release.yml)): по тегу `v*.*.*` проверяет совпадение тега с версией в `package.json`, собирает VSIX, извлекает раздел из CHANGELOG и создаёт GitHub Release. Публикация в Marketplace выполняется вручную ([releasing.md](releasing.md)).

---

## 10. Предложения по доработке

Приоритеты: 🔴 — заметная польза для пользователя при умеренной стоимости, 🟡 — полезно, 🟢 — гигиена и долгосрочные задачи.

### 10.1. Функциональность

> ✅ Выполнено: OpenAI-совместимый провайдер, reasoning effort для LM Studio, разбор `<think>`, осторожный fallback. Описания ниже сохранены для истории.

**🔴 Универсальный OpenAI-совместимый провайдер (Ollama, llama.cpp server, vLLM, Jan, OpenRouter и др.).**
Код LM Studio уже на 80–90 % универсален: SSE-парсер, накопление tool-call, конверсия сообщений. Можно выделить общее ядро `openaiCompatible/` и сделать LM Studio его профилем с нативными метаданными. Дальше добавляются профили или список «endpoint + токен + имя группы». Это самый большой прирост аудитории при небольшом объёме нового кода.

**🔴 LM Studio: выбор reasoning effort.**
Интерфейс `NativeModel` уже описывает `capabilities.reasoning.allowed_options` и `default` ([provider.ts](../src/providers/lmstudio/provider.ts)), но значения не используются. Можно показать их в `configurationSchema` пикера, как effort у Claude и Codex, и передавать в запрос.

**🔴 LM Studio: разбор `<think>…</think>` в `content`.**
Многие локальные модели (Qwen, DeepSeek-R1 и производные) при отключённом разделении reasoning в LM Studio отдают рассуждения внутри обычного текста. Нужен потоковый разделитель тегов (аналогичный маркерному парсеру Claude), который переводит такой текст в `ThinkingPart`. Сейчас рассуждения попадают в ответ.

**🟡 LM Studio: изображения из результатов инструментов для vision-моделей.**
Сейчас `serializeToolResult` превращает `LanguageModelDataPart` в строку `[image/png data: N bytes]`. Для моделей с `vision: true` можно добавлять после tool-сообщений user-сообщение с `image_url`: OpenAI Chat Completions не принимает изображения в `role: tool`. Так агент сможет «видеть» скриншоты.

**🟡 LM Studio: статус-бар и метрики производительности.**
Показывать загруженную модель и скорость генерации (токены в секунду из usage и длительности) по аналогии со статус-барами Claude и Codex. Дополнительно — команды Load / Unload model, если это позволяет нативный REST API LM Studio.

**🟡 LM Studio: повторы при временных ошибках.**
Когда LM Studio делает JIT-загрузку модели, первый запрос может долго ждать или вернуть 5xx. Поможет короткий retry с backoff только до начала стрима, плюс понятное сообщение «модель загружается».

**🟡 LM Studio: осторожный fallback.**
В ветке `/v1/models` всем моделям ставится `toolCalling: true`. Для неизвестных моделей безопаснее `false` или отдельная настройка, иначе Agent mode предлагает модели, которые ломаются на tools.

**🟡 Claude: поддержка изображений.**
`imageInput: false`, вложения заменяются заглушкой. Если stream-json вход Claude Code принимает content-блоки `image` (base64) в user-сообщении, это нужно проверить на минимальной поддерживаемой версии CLI, а затем включить `imageInput` и передавать изображения. Сильный выигрыш для UI-задач.

**🟡 Точнее подсчёт токенов.**
Claude и LM Studio используют эвристику «символы / 4». Простое улучшение без зависимостей: калибровать коэффициент по фактическому `prompt_tokens` / `input_tokens` последнего ответа (отдельно для каждой модели, в памяти). Так Copilot точнее решает, когда суммаризировать историю.

**🟡 Claude: multi-root workspace.**
`cwd` = первая папка workspace. Можно выбирать папку активного редактора или добавить настройку.

**🟢 Onboarding через `contributes.walkthroughs`.**
Пошаговый мастер «выберите провайдера → установите/войдите → Test Connection → выберите модель» с проверкой выполнения шагов. Снижает число вопросов «почему моделей нет в пикере».

**🟢 Локализация (`vscode.l10n` + `package.nls.ru.json`).**
Все строки сейчас на английском. Русская локализация естественна для текущей аудитории (Boosty).

### 10.2. Инженерия и качество кода

**🔴 Разделить крупные модули Codex.**
`provider.ts` (~2 000 строк) и `responsesClient.ts` (~1 860 строк) — самые рискованные места для изменений. Естественные границы: HTTP-транспорт, WebSocket-транспорт, `createResponsesServerEventHandler` (начинается примерно со строки 1124) и нормализация ошибок. Работа уже начата (`providerReplay.ts`, `providerSupport.ts` и др.), её стоит продолжить.

**🔴 Перейти на `node --test`.**
Встроенный раннер Node 22 не требует зависимостей и даёт изоляцию тестов, фильтрацию, понятный отчёт и `--experimental-test-coverage`. Сейчас скрипты связаны через `&&`: первый упавший скрывает результаты остальных, а список тестов в `package.json` поддерживается вручную.

**🟡 Интеграционный тест активации.**
Один тест на `@vscode/test-electron`: расширение активируется, три vendor-провайдера зарегистрированы, падение одного провайдера не ломает другие. Это закрепит главное кросс-провайдерное требование.

**🟡 CI-матрица Windows и macOS.**
В Claude-провайдере есть ветки для `win32` (поиск `claude`, права временных файлов: на Windows `mode: 0o600` фактически игнорируется). Сейчас CI проверяет только ubuntu.

**🟡 Линтер.**
Добавить ESLint + typescript-eslint (или Biome) хотя бы с правилами `no-floating-promises` и `no-misused-promises`: в коде много `void promise`, и случайно потерянный промис здесь — типичная ошибка.

**🟡 Dependabot или Renovate** для GitHub Actions и devDependencies.

**🟢 Скрипт `watch`.**
Сейчас `watch` = `tsc -watch`, который пишет в `out/` небандленые файлы рядом с бандлом esbuild. Лучше `esbuild --watch` (через context API в `esbuild.mjs`) и параллельно `tsc --noEmit --watch`, а также привязать preLaunchTask F5 к watch-задаче.

**🟢 Скрытые пути аутентификации Codex.**
Device code, импорт `auth.json` и API-ключ присутствуют в `codexAuthManager.ts`, но недоступны из UI. Их стоит либо убрать (меньше поверхности атаки и кода), либо явно пометить как внутренние или тестовые.

**🟢 Автопубликация в Marketplace** из release workflow (`vsce publish` с секретом `VSCE_PAT`), чтобы GitHub Release и Marketplace не расходились.

### 10.3. Рекомендуемый порядок

1. ~~LM Studio: reasoning effort + `<think>`-парсер + осторожный fallback.~~ ✅
2. `node --test` + CI-матрица + линтер — страховка перед крупными изменениями.
3. ~~Выделение OpenAI-совместимого ядра и профиль Ollama.~~ ✅
4. Разделение `provider.ts` / `responsesClient.ts` в Codex.
5. Изображения для Claude (после проверки CLI), калибровка подсчёта токенов, walkthrough, локализация.
