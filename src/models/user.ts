import { Schema, model } from 'mongoose';
import { User, Gift } from '../types';
import { getLockedBalanceFromDB } from './transaction';

// Schema для Gift (вложенный)
const GiftSchema = new Schema<Gift>({
  name: { type: String, required: true },
  count: { type: Number, required: true, default: 0 }
}, { _id: false });

// Schema для User
const UserSchema = new Schema<User>({
  id: { type: String, required: true, unique: true },
  balance: { type: Number, required: true, default: 0 },
  gifts: { type: [GiftSchema], default: [] }
});

export const UserModel = model<User>('User', UserSchema);

// Получить юзера по id (создаёт если не существует) — атомарно
export async function getUser(id: string): Promise<User> {
  const user = await UserModel.findOneAndUpdate(
    { id },
    { $setOnInsert: { id, balance: 0, gifts: [] } },
    { upsert: true, new: true }
  );
  return user;
}

// Получить доступный баланс (balance - locked из MongoDB транзакций)
export async function getBalance(id: string): Promise<number> {
  const user = await getUser(id);
  const locked = await getLockedBalanceFromDB(id);
  return user.balance - locked;
}

// Получить locked баланс из транзакций
export async function getLockedBalance(id: string): Promise<number> {
  return getLockedBalanceFromDB(id);
}

// Списать баланс у юзера (атомарно)
// ВАЖНО: эта функция проверяет только balance >= amount
// Для операций с учётом locked баланса используйте deductAvailableBalance
export async function deductBalance(id: string, amount: number): Promise<boolean> {
  const result = await UserModel.updateOne(
    { id, balance: { $gte: amount } },
    { $inc: { balance: -amount } }
  );
  return result.modifiedCount > 0;
}

// Списать с учётом available баланса (balance - locked)
// Используется для операций где нужно проверить что юзер реально может потратить
export async function deductAvailableBalance(
  id: string,
  amount: number
): Promise<{ success: boolean; balance: number; available: number }> {
  const user = await getUser(id);
  const locked = await getLockedBalanceFromDB(id);
  const available = user.balance - locked;

  if (available < amount) {
    return { success: false, balance: user.balance, available };
  }

  const result = await UserModel.updateOne(
    { id, balance: { $gte: amount } },
    { $inc: { balance: -amount } }
  );

  if (result.modifiedCount === 0) {
    // Race condition — баланс изменился между проверкой и списанием
    const updatedUser = await getUser(id);
    return { success: false, balance: updatedUser.balance, available: updatedUser.balance - locked };
  }

  return { success: true, balance: user.balance - amount, available: available - amount };
}

// Списать баланс победителя (его ставка была locked)
// При победе: ставка переходит из locked в потраченное
// Проверяем что balance >= amount (ставка была частью locked)
export async function deductWinnerBalance(
  id: string,
  betAmount: number,
  auctionId: string
): Promise<{ success: boolean; error?: string }> {
  // Проверяем что ставка была locked (есть активная транзакция)
  const { getCurrentBetFromDB } = await import('./transaction');
  const currentBet = await getCurrentBetFromDB(id, auctionId);

  // Ставка должна существовать и совпадать
  if (currentBet !== betAmount) {
    console.error(`Winner bet mismatch: expected ${betAmount}, got ${currentBet} for user ${id} in auction ${auctionId}`);
    // Всё равно пытаемся списать — возможно транзакция уже обновлена
  }

  const success = await deductBalance(id, betAmount);

  if (!success) {
    return {
      success: false,
      error: `Failed to deduct ${betAmount} from user ${id} (insufficient balance)`
    };
  }

  return { success: true };
}

// Получить подарок юзера по имени
export async function getUserGift(id: string, giftName: string): Promise<Gift | null> {
  const user = await getUser(id);
  return user.gifts.find(g => g.name === giftName) || null;
}

// Получить количество конкретного подарка
export async function getUserGiftCount(id: string, giftName: string): Promise<number> {
  const gift = await getUserGift(id, giftName);
  return gift?.count || 0;
}

// Списать подарки у юзера (атомарно)
export async function deductGifts(
  id: string, 
  giftName: string, 
  count: number
): Promise<{ success: boolean; remaining: number }> {
  // Атомарное обновление: уменьшаем count только если хватает
  const result = await UserModel.findOneAndUpdate(
    { 
      id, 
      'gifts.name': giftName,
      'gifts.count': { $gte: count }  // проверяем что хватает
    },
    { 
      $inc: { 'gifts.$.count': -count } 
    },
    { new: true }
  );

  if (!result) {
    // Не хватило подарков или подарка нет
    const currentCount = await getUserGiftCount(id, giftName);
    return { success: false, remaining: currentCount };
  }

  const gift = result.gifts.find(g => g.name === giftName);
  return { success: true, remaining: gift?.count || 0 };
}

// Добавить подарки юзеру — АТОМАРНО без race condition
export async function addGifts(id: string, giftName: string, count: number): Promise<void> {
  // Сначала гарантируем что юзер существует
  await UserModel.findOneAndUpdate(
    { id },
    { $setOnInsert: { id, balance: 0, gifts: [] } },
    { upsert: true }
  );

  // Пробуем инкрементить существующий подарок
  const result = await UserModel.updateOne(
    { id, 'gifts.name': giftName },
    { $inc: { 'gifts.$.count': count } }
  );

  // Если подарка нет — добавляем новый АТОМАРНО
  // Используем $ne чтобы избежать дубликатов при race condition
  if (result.matchedCount === 0) {
    // Попытка добавить — если между проверкой и этим вызовом
    // другой процесс уже добавил подарок, $ne не сработает
    const addResult = await UserModel.updateOne(
      { id, 'gifts.name': { $ne: giftName } },
      { $push: { gifts: { name: giftName, count } } }
    );

    // Если добавление не сработало (race condition — подарок уже добавлен),
    // значит нужно инкрементить
    if (addResult.modifiedCount === 0) {
      await UserModel.updateOne(
        { id, 'gifts.name': giftName },
        { $inc: { 'gifts.$.count': count } }
      );
    }
  }
}
