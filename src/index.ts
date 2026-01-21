import express from 'express';
import path from 'path';
import { connectMongo } from './db/mongo';
import { connectRedis } from './db/redis';
import { initRoundWorker } from './services/rounds';
import { initPubSub } from './services/pubsub';
import apiRouter from './routes/api';
import dataRouter from './routes/data';
import testRouter from './routes/test';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api', apiRouter);
app.use('/api/data', dataRouter);
app.use('/test', testRouter);

// Инициализация
async function start(): Promise<void> {
  try {
    // Подключаем MongoDB
    await connectMongo();
    console.log('✓ MongoDB connected');

    // Подключаем Redis
    await connectRedis();
    console.log('✓ Redis connected');

    // Запускаем воркер раундов
    await initRoundWorker();

    // Инициализируем Pub/Sub для SSE
    await initPubSub();
    console.log('✓ PubSub initialized');

    // Запускаем сервер
    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
