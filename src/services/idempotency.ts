import { redisClient } from '../db/redis';

// TTL для idempotency keys (24 часа)
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Префикс для ключей
const IDEMPOTENCY_PREFIX = 'idem:';

// Статусы обработки
export type IdempotencyStatus = 'processing' | 'completed' | 'failed';

// Сохранённый результат
export interface IdempotencyResult<T = unknown> {
  status: IdempotencyStatus;
  result?: T;
  error?: string;
  createdAt: number;
}

/**
 * Попытаться захватить idempotency key для обработки
 * Возвращает:
 * - { acquired: true } — ключ свободен, можно обрабатывать
 * - { acquired: false, result: ... } — ключ уже использован, вернуть сохранённый результат
 */
export async function acquireIdempotencyKey<T>(
  key: string
): Promise<{ acquired: true } | { acquired: false; result: IdempotencyResult<T> }> {
  const redisKey = IDEMPOTENCY_PREFIX + key;

  // Атомарно пытаемся установить ключ (NX = только если не существует)
  const lockValue: IdempotencyResult = {
    status: 'processing',
    createdAt: Date.now()
  };

  const acquired = await redisClient.set(
    redisKey,
    JSON.stringify(lockValue),
    { NX: true, EX: IDEMPOTENCY_TTL_SECONDS }
  );

  if (acquired) {
    return { acquired: true };
  }

  // Ключ уже существует — получаем сохранённый результат
  const existing = await redisClient.get(redisKey);
  if (!existing) {
    // Редкий race condition — ключ истёк между проверками
    return { acquired: true };
  }

  const result = JSON.parse(existing) as IdempotencyResult<T>;

  // Если предыдущий запрос ещё обрабатывается — ждём или возвращаем конфликт
  if (result.status === 'processing') {
    // Проверяем не завис ли processing (больше 30 секунд)
    if (Date.now() - result.createdAt > 30000) {
      // Перехватываем застрявший ключ
      await redisClient.del(redisKey);
      return { acquired: true };
    }
  }

  return { acquired: false, result };
}

/**
 * Сохранить результат успешной операции
 */
export async function completeIdempotencyKey<T>(
  key: string,
  result: T
): Promise<void> {
  const redisKey = IDEMPOTENCY_PREFIX + key;

  const value: IdempotencyResult<T> = {
    status: 'completed',
    result,
    createdAt: Date.now()
  };

  await redisClient.set(
    redisKey,
    JSON.stringify(value),
    { EX: IDEMPOTENCY_TTL_SECONDS }
  );
}

/**
 * Сохранить результат неудачной операции
 */
export async function failIdempotencyKey(
  key: string,
  error: string
): Promise<void> {
  const redisKey = IDEMPOTENCY_PREFIX + key;

  const value: IdempotencyResult = {
    status: 'failed',
    error,
    createdAt: Date.now()
  };

  await redisClient.set(
    redisKey,
    JSON.stringify(value),
    { EX: IDEMPOTENCY_TTL_SECONDS }
  );
}

/**
 * Освободить ключ (если операция отменена до завершения)
 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  const redisKey = IDEMPOTENCY_PREFIX + key;
  await redisClient.del(redisKey);
}

/**
 * Проверить существует ли ключ
 */
export async function hasIdempotencyKey(key: string): Promise<boolean> {
  const redisKey = IDEMPOTENCY_PREFIX + key;
  const exists = await redisClient.exists(redisKey);
  return exists === 1;
}

/**
 * Валидация формата idempotency key
 * Должен быть UUID или похожий формат (8-64 символа, alphanumeric + дефисы)
 */
export function isValidIdempotencyKey(key: string | undefined): key is string {
  if (!key || typeof key !== 'string') return false;
  if (key.length < 8 || key.length > 64) return false;
  return /^[a-zA-Z0-9-_]+$/.test(key);
}
