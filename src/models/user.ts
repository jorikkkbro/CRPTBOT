import { Schema, model } from 'mongoose';
import { User, Gift } from '../types';
import { getLockedBalance } from '../services/bets';

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

// Получить доступный баланс (balance - locked из Redis)
export async function getBalance(id: string): Promise<number> {
  const user = await getUser(id);
  const locked = await getLockedBalance(id);
  return user.balance - locked;
}

// Списать баланс у юзера (атомарно) — используется при победе в аукционе
export async function deductBalance(id: string, amount: number): Promise<boolean> {
  const result = await UserModel.updateOne(
    { id, balance: { $gte: amount } },
    { $inc: { balance: -amount } }
  );
  return result.modifiedCount > 0;
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

// Добавить подарки юзеру — атомарно с upsert
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

  // Если подарка нет — добавляем новый
  if (result.matchedCount === 0) {
    await UserModel.updateOne(
      { id, 'gifts.name': { $ne: giftName } },
      { $push: { gifts: { name: giftName, count } } }
    );
  }
}
