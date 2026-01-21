import { redisClient } from '../db/redis';
import { LuaScripts } from '../lua';

// Ключи Redis (только кэш, locked теперь в MongoDB)
const userBetsKey = (userId: string) => `user:${userId}:bets`;         // HASH: auctionId → amount
const auctionBetsKey = (auctionId: string) => `auction:${auctionId}:bets`; // ZSET: score = amount*10^10 + (MAX_TS - timestamp_seconds)
const idempotencyKey = (key: string) => `idem:${key}`;                 // STRING: результат операции

// Константы для составного score (должны совпадать с Lua)
const MULTIPLIER = 10_000_000_000;

// Извлечь amount из составного score
const scoreToAmount = (score: number): number => Math.floor(score / MULTIPLIER);

export type BetStatus = 'OK' | 'SAME' | 'INSUFFICIENT_BALANCE' | 'CANNOT_DECREASE';

export type MakeBetResult = {
  success: boolean;
  amount: number;      // новая ставка
  previousBet: number; // старая ставка
  diff: number;        // сколько добавили к locked
  status: BetStatus;
  idempotent: boolean; // true если это повторный запрос с тем же ключом
};

// Атомарная и идемпотентная ставка
// availableBalance = user.balance - locked (вычисляется в API из MongoDB)
export async function makeBet(
  userId: string,
  auctionId: string,
  amount: number,
  availableBalance: number,  // уже доступный баланс (balance - locked)
  idempotencyKeyValue?: string
): Promise<MakeBetResult> {
  const timestamp = Date.now();
  const idemKey = idempotencyKeyValue || '';

  const result = await redisClient.eval(LuaScripts.makeBet, {
    keys: [
      userBetsKey(userId),
      auctionBetsKey(auctionId),
      idemKey ? idempotencyKey(idemKey) : 'idem:_none_'  // пустой ключ если не передан
    ],
    arguments: [
      auctionId,
      userId,
      amount.toString(),
      availableBalance.toString(),  // передаём уже вычисленный доступный баланс
      timestamp.toString(),
      idemKey
    ]
  }) as [number, number, number, number, string, string?];

  const [code, finalAmount, previousBet, diff, status, idempotentFlag] = result;

  return {
    success: code >= 0,
    amount: finalAmount,
    previousBet,
    diff,
    status: status as MakeBetResult['status'],
    idempotent: idempotentFlag === 'IDEMPOTENT'
  };
}

// Получить ставку юзера в аукционе из Redis кэша — O(1)
export async function getBet(userId: string, auctionId: string): Promise<number> {
  const value = await redisClient.hGet(userBetsKey(userId), auctionId);
  return value ? parseInt(value, 10) : 0;
}

// Удалить ставку юзера из аукциона (только Redis кэш) — O(log N)
export async function deleteBet(userId: string, auctionId: string): Promise<number> {
  const result = await redisClient.eval(LuaScripts.deleteBet, {
    keys: [userBetsKey(userId), auctionBetsKey(auctionId)],
    arguments: [auctionId, userId]
  }) as number;

  return result;
}

// Получить все ставки юзера из Redis кэша — O(N) где N = аукционы юзера
export async function getUserBets(userId: string): Promise<Map<string, number>> {
  const hash = await redisClient.hGetAll(userBetsKey(userId));
  const bets = new Map<string, number>();

  for (const [auctionId, value] of Object.entries(hash)) {
    bets.set(auctionId, parseInt(String(value), 10));
  }

  return bets;
}

// Тип для ставки
export type AuctionBet = { userId: string; amount: number };

// Получить топ ставок в аукционе (сортировка по убыванию) — O(log N + M)
export async function getTopBets(auctionId: string, limit = 10): Promise<AuctionBet[]> {
  const result = await redisClient.zRangeWithScores(
    auctionBetsKey(auctionId),
    0, limit - 1,
    { REV: true }  // от большего к меньшему
  );

  return result.map((item: { value: string; score: number }) => ({
    userId: item.value,
    amount: scoreToAmount(item.score)
  }));
}

// Получить все ставки в аукционе отсортированные — O(N)
export async function getAuctionBets(auctionId: string): Promise<AuctionBet[]> {
  const result = await redisClient.zRangeWithScores(
    auctionBetsKey(auctionId),
    0, -1,
    { REV: true }  // от большего к меньшему
  );

  return result.map((item: { value: string; score: number }) => ({
    userId: item.value,
    amount: scoreToAmount(item.score)
  }));
}

// Получить позицию юзера в аукционе (ранг) — O(log N)
export async function getUserRank(userId: string, auctionId: string): Promise<number | null> {
  const rank = await redisClient.zRevRank(auctionBetsKey(auctionId), userId);
  return rank !== null ? rank + 1 : null;  // 1-based
}

// Количество участников в аукционе — O(1)
export async function getAuctionBetsCount(auctionId: string): Promise<number> {
  return redisClient.zCard(auctionBetsKey(auctionId));
}

// Очистить все ставки аукциона из Redis кэша (после завершения) — O(N)
// Locked баланс обновляется через транзакции в MongoDB
export async function clearAuctionBets(auctionId: string): Promise<void> {
  const bets = await getAuctionBets(auctionId);

  const multi = redisClient.multi();
  for (const { userId } of bets) {
    multi.hDel(userBetsKey(userId), auctionId);
  }
  multi.del(auctionBetsKey(auctionId));

  await multi.exec();
}
