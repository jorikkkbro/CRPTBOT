# CryptoBot - Аукционная система

видос: https://youtu.be/zoFxfgTjLDA

Высоконагруженная система аукционов с поддержкой 1000+ ставок в секунду. Разработана для Telegram Mini Apps, но может использоваться как standalone решение.

## Содержание

- [Возможности](#возможности)
- [Технологии](#технологии)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Структура проекта](#структура-проекта)
- [База данных](#база-данных)
- [Redis структуры](#redis-структуры)
- [API документация](#api-документация)
- [Жизненный цикл аукциона](#жизненный-цикл-аукциона)
- [Система ставок](#система-ставок)
- [Anti-snipe система](#anti-snipe-система)
- [Real-time обновления (SSE)](#real-time-обновления-sse)
- [Rate Limiting](#rate-limiting)
- [Производительность](#производительность)
- [Тестирование](#тестирование)
- [Конфигурация](#конфигурация)
- [Масштабирование](#масштабирование)
- [Troubleshooting](#troubleshooting)

---

## Возможности

### Основные
- Создание аукционов с несколькими раундами
- Real-time обновления через SSE (Server-Sent Events)
- Anti-snipe система (продление раунда при ставке в последние секунды)
- Атомарные и идемпотентные ставки через Lua скрипты
- Автоматическое распределение призов победителям
- Автоматический возврат средств проигравшим

### Бизнес-логика
- Нельзя уменьшить ставку (только увеличить)
- Нельзя ставить на свой аукцион
- Блокировка баланса до завершения раунда
- Поддержка нескольких раундов с разными призами
- Если нет ставок - призы возвращаются автору

### Технические
- 1000+ RPS на одном сервере
- Горизонтальное масштабирование
- Graceful shutdown
- Health checks
- Rate limiting

### Надёжность и консистентность
- **Distributed locks** — защита от race conditions при конкурентных операциях
- **Idempotency keys** — безопасные повторные запросы (retry-safe)
- **Transaction ledger** — полный аудит всех операций в MongoDB
- **Recovery** — автоматическое восстановление после падения сервера

---

## Технологии

| Технология | Назначение |
|------------|------------|
| **Node.js 20** | Рантайм |
| **Express 4** | HTTP сервер |
| **TypeScript 5** | Типизация |
| **MongoDB 7** | Хранение пользователей, аукционов, истории |
| **Redis 7** | Ставки, блокировки, pub/sub, кэширование |
| **BullMQ 5** | Очередь задач для обработки раундов |
| **Mongoose 8** | ODM для MongoDB |

---

## Архитектура

### Общая схема

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Browser  │  │ Telegram │  │  Mobile  │  │   API    │        │
│  │          │  │ Mini App │  │   App    │  │  Client  │        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
└───────┼─────────────┼─────────────┼─────────────┼───────────────┘
        │             │             │             │
        └─────────────┴──────┬──────┴─────────────┘
                             │
                    HTTP / SSE / WebSocket
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       EXPRESS SERVER                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  /api/bet   │  │ /api/data/* │  │  /api/      │             │
│  │  (ставки)   │  │   (данные)  │  │  auction/*  │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│  ┌──────┴────────────────┴────────────────┴──────┐             │
│  │              MIDDLEWARE                        │             │
│  │  • Rate Limiting  • Auth  • Validation        │             │
│  └───────────────────────┬───────────────────────┘             │
└──────────────────────────┼──────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   MongoDB    │  │    Redis     │  │   BullMQ     │
│              │  │              │  │   Worker     │
│ • Users      │  │ • Bets       │  │              │
│ • Auctions   │  │ • Locks      │  │ • Round      │
│ • History    │  │ • Pub/Sub    │  │   processing │
│              │  │ • Cache      │  │ • Scheduling │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Поток ставки

```
Client                    Server                     Redis                  MongoDB
   │                         │                         │                       │
   │  POST /api/bet          │                         │                       │
   │  X-Idempotency-Key: abc │                         │                       │
   │────────────────────────▶│                         │                       │
   │                         │                         │                       │
   │                         │  getAuction(id)         │                       │
   │                         │────────────────────────────────────────────────▶│
   │                         │◀────────────────────────────────────────────────│
   │                         │                         │                       │
   │                         │  acquireUserLock()      │                       │
   │                         │────────────────────────▶│                       │
   │                         │◀────────────────────────│                       │
   │                         │                         │                       │
   │                         │  ┌─── CRITICAL SECTION (под локом) ───┐        │
   │                         │  │                      │             │        │
   │                         │  │ getUser + getLocked  │             │        │
   │                         │  │──────────────────────────────────────────────▶
   │                         │  │◀─────────────────────────────────────────────│
   │                         │  │                      │             │        │
   │                         │  │ makeBet (Lua+idem)   │             │        │
   │                         │  │─────────────────────▶│             │        │
   │                         │  │◀─────────────────────│             │        │
   │                         │  │                      │             │        │
   │                         │  │ createBetTransaction │             │        │
   │                         │  │──────────────────────────────────────────────▶
   │                         │  │◀─────────────────────────────────────────────│
   │                         │  │                      │             │        │
   │                         │  └─────────────────────────────────────┘        │
   │                         │                         │                       │
   │                         │  releaseUserLock()      │                       │
   │                         │────────────────────────▶│                       │
   │                         │                         │                       │
   │                         │  [Anti-snipe check]     │                       │
   │                         │────────────────────────▶│                       │
   │                         │                         │                       │
   │  {success, bet,         │                         │                       │
   │   idempotent: false}    │                         │                       │
   │◀────────────────────────│                         │                       │
```

### Поток обработки раунда

```
BullMQ                    Server                     Redis                  MongoDB
   │                         │                         │                       │
   │  Job: end-round         │                         │                       │
   │────────────────────────▶│                         │                       │
   │                         │                         │                       │
   │                         │  Lock auction           │                       │
   │                         │  (currentRound=-999)    │                       │
   │                         │────────────────────────────────────────────────▶│
   │                         │                         │                       │
   │                         │  getTopBets(limit)      │                       │
   │                         │────────────────────────▶│                       │
   │                         │◀────────────────────────│                       │
   │                         │                         │                       │
   │                         │  [Parallel for each winner]                     │
   │                         │  ┌─────────────────────────────────────────────┐│
   │                         │  │ deleteBet()          │                       ││
   │                         │  │─────────────────────▶│                       ││
   │                         │  │ deductBalance()      │                       ││
   │                         │  │──────────────────────────────────────────────▶│
   │                         │  │ addGifts()           │                       ││
   │                         │  │──────────────────────────────────────────────▶│
   │                         │  └─────────────────────────────────────────────┘│
   │                         │                         │                       │
   │                         │  Update auction         │                       │
   │                         │  (winners, state)       │                       │
   │                         │────────────────────────────────────────────────▶│
   │                         │                         │                       │
   │  Schedule next round    │                         │                       │
   │◀────────────────────────│                         │                       │
   │                         │                         │                       │
```

---

## Быстрый старт

### С Docker (рекомендуется)

```bash
# Клонировать репозиторий
git clone <repo-url>
cd cryptobot

# Запустить всё одной командой
docker-compose up -d

# Проверить статус
docker-compose ps

# Посмотреть логи
docker-compose logs -f app

# Открыть в браузере
open http://localhost:3000
```

### Без Docker (для разработки)

```bash
# 1. Установить зависимости
npm install

# 2. Запустить MongoDB
mongod --dbpath /path/to/data

# 3. Запустить Redis
redis-server

# 4. Создать .env файл
cp .env.example .env

# 5. Запустить в dev режиме (с hot reload)
npm run dev

# Или собрать и запустить production
npm run build
npm start
```

### Проверка работоспособности

```bash
# Создать тестового юзера с балансом
curl -X POST http://localhost:3000/test/mint-stars \
  -H "Content-Type: application/json" \
  -H "x-user-id: test-user" \
  -d '{"amount": 1000}'

# Проверить баланс
curl http://localhost:3000/api/data/user/balance \
  -H "x-user-id: test-user"
```

---

## Структура проекта

```
cryptobot/
├── src/                      # Исходный код
│   ├── index.ts              # Точка входа, инициализация
│   ├── types.ts              # TypeScript типы и интерфейсы
│   │
│   ├── db/                   # Подключения к БД
│   │   ├── mongo.ts          # MongoDB connection
│   │   └── redis.ts          # Redis connection
│   │
│   ├── models/               # Mongoose модели
│   │   ├── user.ts           # User: balance, gifts
│   │   ├── auction.ts        # Auction: rounds, winners
│   │   └── transaction.ts    # Transaction: ledger всех операций
│   │
│   ├── services/             # Бизнес-логика
│   │   ├── auction.ts        # CRUD аукционов
│   │   ├── bets.ts           # Ставки (Redis операции)
│   │   ├── rounds.ts         # BullMQ worker, обработка раундов
│   │   ├── pubsub.ts         # Redis Pub/Sub для SSE
│   │   ├── userLock.ts       # Distributed locks для пользователей
│   │   └── idempotency.ts    # Idempotency key management
│   │
│   ├── routes/               # Express роуты
│   │   ├── api.ts            # POST /api/bet, /api/auction/create
│   │   ├── data.ts           # GET /api/data/*, SSE endpoints
│   │   └── test.ts           # Тестовые эндпоинты (mint)
│   │
│   ├── middleware/           # Express middleware
│   │   └── rateLimit.ts      # Rate limiting через Redis
│   │
│   └── lua/                  # Загрузчик Lua скриптов
│       └── index.ts
│
├── lua/                      # Lua скрипты для Redis
│   ├── makeBet.lua           # Атомарная ставка
│   └── deleteBet.lua         # Атомарное удаление
│
├── public/                   # Статические файлы
│   ├── index.html            # Главная страница
│   └── auction.html          # Страница аукциона
│
├── tests/                    # Тесты
│   ├── easy.test.ts          # Базовый функциональный тест
│   ├── middle.test.ts        # Тесты edge cases
│   ├── high.test.ts          # Нагрузочный тест
│   └── overhigh.test.ts      # Стресс-тест
│
├── dist/                     # Скомпилированный JS (gitignore)
├── node_modules/             # Зависимости (gitignore)
│
├── Dockerfile                # Docker образ приложения
├── docker-compose.yml        # Все сервисы
├── .dockerignore
├── .env.example              # Пример переменных окружения
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## База данных

### MongoDB Collections

#### Users Collection

```javascript
{
  _id: ObjectId,
  id: "user_123",              // Уникальный ID (индекс)
  balance: 1000,               // Общий баланс звёзд
  gifts: [                     // Подарки пользователя
    { name: "Diamond", count: 5 },
    { name: "Ruby", count: 10 }
  ]
}
```

**Индексы:**
- `id`: unique

#### Auctions Collection

```javascript
{
  _id: ObjectId,
  id: "auc_abc123",            // Уникальный ID (индекс)
  name: "Мой аукцион",         // Название
  state: "active",             // pending | active | finished | cancelled
  currentRound: 0,             // Текущий раунд (0-based)
  roundEndTime: 1699999999999, // Timestamp конца раунда (для таймера)

  gift: {                      // Разыгрываемый подарок
    name: "Diamond",
    count: 10
  },

  startTime: 1699999000000,    // Когда стартует аукцион
  authorId: "user_456",        // Создатель

  rounds: [                    // Конфигурация раундов
    {
      duration: 60,            // Длительность в секундах
      prizes: [5, 3, 2]        // Призы за 1, 2, 3 место
    },
    {
      duration: 30,
      prizes: [3, 2]
    }
  ],

  winners: [                   // Победители (заполняется по мере игры)
    {
      roundIndex: 0,
      place: 1,
      userId: "user_789",
      stars: 500,              // Сколько заплатил
      prize: 5                 // Сколько получил подарков
    }
  ]
}
```

**Индексы:**
- `id`: unique
- `state`: для фильтрации активных
- `authorId`: для аукционов пользователя

#### Transactions Collection (NEW)

Полный аудит всех финансовых операций:

```javascript
{
  _id: ObjectId,
  odId: "idem_abc123",           // Idempotency key (уникальный)
  odType: "bet",                  // bet | bet_increase | refund | win
  odStatus: "active",             // active | won | lost | refunded
  odCreatedAt: ISODate(),
  odUserId: "user_123",
  odAuctionId: "auc_abc123",
  odRoundIndex: 0,
  odAmount: 500,                  // Текущая сумма ставки
  odPreviousAmount: 0,            // Предыдущая ставка (для increase)
  odDiff: 500                     // Сколько списали/вернули
}
```

**Типы транзакций:**
| Type | Описание |
|------|----------|
| `bet` | Первая ставка в аукционе |
| `bet_increase` | Увеличение существующей ставки |
| `refund` | Возврат средств проигравшему |
| `win` | Победа в раунде |

**Статусы:**
| Status | Описание |
|--------|----------|
| `active` | Ставка активна, средства заблокированы |
| `won` | Пользователь победил, средства списаны |
| `lost` | Пользователь проиграл, средства разблокированы |
| `refunded` | Средства возвращены |

**Индексы:**
- `odId`: unique (idempotency)
- `odUserId, odCreatedAt`: история пользователя
- `odAuctionId, odCreatedAt`: история аукциона
- `odUserId, odStatus, odType`: подсчёт locked баланса

---

## Redis структуры

### Ставки пользователя (HASH)

```
Key: user:{userId}:bets
Type: HASH

Fields:
  auc_abc123 -> 500    # auctionId -> amount
  auc_def456 -> 300
```

### Ставки аукциона (ZSET)

```
Key: auction:{auctionId}:bets
Type: ZSET (Sorted Set)

Members: userId
Score: amount * 10^10 + (MAX_TS - timestamp)

Пример:
  user_123: 5000000000001234567  # 500 stars, раньше
  user_456: 5000000000001234999  # 500 stars, позже
  user_789: 3000000000001235000  # 300 stars
```

**Почему композитный score:**
- Сортировка по сумме (больше = выше)
- При равной сумме - кто раньше поставил

### Idempotency Keys (STRING)

```
Key: idem:{idempotencyKey}
Type: STRING
TTL: 24 часа

Value: "1|500|0|500|OK"  # code|amount|prevBet|diff|status
```

**Формат:** `code|amount|previousBet|diff|status`
- Сохраняет результат операции для идемпотентных повторов

### Distributed Locks (STRING)

```
Key: lock:user:{userId}
Type: STRING
TTL: 5 секунд

Value: "1706123456789-abc123"  # lockId для безопасного release
```

**Важно:** Locked баланс теперь считается из MongoDB (aggregation по транзакциям), а не из Redis. Это обеспечивает консистентность при падении сервера.

### Rate Limiting (STRING)

```
Key: rl:bet:{userId}
Type: STRING (счётчик)
TTL: 1 секунда

Value: 3  # Количество запросов в текущем окне
```

### Pub/Sub каналы

```
Channel: auctions:updates        # Обновления списка аукционов
Channel: auction:{id}:updates    # Обновления конкретного аукциона
```

---

## API документация

### Аутентификация

Все запросы требуют header `x-user-id` с ID пользователя.

```http
x-user-id: user_123
```

> В продакшене замените на JWT токен или Telegram WebApp initData

---

### POST /api/bet

Сделать ставку на аукцион.

**Request:**
```http
POST /api/bet
Content-Type: application/json
x-user-id: user_123
x-idempotency-key: bet_abc123_1706123456

{
  "id": "auc_abc123",
  "stars": 100
}
```

**Headers:**
| Header | Обязательный | Описание |
|--------|--------------|----------|
| `x-user-id` | Да | ID пользователя |
| `x-idempotency-key` | Да | Уникальный ключ запроса (8-64 символа, `[a-zA-Z0-9-_]`) |

**Response (успех):**
```json
{
  "success": true,
  "status": "OK",
  "idempotent": false,
  "auctionId": "auc_abc123",
  "bet": 100,
  "previousBet": 0,
  "charged": 100,
  "extended": false
}
```

**Поля ответа:**
| Поле | Описание |
|------|----------|
| `success` | Успешно ли выполнена операция |
| `status` | `OK` или `SAME` |
| `idempotent` | `true` если это повторный запрос с тем же ключом |
| `bet` | Текущая ставка |
| `previousBet` | Предыдущая ставка (0 если первая) |
| `charged` | Сколько списано с баланса |
| `extended` | Был ли продлён раунд (anti-snipe) |

**Статусы:**
| Status | Описание |
|--------|----------|
| `OK` | Новая ставка принята |
| `SAME` | Та же сумма, ничего не изменилось |

**Ошибки:**
| Error | HTTP | Описание |
|-------|------|----------|
| `INVALID_IDEMPOTENCY_KEY` | 400 | Ключ обязателен (8-64 символа) |
| `USER_NOT_PROVIDED` | 401 | Нет x-user-id header |
| `INVALID_AUCTION_ID` | 400 | Неверный ID аукциона |
| `INVALID_STARS_AMOUNT` | 400 | Сумма должна быть положительным целым |
| `AUCTION_NOT_FOUND` | 404 | Аукцион не найден |
| `AUCTION_NOT_ACTIVE` | 400 | Аукцион не активен |
| `CANNOT_BET_OWN_AUCTION` | 400 | Нельзя ставить на свой аукцион |
| `INSUFFICIENT_BALANCE` | 400 | Недостаточно средств |
| `CANNOT_DECREASE` | 400 | Нельзя уменьшить ставку |
| `TOO_MANY_REQUESTS` | 429 | Rate limit или lock contention |

---

### POST /api/auction/create

Создать новый аукцион.

**Request:**
```http
POST /api/auction/create
Content-Type: application/json
x-user-id: author_123

{
  "name": "Розыгрыш Diamond",
  "giftName": "Diamond",
  "giftCount": 10,
  "startTime": 1699999999999,
  "rounds": [
    { "duration": 60, "prizes": [5, 3, 2] }
  ]
}
```

**Response (успех):**
```json
{
  "success": true,
  "auction": {
    "id": "auc_abc123",
    "name": "Розыгрыш Diamond",
    "state": "pending",
    "gift": { "name": "Diamond", "count": 10 },
    "startTime": 1699999999999,
    "rounds": [...]
  }
}
```

**Ошибки:**
| Error | HTTP | Описание |
|-------|------|----------|
| `INSUFFICIENT_GIFTS` | 400 | Недостаточно подарков |
| `INVALID_NAME` | 400 | Название обязательно |
| `INVALID_ROUNDS` | 400 | Нужен минимум 1 раунд |
| `TOO_MANY_REQUESTS` | 429 | Макс 3 аукциона в минуту |

---

### GET /api/data/auctions

Получить список активных аукционов.

**Response:**
```json
{
  "auctions": [
    {
      "id": "auc_abc123",
      "name": "Розыгрыш Diamond",
      "state": "active",
      "currentRound": 0,
      "roundEndTime": 1699999999999,
      "gift": { "name": "Diamond", "count": 10 },
      "authorId": "author_123",
      "rounds": [...],
      "winners": [...]
    }
  ]
}
```

---

### GET /api/data/auction/:id

Получить данные аукциона.

**Response:**
```json
{
  "auction": {
    "id": "auc_abc123",
    "name": "Розыгрыш Diamond",
    "state": "active",
    "currentRound": 0,
    "roundEndTime": 1699999999999,
    "gift": { "name": "Diamond", "count": 10 },
    "authorId": "author_123",
    "rounds": [...],
    "winners": [...]
  },
  "participantsCount": 42
}
```

---

### GET /api/data/auction/:id/bets

Получить ставки в аукционе.

**Query params:**
- `limit` - максимум записей (default: 100)

**Response:**
```json
{
  "auctionId": "auc_abc123",
  "bets": [
    { "userId": "user_789", "amount": 500 },
    { "userId": "user_456", "amount": 300 },
    { "userId": "user_123", "amount": 100 }
  ],
  "totalCount": 42,
  "limit": 100
}
```

---

### GET /api/data/auction/:id/my

Получить свою ставку и позицию.

**Response:**
```json
{
  "auctionId": "auc_abc123",
  "bet": 300,
  "rank": 2,
  "totalParticipants": 42
}
```

---

### GET /api/data/user

Получить данные пользователя.

**Response:**
```json
{
  "id": "user_123",
  "balance": 1000,
  "availableBalance": 700,
  "lockedBalance": 300,
  "gifts": [
    { "name": "Diamond", "count": 5 }
  ]
}
```

---

### GET /api/data/user/balance

Получить баланс пользователя.

**Response:**
```json
{
  "balance": 1000,
  "available": 700,
  "locked": 300
}
```

---

### GET /api/data/user/transactions

Получить историю транзакций пользователя.

**Query params:**
- `limit` - максимум записей (default: 50)
- `offset` - смещение (default: 0)

**Response:**
```json
{
  "transactions": [
    {
      "id": "idem_abc123",
      "type": "bet",
      "status": "active",
      "amount": 500,
      "auctionId": "auc_abc123",
      "roundIndex": 0,
      "createdAt": "2024-01-24T12:00:00Z"
    },
    {
      "id": "auc_def456:user_123:win:0:place1",
      "type": "win",
      "status": "won",
      "amount": 300,
      "auctionId": "auc_def456",
      "roundIndex": 0,
      "createdAt": "2024-01-24T11:00:00Z"
    }
  ]
}
```

---

### SSE Endpoints

#### GET /api/data/auctions/sse

Подписка на обновления списка аукционов.

```javascript
const source = new EventSource('/api/data/auctions/sse');
source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.auctions);
};
```

**Формат события:**
```json
{
  "auctions": [...],
  "timestamp": 1699999999999
}
```

#### GET /api/data/auction/:id/sse

Подписка на обновления конкретного аукциона.

```javascript
const source = new EventSource('/api/data/auction/auc_abc123/sse');
source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.auction, data.bets);
};
```

**Формат события:**
```json
{
  "auction": {...},
  "bets": [...],
  "participantsCount": 42,
  "timestamp": 1699999999999
}
```

---

### Тестовые эндпоинты

> Только для разработки! Отключите в продакшене.

#### POST /test/mint-stars

Начислить звёзды пользователю.

```http
POST /test/mint-stars
x-user-id: user_123

{ "amount": 1000 }
```

#### POST /test/mint-gifts

Начислить подарки пользователю.

```http
POST /test/mint-gifts
x-user-id: user_123

{ "name": "Diamond", "count": 10 }
```

#### POST /test/reset

Сбросить пользователя.

```http
POST /test/reset
x-user-id: user_123
```

---

## Жизненный цикл аукциона

```
                    ┌─────────────┐
                    │   CREATE    │
                    │   AUCTION   │
                    └──────┬──────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                      PENDING                         │
│  • Подарки списаны с автора                         │
│  • BullMQ job запланирован на startTime             │
│  • Пользователи видят "скоро начнётся"              │
└─────────────────────────┬───────────────────────────┘
                          │
                          │ startTime наступил
                          ▼
┌─────────────────────────────────────────────────────┐
│                      ACTIVE                          │
│  ┌───────────────────────────────────────────────┐  │
│  │                   ROUND N                      │  │
│  │  • Пользователи делают ставки                 │  │
│  │  • Anti-snipe может продлить раунд            │  │
│  │  • SSE отправляет обновления                  │  │
│  └───────────────────────────────────────────────┘  │
│                          │                          │
│                          │ Время раунда вышло       │
│                          ▼                          │
│  ┌───────────────────────────────────────────────┐  │
│  │              ROUND PROCESSING                  │  │
│  │  • Определяем топ N ставок                    │  │
│  │  • Победителям: списываем stars, даём gifts   │  │
│  │  • Проигравшим: возвращаем locked             │  │
│  └───────────────────────────────────────────────┘  │
│                          │                          │
│           ┌──────────────┴──────────────┐          │
│           │                             │          │
│     Есть ещё раунды              Последний раунд   │
│           │                             │          │
│           ▼                             │          │
│      ROUND N+1                          │          │
│                                         │          │
└─────────────────────────────────────────┼──────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────┐
│                     FINISHED                         │
│  • Все раунды завершены                             │
│  • Все ставки очищены                               │
│  • Все locked балансы возвращены                    │
│  • История сохранена в MongoDB                      │
└─────────────────────────────────────────────────────┘
```

---

## Надёжность и консистентность

### Distributed Locks

Все операции с балансом пользователя защищены distributed lock:

```typescript
const lockResult = await withUserLock(userId, async () => {
  // Операции с балансом выполняются атомарно
  const [user, lockedBalance] = await Promise.all([
    getUser(userId),
    getLockedBalanceFromDB(userId)
  ]);
  const availableBalance = user.balance - lockedBalance;

  // makeBet, createTransaction, etc.
});
```

**Параметры:**
- `TTL`: 5 секунд (автоматический release при падении)
- `Retry`: до 500 попыток с jitter
- `Delay`: 20-40ms между попытками

### Idempotency

Все POST запросы требуют `X-Idempotency-Key`:

```
Клиент                     Сервер
   │  POST /api/bet           │
   │  X-Idempotency-Key: abc  │
   │─────────────────────────▶│
   │                          │  Redis: SETNX idem:abc
   │                          │  Выполнить операцию
   │                          │  Redis: SET idem:abc = result
   │◀─────────────────────────│
   │  {success: true}         │
   │                          │
   │  [Retry - сеть упала]    │
   │  POST /api/bet           │
   │  X-Idempotency-Key: abc  │
   │─────────────────────────▶│
   │                          │  Redis: GET idem:abc → result
   │◀─────────────────────────│
   │  {success: true,         │
   │   idempotent: true}      │  ← Тот же результат, без повторного выполнения
```

**TTL ключа:** 24 часа

### Transaction Ledger

Все финансовые операции записываются в MongoDB:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Redis     │     │   MongoDB   │     │   MongoDB   │
│   (cache)   │     │   (users)   │     │(transactions│
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │ makeBet()         │                   │
       │ ─────────────────▶│                   │
       │                   │                   │
       │                   │ createBetTx()     │
       │                   │ ─────────────────▶│
       │                   │                   │
       │ locked = SUM(active transactions)     │
       │◀──────────────────────────────────────│
```

**Преимущества:**
- Locked баланс восстанавливается после падения сервера
- Полный аудит всех операций
- Возможность отладки и расследования

### Recovery после падения

**Сценарий:** Сервер упал между Redis и MongoDB

```
1. makeBet() → Redis записал ставку + idempotency key
2. [CRASH]
3. createBetTransaction() → НЕ выполнилось
```

**Recovery при retry:**

```
1. Клиент повторяет запрос с тем же idempotency key
2. makeBet() → возвращает сохранённый результат (idempotent: true)
3. createBetTransaction() → выполняется (upsert)
4. MongoDB синхронизирована!
```

---

## Система ставок

### Lua скрипт makeBet

Атомарная и идемпотентная операция в Redis:

```lua
-- Входные данные
KEYS[1] = user:{userId}:bets       -- HASH: ставки пользователя
KEYS[2] = auction:{auctionId}:bets -- ZSET: ставки в аукционе
KEYS[3] = idem:{idempotencyKey}    -- STRING: результат операции
ARGV[1] = auctionId
ARGV[2] = userId
ARGV[3] = newAmount
ARGV[4] = availableBalance         -- Уже вычислен: balance - locked
ARGV[5] = timestamp
ARGV[6] = idempotencyKey

-- Логика
1. Проверить idempotency key:
   - Если существует → вернуть сохранённый результат + флаг IDEMPOTENT
2. Получить текущую ставку из HASH
3. Если та же сумма → return SAME, сохранить в idem key
4. Если меньше → return CANNOT_DECREASE (не сохранять в idem)
5. Вычислить diff = newAmount - oldBet
6. Проверить availableBalance + oldBet >= newAmount
7. Атомарно обновить:
   - HASH: user:bets[auctionId] = newAmount
   - ZSET: auction:bets[userId] = compositeScore
   - STRING: idem:key = result (TTL 24h)
```

**Важно:** Locked баланс НЕ хранится в Redis — он вычисляется из MongoDB транзакций. Это обеспечивает консистентность при падении.

### Композитный score в ZSET

```
score = amount * 10^10 + (MAX_TS - timestamp_seconds)
```

**Зачем:**
- Сортировка по сумме (больше = выше)
- При равной сумме - кто раньше поставил (меньше timestamp = выше score)

**Пример:**
```
User A: 500 stars в 12:00:00 → score = 5000000000009999999
User B: 500 stars в 12:00:05 → score = 5000000000009999994
User C: 300 stars в 11:59:00 → score = 3000000000009999999

Порядок: A, B, C (A и B равны по сумме, но A раньше)
```

### Блокировка баланса

```
Общий баланс:     balance (MongoDB users)
Заблокировано:    locked = SUM(transactions WHERE status='active')
Доступно:         available = balance - locked
```

**Как считается locked:**
```javascript
// MongoDB aggregation
Transaction.aggregate([
  { $match: { odUserId: userId, odStatus: 'active', odType: { $in: ['bet', 'bet_increase'] } } },
  { $sort: { odAuctionId: 1, odCreatedAt: 1 } },
  { $group: { _id: '$odAuctionId', lastAmount: { $last: '$odAmount' } } },
  { $group: { _id: null, total: { $sum: '$lastAmount' } } }
])
```

**Жизненный цикл транзакции:**
```
При ставке:       Transaction(status='active') → locked += diff
При победе:       Transaction(status='won')    → locked = 0, balance -= bet
При проигрыше:    Transaction(status='lost')   → locked = 0 (баланс не меняется)
При возврате:     Transaction(status='refunded') → возврат средств
```

---

## Anti-snipe система

### Проблема

"Снайперы" ждут последнюю секунду и перебивают ставку, не давая другим отреагировать.

### Решение

Если в последние N секунд кто-то делает выигрышную ставку - раунд продлевается.

### Параметры

```typescript
ANTI_SNIPE_THRESHOLD_SECONDS = 10  // Последние 10 секунд
ANTI_SNIPE_EXTEND_SECONDS = 5      // Продлить на 5 секунд
MAX_EXTENSIONS = 5                  // Максимум 5 продлений
```

### Алгоритм

```
1. Пользователь делает ставку
2. Проверяем: осталось <= 10 секунд до конца раунда?
3. Если да: попала ли ставка в топ N (выигрышные позиции)?
4. Если да: продлеваем раунд на 5 секунд
5. Если уже было 5 продлений - не продлеваем
```

### Реализация

```typescript
// В POST /api/bet после успешной ставки
if (auction.roundEndTime) {
  const remainingSeconds = (auction.roundEndTime - Date.now()) / 1000;

  if (remainingSeconds > 0 && remainingSeconds <= 10) {
    const topBets = await getTopBets(auctionId, prizesCount);
    const isWinning = topBets.some(b => b.userId === userId);

    if (isWinning) {
      await extendRound(auctionId, currentRound, 5);
    }
  }
}
```

---

## Real-time обновления (SSE)

### Архитектура

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Client 1 │     │ Client 2 │     │ Client N │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
     │ SSE            │ SSE            │ SSE
     │                │                │
     └────────────────┴────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │  Express SSE  │
              │   Endpoint    │
              └───────┬───────┘
                      │
                      │ Subscribe
                      ▼
              ┌───────────────┐
              │  Redis        │
              │  Pub/Sub      │
              └───────┬───────┘
                      │
                      │ Publish
                      ▼
              ┌───────────────┐
              │  Background   │
              │  Updater      │
              │  (setInterval)│
              └───────────────┘
```

### Почему Pub/Sub

При горизонтальном масштабировании (несколько серверов) обновления должны доходить до всех клиентов, независимо от того, к какому серверу они подключены.

### Интервалы обновлений

```typescript
AUCTIONS_UPDATE_INTERVAL = 1000  // Список аукционов: 1 сек
AUCTION_UPDATE_INTERVAL = 500    // Конкретный аукцион: 0.5 сек
```

---

## Rate Limiting

### Лимиты

| Endpoint | Лимит | Окно |
|----------|-------|------|
| `/api/bet` | 5 запросов | 1 секунда |
| `/api/auction/create` | 3 запроса | 1 минута |
| `/api/data/*` | 20 запросов | 1 секунда |

### Реализация

Через Redis с автоматическим TTL:

```typescript
const key = `rl:${prefix}:${userId}`;
const current = await redis.incr(key);

if (current === 1) {
  await redis.expire(key, windowSeconds);
}

if (current > maxRequests) {
  return 429 Too Many Requests;
}
```

### Response при превышении

```json
{
  "error": "TOO_MANY_REQUESTS",
  "retryAfter": 1
}
```

Headers:
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
Retry-After: 1
```

---

## Производительность

### Бенчмарки (один сервер)

| Метрика | Значение |
|---------|----------|
| Ставок/сек | 1000+ |
| Avg latency | 50-100ms |
| P99 latency | 200ms |
| Concurrent connections | 10,000+ |

### Оптимизации

1. **Lua скрипты** - атомарные операции без round-trips
2. **ZSET с композитным score** - O(log N) вставка и сортировка
3. **Параллельная обработка победителей** - Promise.all
4. **BullMQ concurrency: 50** - параллельная обработка jobs
5. **Connection pooling** - переиспользование соединений
6. **Redis pipelining** - батчинг команд

### Узкие места

1. **MongoDB запросы** - 2 запроса на ставку (getAuction, getUser)
2. **SSE обновления** - нагрузка на Redis pub/sub

### Потенциальные улучшения

1. Кэширование аукционов в Redis
2. Кэширование балансов пользователей
3. Batch обработка ставок
4. WebSocket вместо SSE

---

## Тестирование

### Запуск тестов

```bash
# Базовый тест - один аукцион, несколько юзеров
npm run test:easy

# Продвинутые тесты - edge cases
npm run test:middle

# Нагрузочный тест - 100 юзеров, 10 аукционов
npm run test:high

# Стресс-тест - 2000 ставок/сек
npm run test:overhigh
```

### Что тестируется

#### easy.test.ts
- Создание аукциона
- Размещение ставок
- Завершение раунда
- Распределение призов
- Проверка балансов

#### middle.test.ts
- Атомарность параллельных ставок
- Идемпотентность (повторная ставка той же суммы)
- Увеличение ставки (списывается только diff)
- Попытка уменьшить ставку (ошибка)
- Ставка без баланса (ошибка)
- Ставка на свой аукцион (ошибка)
- Несколько раундов
- Anti-snipe срабатывание
- Возврат locked проигравшим

#### high.test.ts
Жёсткие стресс-тесты на надёжность:

| Тест | Описание |
|------|----------|
| Extreme Concurrency | 200 параллельных ставок |
| Double Spending Attack | Попытка потратить баланс дважды |
| Idempotency Storm | 50 запросов с одним ключом |
| Race Condition Torture | Быстрые увеличения ставки |
| Balance Drain Attack | 10 ставок на разные аукционы |
| Anti-Snipe Flood | Массовые ставки в последние секунды |
| Winner Processing Stress | 50 участников, 20 победителей |
| Transaction Ledger Consistency | Проверка соответствия транзакций |
| Lock Contention Stress | Нагрузка на distributed locks |
| Full System Load | 5 авторов, 20 участников, 3 раунда |

#### overhigh.test.ts
- 2000 пользователей
- 20 аукционов
- Целевая нагрузка 2000 ставок/сек
- Измерение реальной пропускной способности

---

## Конфигурация

### Переменные окружения

```env
# Сервер
PORT=3000                                    # Порт HTTP сервера

# MongoDB
MONGO_URI=mongodb://localhost:27017/cryptobot # URI подключения

# Redis
REDIS_URL=redis://localhost:6379             # URL подключения
```

### Константы в коде

```typescript
// src/routes/api.ts
ANTI_SNIPE_THRESHOLD_SECONDS = 10  // Окно anti-snipe
ANTI_SNIPE_EXTEND_SECONDS = 5      // Продление раунда

// src/services/rounds.ts
MAX_ANTI_SNIPE_EXTENSIONS = 5      // Максимум продлений
WORKER_CONCURRENCY = 50            // Параллельность BullMQ

// src/middleware/rateLimit.ts
BET_RATE_LIMIT = 5 per second
CREATE_AUCTION_RATE_LIMIT = 3 per minute
DATA_RATE_LIMIT = 20 per second

// src/services/pubsub.ts
AUCTIONS_UPDATE_INTERVAL = 1000ms
AUCTION_UPDATE_INTERVAL = 500ms
```

---

## Масштабирование

### Вертикальное

- Больше RAM для Redis
- Больше CPU для Node.js
- SSD для MongoDB

### Горизонтальное

```
                    ┌─────────────┐
                    │   Nginx     │
                    │   Load      │
                    │   Balancer  │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │  Node.js   │  │  Node.js   │  │  Node.js   │
    │  Server 1  │  │  Server 2  │  │  Server N  │
    └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
          │               │               │
          └───────────────┴───────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
   ┌─────────────┐                ┌─────────────┐
   │   Redis     │                │  MongoDB    │
   │   Cluster   │                │  Replica    │
   │             │                │  Set        │
   └─────────────┘                └─────────────┘
```

### Рекомендации

1. **Redis Cluster** - для распределения ключей
2. **MongoDB Replica Set** - для отказоустойчивости и read scaling
3. **Sticky sessions** - для SSE соединений (или Redis adapter для Socket.IO)
4. **Kubernetes** - для автоскейлинга

---

## Troubleshooting

### Аукцион не стартует

```bash
# Проверить BullMQ jobs
docker-compose exec redis redis-cli
> KEYS bull:*
> LRANGE bull:auction-rounds:wait 0 -1
```

### Ставки не проходят

```bash
# Проверить rate limiting
curl -I http://localhost:3000/api/bet ...
# Смотреть X-RateLimit-Remaining

# Проверить баланс
curl http://localhost:3000/api/data/user/balance -H "x-user-id: ..."
```

### SSE не обновляется

```bash
# Проверить Redis pub/sub
docker-compose exec redis redis-cli
> SUBSCRIBE auctions:updates
```

### Высокая latency

```bash
# Проверить MongoDB
docker-compose exec mongo mongosh
> db.auctions.find().explain("executionStats")

# Проверить Redis
docker-compose exec redis redis-cli
> INFO stats
> SLOWLOG GET 10
```

### Память растёт

```bash
# Redis память
docker-compose exec redis redis-cli INFO memory

# Node.js память
docker stats cryptobot_app_1
```

### TOO_MANY_REQUESTS при ставках

```bash
# Проверить lock contention
# Если много конкурентных запросов от одного юзера:
# - MAX_RETRIES = 500 (src/services/userLock.ts)
# - RETRY_DELAY = 20-40ms с jitter

# Проверить активные локи
docker-compose exec redis redis-cli
> KEYS lock:user:*
```

### Транзакции не синхронизированы

```bash
# Проверить транзакции юзера
docker-compose exec mongo mongosh
> use cryptobot
> db.transactions.find({ odUserId: "user_123" }).sort({ odCreatedAt: -1 })

# Сравнить с Redis
docker-compose exec redis redis-cli
> HGETALL user:user_123:bets
```

### Idempotency key конфликт

```bash
# Проверить существующий ключ
docker-compose exec redis redis-cli
> GET idem:your_key_here
> TTL idem:your_key_here

# Ключи живут 24 часа, потом автоудаляются
```

---

## Лицензия

MIT

---

## Contributing

1. Fork репозитория
2. Создайте feature branch (`git checkout -b feature/amazing`)
3. Commit изменения (`git commit -m 'Add amazing feature'`)
4. Push в branch (`git push origin feature/amazing`)
5. Откройте Pull Request
