# GpuGrid Gateway (server)

«Мозг» сети GPUGrid: OpenAI-совместимый шлюз + реестр нод + биллинг + экономика
маршрутизации + (опционально) RunPod-фолбэк и on-chain выплаты в $GGRID.

**Стек:** **Bun + Hono + `bun:sqlite`** — один контейнер, без внешней БД/Redis для MVP.
Тяжёлые Solana-зависимости — `optionalDependencies` и грузятся **лениво**, только когда
реально нужна выплата; без них шлюз спокойно стартует и проходит тесты.

```
Developer ──Bearer ggrid_sk_──▶ /v1/chat/completions ─┐
                                                       │  selectNode() — выбор лучшей ноды
Provider  ──ggrid_pv_──▶ /nodes/register ──▶ [registry]│  (дёшево→быстро→надёжно→не занято)
   GPU agent ──heartbeat──▶ keepalive                  ▼
                                              proxy → нода (Ollama / OpenAI API)
                                                       │  стрим/не-стрим, считаем токены
                                                       ▼
                                              settleJob() — атомарно: списать с юзера,
                                              начислить провайдеру 75%, записать сплит
```

---

## Запуск

```bash
bun install
bun run dev        # http://localhost:8080 (watch)
bun run start      # прод-режим
bun run test:e2e   # полный e2e на in-memory БД + mock-нода (~49 проверок)
```

В проде тот же контейнер раздаёт собранный React-сайт: если есть `web/dist`,
`index.ts` поднимает на нём статику + SPA-фолбэк. См. корневой [Dockerfile](../Dockerfile)
(многоступенчатая сборка: Vite-билд сайта → установка серверных зависимостей → рантайм).

---

## Карта модулей (`src/`)

| Файл | Ответственность |
|---|---|
| `index.ts` | Точка входа Bun: статика `web/dist` (если есть) + `export default { port, fetch }`. |
| `app.ts` | Сборка Hono-приложения: middleware (logger, CORS), `/health`, монтаж роутов, обработчики 404/500. |
| `config.ts` | Вся конфигурация из env с дефолтами + `solanaConfigured()`. |
| `db.ts` | `bun:sqlite`, схема (DDL), идемпотентные миграции, хелперы `now()`/`uid()`. |
| `types.ts` | Типы строк БД (`UserRow`, `NodeRow`, `ProviderRow`, `Usage`). |
| `auth.ts` | Хеширование ключей (sha256), выпуск ключей/токенов, middleware `requireUser/Provider/Admin`. |
| `ratelimit.ts` | Per-key лимит запросов (фикс-окно) + per-IP лимит регистраций. |
| `registry.ts` | In-memory liveness нод + `selectNode()` (роутинг) + надёжность/перформанс/аптайм. |
| `pricing.ts` | Прайс по моделям, `priceFor()`, `feeSplit()` (75/12.5/7.5/5). |
| `proxy.ts` | Прокси одного джоба к ноде: стрим/не-стрим, подсчёт токенов, биллинг на завершении. |
| `ledger.ts` | `settleJob()` (атомарная транзакция) и `failJob()`. |
| `runpod.ts` | Облачный фолбэк: поднять под, дождаться Ollama, зарегистрировать, погасить по простою. |
| `solana.ts` | Ленивый клиент `ggrid_payout`: `settleProvider()` — выплата на цепочке. |
| `payouts.ts` | `requestPayout()` — резерв→отправка→подтверждение/компенсация. |
| `routes/v1.ts` | OpenAI-совместимое: `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`. |
| `routes/api.ts` | Control-plane для дашбордов: аккаунты, ключи, провайдеры, выплаты, статистика, admin. |
| `routes/nodes.ts` | Регистрация/heartbeat/удаление нод. |

---

## Жизненный цикл запроса (`/v1/chat/completions`)

`routes/v1.ts → handleProxy()`:

1. **Auth** — `Authorization: Bearer ggrid_sk_…`; ключ ищется по `sha256(key)` среди не-отозванных → юзер. Нет → `401`.
2. **Rate limit** — `allow(key)`: фикс-окно 60 с, `RATE_LIMIT_PER_MIN` (по умолч. 120). Превышение → `429`.
3. **Баланс** — `balance <= MIN_BALANCE` (0) → `402` (insufficient balance).
4. **Валидация** — тело парсится Zod-схемой; обязателен `model`. Кривой JSON → `400`.
5. **Подготовка тела:**
   - для стрима принудительно `stream_options.include_usage = true` (чтобы получить usage из последнего SSE-чанка);
   - `max_tokens` обрезается до `MAX_OUTPUT_TOKENS` (4096) — кэп стоимости и времени GPU.
6. **Выбор ноды** — `selectNode(model)`. Если живых нет и юзеру разрешён облачный фолбэк (`runpod_allowed` или `FREE_TIER_RUNPOD`) → `ensureNode()` (RunPod).
7. **Проксирование с ретраем** — до **2 попыток** на разных нодах (`tryProxy`); упавшую ноду исключаем и берём следующую.
8. **Ответы об ошибке:** все ноды упали → `502`; живых нод под модель нет → `503`.

`proxy.ts → tryProxy()` — что происходит на одной ноде:

- создаём джоб `RUNNING`, `setActive(+1)`, для RUNPOD-ноды отмечаем использование;
- `fetch` к `node.url + /v1/chat/completions` (или `/v1/embeddings`) с таймаутом `UPSTREAM_TIMEOUT_MS` (180 с);
- **сеть/HTTP-ошибка ДО первого байта** → `fail()` (пенальти ноде) и `return null` — это сигнал «можно ретраить на другой»;
- **не-стрим / embeddings** — читаем JSON, берём `usage`, биллим, отдаём;
- **стрим** — байты идут насквозь (passthrough `ReadableStream`), параллельно копим текст и в конце вытаскиваем `usage` → биллим на `done`/`cancel`;
- на успехе: `reward()` (надёжность +) и `recordPerf()` (EWMA токенов/сек).

---

## Биллинг и экономика токена

**Единица — кредит = 1 микро-USD** (1e-6 $). Бонус при регистрации `SIGNUP_BONUS = 5_000_000` ≈ $5.

**Прайс** (`pricing.ts`) задаётся за **1 000 000 токенов** отдельно для in/out, например `llama3:8b → in 50k / out 150k`; неизвестная модель — дефолт `in 100k / out 300k`. Итог: `ceil(in/1e6·pIn + out/1e6·pOut)`. Дев платит цену **выбранной ноды**: итог домножается на её `price_factor` — поэтому дешёвая нода = дешевле для дева.

**Сплит каждого джоба** (`feeSplit`): провайдер **75%**, выкуп-сжигание **12.5%**, стейкеры **7.5%**, казна **5%** (казна = остаток, чтобы части всегда давали в сумме `cost`).

**`settleJob()`** (`ledger.ts`) — всё одной SQLite-транзакцией, **идемпотентно по `job id`** (`status != 'DONE'`):
- джоб → `DONE` (+ токены, cost, latency);
- `users.balance -= cost`;
- `providers.balance += provider`(75%) — провайдеру копится только его доля;
- 5 строк в `ledger`: `CHARGE (-cost)`, `PROVIDER_REWARD`, `BURN`, `STAKERS`, `TREASURY`.

> Сейчас весь учёт **off-chain** (в SQLite). On-chain выплаты — отдельный опциональный слой (ниже), сплит-проценты в нём совпадают с `feeSplit`.

---

## Маршрутизация и репутация нод (`registry.ts`)

Статика ноды — в SQLite; «жива ли / насколько занята / аптайм» — в in-memory `Map` (на одном инстансе; при масштабировании это ушло бы в Redis).

**`selectNode(model, exclude?)`** фильтрует кандидатов:
- отдают нужную `model`;
- живы: `now - lastBeat < HEARTBEAT_TTL_MS` (30 с);
- не перегружены: `activeJobs < MAX_CONCURRENCY` (4);
- не в карантине: `reliability >= MIN_RELIABILITY` (0.3).

И сортирует: **дешевле (`price_factor↑`) → быстрее (`perf↓`) → надёжнее (`reliability↓`) → менее занята (`activeJobs↑`)**.

**Репутация / авто-слэшинг:**
- `penalize()` при сбое: `reliability -= 0.1`; упав ниже 0.3, нода **выпадает из роутинга** (карантин);
- `reward()` при успехе: `reliability += 0.02` (cap 1.0) — доверие восстанавливается медленно;
- `recordPerf()` — EWMA пропускной способности (токены/сек, `alpha = 0.3`) + счётчик `jobs_done`;
- `uptimePct()` — доля времени онлайн с момента регистрации;
- админ может вручную «разслэшить» ноду (`reliability = 1.0`).

---

## Аутентификация (`auth.ts`)

Секреты **никогда не хранятся в открытом виде** — только `sha256`. Префикс ключа (первые 16 симв.) хранится для отображения в дашборде.

| Субъект | Токен | Как проверяется |
|---|---|---|
| Разработчик | `ggrid_sk_…` (API-ключ) | `Bearer`, поиск по `sha256`, не отозван. Юзер может иметь несколько ключей. |
| Провайдер | `ggrid_pv_…` (provider token) | `Bearer` или `x-provider-token`. |
| Нода | `ggrid_node_…` (node secret) | заголовок `x-node-secret` (heartbeat/удаление). |
| Админ | `ADMIN_KEY` (общий, из env) | `x-admin-key` или `Bearer`. Пусто в env → `/api/admin/*` отдаёт `403`. |

Middleware: `requireUser`, `requireProvider`, `requireAdmin`.

---

## Анти-абьюз

- **Per-key rate limit** — `RATE_LIMIT_PER_MIN` (120) в окне 60 с → `429`.
- **Per-IP лимит регистраций** — `SIGNUP_PER_IP_PER_DAY` (3) за 24 ч (IP из `x-forwarded-for`/`x-real-ip`) → `429`. Защита бесплатных кредитов.
- **Кэп выходных токенов** — `MAX_OUTPUT_TOKENS` (4096): большой `max_tokens` не отклоняется, а обрезается.
- **Гейтинг облака** — бесплатный юзер **не может** триггерить платный RunPod-фолбэк. Доступ даёт пополнение баланса (`/api/admin/topup` ставит `runpod_allowed = 1`) или `FREE_TIER_RUNPOD=true`.

---

## RunPod-фолбэк (`runpod.ts`, опционально)

Когда под модель нет живой ноды, поднимаем облачный GPU:

1. `createPod` — GraphQL `podFindAndDeployOnDemand` (`RUNPOD_GPU_TYPE`, образ `RUNPOD_IMAGE` = `ollama/ollama`, порт `11434/http`).
2. `waitReady` — поллинг `https://{podId}-11434.proxy.runpod.net/api/tags` (до 60×5 с).
3. `pullModel` — `POST /api/pull` (best-effort).
4. Регистрируем как ноду `source='RUNPOD'` с `price_factor = RUNPOD_PRICE_FACTOR` (1.5 — облако дороже комьюнити). Системный провайдер `prv_runpod_system`.
5. Keepalive каждые 15 с; **гасим под** при простое дольше `RUNPOD_IDLE_MS` (5 мин) → `podTerminate` + удаление ноды.

Без `RUNPOD_API_KEY` модуль выключен (`ensureNode → null`, шлюз отдаёт `503`).

---

## On-chain выплаты $GGRID (`solana.ts` + `payouts.ts`, опционально)

Включается, только когда заданы `SOLANA_RPC_URL`, `GGRID_PROGRAM_ID`, `GGRID_MINT`, `GGRID_AUTHORITY_KEY` (`solanaConfigured()`); иначе все payout-роуты отдают `503`, а off-chain учёт работает как обычно.

- **`solana.ts`** — ленивый клиент Anchor-программы `ggrid_payout`. `settleProvider(wallet, grossRaw)` шлёт инструкцию `settle(amount)` (аккаунты `config/authority/mint/vault/providerToken/stakers/treasury/tokenProgram`), предварительно идемпотентно создавая ATA получателя (ренту платит authority). `tokenProgram` = `token2022` (само-выпуск) **или** `token` (классический SPL / pump.fun). Authority-ключ — JSON-массив **или** путь к файлу; держать в секретах, не в репозитории.
- **`payouts.ts → requestPayout()`** превращает накопленный off-chain баланс провайдера (это уже его **net** 75%) в реальную выплату. Поскольку on-chain сплиттер сам делит депозит, мы шлём **gross**: `gross = ceil(net / providerShare)`, `rawAmount = gross · GGRID_RAW_PER_CREDIT`.

  Поток без двойных списаний:
  1. **Резерв** — в одной транзакции списываем баланс (`balance -= net` с условием `balance >= net`), создаём запись `payouts(status=PENDING)` и `ledger(PAYOUT, -net)`. Гонка → `409`.
  2. **Отправка** on-chain (вне транзакции БД).
  3. **Успех** → `payouts.status='SENT'` + сигнатура, возвращаем `signature`.
  4. **Ошибка** → компенсация: возвращаем баланс, `payouts.status='FAILED'`, `ledger(PAYOUT_REVERSED)`, отдаём `502`.

  Защиты: минимум `GGRID_MIN_PAYOUT_CREDITS` (иначе пыль и комиссии впустую); `GGRID_PROVIDER_BPS` (7500) **обязан совпадать** с on-chain конфигом.

> Статус: программа `ggrid_payout` написана и провалидирована на **Solana devnet**. Mainnet-запуск — через pump.fun; нужен фандированный mainnet-кошелёк-authority.

---

## Модель данных (`db.ts`)

SQLite в WAL-режиме (кроме `:memory:`). Таблицы:

- **`users`** — `id, email, balance, runpod_allowed, created_at`.
- **`api_keys`** — `id, hash (uniq), prefix, user_id, label, created_at, revoked_at`.
- **`providers`** — `id, email, token_hash, payout_wallet, balance, created_at`.
- **`nodes`** — `id, provider_id, url, secret_hash, source (LOCAL|RUNPOD), models (JSON), gpu_info, reliability, price_factor, perf, jobs_done, created_at`.
- **`jobs`** — `id, user_id, node_id, model, status (RUNNING|DONE|FAILED), source, tokens_in, tokens_out, cost, latency_ms, error, created_at, finished_at`.
- **`ledger`** — `id, type (CHARGE|PROVIDER_REWARD|BURN|STAKERS|TREASURY|DEPOSIT|PAYOUT|PAYOUT_REVERSED), amount, user_id, provider_id, job_id, created_at`.
- **`payouts`** — `id, provider_id, net_credits, gross_credits, raw_amount, wallet, signature, status (PENDING|SENT|FAILED), error, created_at, settled_at`.

Миграции идемпотентные (`ALTER TABLE … ` в `try/catch`), так что старые БД доезжают без потерь.

---

## API

### OpenAI-совместимое (разработчики) — `Authorization: Bearer ggrid_sk_…`
| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/v1/chat/completions` | Стрим и не-стрим. Перед запросом: rate-limit, баланс, кэп токенов, выбор ноды, ретрай ×2. |
| `POST` | `/v1/embeddings` | Не-стрим, биллинг как у chat. |
| `GET` | `/v1/models` | Живые модели грида ∪ известный каталог. |

### Control-plane (дашборды) — `/api`
**Публичное:**
- `POST /api/signup` `{ email? }` → `{ userId, apiKey, balance }` (бонусные кредиты; per-IP кэп).
- `POST /api/providers` `{ email?, payoutWallet? }` → `{ providerId, providerToken }`.
- `GET /api/stats` → `{ onlineNodes, models[], users, totalJobs, totalTokens }`.

**Разработчик (API-ключ):**
- `GET /api/me` · `GET /api/usage` (последние 100 джобов) · `GET /api/keys`
- `POST /api/keys` `{ label? }` (новый ключ) · `DELETE /api/keys/:id` (отзыв).

**Провайдер (provider token):**
- `GET /api/provider/earnings` → баланс, ноды (со `stats`), `jobsServed`, `earned`, кошелёк, `payoutsEnabled`.
- `POST /api/provider/wallet` `{ wallet }` (валидируется как Solana-адрес).
- `POST /api/provider/payout` (вывод накопленного в $GGRID) · `GET /api/provider/payouts` (история).

**Админ (`ADMIN_KEY` → `x-admin-key`):**
- `POST /api/admin/topup` `{ userId, amount }` (пополнение + включает облачный тариф).
- `GET /api/admin/nodes` · `DELETE /api/admin/nodes/:id` · `POST /api/admin/nodes/:id/reset` (разслэшить).

### Ноды (`/nodes`)
- `POST /nodes/register` `{ url, models[], gpuInfo?, providerToken, priceFactor? }` → `{ nodeId, nodeSecret }` (`priceFactor` клампится в 0.5–3).
- `POST /nodes/:id/heartbeat` (`x-node-secret`) `{ status?, models? }` → `{ ok, ttlMs }`.
- `DELETE /nodes/:id` (`x-node-secret`).

`GET /health` → `{ ok: true }`.

---

## Конфигурация (env, `config.ts`)

| Переменная | Дефолт | Назначение |
|---|---|---|
| `APP_PORT` / `PORT` | `8080` | Порт шлюза. |
| `DATABASE_URL` | `file:./data/app.db` | Путь к SQLite (`file::memory:` для тестов). |
| `WEB_DIR` | `../web/dist` | Где лежит собранный сайт (раздаётся тем же контейнером). |
| `CORS_ORIGIN` | `*` | CORS для `/v1` и `/api`. |
| `HEARTBEAT_TTL_MS` | `30000` | Окно живости ноды. |
| `MAX_CONCURRENCY` | `4` | Макс. одновременных джобов на ноду. |
| `MIN_RELIABILITY` | `0.3` | Порог карантина ноды. |
| `RUNPOD_PRICE_FACTOR` | `1.5` | Множитель цены облачных нод. |
| `SIGNUP_BONUS` | `5000000` | Бесплатные кредиты при регистрации (≈$5). |
| `MIN_BALANCE` | `0` | Порог блокировки запросов. |
| `RATE_LIMIT_PER_MIN` | `120` | Лимит запросов на ключ. |
| `SIGNUP_PER_IP_PER_DAY` | `3` | Лимит регистраций на IP/сутки. |
| `MAX_OUTPUT_TOKENS` | `4096` | Кэп выходных токенов. |
| `UPSTREAM_TIMEOUT_MS` | `180000` | Таймаут запроса к ноде. |
| `FREE_TIER_RUNPOD` | `false` | Можно ли бесплатным юзерам жечь облако. |
| `ADMIN_KEY` | `''` | Включает `/api/admin/*`. |
| `RUNPOD_API_KEY` | `''` | Включает облачный фолбэк. |
| `RUNPOD_GPU_TYPE` / `RUNPOD_IMAGE` / `RUNPOD_IDLE_MS` | RTX 4090 / `ollama/ollama:latest` / `300000` | Параметры пода. |
| `SOLANA_RPC_URL`, `GGRID_PROGRAM_ID`, `GGRID_MINT`, `GGRID_AUTHORITY_KEY` | `''` | Вкл. on-chain выплаты (нужны все). |
| `GGRID_TOKEN_PROGRAM` | `token2022` | `token2022` или `token` (pump.fun/SPL). |
| `GGRID_IDL_PATH` | `../onchain/target/idl/ggrid_payout.json` | IDL Anchor-программы. |
| `GGRID_RAW_PER_CREDIT` | `1` | Raw-единиц токена на 1 кредит. |
| `GGRID_PROVIDER_BPS` | `7500` | Доля провайдера (bps) — синхронно с on-chain. |
| `GGRID_MIN_PAYOUT_CREDITS` | `100000` | Минимум для выплаты. |
| `LOG` | — | `off` — выключить request-логгер. |

---

## Быстрая ручная проверка

```bash
# 1. ключ разработчика
curl -s localhost:8080/api/signup -d '{}' | jq

# 2. провайдер + регистрация ноды (url → ваш Ollama через туннель)
curl -s localhost:8080/api/providers -d '{}' | jq
curl -s localhost:8080/nodes/register \
  -d '{"url":"https://xxxx.ngrok.app","models":["llama3:8b"],"providerToken":"ggrid_pv_..."}' | jq

# 3. вызов как у OpenAI
curl -s localhost:8080/v1/chat/completions \
  -H "authorization: Bearer ggrid_sk_..." \
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"hi"}]}' | jq
```

`bun run test:e2e` гоняет полный цикл на in-memory БД и mock-ноде: регистрация, биллинг
(стрим/не-стрим), ретрай вокруг мёртвой ноды, кэп токенов, управление ключами, admin-топап,
анти-абьюз, дешёвый роутинг, авто-слэшинг и disabled-путь выплат.

Полный дизайн и роадмап — в [../PLAN.md](../PLAN.md); прод-runbook — в [../GO-LIVE.md](../GO-LIVE.md).
