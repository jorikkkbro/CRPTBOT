import { Router, Request, Response } from 'express';
import { getUser, getBalance, getUserGiftCount } from '../models/user';
import { getAuction, getActiveAuctions, getUserAuctions } from '../services/auction';
import {
  getBet,
  getUserBets,
  getTopBets,
  getAuctionBets,
  getUserRank,
  getAuctionBetsCount,
  getLockedBalance
} from '../services/bets';
import { subscribeToAuctions, subscribeToAuction } from '../services/pubsub';
import { dataRateLimit } from '../middleware/rateLimit';

const router = Router();

// Rate limit для всех data endpoints
router.use(dataRateLimit);

// ============== USER DATA ==============

// GET /api/data/user
// Получить данные юзера (баланс, подарки, locked)
router.get('/user', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const user = await getUser(userId);
    const availableBalance = await getBalance(userId);
    const lockedBalance = await getLockedBalance(userId);

    return res.json({
      id: user.id,
      balance: user.balance,
      availableBalance,
      lockedBalance,
      gifts: user.gifts
    });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/user/balance
// Получить баланс юзера
router.get('/user/balance', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const user = await getUser(userId);
    const availableBalance = await getBalance(userId);
    const lockedBalance = await getLockedBalance(userId);

    return res.json({
      balance: user.balance,
      available: availableBalance,
      locked: lockedBalance
    });
  } catch (error) {
    console.error('Get balance error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/user/gifts
// Получить подарки юзера
router.get('/user/gifts', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const user = await getUser(userId);
    return res.json({ gifts: user.gifts });
  } catch (error) {
    console.error('Get gifts error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/user/gift/:name
// Получить количество конкретного подарка
router.get('/user/gift/:name', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const { name } = req.params;
    const count = await getUserGiftCount(userId, name);

    return res.json({ name, count });
  } catch (error) {
    console.error('Get gift error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/user/bets
// Получить все ставки юзера
router.get('/user/bets', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const betsMap = await getUserBets(userId);
    const bets = Array.from(betsMap.entries()).map(([auctionId, amount]) => ({
      auctionId,
      amount
    }));

    return res.json({ bets });
  } catch (error) {
    console.error('Get user bets error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/user/auctions
// Получить аукционы созданные юзером
router.get('/user/auctions', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const auctions = await getUserAuctions(userId);
    return res.json({ auctions });
  } catch (error) {
    console.error('Get user auctions error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ============== AUCTIONS ==============

// GET /api/data/auctions
// Получить активные аукционы
router.get('/auctions', async (req: Request, res: Response) => {
  try {
    const auctions = await getActiveAuctions();
    return res.json({ auctions });
  } catch (error) {
    console.error('Get auctions error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/auctions/sse
// SSE для обновления аукционов в реальном времени (через Pub/Sub)
router.get('/auctions/sse', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Подписываемся через Pub/Sub
  const unsubscribe = subscribeToAuctions((message) => {
    try {
      res.write(`data: ${message}\n\n`);
    } catch (e) {
      // Клиент отключился
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// GET /api/data/auction/:id/sse
// SSE для конкретного аукциона (через Pub/Sub)
router.get('/auction/:id/sse', async (req: Request, res: Response) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Подписываемся через Pub/Sub
  const unsubscribe = await subscribeToAuction(id, (message) => {
    try {
      res.write(`data: ${message}\n\n`);
    } catch (e) {
      // Клиент отключился
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// GET /api/data/auction/:id
// Получить аукцион по ID
router.get('/auction/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auction = await getAuction(id);

    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    const participantsCount = await getAuctionBetsCount(id);

    return res.json({
      auction,
      participantsCount
    });
  } catch (error) {
    console.error('Get auction error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/auction/:id/bets
// Получить все ставки в аукционе (отсортированные)
router.get('/auction/:id/bets', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;

    const auction = await getAuction(id);
    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    const bets = await getTopBets(id, limit);
    const totalCount = await getAuctionBetsCount(id);

    return res.json({
      auctionId: id,
      bets,
      totalCount,
      limit
    });
  } catch (error) {
    console.error('Get auction bets error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/auction/:id/top
// Получить топ ставок в аукционе
router.get('/auction/:id/top', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 10;

    const auction = await getAuction(id);
    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    const top = await getTopBets(id, limit);

    return res.json({
      auctionId: id,
      top
    });
  } catch (error) {
    console.error('Get top bets error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/auction/:id/my
// Получить мою ставку и позицию в аукционе
router.get('/auction/:id/my', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'USER_NOT_PROVIDED' });
    }

    const { id } = req.params;

    const auction = await getAuction(id);
    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    const myBet = await getBet(userId, id);
    const myRank = await getUserRank(userId, id);
    const totalParticipants = await getAuctionBetsCount(id);

    return res.json({
      auctionId: id,
      bet: myBet,
      rank: myRank,
      totalParticipants
    });
  } catch (error) {
    console.error('Get my auction data error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/data/auction/:id/winners
// Получить победителей аукциона
router.get('/auction/:id/winners', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const auction = await getAuction(id);
    if (!auction) {
      return res.status(404).json({ error: 'AUCTION_NOT_FOUND' });
    }

    return res.json({
      auctionId: id,
      state: auction.state,
      currentRound: auction.currentRound,
      totalRounds: auction.rounds.length,
      winners: auction.winners
    });
  } catch (error) {
    console.error('Get winners error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;
