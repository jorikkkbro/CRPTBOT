/**
 * Middle Test - Продвинутые тесты
 *
 * Проверки:
 * 1. Много пользователей (20+)
 * 2. Параллельные ставки (атомарность)
 * 3. Повторные ставки (идемпотентность)
 * 4. Увеличение ставок
 * 5. Попытка уменьшить ставку (должна быть ошибка)
 * 6. Ставка без баланса (должна быть ошибка)
 * 7. Ставка на свой аукцион (должна быть ошибка)
 * 8. Несколько раундов
 * 9. Anti-snipe проверка
 */

const BASE_URL = 'http://localhost:3000';

// Типы
interface BalanceResponse { balance: number; available: number; locked: number; }
interface UserResponse { id: string; balance: number; gifts: { name: string; count: number }[]; }
interface BetResponse { success?: boolean; error?: string; bet?: number; status?: string; extended?: boolean; }
interface AuctionResponse { auction?: { id: string; state: string; currentRound: number; roundEndTime?: number; winners: { roundIndex: number; place: number; userId: string; stars: number; prize: number }[]; rounds: { duration: number; prizes: number[] }[]; }; }
interface CreateAuctionResponse { success?: boolean; auction?: { id: string }; error?: string; }

// API
async function api<T>(method: string, path: string, userId: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json() as Promise<T>;
}

const getUser = (userId: string) => api<UserResponse>('GET', '/api/data/user', userId);
const getBalance = (userId: string) => api<BalanceResponse>('GET', '/api/data/user/balance', userId);
const mintStars = (userId: string, amount: number) => api<any>('POST', '/test/mint-stars', userId, { amount });
const mintGifts = (userId: string, name: string, count: number) => api<any>('POST', '/test/mint-gifts', userId, { name, count });
const createAuction = (userId: string, data: any) => api<CreateAuctionResponse>('POST', '/api/auction/create', userId, data);
const placeBet = (userId: string, auctionId: string, stars: number) => api<BetResponse>('POST', '/api/bet', userId, { id: auctionId, stars });
const getAuction = (auctionId: string, userId: string) => api<AuctionResponse>('GET', `/api/data/auction/${auctionId}`, userId);

// Utils
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (msg: string, data?: any) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  if (data) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const section = (t: string) => {
  console.log('');
  console.log('='.repeat(60));
  console.log(`  ${t}`);
  console.log('='.repeat(60));
  console.log('');
};

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}` + (details ? ` - ${details}` : ''));
    failed++;
  }
}

async function waitForState(auctionId: string, userId: string, state: string, maxWait = 15): Promise<AuctionResponse> {
  let res = await getAuction(auctionId, userId);
  for (let i = 0; i < maxWait && res.auction?.state !== state; i++) {
    await sleep(1000);
    res = await getAuction(auctionId, userId);
  }
  return res;
}

// ============================================
// ТЕСТЫ
// ============================================

async function testAtomicity(auctionId: string, users: string[]) {
  section('ТЕСТ 1: Атомарность параллельных ставок');
  await sleep(100);

  // 20 пользователей одновременно ставят
  log(`Параллельные ставки от ${users.length} пользователей...`);

  const bets = await Promise.all(
    users.map((u, i) => placeBet(u, auctionId, 100 + i * 10))
  );

  const successful = bets.filter(b => b.success).length;
  const errors = bets.filter(b => !b.success);

  check('Все параллельные ставки прошли', successful === users.length,
    `${successful}/${users.length}, ошибки: ${errors.map(e => e.error).join(', ')}`);

  await sleep(100);
}

async function testIdempotency(auctionId: string, userId: string) {
  section('ТЕСТ 2: Идемпотентность повторных ставок');
  await sleep(100);

  // Ставим 150
  const bet1 = await placeBet(userId, auctionId, 150);
  check('Первая ставка 150', bet1.success === true);

  // Повторяем ту же ставку
  const bet2 = await placeBet(userId, auctionId, 150);
  check('Повторная ставка 150 - статус SAME', bet2.status === 'SAME');

  // Баланс не должен измениться
  const bal = await getBalance(userId);
  check('Locked не увеличился повторно', bal.locked === 150, `locked=${bal.locked}`);
}

async function testIncreaseBet(auctionId: string, userId: string) {
  section('ТЕСТ 3: Увеличение ставки');

  const balBefore = await getBalance(userId);

  // Увеличиваем до 200
  const bet = await placeBet(userId, auctionId, 200);
  check('Увеличение до 200', bet.success === true && bet.bet === 200);

  const balAfter = await getBalance(userId);
  const diff = balBefore.available - balAfter.available;
  check('Списалась только разница (50)', diff === 50, `diff=${diff}`);
}

async function testDecreaseBet(auctionId: string, userId: string) {
  section('ТЕСТ 4: Попытка уменьшить ставку');

  // Пробуем уменьшить до 100 (текущая 200)
  const bet = await placeBet(userId, auctionId, 100);
  log('Ответ API:', bet);
  check('Уменьшение запрещено', !bet.success && bet.error === 'CANNOT_DECREASE',
    `success=${bet.success}, error=${bet.error}, status=${bet.status}`);
}

async function testInsufficientBalance(auctionId: string, userId: string) {
  section('ТЕСТ 5: Ставка без достаточного баланса');

  const bal = await getBalance(userId);

  // Пробуем поставить больше чем есть
  const bet = await placeBet(userId, auctionId, bal.available + 1000);
  check('Недостаточно баланса', bet.error === 'INSUFFICIENT_BALANCE');
}

async function testBetOnOwnAuction(auctionId: string, authorId: string) {
  section('ТЕСТ 6: Ставка на свой аукцион');
  log('Начало теста 6...');
  log(`authorId=${authorId}, auctionId=${auctionId}`);

  try {
    const bet = await placeBet(authorId, auctionId, 100);
    log('Ответ API:', bet);
    check('Нельзя ставить на свой аукцион', !bet.success && bet.error === 'CANNOT_BET_OWN_AUCTION',
      `error=${bet.error}`);
  } catch (e) {
    log('Ошибка в тесте 6:', String(e));
  }
  log('Конец теста 6');
}

async function testMultipleRounds() {
  section('ТЕСТ 7: Несколько раундов');
  await sleep(100);

  const ts = Date.now();
  const authorId = `author7_${ts}`; // Отдельный автор для этого теста
  const bidders = [`mr1_${ts}`, `mr2_${ts}`, `mr3_${ts}`];

  // Подготовка
  await Promise.all([
    mintStars(authorId, 1000),
    mintGifts(authorId, 'Ruby', 10),
    ...bidders.map(b => mintStars(b, 500))
  ]);

  // Аукцион с 2 раундами - ДЛИННЫЕ раунды чтобы anti-snipe не мешал
  const res = await createAuction(authorId, {
    name: 'Multi Round ' + ts,
    giftName: 'Ruby',
    giftCount: 4, // 2+1 + 1 = 4
    startTime: Date.now() + 1500,
    rounds: [
      { duration: 15, prizes: [2, 1] },  // Раунд 1: 15 сек, 2 победителя
      { duration: 15, prizes: [1] }      // Раунд 2: 15 сек, 1 победитель
    ]
  });

  if (!res.auction?.id) {
    check('Создание аукциона с 2 раундами', false, res.error);
    return;
  }

  const auctionId = res.auction.id;
  check('Создание аукциона с 2 раундами', true);

  // Ждём старта
  await waitForState(auctionId, authorId, 'active', 5);

  // Раунд 1: ставки СРАЗУ после старта (чтобы anti-snipe не сработал)
  log('Раунд 1: ставки сразу после старта...');
  await Promise.all([
    placeBet(bidders[0], auctionId, 100),
    placeBet(bidders[1], auctionId, 80),
    placeBet(bidders[2], auctionId, 60),
  ]);

  // Ждём конца раунда 1 (15 сек + запас)
  log('Ожидание конца раунда 1...');
  await sleep(16000);

  let info = await getAuction(auctionId, authorId);
  check('Раунд 1 завершён, перешли на раунд 2',
    info.auction?.currentRound === 1 || info.auction?.state === 'finished',
    `round=${info.auction?.currentRound}, state=${info.auction?.state}`);

  // Проверяем победителей раунда 1
  const r1Winners = info.auction?.winners?.filter(w => w.roundIndex === 0) || [];
  check('Раунд 1: 2 победителя', r1Winners.length === 2, `winners=${r1Winners.length}`);

  // Если ещё активен - ставим в раунд 2 СРАЗУ
  if (info.auction?.state === 'active') {
    log('Раунд 2: ставки сразу...');
    await placeBet(bidders[2], auctionId, 50);

    // Ждём конца раунда 2
    log('Ожидание конца раунда 2...');
    await sleep(16000);
  }

  // Финал
  info = await waitForState(auctionId, authorId, 'finished', 5);
  check('Аукцион завершён', info.auction?.state === 'finished');

  const totalWinners = info.auction?.winners?.length || 0;
  check('Всего 3 победителя (2+1)', totalWinners === 3, `total=${totalWinners}`);
}

async function testAntiSnipe() {
  section('ТЕСТ 8: Anti-snipe');
  await sleep(100);

  const ts = Date.now();
  const authorId = `author8_${ts}`; // Отдельный автор
  const bidder1 = `snipe1_${ts}`;
  const bidder2 = `snipe2_${ts}`;

  await Promise.all([
    mintStars(authorId, 1000),
    mintGifts(authorId, 'Emerald', 5),
    mintStars(bidder1, 500),
    mintStars(bidder2, 500),
  ]);

  const res = await createAuction(authorId, {
    name: 'Anti-Snipe Test ' + ts,
    giftName: 'Emerald',
    giftCount: 1,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 12, prizes: [1] }]  // 12 сек раунд для надёжности
  });

  if (!res.auction?.id) {
    check('Создание аукциона для anti-snipe', false, res.error);
    return;
  }

  const auctionId = res.auction.id;
  check('Создание аукциона для anti-snipe', true);

  // Ждём старта
  await waitForState(auctionId, authorId, 'active', 5);

  // Первая ставка сразу
  await placeBet(bidder1, auctionId, 100);
  log('Bidder1 поставил 100');

  // Ждём до последних секунд (12 - 8 = 4 секунды до конца, anti-snipe срабатывает в последние 10 сек)
  log('Ждём до последних секунд...');
  await sleep(8000);

  // Перебиваем в последние секунды
  const snipeBet = await placeBet(bidder2, auctionId, 150);
  log('Bidder2 перебил на 150');

  check('Anti-snipe сработал (extended=true)', snipeBet.extended === true,
    `extended=${snipeBet.extended}`);

  // Ждём завершения (12 сек + 5 сек extension + запас)
  log('Ожидание завершения аукциона...');
  await waitForState(auctionId, authorId, 'finished', 20);
}

async function testLockedBalanceReturn() {
  section('ТЕСТ 9: Возврат locked баланса проигравшим');
  await sleep(100);

  const ts = Date.now();
  const authorId = `author9_${ts}`; // Отдельный автор
  const winner = `winner_${ts}`;
  const loser = `loser_${ts}`;

  await Promise.all([
    mintStars(authorId, 1000),
    mintGifts(authorId, 'Gold', 5),
    mintStars(winner, 500),
    mintStars(loser, 300),
  ]);

  const res = await createAuction(authorId, {
    name: 'Loser Return Test ' + ts,
    giftName: 'Gold',
    giftCount: 1,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 15, prizes: [1] }]  // Длинный раунд
  });

  if (!res.auction?.id) {
    check('Создание аукциона для теста 9', false, res.error);
    return;
  }

  const auctionId = res.auction.id;
  await waitForState(auctionId, authorId, 'active', 5);

  // Ставки СРАЗУ после старта
  log('Делаем ставки сразу после старта...');
  await placeBet(winner, auctionId, 200);
  await placeBet(loser, auctionId, 100);

  // Проверяем locked
  const loserBalBefore = await getBalance(loser);
  check('У проигравшего locked=100', loserBalBefore.locked === 100);

  // Ждём завершения (15 сек раунд + запас)
  log('Ожидание завершения аукциона...');
  await waitForState(auctionId, authorId, 'finished', 20);
  await sleep(500);

  // Проверяем возврат
  const loserBalAfter = await getBalance(loser);
  check('После проигрыша locked=0', loserBalAfter.locked === 0, `locked=${loserBalAfter.locked}`);
  check('Баланс вернулся (300)', loserBalAfter.available === 300, `available=${loserBalAfter.available}`);

  // Победитель потерял деньги
  const winnerBal = await getBalance(winner);
  check('Победитель заплатил (300)', winnerBal.available === 300, `available=${winnerBal.available}`);
}

// ============================================
// MAIN
// ============================================

async function runMiddleTests() {
  section('MIDDLE TESTS - Продвинутые тесты');

  const ts = Date.now();
  const author = `author_${ts}`;
  const users = Array.from({ length: 20 }, (_, i) => `user${i}_${ts}`);
  const testUser = users[0];

  log('Подготовка...');

  // Выдаём ресурсы
  await Promise.all([
    mintStars(author, 5000),
    mintGifts(author, 'Diamond', 100),
    ...users.map(u => mintStars(u, 1000))
  ]);

  // Создаём основной аукцион для тестов 1-6
  const mainAuction = await createAuction(author, {
    name: 'Main Test ' + ts,
    giftName: 'Diamond',
    giftCount: 10,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 30, prizes: [5, 3, 2] }]  // Длинный раунд для тестов
  });

  if (!mainAuction.auction?.id) {
    log('ОШИБКА создания аукциона:', mainAuction);
    return;
  }

  const auctionId = mainAuction.auction.id;
  log(`Основной аукцион: ${auctionId}`);

  // Ждём старта
  await waitForState(auctionId, author, 'active', 5);
  log('Аукцион активен');

  // Запускаем тесты последовательно с паузами
  const tests = [
    { name: 'testAtomicity', fn: () => testAtomicity(auctionId, users) },
    { name: 'testIdempotency', fn: () => testIdempotency(auctionId, testUser) },
    { name: 'testIncreaseBet', fn: () => testIncreaseBet(auctionId, testUser) },
    { name: 'testDecreaseBet', fn: () => testDecreaseBet(auctionId, testUser) },
    { name: 'testInsufficientBalance', fn: () => testInsufficientBalance(auctionId, users[5]) },
    { name: 'testBetOnOwnAuction', fn: () => testBetOnOwnAuction(auctionId, author) },
    { name: 'testMultipleRounds', fn: () => testMultipleRounds() },
    { name: 'testAntiSnipe', fn: () => testAntiSnipe() },
    { name: 'testLockedBalanceReturn', fn: () => testLockedBalanceReturn() },
  ];

  for (const test of tests) {
    try {
      await test.fn();
    } catch (e) {
      log(`CRASH в ${test.name}:`, String(e));
    }
    await sleep(200); // Пауза между тестами
  }

  // Итоги
  section('ИТОГИ');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`\n  ${failed === 0 ? '✓ ВСЕ ТЕСТЫ ПРОЙДЕНЫ!' : '✗ ЕСТЬ ОШИБКИ!'}\n`);
}

runMiddleTests().catch(console.error);
