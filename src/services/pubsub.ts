import { createClient, RedisClientType } from 'redis';
import { Auction } from '../types';
import { getActiveAuctions, getAuction } from './auction';
import { getTopBets, getAuctionBetsCount, AuctionBet } from './bets';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Отдельные клиенты для pub и sub (Redis требует)
let pubClient: RedisClientType;
let subClient: RedisClientType;

// Каналы
const AUCTIONS_CHANNEL = 'auctions:updates';
const auctionChannel = (id: string) => `auction:${id}:updates`;

// Кэш ключи
const AUCTIONS_CACHE_KEY = 'cache:auctions:active';
const auctionCacheKey = (id: string) => `cache:auction:${id}`;
const auctionBetsCacheKey = (id: string) => `cache:auction:${id}:bets`;

// Интервалы обновления (мс)
const AUCTIONS_UPDATE_INTERVAL = 1000;
const AUCTION_UPDATE_INTERVAL = 500;

// Типы данных
export interface AuctionsUpdate {
  auctions: Auction[];
  timestamp: number;
}

export interface AuctionUpdate {
  auction: Auction;
  bets: AuctionBet[];
  participantsCount: number;
  timestamp: number;
}

// Подписчики SSE
type SSECallback = (data: string) => void;
const auctionsSubscribers = new Set<SSECallback>();
const auctionSubscribers = new Map<string, Set<SSECallback>>();

// Инициализация Pub/Sub
export async function initPubSub(): Promise<void> {
  pubClient = createClient({ url: REDIS_URL });
  subClient = pubClient.duplicate();

  await Promise.all([pubClient.connect(), subClient.connect()]);

  // Подписка на общий канал аукционов
  await subClient.subscribe(AUCTIONS_CHANNEL, (message) => {
    auctionsSubscribers.forEach(callback => {
      try {
        callback(message);
      } catch (e) {
        console.error('SSE callback error:', e);
      }
    });
  });

  // Запускаем обновление кэша аукционов
  startAuctionsUpdater();

  console.log('PubSub initialized');
}

// Централизованное обновление списка аукционов
let auctionsUpdaterRunning = false;

function startAuctionsUpdater(): void {
  if (auctionsUpdaterRunning) return;
  auctionsUpdaterRunning = true;

  setInterval(async () => {
    try {
      const auctions = await getActiveAuctions();
      const update: AuctionsUpdate = {
        auctions,
        timestamp: Date.now()
      };

      const message = JSON.stringify(update);

      // Кэшируем и публикуем
      await pubClient.set(AUCTIONS_CACHE_KEY, message, { EX: 5 });
      await pubClient.publish(AUCTIONS_CHANNEL, message);
    } catch (error) {
      console.error('Auctions updater error:', error);
    }
  }, AUCTIONS_UPDATE_INTERVAL);
}

// Подписка на обновления списка аукционов (для SSE)
export function subscribeToAuctions(callback: SSECallback): () => void {
  auctionsSubscribers.add(callback);

  // Сразу отправляем из кэша
  pubClient.get(AUCTIONS_CACHE_KEY).then(cached => {
    if (cached) {
      callback(cached);
    }
  });

  // Возвращаем функцию отписки
  return () => {
    auctionsSubscribers.delete(callback);
  };
}

// Активные аукционы с обновлениями
const activeAuctionUpdaters = new Map<string, NodeJS.Timeout>();

// Запустить обновление конкретного аукциона
function startAuctionUpdater(auctionId: string): void {
  if (activeAuctionUpdaters.has(auctionId)) return;

  const update = async () => {
    try {
      const auction = await getAuction(auctionId);
      if (!auction) {
        stopAuctionUpdater(auctionId);
        return;
      }

      const [bets, participantsCount] = await Promise.all([
        getTopBets(auctionId, 50),
        getAuctionBetsCount(auctionId)
      ]);

      const data: AuctionUpdate = {
        auction,
        bets,
        participantsCount,
        timestamp: Date.now()
      };

      const message = JSON.stringify(data);
      const channel = auctionChannel(auctionId);

      // Кэшируем и публикуем
      await pubClient.set(auctionCacheKey(auctionId), message, { EX: 5 });
      await pubClient.publish(channel, message);

      // Если аукцион завершён — останавливаем обновление
      if (auction.state === 'finished' || auction.state === 'cancelled') {
        // Даём время клиентам получить финальное обновление
        setTimeout(() => stopAuctionUpdater(auctionId), 5000);
      }
    } catch (error) {
      console.error(`Auction ${auctionId} updater error:`, error);
    }
  };

  // Первое обновление сразу
  update();

  // Затем по интервалу
  const interval = setInterval(update, AUCTION_UPDATE_INTERVAL);
  activeAuctionUpdaters.set(auctionId, interval);
}

function stopAuctionUpdater(auctionId: string): void {
  const interval = activeAuctionUpdaters.get(auctionId);
  if (interval) {
    clearInterval(interval);
    activeAuctionUpdaters.delete(auctionId);
  }
}

// Подписка на обновления конкретного аукциона
export async function subscribeToAuction(auctionId: string, callback: SSECallback): Promise<() => void> {
  const channel = auctionChannel(auctionId);

  // Создаём set подписчиков если его нет
  if (!auctionSubscribers.has(auctionId)) {
    auctionSubscribers.set(auctionId, new Set());

    // Подписываемся на канал
    await subClient.subscribe(channel, (message) => {
      const subscribers = auctionSubscribers.get(auctionId);
      subscribers?.forEach(cb => {
        try {
          cb(message);
        } catch (e) {
          console.error('SSE callback error:', e);
        }
      });
    });

    // Запускаем обновление
    startAuctionUpdater(auctionId);
  }

  auctionSubscribers.get(auctionId)!.add(callback);

  // Сразу отправляем из кэша
  const cached = await pubClient.get(auctionCacheKey(auctionId));
  if (cached) {
    callback(cached);
  }

  // Возвращаем функцию отписки
  return () => {
    const subscribers = auctionSubscribers.get(auctionId);
    if (subscribers) {
      subscribers.delete(callback);

      // Если подписчиков не осталось — отписываемся от канала
      if (subscribers.size === 0) {
        auctionSubscribers.delete(auctionId);
        subClient.unsubscribe(channel);
        stopAuctionUpdater(auctionId);
      }
    }
  };
}

// Принудительно обновить данные аукциона (после ставки)
export async function notifyAuctionUpdate(auctionId: string): Promise<void> {
  // Запускаем updater если его нет
  if (!activeAuctionUpdaters.has(auctionId)) {
    startAuctionUpdater(auctionId);
  }
}

// Graceful shutdown
export async function closePubSub(): Promise<void> {
  activeAuctionUpdaters.forEach((interval) => clearInterval(interval));
  activeAuctionUpdaters.clear();

  await subClient?.quit();
  await pubClient?.quit();
}
