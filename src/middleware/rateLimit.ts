import { Request, Response, NextFunction } from 'express';
import { redisClient } from '../db/redis';

interface RateLimitOptions {
  windowMs: number;      // окно в миллисекундах
  maxRequests: number;   // максимум запросов в окне
  keyPrefix?: string;
}

// Rate limiter через Redis
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyPrefix = 'rl' } = options;
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return next(); // без userId — пропускаем (auth middleware обработает)
    }

    const key = `${keyPrefix}:${userId}`;

    try {
      const current = await redisClient.incr(key);
      
      if (current === 1) {
        // Первый запрос — устанавливаем TTL
        await redisClient.expire(key, windowSeconds);
      }

      // Добавляем headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - current));

      if (current > maxRequests) {
        const ttl = await redisClient.ttl(key);
        res.setHeader('Retry-After', ttl);
        return res.status(429).json({ 
          error: 'TOO_MANY_REQUESTS',
          retryAfter: ttl
        });
      }

      next();
    } catch (error) {
      console.error('Rate limit error:', error);
      next(); // При ошибке — пропускаем (лучше чем блокировать)
    }
  };
}

// Готовые пресеты
export const betRateLimit = rateLimit({
  windowMs: 1000,      // 1 секунда
  maxRequests: 5,      // 5 ставок в секунду
  keyPrefix: 'rl:bet'
});

export const createAuctionRateLimit = rateLimit({
  windowMs: 60000,     // 1 минута
  maxRequests: 3,      // 3 аукциона в минуту
  keyPrefix: 'rl:auction'
});

export const dataRateLimit = rateLimit({
  windowMs: 1000,      // 1 секунда
  maxRequests: 20,     // 20 запросов в секунду
  keyPrefix: 'rl:data'
});
