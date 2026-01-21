import { Queue, Worker, Job } from 'bullmq';
import { AuctionModel } from '../models/auction';
import { addGifts, deductWinnerBalance } from '../models/user';
import { getTopBets, deleteBet, clearAuctionBets, getAuctionBets } from './bets';
import {
  createWinTransaction,
  updateUserAuctionTransactionsStatus,
  isWinnerAlreadyProcessed
} from '../models/transaction';
import { Auction, AuctionWinner } from '../types';
import { withUserLock } from './userLock';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Парсим Redis URL для connection options
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined
  };
}

const connection = parseRedisUrl(REDIS_URL);

// Очередь для обработки раундов
export const roundQueue = new Queue('auction-rounds', { connection });

// Типы заданий
interface RoundJobData {
  auctionId: string;
  roundIndex: number;
}

// Запланировать первый раунд (при старте аукциона)
export async function scheduleFirstRound(auctionId: string, startTime: number): Promise<void> {
  const delay = Math.max(0, startTime - Date.now());
  
  await roundQueue.add(
    'start-round',
    { auctionId, roundIndex: 0 },
    { 
      delay,
      jobId: `${auctionId}-round-0`,
      removeOnComplete: true
    }
  );
  
  console.log(`Scheduled first round for auction ${auctionId} in ${delay}ms`);
}

// Запланировать следующий раунд
async function scheduleNextRound(auctionId: string, roundIndex: number, durationSeconds: number): Promise<void> {
  const delay = durationSeconds * 1000;
  
  await roundQueue.add(
    'end-round',
    { auctionId, roundIndex },
    { 
      delay,
      jobId: `${auctionId}-round-${roundIndex}-end`,
      removeOnComplete: true
    }
  );
  
  console.log(`Scheduled end of round ${roundIndex} for auction ${auctionId} in ${delay}ms`);
}

// Максимум продлений anti-snipe за раунд
const MAX_ANTI_SNIPE_EXTENSIONS = 5;

// Счётчик продлений (в памяти, сбрасывается при рестарте — ОК для нашего случая)
const antiSnipeCount = new Map<string, number>();

// Anti-snipe порог (должен совпадать с api.ts)
const ANTI_SNIPE_THRESHOLD_MS = 10 * 1000;  // 10 секунд

// Anti-snipe: продлить раунд на указанное количество секунд
export async function extendRound(auctionId: string, roundIndex: number, extendSeconds: number): Promise<boolean> {
  const jobId = `${auctionId}-round-${roundIndex}-end`;
  const countKey = `${auctionId}-${roundIndex}`;

  // Проверяем лимит продлений
  const currentCount = antiSnipeCount.get(countKey) || 0;
  if (currentCount >= MAX_ANTI_SNIPE_EXTENSIONS) {
    console.log(`Anti-snipe limit reached for ${auctionId} round ${roundIndex} (${currentCount}/${MAX_ANTI_SNIPE_EXTENSIONS})`);
    return false;
  }

  try {
    // Получаем текущий job
    const job = await roundQueue.getJob(jobId);
    if (!job) {
      console.log(`Job ${jobId} not found, cannot extend`);
      return false;
    }

    // Получаем РЕАЛЬНОЕ оставшееся время из job (не из кэша auction)
    const delayUntil = job.opts.delay ? job.timestamp + job.opts.delay : 0;
    const remaining = delayUntil - Date.now();

    if (remaining <= 0) {
      console.log(`Job ${jobId} already expired, cannot extend`);
      return false;
    }

    // ВАЖНО: проверяем что мы ВСЁ ЕЩЁ в пределах порога
    // Это предотвращает множественные продления от конкурентных запросов
    if (remaining > ANTI_SNIPE_THRESHOLD_MS) {
      console.log(`Anti-snipe: ${auctionId} round ${roundIndex} already extended beyond threshold (${Math.ceil(remaining / 1000)}s > 10s), skipping`);
      return false;
    }

    // Новое время = оставшееся + продление
    const newDelay = remaining + extendSeconds * 1000;
    const newEndTime = Date.now() + newDelay;

    // Удаляем старый job и создаём новый
    await job.remove();

    await roundQueue.add(
      'end-round',
      { auctionId, roundIndex },
      {
        delay: newDelay,
        jobId,
        removeOnComplete: true
      }
    );

    // Обновляем roundEndTime в базе
    await AuctionModel.updateOne(
      { id: auctionId },
      { roundEndTime: newEndTime }
    );

    // Увеличиваем счётчик
    antiSnipeCount.set(countKey, currentCount + 1);

    console.log(`Anti-snipe: Extended round ${roundIndex} of auction ${auctionId} by ${extendSeconds}s (${currentCount + 1}/${MAX_ANTI_SNIPE_EXTENSIONS}, new remaining: ${Math.ceil(newDelay / 1000)}s)`);
    return true;
  } catch (error) {
    console.error(`Failed to extend round: ${error}`);
    return false;
  }
}

// Обработать завершение раунда (ИДЕМПОТЕНТНО)
async function processRoundEnd(auctionId: string, roundIndex: number): Promise<void> {
  // Атомарная проверка + обновление currentRound чтобы избежать двойной обработки
  // Также проверяем -999 (застрявшая обработка) — продолжаем её
  const updateResult = await AuctionModel.findOneAndUpdate(
    {
      id: auctionId,
      state: 'active',
      $or: [
        { currentRound: roundIndex },  // ещё не начали обработку
        { currentRound: -999 }         // застряла предыдущая обработка
      ]
    },
    {
      $set: { currentRound: -999 }  // временная блокировка
    },
    { new: false }  // вернуть старый документ
  );

  if (!updateResult) {
    console.log(`Round ${roundIndex} for auction ${auctionId} already processed or auction not active`);
    return;
  }

  // Если currentRound был -999, значит это recovery — логируем
  if (updateResult.currentRound === -999) {
    console.log(`Recovering stuck round processing for auction ${auctionId}, round ${roundIndex}`);
  }

  const auction = updateResult;
  const round = auction.rounds[roundIndex];
  
  if (!round) {
    console.error(`Round ${roundIndex} not found in auction ${auctionId}`);
    // Откатываем блокировку
    await AuctionModel.updateOne({ id: auctionId }, { currentRound: roundIndex });
    return;
  }

  const winnersCount = round.prizes.length;
  const topBets = await getTopBets(auctionId, winnersCount);

  console.log(`Round ${roundIndex} ended. Top ${winnersCount} bets:`, topBets);

  const newWinners: AuctionWinner[] = [];

  try {
    // Если нет ставок — возвращаем призы создателю аукциона
    if (topBets.length === 0) {
      const totalPrize = round.prizes.reduce((sum: number, p: number) => sum + p, 0);

      // ИДЕМПОТЕНТНОСТЬ: проверяем, был ли уже возврат автору
      const authorAlreadyProcessed = await isWinnerAlreadyProcessed(auction.authorId, auctionId, roundIndex);

      if (!authorAlreadyProcessed) {
        // Создаём транзакцию возврата (флаг обработки)
        await createWinTransaction(auction.authorId, auctionId, roundIndex, 0, 0, totalPrize);
        await addGifts(auction.authorId, auction.gift.name, totalPrize);
        console.log(`No bets in round ${roundIndex}. Returning ${totalPrize} ${auction.gift.name} to author ${auction.authorId}`);
      } else {
        console.log(`No bets return to author ${auction.authorId} already processed, skipping`);
      }

      newWinners.push({
        roundIndex,
        place: 0,  // place 0 = возврат автору (не победитель)
        userId: auction.authorId,
        stars: 0,
        prize: totalPrize
      });
    } else {
      // ИДЕМПОТЕНТНАЯ обработка победителей с distributed lock
      // Лок предотвращает race condition с конкурентными ставками
      const winnerResults = await Promise.all(topBets.map(async (bet, placeIndex) => {
        const place = placeIndex + 1;  // 1-based
        const prizeAmount = round.prizes[placeIndex];

        // Используем distributed lock для каждого победителя
        const lockResult = await withUserLock(bet.userId, async () => {
          // ИДЕМПОТЕНТНОСТЬ: проверяем, был ли победитель уже обработан
          const alreadyProcessed = await isWinnerAlreadyProcessed(bet.userId, auctionId, roundIndex);

          if (alreadyProcessed) {
            console.log(`Winner place ${place}: ${bet.userId} already processed, skipping`);
            return { alreadyProcessed: true };
          }

          // Сначала создаём win транзакцию (это наш "флаг" обработки)
          // Если она уже есть — upsert ничего не сделает
          await createWinTransaction(bet.userId, auctionId, roundIndex, place, bet.amount, prizeAmount);

          // Теперь выполняем операции ПОД ЛОКОМ
          // Это предотвращает конкурентные ставки во время списания баланса

          // 1. Сначала списываем баланс победителя (с проверкой)
          const deductResult = await deductWinnerBalance(bet.userId, bet.amount, auctionId);
          if (!deductResult.success) {
            console.error(`Failed to deduct winner balance: ${deductResult.error}`);
            // Продолжаем — возможно баланс уже был списан при retry
          }

          // 2. Остальные операции параллельно
          await Promise.all([
            deleteBet(bet.userId, auctionId),           // Redis: удаляет ставку (идемпотентно)
            addGifts(bet.userId, auction.gift.name, prizeAmount), // MongoDB: даёт приз
            // Обновляем статус ставок юзера на 'won'
            updateUserAuctionTransactionsStatus(bet.userId, auctionId, 'won')
          ]);

          console.log(`Winner place ${place}: ${bet.userId} gets ${prizeAmount} ${auction.gift.name}, paid ${bet.amount} stars`);
          return { alreadyProcessed: false };
        });

        if (!lockResult.success) {
          console.error(`Failed to acquire lock for winner ${bet.userId}, will retry on next job`);
          throw new Error(`Lock failed for winner ${bet.userId}`);
        }

        return {
          roundIndex,
          place,
          userId: bet.userId,
          stars: bet.amount,
          prize: prizeAmount
        };
      }));

      // Добавляем всех победителей в правильном порядке
      newWinners.push(...winnerResults);

      // Возвращаем невыданные призы автору (если ставок меньше чем призовых мест)
      if (topBets.length < winnersCount) {
        const unclaimedPrizes = round.prizes.slice(topBets.length);
        const unclaimedTotal = unclaimedPrizes.reduce((sum: number, p: number) => sum + p, 0);

        if (unclaimedTotal > 0) {
          // ИДЕМПОТЕНТНОСТЬ: используем специальный place = -1 для unclaimed
          // Проверяем по транзакции с odId = auctionId:authorId:win:roundIndex:place-1
          const unclaimedKey = `${auctionId}:${auction.authorId}:unclaimed:${roundIndex}`;
          const { Transaction } = await import('../models/transaction');
          const alreadyReturned = await Transaction.findOne({ odId: unclaimedKey });

          if (!alreadyReturned) {
            // Создаём транзакцию unclaimed (флаг обработки)
            await Transaction.findOneAndUpdate(
              { odId: unclaimedKey },
              {
                $setOnInsert: {
                  odId: unclaimedKey,
                  odType: 'refund',
                  odStatus: 'refunded',
                  odCreatedAt: new Date(),
                  odUserId: auction.authorId,
                  odAuctionId: auctionId,
                  odRoundIndex: roundIndex,
                  odAmount: 0,
                  odPreviousAmount: 0,
                  odDiff: unclaimedTotal
                }
              },
              { upsert: true }
            );

            await addGifts(auction.authorId, auction.gift.name, unclaimedTotal);
            console.log(`Returning ${unclaimedTotal} unclaimed ${auction.gift.name} to author ${auction.authorId}`);
          } else {
            console.log(`Unclaimed prizes for round ${roundIndex} already returned to author`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error processing winners for round ${roundIndex}:`, error);
    // Не откатываем — лучше потерять немного чем дублировать
  }

  const isLastRound = roundIndex >= auction.rounds.length - 1;
  const nextRound = !isLastRound ? auction.rounds[roundIndex + 1] : null;
  const nextRoundEndTime = nextRound ? Date.now() + nextRound.duration * 1000 : undefined;

  // ИДЕМПОТЕНТНОЕ финальное обновление
  // Проверяем, есть ли уже winners для этого раунда (избегаем дубликатов)
  const currentAuction = await AuctionModel.findOne({ id: auctionId });
  const existingWinnersForRound = currentAuction?.winners.filter(w => w.roundIndex === roundIndex) || [];

  // Добавляем только если ещё нет winners для этого раунда
  const winnersToAdd = existingWinnersForRound.length === 0 ? newWinners : [];

  await AuctionModel.updateOne(
    { id: auctionId },
    {
      ...(winnersToAdd.length > 0 && { $push: { winners: { $each: winnersToAdd } } }),
      $set: {
        currentRound: isLastRound ? roundIndex : roundIndex + 1,
        state: isLastRound ? 'finished' : 'active',
        roundEndTime: nextRoundEndTime
      }
    }
  );

  // Если не последний раунд — запланировать следующий
  if (!isLastRound && nextRound) {
    await scheduleNextRound(auctionId, roundIndex + 1, nextRound.duration);
    console.log(`Starting round ${roundIndex + 1} for auction ${auctionId}`);
  } else {
    // Получаем проигравших до очистки
    const losingBets = await getAuctionBets(auctionId);

    // Обновляем статус транзакций проигравших на 'lost'
    await Promise.all(
      losingBets.map(bet =>
        updateUserAuctionTransactionsStatus(bet.userId, auctionId, 'lost')
          .catch(err => console.error('Failed to update loser transaction status:', err))
      )
    );

    // Очистить оставшиеся ставки проигравших и снять locked баланс
    await clearAuctionBets(auctionId);
    console.log(`Auction ${auctionId} finished! Cleared remaining bets. Updated ${losingBets.length} losers.`);
  }
}

// Обработать начало аукциона (первый раунд) — ИДЕМПОТЕНТНО
async function processRoundStart(auctionId: string, roundIndex: number): Promise<void> {
  // АТОМАРНАЯ проверка + обновление — избегаем race condition
  const auction = await AuctionModel.findOneAndUpdate(
    {
      id: auctionId,
      state: 'pending'  // только если ещё pending
    },
    {
      $set: { state: 'active', currentRound: roundIndex }
      // roundEndTime установим после, когда узнаем duration
    },
    { new: false }  // вернуть старый документ чтобы получить rounds
  );

  if (!auction) {
    // Либо не найден, либо уже не pending (уже запущен)
    const existing = await AuctionModel.findOne({ id: auctionId });
    if (!existing) {
      console.error(`Auction ${auctionId} not found`);
    } else {
      console.log(`Auction ${auctionId} is not pending (state: ${existing.state}), skipping start`);
    }
    return;
  }

  const round = auction.rounds[roundIndex];
  if (!round) {
    console.error(`Round ${roundIndex} not found in auction ${auctionId}`);
    // Откатываем состояние
    await AuctionModel.updateOne({ id: auctionId }, { state: 'pending', currentRound: -1 });
    return;
  }

  const roundEndTime = Date.now() + round.duration * 1000;

  // Обновляем roundEndTime
  await AuctionModel.updateOne(
    { id: auctionId },
    { roundEndTime }
  );

  console.log(`Auction ${auctionId} started! Round ${roundIndex} begins (${round.duration}s)`);

  // Запланировать окончание раунда
  await scheduleNextRound(auctionId, roundIndex, round.duration);
}

// Воркер для обработки заданий (с concurrency для высокой нагрузки)
export const roundWorker = new Worker<RoundJobData>(
  'auction-rounds',
  async (job: Job<RoundJobData>) => {
    const { auctionId, roundIndex } = job.data;

    console.log(`Processing job ${job.name} for auction ${auctionId}, round ${roundIndex}`);

    try {
      if (job.name === 'start-round') {
        await processRoundStart(auctionId, roundIndex);
      } else if (job.name === 'end-round') {
        await processRoundEnd(auctionId, roundIndex);
      }
    } catch (error) {
      console.error(`Job ${job.name} for ${auctionId} failed:`, error);
      throw error; // Re-throw для retry
    }
  },
  {
    connection,
    concurrency: 50,  // Обрабатываем до 50 jobs параллельно
  }
);

// Обработчики событий воркера
roundWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

roundWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

// Инициализация (вызвать при старте сервера)
export async function initRoundWorker(): Promise<void> {
  // Очищаем старые/застрявшие jobs
  try {
    const waiting = await roundQueue.getWaiting();
    const delayed = await roundQueue.getDelayed();
    const active = await roundQueue.getActive();

    console.log(`Queue status: ${waiting.length} waiting, ${delayed.length} delayed, ${active.length} active`);

    // Очищаем старые delayed jobs (старше 5 минут)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const job of delayed) {
      if (job.timestamp < fiveMinutesAgo) {
        await job.remove();
        console.log(`Removed stale job: ${job.id}`);
      }
    }
  } catch (error) {
    console.error('Failed to clean queue:', error);
  }

  console.log('✓ Round worker initialized');
}
