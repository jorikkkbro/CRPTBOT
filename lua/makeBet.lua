-- Атомарная и идемпотентная ставка с idempotency key
-- Locked баланс теперь считается из MongoDB, не из Redis
-- KEYS[1] = user:{userId}:bets (HASH)
-- KEYS[2] = auction:{auctionId}:bets (ZSET - сортировка по ставке + время)
-- KEYS[3] = idem:{idempotencyKey} (для идемпотентности)
-- ARGV[1] = auctionId
-- ARGV[2] = userId
-- ARGV[3] = newAmount
-- ARGV[4] = availableBalance (уже вычислен: balance - locked из MongoDB)
-- ARGV[5] = timestamp (ms)
-- ARGV[6] = idempotencyKey

local userBetsKey = KEYS[1]
local auctionBetsKey = KEYS[2]
local idemKey = KEYS[3]
local auctionId = ARGV[1]
local userId = ARGV[2]
local newAmount = tonumber(ARGV[3])
local availableBalance = tonumber(ARGV[4])  -- уже доступный баланс
local timestamp = tonumber(ARGV[5])
local idempotencyKey = ARGV[6]

-- Константа для составного score
-- score = amount * 10^10 + (MAX_TS - timestamp_seconds)
-- Больше amount = выше, раньше timestamp = выше
-- MAX_TS должен быть < MULTIPLIER чтобы не ломать извлечение amount
local MAX_TS = 9999999999       -- ~2286 год в секундах
local MULTIPLIER = 10000000000  -- 10^10
local IDEM_TTL = 86400          -- 24 часа в секундах

-- Проверяем idempotency key (если передан)
if idempotencyKey and idempotencyKey ~= "" then
  local existing = redis.call('GET', idemKey)
  if existing then
    -- Ключ уже использован — возвращаем сохранённый результат
    -- Формат: code|amount|previousBet|diff|status
    local parts = {}
    for part in string.gmatch(existing, "[^|]+") do
      table.insert(parts, part)
    end
    return {
      tonumber(parts[1]),
      tonumber(parts[2]),
      tonumber(parts[3]),
      tonumber(parts[4]),
      parts[5],
      "IDEMPOTENT"  -- флаг что это повторный запрос
    }
  end
end

-- Получаем текущую ставку из Redis кэша
local oldBet = tonumber(redis.call('HGET', userBetsKey, auctionId)) or 0

-- Проверка: если ставка та же — это идемпотентность по значению
if oldBet == newAmount then
  local result = { 0, oldBet, oldBet, 0, "SAME" }
  -- Сохраняем результат для idempotency key
  if idempotencyKey and idempotencyKey ~= "" then
    local resultStr = "0|" .. oldBet .. "|" .. oldBet .. "|0|SAME"
    redis.call('SETEX', idemKey, IDEM_TTL, resultStr)
  end
  return result
end

-- Считаем diff для этого конкретного аукциона
local diff = newAmount - oldBet

-- Уменьшать ставку нельзя!
if diff < 0 then
  local result = { -2, oldBet, oldBet, 0, "CANNOT_DECREASE" }
  -- НЕ сохраняем для idempotency — это ошибка валидации, можно повторить с другими данными
  return result
end

-- Проверяем хватает ли доступного баланса на добавляемую сумму
-- availableBalance уже учитывает текущую ставку в этом аукционе,
-- поэтому нужно добавить oldBet обратно к доступному балансу
local actualAvailable = availableBalance + oldBet

if actualAvailable < newAmount then
  local result = { -1, 0, oldBet, diff, "INSUFFICIENT_BALANCE" }
  -- НЕ сохраняем для idempotency — баланс может измениться
  return result
end

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

-- Атомарно обновляем Redis кэш (без locked — он теперь в MongoDB)
redis.call('HSET', userBetsKey, auctionId, newAmount)
redis.call('ZADD', auctionBetsKey, score, userId)

-- Сохраняем результат для idempotency key
if idempotencyKey and idempotencyKey ~= "" then
  local resultStr = "1|" .. newAmount .. "|" .. oldBet .. "|" .. diff .. "|OK"
  redis.call('SETEX', idemKey, IDEM_TTL, resultStr)
end

-- Возвращаем: код, новая ставка, старая ставка, diff, статус
return { 1, newAmount, oldBet, diff, "OK" }
