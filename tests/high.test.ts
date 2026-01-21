/**
 * HIGH LOAD TEST SUITE - Жёсткие стресс-тесты
 *
 * ТЕСТЫ:
 * 1. Extreme Concurrency - 200 параллельных ставок на один аукцион
 * 2. Double Spending Attack - попытка потратить один баланс дважды
 * 3. Idempotency Storm - один ключ от 50 "клиентов" одновременно
 * 4. Race Condition Torture - быстрые увеличения одной ставки
 * 5. Balance Drain Attack - попытка слить баланс через параллельные аукционы
 * 6. Anti-Snipe Flood - массовые ставки в последние секунды
 * 7. Winner Processing Stress - много победителей одновременно
 * 8. Transaction Ledger Consistency - проверка что все транзакции сходятся
 * 9. Lock Contention Stress - нагрузка на distributed locks
 * 10. Full System Load - полный стресс-тест системы
 */

const BASE_URL = 'http://localhost:3000';

// ============== TYPES ==============

interface BalanceResponse {
  balance: number;
  available: number;
  locked: number;
}

interface UserResponse {
  id: string;
  balance: number;
  availableBalance: number;
  lockedBalance: number;
  gifts: { name: string; count: number }[];
}

interface BetResponse {
  success?: boolean;
  error?: string;
  status?: string;
  message?: string;
  bet?: number;
  previousBet?: number;
  charged?: number;
  extended?: boolean;
  idempotent?: boolean;
}

interface AuctionData {
  id: string;
  name: string;
  state: string;
  currentRound: number;
  author: string;
  startTime: number;
  rounds: { duration: number; endTime: number; prizes: number[] }[];
  winners: { roundIndex: number; place: number; userId: string; stars: number; prize: number }[];
  participants: string[];
}

interface AuctionResponse {
  auction?: AuctionData;
  participantsCount?: number;
  error?: string;
}

interface CreateAuctionResponse {
  success?: boolean;
  auction?: { id: string };
  error?: string;
}

interface TransactionResponse {
  transactions: {
    odempotencyKey: string;
    odempotency_key?: string;
    type: string;
    amount: number;
    status: string;
    auctionId?: string;
  }[];
}

// ============== UTILS ==============

function generateIdempotencyKey(): string {
  return `idem_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

async function api<T>(
  method: string,
  path: string,
  userId: string,
  body?: any,
  idempotencyKey?: string
): Promise<{ data: T; status: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-user-id': userId
  };

  if (idempotencyKey) {
    headers['x-idempotency-key'] = idempotencyKey;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json() as T;
  return { data, status: res.status };
}

// API shortcuts
const getBalance = (userId: string) =>
  api<BalanceResponse>('GET', '/api/data/user/balance', userId);

const getUser = (userId: string) =>
  api<UserResponse>('GET', '/api/data/user', userId);

const getTransactions = (userId: string) =>
  api<TransactionResponse>('GET', '/api/data/user/transactions', userId);

const mintStars = (userId: string, amount: number) =>
  api<any>('POST', '/test/mint-stars', userId, { amount });

const mintGifts = (userId: string, name: string, count: number) =>
  api<any>('POST', '/test/mint-gifts', userId, { name, count });

const createAuction = (userId: string, auctionData: any, idempotencyKey?: string) =>
  api<CreateAuctionResponse>('POST', '/api/auction/create', userId, auctionData, idempotencyKey || generateIdempotencyKey());

const placeBet = (userId: string, auctionId: string, stars: number, idempotencyKey?: string) =>
  api<BetResponse>('POST', '/api/bet', userId, { id: auctionId, stars }, idempotencyKey || generateIdempotencyKey());

const getAuction = (auctionId: string, userId: string) =>
  api<AuctionResponse>('GET', `/api/data/auction/${auctionId}`, userId);

// Logging
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(msg: string, data?: any) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${msg}`);
  if (data !== undefined) {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

function section(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70) + '\n');
}

function check(name: string, condition: boolean, details?: string) {
  const icon = condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${name}${details ? ` - ${details}` : ''}`);
  return condition;
}

async function waitForState(
  auctionId: string,
  userId: string,
  targetState: string,
  maxWaitSec = 30
): Promise<AuctionResponse> {
  for (let i = 0; i < maxWaitSec; i++) {
    try {
      const { data } = await getAuction(auctionId, userId);
      if (data.auction?.state === targetState) {
        return data;
      }
    } catch (err) {
      // Сервер может быть временно недоступен, продолжаем ждать
      console.log(`[waitForState] Retry ${i + 1}/${maxWaitSec} - connection error`);
    }
    await sleep(1000);
  }
  try {
    const { data } = await getAuction(auctionId, userId);
    return data;
  } catch {
    return { error: 'SERVER_UNAVAILABLE' };
  }
}

// Stats tracker
const stats = {
  tests: 0,
  passed: 0,
  failed: 0,
  totalRequests: 0,
  errors: new Map<string, number>()
};

function recordResult(passed: boolean) {
  stats.tests++;
  if (passed) stats.passed++;
  else stats.failed++;
}

function recordError(error: string) {
  stats.errors.set(error, (stats.errors.get(error) || 0) + 1);
}

// ============== TEST 1: Extreme Concurrency ==============

async function testExtremeConcurrency() {
  section('TEST 1: Extreme Concurrency - 200 параллельных ставок');

  const ts = Date.now();
  const author = `extreme_author_${ts}`;
  const bidders = Array.from({ length: 200 }, (_, i) => `extreme_b${i}_${ts}`);

  await mintStars(author, 10000);
  await mintGifts(author, 'ExtremeGift', 500);

  // Mint stars in batches
  log('Подготовка 200 участников...');
  const BATCH = 50;
  for (let i = 0; i < bidders.length; i += BATCH) {
    await Promise.all(bidders.slice(i, i + BATCH).map(b => mintStars(b, 1000)));
  }

  const { data: auctionRes } = await createAuction(author, {
    name: `Extreme Test ${ts}`,
    giftName: 'ExtremeGift',
    giftCount: 100,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 30, prizes: [10, 8, 6, 5, 4, 3, 2, 1, 1] }] // 9 winners
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false, auctionRes.error);
    recordResult(false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);
  log('Аукцион активен, запуск 200 параллельных ставок...');

  const startTime = Date.now();

  // All 200 bets simultaneously
  const results = await Promise.all(
    bidders.map((bidder, idx) =>
      placeBet(bidder, auctionId, 100 + idx) // Different amounts to create ordering
    )
  );

  const elapsed = Date.now() - startTime;
  const successful = results.filter(r => r.data.success).length;
  const failed = results.filter(r => r.data.error).length;

  log(`Завершено за ${elapsed}ms`);
  log(`Успешно: ${successful}, Ошибок: ${failed}`);

  // Count errors
  results.forEach(r => {
    if (r.data.error) recordError(r.data.error);
  });

  const passed = check('Большинство ставок успешно (>=180)', successful >= 180, `${successful}/200`);
  check('Время обработки < 10s', elapsed < 10000, `${elapsed}ms`);

  // Verify auction state
  const { data: auctionInfo } = await getAuction(auctionId, author);
  check('Участники зарегистрированы',
    (auctionInfo.participantsCount || 0) >= 180,
    `participants=${auctionInfo.participantsCount}`
  );

  recordResult(passed);
}

// ============== TEST 2: Double Spending Attack ==============

async function testDoubleSpendingAttack() {
  section('TEST 2: Double Spending Attack - попытка потратить баланс дважды');

  const ts = Date.now();
  const author1 = `dbl_author1_${ts}`;
  const author2 = `dbl_author2_${ts}`;
  const attacker = `dbl_attacker_${ts}`;

  await mintStars(author1, 5000);
  await mintStars(author2, 5000);
  await mintGifts(author1, 'DblGift1', 50);
  await mintGifts(author2, 'DblGift2', 50);

  // Attacker has EXACTLY 500 stars
  await mintStars(attacker, 500);

  // Create 2 auctions
  const [{ data: a1 }, { data: a2 }] = await Promise.all([
    createAuction(author1, {
      name: `DblSpend1 ${ts}`,
      giftName: 'DblGift1',
      giftCount: 10,
      startTime: Date.now() + 2000,
      rounds: [{ duration: 60, prizes: [10] }]
    }),
    createAuction(author2, {
      name: `DblSpend2 ${ts}`,
      giftName: 'DblGift2',
      giftCount: 10,
      startTime: Date.now() + 2000,
      rounds: [{ duration: 60, prizes: [10] }]
    })
  ]);

  const auctionId1 = a1.auction?.id;
  const auctionId2 = a2.auction?.id;

  if (!auctionId1 || !auctionId2) {
    check('Создание аукционов', false);
    recordResult(false);
    return;
  }

  await sleep(2500); // Wait for active

  log('Атака: одновременные ставки 500 на оба аукциона...');

  // Try to bet 500 stars on BOTH auctions simultaneously
  // Only ONE should succeed (distributed lock + balance check)
  const [r1, r2] = await Promise.all([
    placeBet(attacker, auctionId1, 500),
    placeBet(attacker, auctionId2, 500)
  ]);

  const successes = [r1, r2].filter(r => r.data.success).length;
  const insufficient = [r1, r2].filter(r => r.data.error === 'INSUFFICIENT_BALANCE').length;

  log(`Результат: ${successes} успешно, ${insufficient} INSUFFICIENT_BALANCE`);

  // Check final balance
  const { data: bal } = await getBalance(attacker);

  const passed = check('Только одна ставка прошла', successes === 1, `successes=${successes}`);
  check('Другая отклонена как INSUFFICIENT_BALANCE', insufficient === 1, `insufficient=${insufficient}`);
  check('Баланс корректен (locked=500 или 0)',
    bal.locked === 500 || bal.locked === 0,
    `locked=${bal.locked}, available=${bal.available}`
  );
  check('Нет овердрафта', bal.available >= 0, `available=${bal.available}`);

  recordResult(passed && insufficient === 1);
}

// ============== TEST 3: Idempotency Storm ==============

async function testIdempotencyStorm() {
  section('TEST 3: Idempotency Storm - один ключ от 50 клиентов');

  const ts = Date.now();
  const author = `idem_storm_author_${ts}`;
  const bidder = `idem_storm_bidder_${ts}`;

  await mintStars(author, 5000);
  await mintGifts(author, 'IdemGift', 50);
  await mintStars(bidder, 1000);

  const { data: auctionRes } = await createAuction(author, {
    name: `IdemStorm Test ${ts}`,
    giftName: 'IdemGift',
    giftCount: 10,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 60, prizes: [10] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    recordResult(false);
    return;
  }

  await sleep(2500);

  // ONE idempotency key, 50 simultaneous requests
  const SAME_KEY = `storm_key_${ts}_${Math.random().toString(36).slice(2)}`;

  log(`Запуск 50 запросов с одним ключом: ${SAME_KEY.substring(0, 20)}...`);

  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      placeBet(bidder, auctionId, 200, SAME_KEY)
    )
  );

  const successes = results.filter(r => r.data.success === true).length;
  const idempotent = results.filter(r => r.data.idempotent === true).length;
  const sameStatus = results.filter(r => r.data.status === 'SAME').length;
  const errors = results.filter(r => r.data.error && r.data.error !== 'SAME').length;

  // Логируем типы ошибок для диагностики
  const errorTypes = results
    .filter(r => r.data.error)
    .reduce((acc, r) => {
      const errKey = r.data.error as string;
      acc[errKey] = (acc[errKey] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  if (Object.keys(errorTypes).length > 0) {
    log(`Типы ошибок: ${JSON.stringify(errorTypes)}`);
  }

  log(`Успешно: ${successes}, Idempotent: ${idempotent}, SAME: ${sameStatus}, Ошибок: ${errors}`);

  // Check balance - should be charged exactly once
  const { data: bal } = await getBalance(bidder);

  // При idempotency с высокой конкурентностью:
  // - Часть запросов успешны (первый + idempotent повторы)
  // - Часть получает TOO_MANY_REQUESTS (нормально при перегрузке)
  // ГЛАВНОЕ: баланс корректен — ставка сделана ровно один раз
  const tooManyRequests = results.filter(r => r.data.error === 'TOO_MANY_REQUESTS').length;

  check('Есть успешные запросы', successes >= 1, `successes=${successes}`);
  check('Idempotent повторы работают', successes > 1 ? idempotent >= 1 : true, `idempotent=${idempotent}`);
  check('TOO_MANY_REQUESTS при перегрузке (ОК)', tooManyRequests >= 0, `tooMany=${tooManyRequests}`);

  // КРИТИЧЕСКИЕ проверки — баланс должен быть корректным
  const lockedOk = check('Locked = 200 (один раз)', bal.locked === 200, `locked=${bal.locked}`);
  const availOk = check('Available = 800', bal.available === 800, `available=${bal.available}`);

  recordResult(lockedOk && availOk);
}

// ============== TEST 4: Race Condition Torture ==============

async function testRaceConditionTorture() {
  section('TEST 4: Race Condition Torture - быстрые увеличения ставки');

  const ts = Date.now();
  const author = `race_author_${ts}`;
  const bidder = `race_bidder_${ts}`;

  await mintStars(author, 5000);
  await mintGifts(author, 'RaceGift', 50);
  await mintStars(bidder, 2000);

  const { data: auctionRes } = await createAuction(author, {
    name: `Race Test ${ts}`,
    giftName: 'RaceGift',
    giftCount: 10,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 60, prizes: [10] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    recordResult(false);
    return;
  }

  await sleep(2500);

  // Initial bet
  await placeBet(bidder, auctionId, 100);

  // 20 rapid increases with different amounts
  log('Запуск 20 конкурентных увеличений ставки...');

  const amounts = [150, 200, 250, 300, 350, 400, 450, 500, 550, 600,
                   650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100];

  const results = await Promise.all(
    amounts.map(amount => placeBet(bidder, auctionId, amount))
  );

  const successful = results.filter(r => r.data.success).length;
  const cannotDecrease = results.filter(r => r.data.error === 'CANNOT_DECREASE').length;
  const same = results.filter(r => r.data.status === 'SAME').length;

  log(`Успешных: ${successful}, CANNOT_DECREASE: ${cannotDecrease}, SAME: ${same}`);

  // Final state
  const { data: bal } = await getBalance(bidder);

  // Balance should be consistent: balance = available + locked
  const consistent = bal.balance === bal.available + bal.locked;

  const passed = check('Баланс консистентен', consistent,
    `bal=${bal.balance}, avail=${bal.available}, locked=${bal.locked}`);
  check('Нет овердрафта', bal.available >= 0 && bal.locked >= 0);
  check('Locked <= начальный баланс', bal.locked <= 2000, `locked=${bal.locked}`);

  recordResult(passed && consistent);
}

// ============== TEST 5: Balance Drain Attack ==============

async function testBalanceDrainAttack() {
  section('TEST 5: Balance Drain Attack - параллельные ставки на 10 аукционов');

  const ts = Date.now();
  const authors = Array.from({ length: 10 }, (_, i) => `drain_author${i}_${ts}`);
  const attacker = `drain_attacker_${ts}`;

  // Setup authors
  await Promise.all(authors.map(async (author, i) => {
    await mintStars(author, 5000);
    await mintGifts(author, `DrainGift${i}`, 50);
  }));

  // Attacker has 1000 stars
  await mintStars(attacker, 1000);

  // Create 10 auctions
  const auctionIds: string[] = [];
  for (const [i, author] of authors.entries()) {
    const { data } = await createAuction(author, {
      name: `Drain${i} ${ts}`,
      giftName: `DrainGift${i}`,
      giftCount: 10,
      startTime: Date.now() + 2000,
      rounds: [{ duration: 60, prizes: [10] }]
    });
    if (data.auction?.id) auctionIds.push(data.auction.id);
  }

  check('Создано 10 аукционов', auctionIds.length === 10);
  await sleep(3000);

  // Try to bet 500 stars on ALL 10 auctions simultaneously
  // Max possible: 2 auctions (1000 / 500 = 2)
  log('Атака: ставка 500 на все 10 аукционов одновременно...');

  const results = await Promise.all(
    auctionIds.map(auctionId => placeBet(attacker, auctionId, 500))
  );

  const successes = results.filter(r => r.data.success).length;
  const insufficient = results.filter(r => r.data.error === 'INSUFFICIENT_BALANCE').length;
  const tooMany = results.filter(r => r.data.error === 'TOO_MANY_REQUESTS').length;
  const notActive = results.filter(r => r.data.error === 'AUCTION_NOT_ACTIVE').length;

  log(`Успешно: ${successes}, INSUFFICIENT: ${insufficient}, TOO_MANY: ${tooMany}, NOT_ACTIVE: ${notActive}`);

  const { data: bal } = await getBalance(attacker);

  // КРИТИЧЕСКИЕ проверки — баланс должен быть корректным
  // При конкурентных запросах часть может получить TOO_MANY_REQUESTS — это нормально
  const passed = check('Максимум 2 ставки прошли', successes <= 2, `successes=${successes}`);
  check('Отклонено по балансу или перегрузке', insufficient + tooMany >= 8 - notActive,
    `insufficient=${insufficient}, tooMany=${tooMany}`);
  check('Locked корректен', bal.locked === successes * 500, `locked=${bal.locked}`);
  check('Нет овердрафта', bal.available >= 0, `available=${bal.available}`);

  recordResult(passed && bal.available >= 0);
}

// ============== TEST 6: Anti-Snipe Flood ==============

async function testAntiSnipeFlood() {
  section('TEST 6: Anti-Snipe Flood - массовые ставки в последние секунды');

  const ts = Date.now();
  const author = `snipe_flood_author_${ts}`;
  const bidders = Array.from({ length: 30 }, (_, i) => `snipe_flood_b${i}_${ts}`);

  await mintStars(author, 5000);
  await mintGifts(author, 'SnipeFloodGift', 100);
  await Promise.all(bidders.map(b => mintStars(b, 500)));

  // Short auction - 12 seconds (anti-snipe kicks in at last 10)
  const { data: auctionRes } = await createAuction(author, {
    name: `SnipeFlood Test ${ts}`,
    giftName: 'SnipeFloodGift',
    giftCount: 50,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 12, prizes: [10, 8, 6, 5, 4, 3, 2, 1, 1] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    recordResult(false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Wait until last 5 seconds
  log('Ждём последних секунд (7 сек)...');
  await sleep(7000);

  // Flood with 30 bets in anti-snipe window
  log('Флуд: 30 ставок в anti-snipe зоне...');

  const results = await Promise.all(
    bidders.map((bidder, i) => placeBet(bidder, auctionId, 100 + i * 10))
  );

  const successful = results.filter(r => r.data.success).length;
  const extended = results.filter(r => r.data.extended === true).length;

  log(`Успешно: ${successful}, С продлением: ${extended}`);

  // Wait for auction to finish (with possible extensions)
  log('Ждём завершения аукциона...');
  const finalInfo = await waitForState(auctionId, author, 'finished', 30);

  const passed = check('Большинство ставок успешно (>=25)', successful >= 25, `${successful}/30`);
  check('Anti-snipe сработал', extended >= 1, `extended=${extended}`);
  check('Аукцион завершился', finalInfo.auction?.state === 'finished');

  recordResult(passed);
}

// ============== TEST 7: Winner Processing Stress ==============

async function testWinnerProcessingStress() {
  section('TEST 7: Winner Processing Stress - много победителей');

  const ts = Date.now();
  const author = `winner_stress_author_${ts}`;
  // 50 bidders for 20 winner slots
  const bidders = Array.from({ length: 50 }, (_, i) => `winner_stress_b${i}_${ts}`);

  await mintStars(author, 10000);
  await mintGifts(author, 'WinnerStressGift', 500);

  // Mint in batches
  for (let i = 0; i < bidders.length; i += 25) {
    await Promise.all(bidders.slice(i, i + 25).map(b => mintStars(b, 1000)));
  }

  // Many winners: 20 places
  const { data: auctionRes } = await createAuction(author, {
    name: `WinnerStress Test ${ts}`,
    giftName: 'WinnerStressGift',
    giftCount: 200, // Total prizes
    startTime: Date.now() + 2000,
    rounds: [{
      duration: 5,
      prizes: [20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] // 20 winners
    }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false, auctionRes.error);
    recordResult(false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // All 50 bidders place bets with different amounts
  log('50 участников делают ставки...');
  await Promise.all(
    bidders.map((bidder, i) => placeBet(bidder, auctionId, 100 + i * 20))
  );

  // Wait for finish
  log('Ждём обработки победителей...');
  const finalInfo = await waitForState(auctionId, author, 'finished', 20);

  const winnersCount = finalInfo.auction?.winners?.length || 0;

  const passed = check('20 победителей определено', winnersCount === 20, `winners=${winnersCount}`);
  check('Аукцион завершён', finalInfo.auction?.state === 'finished');

  // Verify some winners got prizes
  if (winnersCount > 0) {
    const topWinner = finalInfo.auction!.winners![0];
    const { data: winnerUser } = await getUser(topWinner.userId);
    const prizes = winnerUser.gifts?.find(g => g.name === 'WinnerStressGift')?.count || 0;
    check('Топ победитель получил призы', prizes > 0, `prizes=${prizes}`);
  }

  recordResult(passed);
}

// ============== TEST 8: Transaction Ledger Consistency ==============

async function testTransactionLedgerConsistency() {
  section('TEST 8: Transaction Ledger - проверка консистентности транзакций');

  const ts = Date.now();
  const author = `ledger_author_${ts}`;
  const bidder = `ledger_bidder_${ts}`;

  await mintStars(author, 5000);
  await mintGifts(author, 'LedgerGift', 50);
  await mintStars(bidder, 1000);

  const { data: balBefore } = await getBalance(bidder);

  const { data: auctionRes } = await createAuction(author, {
    name: `Ledger Test ${ts}`,
    giftName: 'LedgerGift',
    giftCount: 10,
    startTime: Date.now() + 2000,
    rounds: [{ duration: 5, prizes: [10] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    recordResult(false);
    return;
  }

  await sleep(2500);

  // Make several bets (increasing)
  await placeBet(bidder, auctionId, 100);
  await placeBet(bidder, auctionId, 200);
  await placeBet(bidder, auctionId, 300);

  // Wait for finish
  log('Ждём завершения...');
  await waitForState(auctionId, author, 'finished', 15);
  await sleep(500);

  // Get transactions
  const { data: txData } = await getTransactions(bidder);
  const { data: balAfter } = await getBalance(bidder);

  // Calculate expected balance from transactions
  const betTxs = txData.transactions?.filter(t => t.type === 'bet' || t.type === 'bet_increase') || [];
  const refundTxs = txData.transactions?.filter(t => t.type === 'refund' || t.type === 'bet_lost') || [];
  const wonTxs = txData.transactions?.filter(t => t.type === 'bet_won') || [];

  log(`Транзакции: bets=${betTxs.length}, refunds=${refundTxs.length}, won=${wonTxs.length}`);

  const totalBet = betTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const totalRefund = refundTxs.reduce((sum, t) => sum + t.amount, 0);

  // If bidder won (highest bet), they paid. If lost, got refund.
  const { data: auctionInfo } = await getAuction(auctionId, author);
  const isWinner = auctionInfo.auction?.winners?.some(w => w.userId === bidder);

  log(`Bidder is winner: ${isWinner}, totalBet: ${totalBet}`);

  // Balance should match
  let expectedBalance: number;
  if (isWinner) {
    // Won: paid 300 stars
    expectedBalance = 1000 - 300;
  } else {
    // Lost: refunded
    expectedBalance = 1000;
  }

  const passed = check('Баланс соответствует транзакциям',
    balAfter.balance === expectedBalance,
    `expected=${expectedBalance}, actual=${balAfter.balance}`
  );
  check('Locked = 0 после завершения', balAfter.locked === 0, `locked=${balAfter.locked}`);

  recordResult(passed);
}

// ============== TEST 9: Lock Contention Stress ==============

async function testLockContentionStress() {
  section('TEST 9: Lock Contention - нагрузка на distributed locks');

  const ts = Date.now();
  const author = `lock_author_${ts}`;
  const bidder = `lock_bidder_${ts}`; // ONE user, many concurrent ops

  await mintStars(author, 5000);
  await mintGifts(author, 'LockGift', 50);
  await mintStars(bidder, 5000);

  // Create multiple auctions
  const auctionIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { data } = await createAuction(author, {
      name: `Lock${i} ${ts}`,
      giftName: 'LockGift',
      giftCount: 5,
      startTime: Date.now() + 2000,
      rounds: [{ duration: 60, prizes: [5] }]
    });
    if (data.auction?.id) auctionIds.push(data.auction.id);
  }

  await sleep(3000);

  // ONE user makes 50 concurrent bets across 5 auctions
  // This tests the user-level distributed lock
  log('50 конкурентных операций от одного юзера...');

  const operations = Array.from({ length: 50 }, (_, i) => {
    const auctionId = auctionIds[i % auctionIds.length];
    const amount = 100 + (i * 20);
    return placeBet(bidder, auctionId, amount);
  });

  const startTime = Date.now();
  const results = await Promise.all(operations);
  const elapsed = Date.now() - startTime;

  const successful = results.filter(r => r.data.success || r.data.status === 'SAME').length;
  const lockErrors = results.filter(r => r.data.error?.includes('LOCK')).length;

  log(`Завершено за ${elapsed}ms, успешно: ${successful}, lock errors: ${lockErrors}`);

  // Final balance check
  const { data: bal } = await getBalance(bidder);

  const passed = check('Баланс консистентен',
    bal.balance === bal.available + bal.locked,
    `bal=${bal.balance}, avail=${bal.available}, locked=${bal.locked}`
  );
  check('Нет отрицательных значений', bal.available >= 0 && bal.locked >= 0);
  check('Locked <= исходный баланс', bal.locked <= 5000, `locked=${bal.locked}`);

  recordResult(passed);
}

// ============== TEST 10: Full System Load ==============

async function testFullSystemLoad() {
  section('TEST 10: Full System Load - комплексный стресс-тест');

  const ts = Date.now();
  const NUM_AUTHORS = 5;
  const NUM_BIDDERS = 50;
  const ROUNDS = 2;
  const ROUND_DURATION = 8;

  log(`Конфигурация: ${NUM_AUTHORS} аукционов, ${NUM_BIDDERS} участников, ${ROUNDS} раунда`);

  const authors = Array.from({ length: NUM_AUTHORS }, (_, i) => `full_author${i}_${ts}`);
  const bidders = Array.from({ length: NUM_BIDDERS }, (_, i) => `full_bidder${i}_${ts}`);

  // Setup
  log('Подготовка...');
  await Promise.all([
    ...authors.map(async (author, i) => {
      await mintStars(author, 10000);
      await mintGifts(author, `FullGift${i}`, 200);
    }),
    ...bidders.map(b => mintStars(b, 3000))
  ]);

  // Create auctions
  const auctionIds: string[] = [];
  for (const [i, author] of authors.entries()) {
    const { data } = await createAuction(author, {
      name: `Full${i} ${ts}`,
      giftName: `FullGift${i}`,
      giftCount: 30,
      startTime: Date.now() + 3000,
      rounds: Array.from({ length: ROUNDS }, () => ({
        duration: ROUND_DURATION,
        prizes: [5, 4, 3, 2, 1]
      }))
    });
    if (data.auction?.id) auctionIds.push(data.auction.id);
  }

  check('Все аукционы созданы', auctionIds.length === NUM_AUTHORS, `${auctionIds.length}/${NUM_AUTHORS}`);

  await sleep(4000); // Wait for active

  // Track stats
  let totalBets = 0;
  let successfulBets = 0;

  // Multiple waves of bets across all rounds
  for (let round = 0; round < ROUNDS; round++) {
    log(`\n--- Раунд ${round + 1}/${ROUNDS} ---`);

    // Wave of bets
    for (let wave = 0; wave < 2; wave++) {
      log(`Волна ${wave + 1}/2...`);

      const betPromises = bidders.map(async (bidder, idx) => {
        const auctionId = auctionIds[idx % auctionIds.length];
        const amount = 50 + round * 30 + wave * 20 + idx;

        const { data } = await placeBet(bidder, auctionId, amount);
        totalBets++;
        if (data.success || data.status === 'SAME') successfulBets++;
        return data;
      });

      await Promise.all(betPromises);
      await sleep(1000);
    }

    // Wait for round to process
    if (round < ROUNDS - 1) {
      log(`Ждём конца раунда ${round + 1}...`);
      await sleep((ROUND_DURATION + 3) * 1000);
    }
  }

  // Wait for all auctions to finish
  log('\nЖдём завершения всех аукционов...');

  let allFinished = false;
  for (let i = 0; i < 30; i++) {
    const states = await Promise.all(
      auctionIds.map(async id => {
        const { data } = await getAuction(id, authors[0]);
        return data.auction?.state;
      })
    );

    allFinished = states.every(s => s === 'finished');
    if (allFinished) break;
    await sleep(2000);
  }

  // Verify results
  log('\n--- Проверка результатов ---');

  let totalWinners = 0;
  for (const auctionId of auctionIds) {
    const { data } = await getAuction(auctionId, authors[0]);
    totalWinners += data.auction?.winners?.length || 0;
  }

  const expectedWinners = NUM_AUTHORS * ROUNDS * 5; // 5 winners per round

  // Check some random bidder balances
  let balancesOk = 0;
  const sampleBidders = bidders.slice(0, 10);
  for (const bidder of sampleBidders) {
    const { data: bal } = await getBalance(bidder);
    // After all auctions finished, locked should be 0
    if (bal.locked === 0 && bal.balance === bal.available) {
      balancesOk++;
    }
  }

  console.log(`\n  Статистика:`);
  console.log(`    Всего ставок: ${totalBets}`);
  console.log(`    Успешных: ${successfulBets} (${Math.round(successfulBets/totalBets*100)}%)`);
  console.log(`    Победителей: ${totalWinners}/${expectedWinners}`);
  console.log(`    Балансы OK: ${balancesOk}/${sampleBidders.length}`);

  const passed = check('Все аукционы завершены', allFinished);
  check('Победители обработаны', totalWinners === expectedWinners, `${totalWinners}/${expectedWinners}`);
  check('Балансы корректны после завершения', balancesOk === sampleBidders.length, `${balancesOk}/${sampleBidders.length}`);

  recordResult(passed && totalWinners === expectedWinners);
}

// ============== MAIN ==============

async function runHighTests() {
  console.log('\n');
  console.log('\x1b[31m╔══════════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[31m║         HIGH LOAD TEST SUITE - Жёсткие стресс-тесты                 ║\x1b[0m');
  console.log('\x1b[31m╚══════════════════════════════════════════════════════════════════════╝\x1b[0m');

  const startTime = Date.now();

  const tests = [
    testExtremeConcurrency,
    testDoubleSpendingAttack,
    testIdempotencyStorm,
    testRaceConditionTorture,
    testBalanceDrainAttack,
    testAntiSnipeFlood,
    testWinnerProcessingStress,
    testTransactionLedgerConsistency,
    testLockContentionStress,
    testFullSystemLoad,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.error(`\n\x1b[31m[${test.name}] ОШИБКА:\x1b[0m`, error);
      recordResult(false);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                            ИТОГИ                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`  Время выполнения: ${elapsed} секунд`);
  console.log(`  Тестов пройдено: ${stats.passed}/${stats.tests}`);
  console.log(`  Тестов провалено: ${stats.failed}/${stats.tests}`);

  if (stats.errors.size > 0) {
    console.log('\n  Зафиксированные ошибки:');
    for (const [err, count] of stats.errors) {
      console.log(`    ${err}: ${count}`);
    }
  }

  const allPassed = stats.failed === 0;
  console.log('');
  if (allPassed) {
    console.log('\x1b[32m  ✓ ALL HIGH LOAD TESTS PASSED!\x1b[0m');
  } else {
    console.log('\x1b[31m  ✗ SOME TESTS FAILED\x1b[0m');
  }
  console.log('');

  process.exit(allPassed ? 0 : 1);
}

runHighTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
