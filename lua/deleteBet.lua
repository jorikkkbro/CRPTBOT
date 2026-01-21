-- Атомарное удаление ставки из Redis кэша
-- Locked баланс теперь в MongoDB, не в Redis
-- KEYS[1] = user:{userId}:bets (HASH)
-- KEYS[2] = auction:{auctionId}:bets (ZSET)
-- ARGV[1] = auctionId
-- ARGV[2] = userId

local userBetsKey = KEYS[1]
local auctionBetsKey = KEYS[2]
local auctionId = ARGV[1]
local userId = ARGV[2]

-- Получаем текущую ставку
local oldBet = tonumber(redis.call('HGET', userBetsKey, auctionId)) or 0

if oldBet == 0 then
  return 0  -- Ставки не было
end

-- Удаляем ставку из HASH
redis.call('HDEL', userBetsKey, auctionId)

-- Удаляем из ZSET
if userId then
  redis.call('ZREM', auctionBetsKey, userId)
end

return oldBet
