import { Queue, Worker, Job } from 'bullmq';
import { AuctionModel } from '../models/auction';
import { addGifts, deductBalance } from '../models/user';
import { getTopBets, deleteBet, clearAuctionBets } from './bets';
import { Auction, AuctionWinner } from '../types';

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

    // Получаем оставшееся время
    const delayUntil = job.opts.delay ? job.timestamp + job.opts.delay : 0;
    const remaining = delayUntil - Date.now();

    if (remaining <= 0) {
      console.log(`Job ${jobId} already expired, cannot extend`);
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
  const updateResult = await AuctionModel.findOneAndUpdate(
    { 
      id: auctionId, 
      state: 'active',
      currentRound: roundIndex  // только если ещё не обработан
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
      const totalPrize = round.prizes.reduce((sum, p) => sum + p, 0);
      await addGifts(auction.authorId, auction.gift.name, totalPrize);

      newWinners.push({
        roundIndex,
        place: 1,
        userId: auction.authorId,
        stars: 0,
        prize: totalPrize
      });

      console.log(`No bets in round ${roundIndex}. Returning ${totalPrize} ${auction.gift.name} to author ${auction.authorId}`);
    } else {
      // ПАРАЛЛЕЛЬНАЯ обработка победителей для скорости
      // Каждый победитель - разный юзер, поэтому безопасно
      const winnerResults = await Promise.all(topBets.map(async (bet, place) => {
        const prizeAmount = round.prizes[place];

        // Все операции для одного победителя параллельно
        // Безопасно т.к. каждая операция работает только с данными ЭТОГО юзера
        await Promise.all([
          deleteBet(bet.userId, auctionId),           // Redis: удаляет ставку ЭТОГО юзера
          deductBalance(bet.userId, bet.amount),      // MongoDB: списывает у ЭТОГО юзера
          addGifts(bet.userId, auction.gift.name, prizeAmount) // MongoDB: даёт приз ЭТОМУ юзеру
        ]);

        console.log(`Winner place ${place + 1}: ${bet.userId} gets ${prizeAmount} ${auction.gift.name}, paid ${bet.amount} stars`);

        // Возвращаем данные победителя (не push в общий массив!)
        return {
          roundIndex,
          place: place + 1,
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
        const unclaimedTotal = unclaimedPrizes.reduce((sum, p) => sum + p, 0);

        if (unclaimedTotal > 0) {
          await addGifts(auction.authorId, auction.gift.name, unclaimedTotal);
          console.log(`Returning ${unclaimedTotal} unclaimed ${auction.gift.name} to author ${auction.authorId}`);
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

  // Финальное обновление
  await AuctionModel.updateOne(
    { id: auctionId },
    {
      $push: { winners: { $each: newWinners } },
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
    // Очистить оставшиеся ставки проигравших и снять locked баланс
    await clearAuctionBets(auctionId);
    console.log(`Auction ${auctionId} finished! Cleared remaining bets.`);
  }
}

// Обработать начало аукциона (первый раунд)
async function processRoundStart(auctionId: string, roundIndex: number): Promise<void> {
  const auction = await AuctionModel.findOne({ id: auctionId });
  if (!auction) {
    console.error(`Auction ${auctionId} not found`);
    return;
  }

  if (auction.state !== 'pending') {
    console.log(`Auction ${auctionId} is not pending, skipping start`);
    return;
  }

  const round = auction.rounds[roundIndex];
  if (!round) {
    console.error(`Round ${roundIndex} not found`);
    return;
  }

  const roundEndTime = Date.now() + round.duration * 1000;

  // Активируем аукцион
  await AuctionModel.updateOne(
    { id: auctionId },
    { state: 'active', currentRound: roundIndex, roundEndTime }
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
