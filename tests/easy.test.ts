/**
 * Easy Test - Симуляция реального сценария аукциона
 */

const BASE_URL = 'http://localhost:3000';

// Типы ответов API
interface BalanceResponse {
  balance: number;
  available: number;
  locked: number;
}

interface UserResponse {
  id: string;
  balance: number;
  gifts: { name: string; count: number }[];
}

interface BetResponse {
  success?: boolean;
  error?: string;
  bet?: number;
}

interface AuctionResponse {
  auction?: {
    id: string;
    state: string;
    currentRound: number;
    winners: { place: number; userId: string; stars: number; prize: number }[];
  };
}

interface CreateAuctionResponse {
  success?: boolean;
  auction?: { id: string };
  error?: string;
}

// Утилиты для API запросов
async function api<T>(method: string, path: string, userId: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json() as Promise<T>;
}

// Хелперы
const getUser = (userId: string) => api<UserResponse>('GET', '/api/data/user', userId);
const getBalance = (userId: string) => api<BalanceResponse>('GET', '/api/data/user/balance', userId);
const mintStars = (userId: string, amount: number) => api<any>('POST', '/test/mint-stars', userId, { amount });
const mintGifts = (userId: string, name: string, count: number) => api<any>('POST', '/test/mint-gifts', userId, { name, count });
const createAuction = (userId: string, data: any) => api<CreateAuctionResponse>('POST', '/api/auction/create', userId, data);
const placeBet = (userId: string, auctionId: string, stars: number) => api<BetResponse>('POST', '/api/bet', userId, { id: auctionId, stars });
const getAuction = (auctionId: string, userId: string) => api<AuctionResponse>('GET', `/api/data/auction/${auctionId}`, userId);

// Логирование
function log(message: string, data?: any) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60) + '\n');
}

// Ожидание
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Главный тест
async function runEasyTest() {
  logSection('EASY TEST - Быстрая симуляция аукциона');

  const ts = Date.now();
  const users = {
    author: `author_${ts}`,
    bidder1: `bidder1_${ts}`,
    bidder2: `bidder2_${ts}`,
    bidder3: `bidder3_${ts}`,
    bidder4: `bidder4_${ts}`,
  };

  log('Пользователи:', Object.values(users));

  // Шаг 1: Выдаём балансы и подарки
  logSection('Шаг 1: Подготовка');

  await Promise.all([
    mintStars(users.author, 1000),
    mintStars(users.bidder1, 500),
    mintStars(users.bidder2, 600),
    mintStars(users.bidder3, 400),
    mintStars(users.bidder4, 300),
    mintGifts(users.author, 'Diamond', 10),
  ]);

  log('Балансы и подарки выданы');

  // Шаг 2: Создаём аукцион
  logSection('Шаг 2: Создание аукциона');

  const createResult = await createAuction(users.author, {
    name: 'Quick Test ' + ts,
    giftName: 'Diamond',
    giftCount: 6,
    startTime: Date.now() + 2000, // Старт через 2 сек
    rounds: [{ duration: 5, prizes: [3, 2, 1] }] // 5 сек раунд
  });

  if (!createResult.auction?.id) {
    log('ОШИБКА:', createResult);
    return;
  }

  const auctionId = createResult.auction.id;
  log(`Аукцион: ${auctionId}`);

  // Шаг 3: Ждём старта
  logSection('Шаг 3: Ожидание старта');
  log('Ждём 3 сек...');
  await sleep(3000);

  const info = await getAuction(auctionId, users.author);
  log('Статус:', info.auction?.state);

  if (info.auction?.state !== 'active') {
    log('ОШИБКА: Аукцион не стартовал!');
    return;
  }

  // Шаг 4: Ставки
  logSection('Шаг 4: Ставки');

  const bets = await Promise.all([
    placeBet(users.bidder1, auctionId, 100),
    placeBet(users.bidder2, auctionId, 150),
    placeBet(users.bidder3, auctionId, 80),
    placeBet(users.bidder4, auctionId, 50),
  ]);

  log('Ставки 1:', bets.map(b => b.success ? 'OK' : b.error));

  await sleep(500);

  // Bidder1 увеличивает
  const bet1up = await placeBet(users.bidder1, auctionId, 200);
  log('Bidder1 -> 200:', bet1up.success ? 'OK' : bet1up.error);

  // Шаг 5: Ждём конца раунда
  logSection('Шаг 5: Ожидание завершения');

  for (let i = 8; i > 0; i--) {
    process.stdout.write(`\r  ${i} сек...  `);
    await sleep(1000);
  }
  console.log('');

  // Шаг 6: Результаты
  logSection('Шаг 6: Результаты');

  let final = await getAuction(auctionId, users.author);

  // Ждём пока аукцион завершится (макс 10 попыток)
  for (let i = 0; i < 10 && final.auction?.state !== 'finished'; i++) {
    log(`Статус: ${final.auction?.state}, ждём ещё...`);
    await sleep(1000);
    final = await getAuction(auctionId, users.author);
  }

  log('Финальный статус:', final.auction?.state);

  if (final.auction?.state !== 'finished') {
    log('ОШИБКА: Аукцион не завершился!');
    return;
  }

  log('Победители:');
  for (const w of final.auction?.winners || []) {
    log(`  #${w.place}: ${w.userId} - ${w.stars} stars -> ${w.prize} Diamond`);
  }

  // Шаг 7: Проверка балансов
  logSection('Шаг 7: Проверка балансов');

  const expected: Record<string, { stars: number; diamonds: number }> = {
    author: { stars: 1000, diamonds: 4 },   // 10 - 6 = 4
    bidder1: { stars: 300, diamonds: 3 },   // 500 - 200 = 300, приз 3
    bidder2: { stars: 450, diamonds: 2 },   // 600 - 150 = 450, приз 2
    bidder3: { stars: 320, diamonds: 1 },   // 400 - 80 = 320, приз 1
    bidder4: { stars: 300, diamonds: 0 },   // проиграл, вернули
  };

  let allOk = true;

  for (const [name, id] of Object.entries(users)) {
    const bal = await getBalance(id);
    const user = await getUser(id);
    const diamonds = user.gifts?.find(g => g.name === 'Diamond')?.count || 0;
    const exp = expected[name];

    const starsOk = bal.available === exp.stars;
    const diaOk = diamonds === exp.diamonds;
    const ok = starsOk && diaOk;
    if (!ok) allOk = false;

    console.log(`${ok ? '✓' : '✗'} ${name}: ${bal.available} stars (${starsOk ? '✓' : '✗'}), ${diamonds} diamonds (${diaOk ? '✓' : '✗'})`);
  }

  // Итог
  logSection('ИТОГ');
  console.log(allOk ? '  ✓ ВСЕ ТЕСТЫ ПРОЙДЕНЫ!\n' : '  ✗ ЕСТЬ ОШИБКИ!\n');
}

runEasyTest().catch(console.error);
