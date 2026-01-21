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
   │  {id, stars}            │                         │                       │
   │────────────────────────▶│                         │                       │
   │                         │                         │                       │
   │                         │  getAuction(id)         │                       │
   │                         │────────────────────────────────────────────────▶│
   │                         │◀────────────────────────────────────────────────│
   │                         │                         │                       │
   │                         │  getUser(userId)        │                       │
   │                         │────────────────────────────────────────────────▶│
   │                         │◀────────────────────────────────────────────────│
   │                         │                         │                       │
   │                         │  makeBet (Lua script)   │                       │
   │                         │────────────────────────▶│                       │
   │                         │◀────────────────────────│                       │
   │                         │                         │                       │
   │                         │  [Anti-snipe check]     │                       │
   │                         │────────────────────────▶│                       │
   │                         │◀────────────────────────│                       │
   │                         │                         │                       │
   │  {success, bet, ...}    │                         │                       │
   │◀────────────────────────│                         │                       │
   │                         │                         │                       │
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
│   │   └── auction.ts        # Auction: rounds, winners
│   │
│   ├── services/             # Бизнес-логика
│   │   ├── auction.ts        # CRUD аукционов
│   │   ├── bets.ts           # Ставки (Redis операции)
│   │   ├── rounds.ts         # BullMQ worker, обработка раундов
│   │   └── pubsub.ts         # Redis Pub/Sub для SSE
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

### Заблокированный баланс (STRING)

```
Key: locked:{userId}
Type: STRING (число)

Value: 800  # Сумма всех активных ставок пользователя
```

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

{
  "id": "auc_abc123",
  "stars": 100
}
```

**Response (успех):**
```json
{
  "success": true,
  "status": "OK",
  "auctionId": "auc_abc123",
  "bet": 100,
  "previousBet": 0,
  "charged": 100,
  "extended": false
}
```

**Статусы:**
| Status | Описание |
|--------|----------|
| `OK` | Новая ставка принята |
| `SAME` | Та же сумма, ничего не изменилось |

**Ошибки:**
| Error | HTTP | Описание |
|-------|------|----------|
| `USER_NOT_PROVIDED` | 401 | Нет x-user-id header |
| `INVALID_AUCTION_ID` | 400 | Неверный ID аукциона |
| `INVALID_STARS_AMOUNT` | 400 | Сумма должна быть положительным целым |
| `AUCTION_NOT_FOUND` | 404 | Аукцион не найден |
| `AUCTION_NOT_ACTIVE` | 400 | Аукцион не активен |
| `CANNOT_BET_OWN_AUCTION` | 400 | Нельзя ставить на свой аукцион |
| `INSUFFICIENT_BALANCE` | 400 | Недостаточно средств |
| `CANNOT_DECREASE` | 400 | Нельзя уменьшить ставку |
| `TOO_MANY_REQUESTS` | 429 | Rate limit превышен |

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

## Система ставок

### Lua скрипт makeBet

Атомарная операция в Redis, гарантирующая консистентность:

```lua
-- Входные данные
KEYS[1] = user:{userId}:bets      -- HASH
KEYS[2] = auction:{auctionId}:bets -- ZSET
KEYS[3] = locked:{userId}          -- STRING
ARGV[1] = auctionId
ARGV[2] = userId
ARGV[3] = newAmount
ARGV[4] = userBalance
ARGV[5] = timestamp

-- Логика
1. Получить текущую ставку из HASH
2. Если та же сумма → return SAME (идемпотентность)
3. Если меньше → return CANNOT_DECREASE
4. Вычислить diff = newAmount - oldBet
5. Проверить availableBalance >= diff
6. Атомарно обновить:
   - HASH: user:bets[auctionId] = newAmount
   - ZSET: auction:bets[userId] = compositeScore
   - STRING: locked += diff
```

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
Общий баланс:     balance (MongoDB)
Заблокировано:    locked (Redis)
Доступно:         available = balance - locked

При ставке:       locked += diff
При победе:       locked -= bet, balance -= bet
При проигрыше:    locked -= bet (баланс не меняется)
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
- 100 пользователей
- 10 параллельных аукционов
- 3 раунда в каждом
- Проверка всех балансов и призов

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
