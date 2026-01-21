-- Атомарная и идемпотентная ставка
-- KEYS[1] = user:{userId}:bets (HASH)
-- KEYS[2] = auction:{auctionId}:bets (ZSET - сортировка по ставке + время)
-- KEYS[3] = locked:{userId}
-- ARGV[1] = auctionId
-- ARGV[2] = userId
-- ARGV[3] = newAmount
-- ARGV[4] = userBalance
-- ARGV[5] = timestamp (ms)

local userBetsKey = KEYS[1]
local auctionBetsKey = KEYS[2]
local lockedKey = KEYS[3]
local auctionId = ARGV[1]
local userId = ARGV[2]
local newAmount = tonumber(ARGV[3])
local userBalance = tonumber(ARGV[4])
local timestamp = tonumber(ARGV[5])

-- Константа для составного score
-- score = amount * 10^10 + (MAX_TS - timestamp_seconds)
-- Больше amount = выше, раньше timestamp = выше
-- MAX_TS должен быть < MULTIPLIER чтобы не ломать извлечение amount
local MAX_TS = 9999999999       -- ~2286 год в секундах
local MULTIPLIER = 10000000000  -- 10^10

-- Получаем текущую ставку
local oldBet = tonumber(redis.call('HGET', userBetsKey, auctionId)) or 0

-- Идемпотентность: если ставка та же — ничего не делаем
if oldBet == newAmount then
  return { 0, oldBet, oldBet, 0, "SAME" }
end

-- Считаем diff для этого конкретного аукциона
local diff = newAmount - oldBet

-- Уменьшать ставку нельзя!
if diff < 0 then
  return { -2, oldBet, oldBet, 0, "CANNOT_DECREASE" }
end

-- Увеличиваем ставку — проверяем только diff
local currentLocked = tonumber(redis.call('GET', lockedKey)) or 0
local availableBalance = userBalance - currentLocked

-- Хватает ли свободного баланса на добавляемую сумму?
if availableBalance < diff then
  return { -1, 0, oldBet, diff, "INSUFFICIENT_BALANCE" }
end

local newLocked = currentLocked + diff

-- Конвертируем timestamp из мс в секунды
local timestampSeconds = math.floor(timestamp / 1000)

-- Получаем старый timestamp (если есть ставка) для сохранения позиции
local oldScore = redis.call('ZSCORE', auctionBetsKey, userId)
local betTimestamp = timestampSeconds

if oldScore then
  -- Сохраняем оригинальный timestamp при увеличении ставки
  betTimestamp = MAX_TS - (oldScore % MULTIPLIER)
end

-- Составной score: amount * 10^10 + (MAX_TS - timestamp_seconds)
local score = newAmount * MULTIPLIER + (MAX_TS - betTimestamp)

-- Атомарно обновляем всё
redis.call('HSET', userBetsKey, auctionId, newAmount)
redis.call('ZADD', auctionBetsKey, score, userId)
redis.call('SET', lockedKey, newLocked)

-- Возвращаем: код, новая ставка, старая ставка, diff, статус
return { 1, newAmount, oldBet, diff, "OK" }
