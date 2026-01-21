import { redisClient } from '../db/redis';

// Distributed lock для операций с балансом юзера
// Предотвращает race conditions при конкурентных операциях

const LOCK_PREFIX = 'lock:user:';
const DEFAULT_LOCK_TTL_MS = 5000;  // 5 секунд максимум
const RETRY_DELAY_MS = 20;  // базовая задержка (+ jitter до 20ms = 20-40ms)
const MAX_RETRIES = 500;   // 500 * ~30ms = ~15 секунд максимум ожидания

export interface LockResult {
  acquired: boolean;
  lockId: string;
}

// Генерация уникального ID лока (для безопасного release)
function generateLockId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Попытка захватить лок
export async function acquireUserLock(
  userId: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<LockResult> {
  const lockKey = `${LOCK_PREFIX}${userId}`;
  const lockId = generateLockId();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // SET NX с TTL — атомарная операция
    const result = await redisClient.set(lockKey, lockId, {
      NX: true,  // только если не существует
      PX: ttlMs  // TTL в миллисекундах
    });

    if (result === 'OK') {
      return { acquired: true, lockId };
    }

    // Лок занят — ждём с jitter (случайная задержка для избежания thundering herd)
    const jitter = Math.random() * RETRY_DELAY_MS;
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS + jitter));
  }

  // Не удалось захватить лок
  return { acquired: false, lockId: '' };
}

// Освободить лок (только если мы его владелец)
export async function releaseUserLock(userId: string, lockId: string): Promise<boolean> {
  const lockKey = `${LOCK_PREFIX}${userId}`;

  // Lua скрипт для атомарной проверки и удаления
  // Удаляем только если lockId совпадает (мы владелец)
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;

  const result = await redisClient.eval(script, {
    keys: [lockKey],
    arguments: [lockId]
  }) as number;

  return result === 1;
}

// Хелпер: выполнить операцию под локом
export async function withUserLock<T>(
  userId: string,
  operation: () => Promise<T>,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<{ success: true; result: T } | { success: false; error: 'LOCK_FAILED' }> {
  const lock = await acquireUserLock(userId, ttlMs);

  if (!lock.acquired) {
    console.warn(`Failed to acquire lock for user ${userId}`);
    return { success: false, error: 'LOCK_FAILED' };
  }

  try {
    const result = await operation();
    return { success: true, result };
  } finally {
    // Всегда освобождаем лок
    await releaseUserLock(userId, lock.lockId);
  }
}
