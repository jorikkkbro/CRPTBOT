import { randomUUID } from 'crypto';
import { AuctionModel } from '../models/auction';
import { Auction, AuctionState, CreateAuctionInput } from '../types';
import { deductGifts, getUserGiftCount, addGifts } from '../models/user';
import { scheduleFirstRound } from './rounds';
import {
  acquireIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  releaseIdempotencyKey
} from './idempotency';

// Генерация ID аукциона
function generateAuctionId(): string {
  return `auc_${randomUUID().slice(0, 8)}`;
}

// Получить аукцион по id — O(1) с индексом
export async function getAuction(id: string): Promise<Auction | null> {
  return AuctionModel.findOne({ id });
}

// Проверить что аукцион активен — O(1)
// Проверяем state + currentRound >= 0 (во время обработки раунда currentRound = -999)
export function isAuctionActive(auction: Auction): boolean {
  return auction.state === 'active' && auction.currentRound >= 0;
}

// Получить активные аукционы — O(N) где N = активные аукционы
export async function getActiveAuctions(): Promise<Auction[]> {
  return AuctionModel.find({ state: 'active' }).sort({ startTime: -1 });
}

// Получить аукционы юзера — O(N)
export async function getUserAuctions(authorId: string): Promise<Auction[]> {
  return AuctionModel.find({ authorId }).sort({ startTime: -1 });
}

// Изменить состояние аукциона — O(1)
export async function setAuctionState(id: string, state: AuctionState): Promise<boolean> {
  const result = await AuctionModel.updateOne({ id }, { state });
  return result.modifiedCount > 0;
}

// Результат создания аукциона
export type CreateAuctionResult =
  | { success: true; auction: Auction; idempotent?: boolean }
  | { success: false; error: 'INSUFFICIENT_GIFTS'; have: number; need: number }
  | { success: false; error: 'INVALID_INPUT'; message: string }
  | { success: false; error: 'IDEMPOTENCY_CONFLICT'; message: string };

// Создать аукцион (атомарно списывает подарки, идемпотентно по ключу)
export async function createAuction(
  authorId: string,
  input: CreateAuctionInput,
  idempotencyKey?: string
): Promise<CreateAuctionResult> {
  const { name, giftName, giftCount, startTime, rounds } = input;

  // Валидация (до проверки idempotency — эти ошибки можно исправить и повторить)
  if (!name || name.length < 1) {
    return { success: false, error: 'INVALID_INPUT', message: 'Name is required' };
  }
  if (giftCount <= 0) {
    return { success: false, error: 'INVALID_INPUT', message: 'Gift count must be positive' };
  }
  if (!rounds || rounds.length === 0) {
    return { success: false, error: 'INVALID_INPUT', message: 'At least one round is required' };
  }

  // Проверяем idempotency key (если передан)
  if (idempotencyKey) {
    const idemResult = await acquireIdempotencyKey<Auction>(idempotencyKey);

    if (!idemResult.acquired) {
      // Ключ уже использован
      if (idemResult.result.status === 'completed' && idemResult.result.result) {
        // Возвращаем сохранённый результат
        return { success: true, auction: idemResult.result.result, idempotent: true };
      }
      if (idemResult.result.status === 'failed') {
        return {
          success: false,
          error: 'IDEMPOTENCY_CONFLICT',
          message: `Previous request failed: ${idemResult.result.error}`
        };
      }
      // processing — запрос ещё выполняется
      return {
        success: false,
        error: 'IDEMPOTENCY_CONFLICT',
        message: 'Request with this idempotency key is still processing'
      };
    }
  }

  let giftsDeducted = false;
  let auctionCreated = false;
  let auctionId = '';

  try {
    // Проверяем и списываем подарки атомарно
    const deductResult = await deductGifts(authorId, giftName, giftCount);

    if (!deductResult.success) {
      const currentCount = await getUserGiftCount(authorId, giftName);
      const error = {
        success: false as const,
        error: 'INSUFFICIENT_GIFTS' as const,
        have: currentCount,
        need: giftCount
      };

      // Освобождаем idempotency key — это recoverable error
      if (idempotencyKey) {
        await releaseIdempotencyKey(idempotencyKey);
      }

      return error;
    }

    giftsDeducted = true;  // Отмечаем что подарки списаны

    // Создаём аукцион
    auctionId = generateAuctionId();

    const auction = await AuctionModel.create({
      id: auctionId,
      name,
      state: 'pending',
      currentRound: -1,
      gift: { name: giftName, count: giftCount },
      startTime,
      authorId,
      winners: [],
      rounds
    });

    auctionCreated = true;  // Отмечаем что аукцион создан

    // Запланировать старт аукциона (первый раунд)
    await scheduleFirstRound(auctionId, startTime);

    const auctionObj = auction.toObject();

    // Сохраняем успешный результат для idempotency
    if (idempotencyKey) {
      await completeIdempotencyKey(idempotencyKey, auctionObj);
    }

    return { success: true, auction: auctionObj };

  } catch (error) {
    // КРИТИЧНО: откатываем все изменения при ошибке

    // 1. Удаляем созданный аукцион (если был создан)
    if (auctionCreated) {
      try {
        await AuctionModel.deleteOne({ id: auctionId });
        console.log(`Rolled back auction ${auctionId} after failure`);
      } catch (rollbackError) {
        console.error(`CRITICAL: Failed to rollback auction ${auctionId}:`, rollbackError);
      }
    }

    // 2. Возвращаем подарки (если были списаны)
    if (giftsDeducted) {
      try {
        await addGifts(authorId, giftName, giftCount);
        console.log(`Rolled back ${giftCount} ${giftName} to user ${authorId} after auction creation failure`);
      } catch (rollbackError) {
        console.error(`CRITICAL: Failed to rollback gifts for user ${authorId}:`, rollbackError);
      }
    }

    // 3. Освобождаем idempotency key чтобы можно было повторить
    if (idempotencyKey) {
      await releaseIdempotencyKey(idempotencyKey);
    }

    throw error;
  }
}
