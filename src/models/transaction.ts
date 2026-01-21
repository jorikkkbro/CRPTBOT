import mongoose, { Schema, Document } from 'mongoose';

// Типы транзакций
export type TransactionType = 'bet' | 'bet_increase' | 'refund' | 'win';

// Статусы транзакций
export type TransactionStatus = 'active' | 'won' | 'lost' | 'refunded';

// Интерфейс транзакции
export interface ITransaction {
  odId: string;           // уникальный ID операции (odId = operation ID, auctionId:odId:odType)
  odType: TransactionType;
  odStatus: TransactionStatus;
  odCreatedAt: Date;
  odUserId: string;
  odAuctionId: string;
  odRoundIndex: number;   // номер раунда (-1 если до начала)
  odAmount: number;       // сумма ставки
  odPreviousAmount: number; // предыдущая ставка (для bet_increase)
  odDiff: number;         // разница (сколько списали/вернули)
}

export interface TransactionDocument extends ITransaction, Document {}

const transactionSchema = new Schema<TransactionDocument>({
  odId: { type: String, required: true, unique: true },
  odType: {
    type: String,
    required: true,
    enum: ['bet', 'bet_increase', 'refund', 'win']
  },
  odStatus: {
    type: String,
    required: true,
    enum: ['active', 'won', 'lost', 'refunded'],
    default: 'active'
  },
  odCreatedAt: { type: Date, required: true, default: Date.now },
  odUserId: { type: String, required: true },
  odAuctionId: { type: String, required: true },
  odRoundIndex: { type: Number, required: true, default: -1 },
  odAmount: { type: Number, required: true },
  odPreviousAmount: { type: Number, required: true, default: 0 },
  odDiff: { type: Number, required: true }
}, {
  timestamps: false  // мы сами управляем odCreatedAt
});

// Индексы для быстрых запросов
transactionSchema.index({ odUserId: 1, odCreatedAt: -1 });  // история юзера
transactionSchema.index({ odAuctionId: 1, odCreatedAt: -1 });  // история аукциона
transactionSchema.index({ odAuctionId: 1, odUserId: 1 });  // ставки юзера в аукционе
transactionSchema.index({ odStatus: 1 });  // фильтр по статусу
transactionSchema.index({ odUserId: 1, odStatus: 1, odType: 1 });  // для подсчёта locked баланса

export const Transaction = mongoose.model<TransactionDocument>('Transaction', transactionSchema);

// Создать транзакцию ставки (идемпотентно по odId)
export async function createBetTransaction(
  idempotencyKey: string,  // используется как odId для идемпотентности
  userId: string,
  auctionId: string,
  roundIndex: number,
  amount: number,
  previousAmount: number,
  diff: number
): Promise<TransactionDocument> {
  const isIncrease = previousAmount > 0;

  // Используем upsert для идемпотентности — если транзакция уже есть, ничего не делаем
  const transaction = await Transaction.findOneAndUpdate(
    { odId: idempotencyKey },
    {
      $setOnInsert: {
        odId: idempotencyKey,
        odType: isIncrease ? 'bet_increase' : 'bet',
        odStatus: 'active',
        odCreatedAt: new Date(),
        odUserId: userId,
        odAuctionId: auctionId,
        odRoundIndex: roundIndex,
        odAmount: amount,
        odPreviousAmount: previousAmount,
        odDiff: diff
      }
    },
    { upsert: true, new: true }
  );

  return transaction;
}

// Создать транзакцию возврата (ИДЕМПОТЕНТНО по odId)
export async function createRefundTransaction(
  userId: string,
  auctionId: string,
  roundIndex: number,
  amount: number
): Promise<TransactionDocument> {
  // Детерминированный odId — один refund на юзера/аукцион/раунд
  const odId = `${auctionId}:${userId}:refund:${roundIndex}`;

  // Используем upsert для идемпотентности
  const transaction = await Transaction.findOneAndUpdate(
    { odId },
    {
      $setOnInsert: {
        odId,
        odType: 'refund',
        odStatus: 'refunded',
        odCreatedAt: new Date(),
        odUserId: userId,
        odAuctionId: auctionId,
        odRoundIndex: roundIndex,
        odAmount: 0,
        odPreviousAmount: amount,
        odDiff: -amount  // отрицательный diff = возврат
      }
    },
    { upsert: true, new: true }
  );

  return transaction;
}

// Создать транзакцию выигрыша (ИДЕМПОТЕНТНО по odId)
export async function createWinTransaction(
  userId: string,
  auctionId: string,
  roundIndex: number,
  place: number,  // добавляем place для уникальности
  betAmount: number,
  prizeCount: number
): Promise<TransactionDocument> {
  // Детерминированный odId — один win на юзера/аукцион/раунд/место
  const odId = `${auctionId}:${userId}:win:${roundIndex}:place${place}`;

  // Используем upsert для идемпотентности
  const transaction = await Transaction.findOneAndUpdate(
    { odId },
    {
      $setOnInsert: {
        odId,
        odType: 'win',
        odStatus: 'won',
        odCreatedAt: new Date(),
        odUserId: userId,
        odAuctionId: auctionId,
        odRoundIndex: roundIndex,
        odAmount: betAmount,
        odPreviousAmount: 0,
        odDiff: prizeCount  // для win diff = количество призов
      }
    },
    { upsert: true, new: true }
  );

  return transaction;
}

// Проверить, был ли юзер уже обработан как победитель в раунде
export async function isWinnerAlreadyProcessed(
  userId: string,
  auctionId: string,
  roundIndex: number
): Promise<boolean> {
  const existing = await Transaction.findOne({
    odUserId: userId,
    odAuctionId: auctionId,
    odRoundIndex: roundIndex,
    odType: 'win'
  });
  return !!existing;
}

// Обновить статус транзакций юзера в аукционе
export async function updateUserAuctionTransactionsStatus(
  userId: string,
  auctionId: string,
  newStatus: TransactionStatus
): Promise<void> {
  await Transaction.updateMany(
    {
      odUserId: userId,
      odAuctionId: auctionId,
      odStatus: 'active'  // только активные
    },
    { $set: { odStatus: newStatus } }
  );
}

// Получить историю транзакций юзера
export async function getUserTransactions(
  userId: string,
  limit = 50,
  offset = 0
): Promise<TransactionDocument[]> {
  return Transaction.find({ odUserId: userId })
    .sort({ odCreatedAt: -1 })
    .skip(offset)
    .limit(limit)
    .exec();
}

// Получить транзакции аукциона
export async function getAuctionTransactions(
  auctionId: string,
  limit = 100
): Promise<TransactionDocument[]> {
  return Transaction.find({ odAuctionId: auctionId })
    .sort({ odCreatedAt: -1 })
    .limit(limit)
    .exec();
}

// Получить locked баланс юзера (сумма активных ставок из БД)
export async function getLockedBalanceFromDB(userId: string): Promise<number> {
  const result = await Transaction.aggregate([
    {
      $match: {
        odUserId: userId,
        odStatus: 'active',
        odType: { $in: ['bet', 'bet_increase'] }
      }
    },
    {
      // ВАЖНО: сортируем перед группировкой для корректного $last
      $sort: { odAuctionId: 1, odCreatedAt: 1 }
    },
    {
      $group: {
        _id: '$odAuctionId',  // группируем по аукциону
        lastAmount: { $last: '$odAmount' }  // берём последнюю ставку (актуальную)
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$lastAmount' }  // суммируем по всем аукционам
      }
    }
  ]);

  return result.length > 0 ? result[0].total : 0;
}

// Получить текущую активную ставку юзера в аукционе из БД
export async function getCurrentBetFromDB(
  userId: string,
  auctionId: string
): Promise<number> {
  const lastBet = await Transaction.findOne({
    odUserId: userId,
    odAuctionId: auctionId,
    odStatus: 'active',
    odType: { $in: ['bet', 'bet_increase'] }
  })
    .sort({ odCreatedAt: -1 })
    .select('odAmount')
    .exec();

  return lastBet ? lastBet.odAmount : 0;
}
