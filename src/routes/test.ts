import { Router, Request, Response } from 'express';
import { UserModel, getUser, addGifts } from '../models/user';

const router = Router();

// POST /test/mint-gifts — выдать себе подарки
router.post('/mint-gifts', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(400).json({ error: 'Missing x-user-id header' });
    }

    const { name, count } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid gift name' });
    }

    const amount = parseInt(count, 10) || 100;

    await addGifts(userId, name, amount);
    const user = await getUser(userId);
    const gift = user.gifts.find(g => g.name === name);

    res.json({
      success: true,
      gift: { name, count: gift?.count || amount },
      message: `Minted ${amount} ${name} gifts`
    });
  } catch (error) {
    console.error('Mint gifts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /test/mint-stars — выдать себе звёзды (баланс)
router.post('/mint-stars', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(400).json({ error: 'Missing x-user-id header' });
    }

    const { amount } = req.body;
    const stars = parseInt(amount, 10) || 1000;

    // Атомарный upsert — создаёт юзера если не существует
    const result = await UserModel.findOneAndUpdate(
      { id: userId },
      {
        $inc: { balance: stars },
        $setOnInsert: { id: userId, gifts: [] }
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      balance: result?.balance || 0,
      message: `Minted ${stars} stars`
    });
  } catch (error) {
    console.error('Mint stars error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /test/reset — сбросить юзера (для тестов)
router.post('/reset', async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(400).json({ error: 'Missing x-user-id header' });
    }

    await UserModel.findOneAndUpdate(
      { id: userId },
      { $set: { balance: 0, gifts: [] } },
      { upsert: true }
    );

    res.json({
      success: true,
      message: `User ${userId} reset`
    });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
