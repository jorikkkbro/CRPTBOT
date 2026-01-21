-- Атомарное удаление ставки
-- KEYS[1] = user:{userId}:bets (HASH)
-- KEYS[2] = auction:{auctionId}:bets (ZSET)
-- KEYS[3] = locked:{userId}
-- ARGV[1] = auctionId

local userBetsKey = KEYS[1]
local auctionBetsKey = KEYS[2]
local lockedKey = KEYS[3]
local auctionId = ARGV[1]

-- Получаем текущую ставку
local oldBet = tonumber(redis.call('HGET', userBetsKey, auctionId)) or 0

if oldBet == 0 then
  return 0  -- Ставки не было
end

-- Удаляем ставку из HASH
redis.call('HDEL', userBetsKey, auctionId)

-- Получаем userId из ARGV[2] если передан, иначе ищем по auctionBetsKey
local userId = ARGV[2]
if userId then
  redis.call('ZREM', auctionBetsKey, userId)
end

-- Уменьшаем locked баланс
local currentLocked = tonumber(redis.call('GET', lockedKey)) or 0
local newLocked = math.max(0, currentLocked - oldBet)
redis.call('SET', lockedKey, newLocked)

return oldBet
