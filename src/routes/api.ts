import { Router, Request, Response } from 'express';
import { getUser } from '../models/user';
import { getAuction, isAuctionActive, createAuction } from '../services/auction';
import { makeBet, getTopBets } from '../services/bets';
import { extendRound } from '../services/rounds';
import { notifyAuctionUpdate } from '../services/pubsub';
import { createBetTransaction, getLockedBalanceFromDB } from '../models/transaction';
import { CreateAuctionInput } from '../types';
import { betRateLimit, createAuctionRateLimit } from '../middleware/rateLimit';
import { withUserLock } from '../services/userLock';

// Anti-snipe константы
const ANTI_SNIPE_THRESHOLD_SECONDS = 10;  // Если осталось <= 10 секунд
const ANTI_SNIPE_EXTEND_SECONDS = 5;      // Продлить на 5 секунд

const router = Router();

// Валидация idempotency key
function isValidIdempotencyKey(key: string | undefined): key is string {
  if (!key || typeof key !== 'string') return false;
  if (key.length < 8 || key.length > 64) return false;
  return /^[a-zA-Z0-9-_]+$/.test(key);
}

// POST /api/bet
// Body: { id: string, stars: number }
// Headers: x-user-id, x-idempotency-key (обязательный)
router.post('/bet', betRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const idempotencyKey = req.headers['x-idempotency-key'] as string;
    const { id: auctionId, stars } = req.body;

    // Валидация idempotency key (ОБЯЗАТЕЛЬНЫЙ)
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key header is required (8-64 alphanumeric chars)'
      });
    }

    // Валидация входных данных
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    if (!auctionId || typeof auctionId !== 'string') {
      return res.status(400).json({ error: 'INVALID_AUCTION_ID' });
    }

    if (typeof stars !== 'number' || stars <= 0 || !Number.isInteger(stars)) {
      return res.status(400).json({ error: 'INVALID_STARS_AMOUNT' });
    }

    // Проверяем что аукцион существует и активен
    const auction = await getAuction(auctionId);
    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    if (!isAuctionActive(auction)) {
      return res.status(400).json({ error: 'AUCTION_NOT_ACTIVE' });
    }

    // Нельзя ставить на свой аукцион
    if (auction.authorId === userId) {
      return res.status(400).json({ error: 'CANNOT_BET_OWN_AUCTION' });
    }

    // === КРИТИЧЕСКАЯ СЕКЦИЯ: используем distributed lock ===
    // Это предотвращает race condition при конкурентных ставках
    const lockResult = await withUserLock(userId, async () => {
      // Получаем юзера и вычисляем доступный баланс ПОД ЛОКОМ
      const [user, lockedBalance] = await Promise.all([
        getUser(userId),
        getLockedBalanceFromDB(userId)
      ]);
      const availableBalance = user.balance - lockedBalance;

      // Атомарная и идемпотентная ставка (с idempotency key)
      const betResult = await makeBet(userId, auctionId, stars, availableBalance, idempotencyKey);

      // Записываем транзакцию в БД (ВСЕГДА при успехе, даже при idempotent)
      // createBetTransaction использует upsert — безопасно вызывать повторно
      // Это гарантирует recovery если сервер упал между Redis и MongoDB
      if (betResult.success) {
        await createBetTransaction(
          idempotencyKey,  // используется как odId для идемпотентности
          userId,
          auctionId,
          auction.currentRound,
          betResult.amount,
          betResult.previousBet,
          betResult.diff
        );
      }

      return betResult;
    });

    // Не удалось захватить лок (слишком много конкурентных запросов)
    if (!lockResult.success) {
      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: 'Please retry your request'
      });
    }

    const result = lockResult.result;

    if (!result.success) {
      const messages: Record<string, string> = {
        'INSUFFICIENT_BALANCE': `Not enough balance. Need ${result.diff} more stars`,
        'CANNOT_DECREASE': `Cannot decrease bet. Current bet: ${result.previousBet}`
      };

      return res.status(400).json({
        error: result.status,
        message: messages[result.status] || 'Unknown error',
        currentBet: result.previousBet
      });
    }

    // Anti-snipe проверка
    let extended = false;
    if (auction.roundEndTime && auction.currentRound >= 0) {
      const remainingMs = auction.roundEndTime - Date.now();
      const remainingSeconds = remainingMs / 1000;

      // Если осталось <= 10 секунд
      if (remainingSeconds > 0 && remainingSeconds <= ANTI_SNIPE_THRESHOLD_SECONDS) {
        // Получаем количество призовых мест в текущем раунде
        const currentRound = auction.rounds[auction.currentRound];
        const winnersCount = currentRound?.prizes?.length || 0;

        if (winnersCount > 0) {
          // Получаем топ ставок
          const topBets = await getTopBets(auctionId, winnersCount);

          // Проверяем, попала ли новая ставка в топ (выигрышную позицию)
          const isInWinningPosition = topBets.some(bet => bet.userId === userId);

          if (isInWinningPosition) {
            // Продлеваем раунд
            extended = await extendRound(auctionId, auction.currentRound, ANTI_SNIPE_EXTEND_SECONDS);
          }
        }
      }
    }

    // Уведомляем подписчиков о новой ставке (мгновенное обновление)
    notifyAuctionUpdate(auctionId).catch(console.error);

    return res.json({
      success: true,
      status: result.status,
      idempotent: result.idempotent,  // флаг повторного запроса
      auctionId,
      bet: result.amount,           // текущая ставка
      previousBet: result.previousBet, // была до этого
      charged: result.diff,          // сколько списали с баланса
      extended                       // было ли продление раунда
    });

  } catch (error) {
    console.error('Bet error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// POST /api/auction/create
// Body: { name, giftName, giftCount, startTime, rounds }
// Headers: x-user-id, x-idempotency-key (обязательный)
router.post('/auction/create', createAuctionRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const idempotencyKey = req.headers['x-idempotency-key'] as string;
    const { name, giftName, giftCount, startTime, rounds } = req.body;

    // Валидация idempotency key (ОБЯЗАТЕЛЬНЫЙ)
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key header is required (8-64 alphanumeric chars)'
      });
    }

    // Валидация userId
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    // Валидация входных данных
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'INVALID_NAME' });
    }

    if (!giftName || typeof giftName !== 'string') {
      return res.status(400).json({ error: 'INVALID_GIFT_NAME' });
    }

    if (typeof giftCount !== 'number' || giftCount <= 0 || !Number.isInteger(giftCount)) {
      return res.status(400).json({ error: 'INVALID_GIFT_COUNT' });
    }

    if (typeof startTime !== 'number' || startTime <= 0) {
      return res.status(400).json({ error: 'INVALID_START_TIME' });
    }

    if (!Array.isArray(rounds) || rounds.length === 0) {
      return res.status(400).json({ error: 'INVALID_ROUNDS' });
    }

    // Валидация раундов
    for (const round of rounds) {
      if (typeof round.duration !== 'number' || round.duration <= 0) {
        return res.status(400).json({ error: 'INVALID_ROUND_DURATION' });
      }
    }

    const input: CreateAuctionInput = {
      name,
      giftName,
      giftCount,
      startTime,
      rounds
    };

    const result = await createAuction(userId, input, idempotencyKey);

    if (!result.success) {
      if (result.error === 'INSUFFICIENT_GIFTS') {
        return res.status(400).json({
          error: result.error,
          message: `Not enough gifts. Have: ${result.have}, need: ${result.need}`,
          have: result.have,
          need: result.need
        });
      }
      if (result.error === 'IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({
          error: result.error,
          message: result.message
        });
      }
      return res.status(400).json({
        error: result.error,
        message: result.message
      });
    }

    return res.json({
      success: true,
      idempotent: result.idempotent || false,  // флаг повторного запроса
      auction: {
        id: result.auction.id,
        name: result.auction.name,
        state: result.auction.state,
        gift: result.auction.gift,
        startTime: result.auction.startTime,
        rounds: result.auction.rounds
      }
    });

  } catch (error) {
    console.error('Create auction error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;
