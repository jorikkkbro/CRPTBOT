import { randomUUID } from 'crypto';
import { AuctionModel } from '../models/auction';
import { Auction, AuctionState, CreateAuctionInput } from '../types';
import { deductGifts, getUserGiftCount } from '../models/user';
import { scheduleFirstRound } from './rounds';

// Генерация ID аукциона
function generateAuctionId(): string {
  return `auc_${randomUUID().slice(0, 8)}`;
}

// Получить аукцион по id — O(1) с индексом
export async function getAuction(id: string): Promise<Auction | null> {
  return AuctionModel.findOne({ id });
}

// Проверить что аукцион активен — O(1)
export function isAuctionActive(auction: Auction): boolean {
  return auction.state === 'active';
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
  | { success: true; auction: Auction }
  | { success: false; error: 'INSUFFICIENT_GIFTS'; have: number; need: number }
  | { success: false; error: 'INVALID_INPUT'; message: string };

// Создать аукцион (атомарно списывает подарки)
export async function createAuction(
  authorId: string,
  input: CreateAuctionInput
): Promise<CreateAuctionResult> {
  const { name, giftName, giftCount, startTime, rounds } = input;

  // Валидация
  if (!name || name.length < 1) {
    return { success: false, error: 'INVALID_INPUT', message: 'Name is required' };
  }
  if (giftCount <= 0) {
    return { success: false, error: 'INVALID_INPUT', message: 'Gift count must be positive' };
  }
  if (!rounds || rounds.length === 0) {
    return { success: false, error: 'INVALID_INPUT', message: 'At least one round is required' };
  }

  // Проверяем и списываем подарки атомарно
  const deductResult = await deductGifts(authorId, giftName, giftCount);
  
  if (!deductResult.success) {
    const currentCount = await getUserGiftCount(authorId, giftName);
    return { 
      success: false, 
      error: 'INSUFFICIENT_GIFTS', 
      have: currentCount, 
      need: giftCount 
    };
  }

  // Создаём аукцион
  const auctionId = generateAuctionId();
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

  // Запланировать старт аукциона (первый раунд)
  await scheduleFirstRound(auctionId, startTime);

  return { success: true, auction: auction.toObject() };
}
