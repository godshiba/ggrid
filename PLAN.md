# GpuGrid ($GGRID) — Полный план реализации

> Версия 1.0 · 2026-06-23
> Децентрализованный рынок GPU-вычислений. «Uber для видеокарт»: владельцы GPU сдают простаивающие карты, разработчики получают дешёвый OpenAI-совместимый доступ к ИИ-инференсу.

---

## 0. Оглавление

1. [Цель и принципы](#1-цель-и-принципы)
2. [Архитектура (обзор)](#2-архитектура-обзор)
3. [Технологический стек](#3-технологический-стек)
4. [Структура репозитория](#4-структура-репозитория)
5. [Модель данных (Prisma)](#5-модель-данных-prisma)
6. [API](#6-api)
7. [Логика роутера](#7-логика-роутера)
8. [Тарификация и леджер](#8-тарификация-и-леджер)
9. [Нода провайдера](#9-нода-провайдера)
10. [RunPod fallback](#10-runpod-fallback)
11. [Веб: дашборды + лендинг/демо](#11-веб-дашборды--лендингдемо)
12. [План по спринтам](#12-план-по-спринтам)
13. [Детальные задачи Спринта 0](#13-детальные-задачи-спринта-0)
14. [Тестирование](#14-тестирование)
15. [Безопасность и анти-абьюз](#15-безопасность-и-анти-абьюз)
16. [Деплой и инфраструктура](#16-деплой-и-инфраструктура)
17. [Токен-слой $GGRID (Solana / pump.fun)](#17-токен-слой-ggrid-solana--pumpfun)
18. [Риски и митигейшн](#18-риски-и-митигейшн)
19. [Definition of Done для демо к запуску](#19-definition-of-done-для-демо-к-запуску)

---

## 1. Цель и принципы

### Что доказывает MVP
Одну петлю: **запрос разработчика уходит на чужой GPU → ответ возвращается → начисление записано** (с кого списали, кому начислили, сколько токенов).

### Принципы
- **Используем готовые кирпичи.** Самое сложное (запуск моделей) уже решено в Ollama. Мы пишем только «диспетчера» и учёт.
- **Узкий клин.** Не «суперкомпьютер для всего», а дешёвый инференс открытых моделей. Одна задача, сделанная хорошо.
- **Честность.** Обещаем ровно то, что железо реально может. Никакого обучения и enterprise-надёжности на домашних картах в заявлениях.
- **Сначала работает, потом красиво.** Стрим важнее UI, петля важнее токеномики.

### Не-цели MVP (осознанные упрощения)
| Что | Почему откладываем |
|---|---|
| Верификация честности вычислений | Нерешённая отраслевая проблема. В MVP верим ноде на слово. |
| Реальный блокчейн | Токен = счётчик в БД. On-chain — фаза 5. |
| Децентрализация роутера | Роутер/реестр централизованы — это нормально, как трекер в торренте. |
| Обучение моделей, большие модели | Домашние карты и домашний интернет не тянут. Только инференс. |
| Постоянный публичный адрес ноды | ngrok временно; Cloudflare Tunnel — позже. |

---

## 2. Архитектура (обзор)

**5 компонентов:**

1. **Gateway / Router** — OpenAI-совместимый API. Принимает запрос → выбирает ноду → проксирует стрим → считает токены. Сердце системы.
2. **Registry (реестр нод)** — кто онлайн, какие модели, heartbeat, метрики. Postgres + Redis.
3. **Node Agent** — то, что ставит провайдер: Ollama + ngrok + маленький агент (регистрация + heartbeat).
4. **RunPod fallback** — поднимает облачный GPU, когда своих нод нет (решает холодный старт).
5. **Web** — дашборды провайдера и разработчика + публичный лендинг/демо.

**Поток одного запроса:**
```
[S] провайдер один раз: Ollama + ngrok → регистрация в реестре
 1  разработчик: POST /v1/chat/completions (Bearer api_key, model="...")
 2  роутер: подбор онлайн-ноды с нужной моделью
 3  прокси запроса на GPU-ноду (или [F] нет нод → поднять RunPod)
 4  стрим результата обратно + счётчик токенов из финального чанка
 5  ответ разработчику (SSE насквозь, без буферизации)
 6  учёт: job-лог, списание с user, начисление провайдеру (минус комиссия)
```

Что централизовано (и это ок для MVP): роутер, реестр, биллинг. Что распределено: само исполнение (на чужих GPU).

---

## 3. Технологический стек

| Слой | Выбор | Почему |
|---|---|---|
| Язык | TypeScript (Node.js 20+) везде | один язык на бэке/фронте/агенте |
| Менеджер пакетов | pnpm workspaces (монорепо) | простые воркспейсы без лишнего |
| Gateway/API | **Fastify** | нативный SSE-стрим, быстрый, лёгкое проксирование |
| HTTP к нодам | `undici` (fetch) | стримы ReadableStream насквозь |
| БД | **PostgreSQL 16 + Prisma** | джобы, балансы, идемпотентность, миграции |
| Кеш/состояние | **Redis 7** | liveness нод (TTL), счётчики активных джоб, rate-limit |
| Валидация | `zod` | схемы запросов, типобезопасность |
| Frontend | **Next.js 15 (App Router) + Tailwind + shadcn/ui** | дашборды + лендинг/демо |
| Агент ноды | Node CLI (`npx @ggrid/agent`) + Ollama + ngrok | 10 минут на установку у провайдера |
| Fallback | RunPod API + Docker-образ `ollama/ollama` | холодный старт |
| Тоннель (прод) | Cloudflare Tunnel (после ngrok) | стабильный URL, без таймаутов |
| Деплой | Railway/Fly.io (бэк) + managed Postgres/Redis; Vercel (web) | быстрый старт |
| Токен (фаза 5) | Solana, pump.fun, SPL-токен `$GGRID` | запуск и сообщество |

---

## 4. Структура репозитория

```
ggrid/
├─ apps/
│  ├─ gateway/            # Fastify: /v1/* (OpenAI API) + /api/* (control) + /nodes/* (provider)
│  │  └─ src/
│  │     ├─ server.ts
│  │     ├─ routes/{chat,models,keys,billing,provider,nodes}.ts
│  │     ├─ router/{select.ts,proxy.ts,usage.ts}
│  │     ├─ lib/{redis.ts,auth.ts,pricing.ts,ledger.ts}
│  │     └─ runpod/orchestrator.ts
│  ├─ web/                # Next.js: лендинг + /demo + /dashboard (provider/dev)
│  └─ agent/              # CLI провайдера: register + heartbeat + проверка Ollama
├─ packages/
│  ├─ db/                 # Prisma schema + сгенерированный клиент
│  └─ shared/             # общие типы, zod-схемы, константы цен
├─ infra/
│  ├─ docker-compose.yml  # postgres + redis для локальной разработки
│  └─ .env.example
├─ PLAN.md                # этот файл
└─ README.md
```

Для MVP **gateway — монолит** (gateway + control plane + provider endpoints в одном Fastify-приложении). Разделение на сервисы — позже, если понадобится.

---

## 5. Модель данных (Prisma)

`packages/db/schema.prisma`:

```prisma
model User {
  id        String        @id @default(cuid())
  email     String?       @unique
  balance   BigInt        @default(0)   // кредиты в микро-единицах
  apiKeys   ApiKey[]
  jobs      Job[]
  ledger    LedgerEntry[]
  createdAt DateTime      @default(now())
}

model ApiKey {
  id        String    @id @default(cuid())
  hash      String    @unique           // хеш ключа, не сам ключ
  prefix    String                       // первые символы для отображения
  label     String?
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  createdAt DateTime  @default(now())
  revokedAt DateTime?
}

model Provider {
  id           String        @id @default(cuid())
  email        String?
  payoutWallet String?                    // Solana-адрес (фаза 5)
  balance      BigInt        @default(0)
  nodes        Node[]
  ledger       LedgerEntry[]
  createdAt    DateTime      @default(now())
}

model Node {
  id            String     @id @default(cuid())
  providerId    String
  provider      Provider   @relation(fields: [providerId], references: [id])
  url           String                      // публичный URL (ngrok/Cloudflare)
  secretHash    String                      // секрет ноды для heartbeat
  source        NodeSource @default(LOCAL)
  models        String[]                    // список моделей ноды
  gpuInfo       Json?                        // { name, vramGb }
  status        NodeStatus @default(OFFLINE)
  reliability   Float      @default(1.0)     // 0..1, падает на ошибках
  activeJobs    Int        @default(0)
  lastHeartbeat DateTime?
  jobs          Job[]
  createdAt     DateTime   @default(now())
}

model Job {
  id          String      @id @default(cuid())
  userId      String
  user        User        @relation(fields: [userId], references: [id])
  nodeId      String?
  node        Node?       @relation(fields: [nodeId], references: [id])
  model       String
  status      JobStatus   @default(PENDING)
  source      NodeSource?
  tokensIn    Int         @default(0)
  tokensOut   Int         @default(0)
  costCredits BigInt      @default(0)
  latencyMs   Int?
  error       String?
  createdAt   DateTime    @default(now())
  finishedAt  DateTime?
}

model LedgerEntry {
  id         String     @id @default(cuid())
  type       LedgerType
  amount     BigInt                          // знак: + начисление, − списание
  userId     String?
  user       User?      @relation(fields: [userId], references: [id])
  providerId String?
  provider   Provider?  @relation(fields: [providerId], references: [id])
  jobId      String?
  createdAt  DateTime   @default(now())
}

enum NodeSource { LOCAL RUNPOD }
enum NodeStatus { ONLINE OFFLINE BUSY }
enum JobStatus  { PENDING RUNNING DONE FAILED }
enum LedgerType { DEPOSIT CHARGE PROVIDER_REWARD BURN TREASURY STAKERS }
```

---

## 6. API

### 6.1 Gateway (OpenAI-совместимый — для разработчиков)
| Метод | Путь | Описание |
|---|---|---|
| POST | `/v1/chat/completions` | основной эндпоинт, стрим и не-стрим |
| GET | `/v1/models` | агрегированный список моделей со всех онлайн-нод |
| POST | `/v1/embeddings` | (опционально, позже) |

Аутентификация: `Authorization: Bearer <api_key>`. Полная совместимость с OpenAI SDK — разработчик просто меняет `base_url`.

### 6.2 Control plane (для дашбордов)
| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/login` | magic-link / простая авторизация (MVP — email) |
| GET | `/api/me` | профиль + баланс |
| POST | `/api/keys` | создать API-ключ (возвращается один раз) |
| DELETE | `/api/keys/:id` | отозвать ключ |
| GET | `/api/usage` | история джоб, расход |
| POST | `/api/balance/topup` | пополнение (MVP — мок/промокод) |
| GET | `/api/provider/nodes` | ноды провайдера и их статус |
| GET | `/api/provider/earnings` | заработок провайдера |
| GET | `/api/stats` | публичная статистика сети (ноды, объём) |

### 6.3 Provider / Node
| Метод | Путь | Описание |
|---|---|---|
| POST | `/nodes/register` | `{ url, models, gpuInfo, providerToken }` → `{ nodeId, nodeSecret }` |
| POST | `/nodes/:id/heartbeat` | `{ status, activeJobs, models }` (auth: nodeSecret) → ставит TTL в Redis |
| DELETE | `/nodes/:id` | дерегистрация |

**Пример запроса разработчика:**
```bash
curl https://api.ggrid.xyz/v1/chat/completions \
  -H "Authorization: Bearer ggrid_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3:8b","stream":true,
       "messages":[{"role":"user","content":"Привет!"}]}'
```

---

## 7. Логика роутера

```ts
async function handleChatCompletion(req) {
  const apiKey = parseBearer(req)
  const user   = await authByApiKey(apiKey)        // 401 если невалидный
  if (user.balance <= MIN_BALANCE) return 402       // Payment Required

  const model = req.body.model
  let node = await selectNode(model)
  if (!node) node = await runpod.ensureNode(model)  // холодный старт
  if (!node) return 503                              // совсем нет мощностей

  const job = await db.job.create({ userId: user.id, model,
                                    status: 'RUNNING', source: node.source })
  await redis.incr(`node:${node.id}:active`)
  const t0 = performance.now()
  try {
    const upstream = await fetch(node.url + '/v1/chat/completions', {
      method: 'POST',
      body: withUsage(req.body),           // добавляем stream_options.include_usage
    })
    const usage = await pipeAndCaptureUsage(upstream, reply)  // SSE насквозь
    const cost  = price(model, usage)
    await settle(job, node, usage, cost, performance.now() - t0)  // см. §8
  } catch (e) {
    await db.job.update({ id: job.id, status: 'FAILED', error: String(e) })
    await penalizeReliability(node)
    // опционально: ретрай один раз на другой ноде, не списывая дважды
    throw e
  } finally {
    await redis.decr(`node:${node.id}:active`)
  }
}

async function selectNode(model) {
  const onlineIds = await redis.smembers('nodes:online')   // только со свежим heartbeat
  const candidates = (await db.node.findMany({
    where: { id: { in: onlineIds }, models: { has: model } }
  })).filter(n => n.activeJobs < MAX_CONCURRENCY)

  // сортировка: свои ноды раньше RunPod → меньше загрузка → выше надёжность
  candidates.sort(byPriority(['source:LOCAL_FIRST', 'activeJobs:asc', 'reliability:desc']))
  return candidates[0] ?? null
}
```

**Стриминг и подсчёт токенов:**
- Проксируем на `/v1/chat/completions` ноды с `stream_options: { include_usage: true }` → usage приходит в финальном чанке.
- Запасной путь: Ollama-native `/api/chat` отдаёт `prompt_eval_count` (вход) и `eval_count` (выход).
- Стрим **не буферим**: `reply.raw` / passthrough, чанки летят клиенту сразу.

**Heartbeat / liveness:**
- Агент шлёт `POST /nodes/:id/heartbeat` каждые 15с → `redis.setex('online:'+id, 30, '1')` + `SADD nodes:online`.
- Ключ протух (30с) → ноду не выбираем. Запасная проверка: `GET node.url/api/tags` перед маршрутизацией.

---

## 8. Тарификация и леджер

**Цена** (кредиты за 1M токенов, настраивается по моделям):
```ts
const PRICES = {
  'llama3:8b':   { in: 20,  out: 60  },
  'qwen2.5:7b':  { in: 20,  out: 60  },
  'llama3:70b':  { in: 120, out: 300 },
}
cost = ceil(tokensIn/1e6 * in + tokensOut/1e6 * out)   // в кредитах
```

**Сплит комиссии за каждый job (из ТЗ):**
| Доля | Кому | Тип в леджере |
|---|---|---|
| 75% | GPU-провайдеру | `PROVIDER_REWARD` |
| 12.5% | buyback & burn | `BURN` |
| 7.5% | стейкерам | `STAKERS` |
| 5% | казна | `TREASURY` |

```ts
async function settle(job, node, usage, cost, latencyMs) {
  await db.$transaction([
    db.job.update({ id: job.id, status: 'DONE',
      tokensIn: usage.in, tokensOut: usage.out, costCredits: cost, latencyMs }),
    // списание с пользователя
    db.user.update({ id: job.userId, balance: { decrement: cost } }),
    db.ledger.create({ type: 'CHARGE', userId: job.userId, amount: -cost, jobId: job.id }),
    // начисление провайдеру (75%)
    db.provider.update({ id: node.providerId,
      balance: { increment: cost * 75n / 100n } }),
    db.ledger.create({ type: 'PROVIDER_REWARD', providerId: node.providerId,
      amount: cost * 75n / 100n, jobId: job.id }),
    // burn / stakers / treasury — пока бухгалтерия (записи), без реальных переводов
    db.ledger.create({ type: 'BURN',     amount: cost * 125n / 1000n, jobId: job.id }),
    db.ledger.create({ type: 'STAKERS',  amount: cost * 75n  / 1000n, jobId: job.id }),
    db.ledger.create({ type: 'TREASURY', amount: cost * 50n  / 1000n, jobId: job.id }),
  ])
}
```
Идемпотентность: списываем строго один раз по `job.id` в транзакции. При ошибке ноды — НЕ списываем (джоб `FAILED`), возможен ретрай.

В фазе 5 этот же `LedgerEntry` 1:1 маппится на on-chain переводы `$GGRID` без переписывания логики.

---

## 9. Нода провайдера

**Что делает провайдер (10 минут):**
1. Ставит Ollama (`ollama.com/download`), тянет модель: `ollama pull llama3:8b`.
2. Запускает тоннель: `ngrok http 11434` → получает публичный URL.
3. Запускает агента: `npx @ggrid/agent --token <providerToken> --url <ngrok-url>`.

**Агент (`apps/agent`) делает:**
- проверяет, что Ollama жив (`GET /api/tags`), собирает список моделей и `gpuInfo`;
- `POST /nodes/register` → сохраняет `nodeId` + `nodeSecret` локально;
- каждые 15с шлёт heartbeat с `activeJobs` и статусом;
- при выходе — `DELETE /nodes/:id`.

В MVP можно начать вообще без агента: ручная регистрация URL через форму на сайте + серверный pull-heartbeat (`GET url/api/tags`). Агент добавляем в Спринте 1.

---

## 10. RunPod fallback

```ts
// apps/gateway/src/runpod/orchestrator.ts
async function ensureNode(model): Promise<Node | null> {
  // 1. уже есть тёплый под с этой моделью? — вернуть его
  // 2. иначе создать под:
  const pod = await runpod.createPod({
    gpuType: 'NVIDIA RTX 4090',
    imageName: 'ollama/ollama:latest',
    ports: '11434/http',
    env: { OLLAMA_KEEP_ALIVE: '30m' },
  })
  await waitUntilReady(pod, '/api/tags')        // poll, таймаут 3 мин
  await runpod.exec(pod, `ollama pull ${model}`) // или образ с предзагрузкой
  const node = await db.node.create({
    providerId: SYSTEM_PROVIDER_ID, url: pod.publicUrl,
    source: 'RUNPOD', models: [model], status: 'ONLINE',
  })
  scheduleIdleTeardown(pod, node, IDLE_MS)       // погасить после 5 мин простоя
  return node
}
```
Тонкости:
- Первый под = 1–3 мин (создание + pull). Для демо держим **1 тёплый под** на популярную модель ИЛИ показываем статус «провижининг…».
- Idle-teardown по таймеру без джоб → гасим под, чтобы не платить зря.
- Для пиков позже — пул из N подов.

---

## 11. Веб: дашборды + лендинг/демо

`apps/web` (Next.js):
- **Лендинг** — что это, для провайдеров и для разработчиков, ссылки.
- **`/demo`** — публичная страница: textarea → отправить запрос → видно стрим ответа **и плашку «обработано нодой #X (RTX 4090, ngrok/RunPod), N токенов, M мс»**. Это ключевой пруф для запуска.
- **`/dashboard` (разработчик)** — API-ключи, баланс, история расхода, пример кода (`base_url`).
- **`/dashboard/provider`** — мои ноды и статус, график заработка, инструкция подключения.
- **`/stats`** — публично: число онлайн-нод, суммарный объём токенов, аптайм.

---

## 12. План по спринтам

| Спринт | Название | Срок | Результат (критерий приёмки) |
|---|---|---|---|
| **0** | Петля жива | 2–3 дня | `curl` на gateway → ответ приходит со второй машины (Ollama+ngrok). Токены и латентность логируются. |
| **1** | Реестр + регистрация + биллинг | 1.5–2 нед | Postgres+Redis. 2 ноды зарегистрированы, heartbeat работает. Запрос роутится на онлайн-ноду с нужной моделью; офлайн-нода пропускается. API-ключи, баланс списывается, провайдер получает начисление. `/v1/models` отдаёт агрегат. |
| **2** | RunPod fallback | ~1 нед | Своих нод нет → запрос автоматически поднимает RunPod, исполняется, под гасится после простоя. Пользователь не видит разницы. |
| **3** | Дашборды + лендинг/демо | 1.5–2 нед | Сквозной сценарий через UI: разработчик берёт ключ и шлёт запрос; провайдер видит ноду и заработок. Публичная `/demo` готова для записи видео/стрима. |
| **4** | Прод-готовность | 1–2 нед | Cloudflare Tunnel вместо ngrok, scoring надёжности, rate-limit, ретраи, логирование/метрики, деплой. Пакет агента `@ggrid/agent`. Открытая бета с внешними провайдерами. |
| **5** | Токен-слой $GGRID | после демо | Запуск на pump.fun (честный), SPL-токен, маппинг леджера на on-chain выплаты, кошельки провайдеров. См. §17. |

**Итого до открытой беты (solo): ~6–8 недель.** Фаза 5 — параллельно/после, по готовности продукта.

---

## 13. Детальные задачи Спринта 0

Цель: увидеть живую петлю своими глазами. Минимум кода, максимум смысла.

**Задачи:**
1. `pnpm init` монорепо, воркспейс `apps/gateway`, TypeScript + tsx + Fastify.
2. `gateway/src/server.ts`: эндпоинт `POST /v1/chat/completions`.
3. Прокси на `process.env.NODE_URL + '/v1/chat/completions'` (твой Ollama через ngrok).
4. Поддержать стрим (passthrough SSE) и не-стрим (JSON).
5. После ответа — вытащить usage и `console.log({ model, tokensIn, tokensOut, latencyMs })`.
6. `GET /v1/models` → проксировать `/api/tags` ноды.

**Первые команды:**
```bash
# машина B (нода):
ollama pull llama3:8b
ollama serve            # уже слушает :11434
ngrok http 11434        # копируем https://xxxx.ngrok.app

# машина A (gateway):
mkdir ggrid && cd ggrid && pnpm init
pnpm add fastify undici && pnpm add -D typescript tsx @types/node
# создаём apps/gateway/src/server.ts (прокси)
NODE_URL=https://xxxx.ngrok.app pnpm tsx apps/gateway/src/server.ts

# тест:
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"ping"}]}'
```
**Готово, когда:** ответ в `curl` пришёл, и в консоли gateway видно лог джоба с числом токенов.

---

## 14. Тестирование

- **Unit:** `price()`, `selectNode()` (сортировка/фильтры), сплит леджера.
- **Integration:** роутинг на мок-Ollama (поднимаем фейковый сервер с `/v1/chat/completions` и `/api/tags`); проверяем списание/начисление в транзакции.
- **E2E:** `docker-compose up` (pg+redis) + скриптовый сценарий: register node → curl → проверка job/ledger в БД.
- **Load:** `k6` на стриминг — параллельные SSE, проверка отсутствия буферизации и утечек соединений.
- **Resilience:** убить ноду посреди джоба → джоб `FAILED`, без двойного списания, reliability падает.

---

## 15. Безопасность и анти-абьюз

- **API-ключи:** хранить только хеш (`hash`), показывать ключ один раз. Префикс для UI.
- **Секрет ноды:** `nodeSecret` для heartbeat/дерегистрации; в БД — хеш.
- **Rate-limit:** по ключу через Redis (запросов/мин, параллельных стримов).
- **Префандинг:** баланс вперёд, отрицательный не уходит (проверка до джоба + транзакция).
- **Лимиты запроса:** max токенов/размер тела/таймаут на ноду.
- **Приватность задач:** провайдер видит payload — честно отметить в доках; для прода — шифрование/доверенные ноды.
- **Секреты:** только в `.env`/секрет-менеджере, не в репозитории. TLS обеспечивает тоннель.

---

## 16. Деплой и инфраструктура

- **Локально:** `infra/docker-compose.yml` — Postgres + Redis. Gateway и web — `pnpm dev`.
- **Стейдж/прод:** gateway → Railway или Fly.io; Postgres/Redis → managed (Railway/Neon/Upstash); web → Vercel.
- **Домены:** `api.ggrid.xyz` (gateway), `ggrid.xyz` (web).
- **CI:** GitHub Actions — typecheck + тесты + Prisma migrate на деплое.
- **Наблюдаемость:** структурные логи (pino), базовые метрики (число джоб, латентность, ошибки нод), алерты на падение нод.

---

## 17. Токен-слой $GGRID (Solana / pump.fun)

**Подход:** off-chain леджер сейчас → on-chain расчёты потом. Внутренние «кредиты» в MVP, реальный SPL-токен `$GGRID` в фазе 5.

**Маппинг:**
- `LedgerEntry(PROVIDER_REWARD)` → периодическая выплата `$GGRID` на `payoutWallet` провайдера.
- `BURN` → реальный burn части казны/комиссии.
- `STAKERS`, `TREASURY` → соответствующие кошельки/контракты.

**Честный launch-чеклист (важно — и этично, и безопаснее):**
- [ ] рабочее демо в руках до запуска (пруф, а не whitepaper);
- [ ] прозрачное распределение токена, публично;
- [ ] ликвидность залочена/сожжена, без скрытого инсайдерского снайпа;
- [ ] честный месседж: что работает сейчас, что — роадмап;
- [ ] никаких обещаний обучения/enterprise на домашних картах;
- [ ] дисклеймер о рисках и раннем статусе.

> Стейкинг и slashing — дизайн отдельной фазы. Не блокируют MVP.

---

## 18. Риски и митигейшн

| Риск | Митигейшн |
|---|---|
| Нестабильные домашние ноды | heartbeat + reliability scoring + RunPod fallback + ретрай на другую ноду |
| Холодный старт (нет нод) | тёплый под RunPod на популярную модель |
| ngrok меняет URL при рестарте | агент перерегистрируется; в проде — Cloudflare Tunnel |
| Провайдер вернул мусор/обманул | reliability вниз, бан; верификация — будущая фаза |
| Конкуренты (Salad, io.net, Akash, Vast) | узкий клин + честность + живое демо как отличие |
| Тонкая экономика | таргет — хоббисты/инди/батч, не enterprise-production |
| Токен живёт отдельно от продукта | сначала продукт, токен обслуживает его, прозрачность |

---

## 19. Definition of Done для демо к запуску

К моменту запуска на pump.fun должно работать:
1. Разработчик берёт API-ключ на сайте и шлёт OpenAI-совместимый запрос — получает стрим-ответ.
2. Запрос реально исполняется на отдельной ноде (минимум: твоя вторая машина через ngrok + RunPod fallback).
3. Публичная `/demo`-страница показывает запрос → ответ → «кто обработал, сколько токенов, сколько мс».
4. Провайдер видит свою ноду онлайн и капающий заработок в дашборде.
5. `/stats` показывает живые цифры сети.
6. Сайт честно описывает, что работает сейчас и что в роадмапе.

Это даёт то, чего нет у 99% запусков: **настоящую работающую вещь за нарративом.**
```

— Готово, обновляем по мере движения.
