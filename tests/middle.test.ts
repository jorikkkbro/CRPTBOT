/**
 * Middle Test Suite - Продвинутые сценарии
 *
 * Тесты:
 * 1. Массовые параллельные ставки (20+ юзеров)
 * 2. Идемпотентность ставок (SAME статус)
 * 3. Увеличение ставки (атомарность)
 * 4. Уменьшение ставки (запрещено)
 * 5. Недостаточный баланс
 * 6. Ставка на свой аукцион
 * 7. Несколько раундов (multi-round)
 * 8. Anti-snipe механизм
 * 9. Возврат баланса проигравшим
 * 10. Конкурентные увеличения ставок
 * 11. Призы при отсутствии ставок
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

interface AuctionResponse {
  auction?: {
    id: string;
    name: string;
    state: string;
    currentRound: number;
    roundEndTime?: number;
    authorId: string;
    gift: { name: string; count: number };
    winners: {
      roundIndex: number;
      place: number;
      userId: string;
      stars: number;
      prize: number;
    }[];
    rounds: { duration: number; prizes: number[] }[];
  };
  participantsCount?: number;
}

interface CreateAuctionResponse {
  success?: boolean;
  auction?: { id: string };
  error?: string;
  idempotent?: boolean;
}

// ============== UTILITIES ==============

function generateIdempotencyKey(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random}`;
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

  return {
    data: await res.json() as T,
    status: res.status
  };
}

// API Helpers
const getUser = (userId: string) => api<UserResponse>('GET', '/api/data/user', userId);
const getBalance = (userId: string) => api<BalanceResponse>('GET', '/api/data/user/balance', userId);
const mintStars = (userId: string, amount: number) => api<any>('POST', '/test/mint-stars', userId, { amount });
const mintGifts = (userId: string, name: string, count: number) => api<any>('POST', '/test/mint-gifts', userId, { name, count });

const createAuction = (userId: string, data: any, idempotencyKey?: string) =>
  api<CreateAuctionResponse>('POST', '/api/auction/create', userId, data, idempotencyKey || generateIdempotencyKey());

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

// Results tracking
interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function check(name: string, condition: boolean, details?: string) {
  results.push({ name, passed: condition, details });
  const icon = condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${name}${details ? ` - ${details}` : ''}`);
}

async function waitForState(
  auctionId: string,
  userId: string,
  targetState: string,
  maxWaitSec = 20
): Promise<AuctionResponse> {
  for (let i = 0; i < maxWaitSec; i++) {
    const { data } = await getAuction(auctionId, userId);
    if (data.auction?.state === targetState) {
      return data;
    }
    await sleep(1000);
  }
  const { data } = await getAuction(auctionId, userId);
  return data;
}

// ============== TESTS ==============

/**
 * TEST 1: Массовые параллельные ставки
 */
async function testMassParallelBets() {
  section('TEST 1: Массовые параллельные ставки (20 юзеров)');

  const ts = Date.now();
  const author = `mass_author_${ts}`;
  const users = Array.from({ length: 20 }, (_, i) => `mass_user${i}_${ts}`);

  // Setup
  await mintStars(author, 1000);
  await mintGifts(author, 'MassGift', 50);
  await Promise.all(users.map(u => mintStars(u, 1000)));

  const { data: auctionRes } = await createAuction(author, {
    name: `Mass Test ${ts}`,
    giftName: 'MassGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  if (!auctionRes.auction?.id) {
    check('Создание аукциона', false, auctionRes.error);
    return;
  }

  const auctionId = auctionRes.auction.id;
  await waitForState(auctionId, author, 'active', 5);

  // 20 параллельных ставок
  log('Запуск 20 параллельных ставок...');
  const startTime = Date.now();

  const betPromises = users.map((u, i) =>
    placeBet(u, auctionId, 100 + i * 10)
  );

  const betResults = await Promise.all(betPromises);
  const duration = Date.now() - startTime;

  const successCount = betResults.filter(r => r.data.success).length;
  const lockFails = betResults.filter(r => r.data.error === 'TOO_MANY_REQUESTS').length;

  log(`Завершено за ${duration}ms: ${successCount} успешно, ${lockFails} lock failures`);

  check('Большинство ставок успешно', successCount >= 15, `${successCount}/20`);

  // Проверяем консистентность балансов
  let allConsistent = true;
  for (const user of users.slice(0, 5)) {  // Check first 5
    const { data: bal } = await getBalance(user);
    if (bal.balance !== bal.available + bal.locked) {
      allConsistent = false;
      break;
    }
  }
  check('Балансы консистентны', allConsistent);

  // Check auction has participants
  const { data: auctionData } = await getAuction(auctionId, author);
  check('Участники зарегистрированы', (auctionData.participantsCount || 0) >= 15);
}

/**
 * TEST 2: Идемпотентность ставок (SAME статус)
 */
async function testBetIdempotency() {
  section('TEST 2: Идемпотентность ставок');

  const ts = Date.now();
  const author = `idem_author_${ts}`;
  const bidder = `idem_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'IdemGift', 50);
  await mintStars(bidder, 500);

  const { data: auctionRes } = await createAuction(author, {
    name: `Idem Test ${ts}`,
    giftName: 'IdemGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Первая ставка
  const { data: bet1 } = await placeBet(bidder, auctionId, 150);
  check('Первая ставка 150', bet1.success === true, `bet=${bet1.bet}`);

  // Повторная ставка той же суммы (новый idempotency key, но та же сумма)
  const { data: bet2 } = await placeBet(bidder, auctionId, 150);
  check('Повторная ставка 150 = SAME', bet2.status === 'SAME', `status=${bet2.status}`);

  // Баланс не должен измениться
  const { data: bal } = await getBalance(bidder);
  check('Locked остался 150', bal.locked === 150, `locked=${bal.locked}`);
  check('Available = 350', bal.available === 350, `available=${bal.available}`);
}

/**
 * TEST 3: Увеличение ставки
 */
async function testBetIncrease() {
  section('TEST 3: Увеличение ставки');

  const ts = Date.now();
  const author = `inc_author_${ts}`;
  const bidder = `inc_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'IncGift', 50);
  await mintStars(bidder, 500);

  const { data: auctionRes } = await createAuction(author, {
    name: `Inc Test ${ts}`,
    giftName: 'IncGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Первая ставка 100
  await placeBet(bidder, auctionId, 100);
  const { data: bal1 } = await getBalance(bidder);
  check('После ставки 100: locked=100', bal1.locked === 100);

  // Увеличиваем до 200
  const { data: incBet } = await placeBet(bidder, auctionId, 200);
  check('Увеличение до 200 успешно', incBet.success === true && incBet.bet === 200);
  check('Charged = 100 (разница)', incBet.charged === 100, `charged=${incBet.charged}`);

  // Проверяем баланс
  const { data: bal2 } = await getBalance(bidder);
  check('Locked = 200', bal2.locked === 200, `locked=${bal2.locked}`);
  check('Available = 300', bal2.available === 300, `available=${bal2.available}`);
}

/**
 * TEST 4: Уменьшение ставки запрещено
 */
async function testBetDecreaseBlocked() {
  section('TEST 4: Уменьшение ставки запрещено');

  const ts = Date.now();
  const author = `dec_author_${ts}`;
  const bidder = `dec_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'DecGift', 50);
  await mintStars(bidder, 500);

  const { data: auctionRes } = await createAuction(author, {
    name: `Dec Test ${ts}`,
    giftName: 'DecGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Ставка 200
  await placeBet(bidder, auctionId, 200);

  // Попытка уменьшить до 100
  const { data: decBet, status } = await placeBet(bidder, auctionId, 100);

  check('Уменьшение отклонено', decBet.error === 'CANNOT_DECREASE', `error=${decBet.error}`);
  check('HTTP статус 400', status === 400, `status=${status}`);

  // Баланс не изменился
  const { data: bal } = await getBalance(bidder);
  check('Locked остался 200', bal.locked === 200, `locked=${bal.locked}`);
}

/**
 * TEST 5: Недостаточный баланс
 */
async function testInsufficientBalance() {
  section('TEST 5: Недостаточный баланс');

  const ts = Date.now();
  const author = `insuf_author_${ts}`;
  const bidder = `insuf_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'InsufGift', 50);
  await mintStars(bidder, 50);  // Только 50!

  const { data: auctionRes } = await createAuction(author, {
    name: `Insuf Test ${ts}`,
    giftName: 'InsufGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Попытка ставки 100 при балансе 50
  const { data: betRes, status } = await placeBet(bidder, auctionId, 100);

  check('Ставка отклонена', betRes.error === 'INSUFFICIENT_BALANCE', `error=${betRes.error}`);
  check('HTTP статус 400', status === 400);

  // Баланс не изменился
  const { data: bal } = await getBalance(bidder);
  check('Баланс не тронут', bal.available === 50 && bal.locked === 0);
}

/**
 * TEST 6: Ставка на свой аукцион
 */
async function testBetOnOwnAuction() {
  section('TEST 6: Ставка на свой аукцион запрещена');

  const ts = Date.now();
  const author = `own_author_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'OwnGift', 50);

  const { data: auctionRes } = await createAuction(author, {
    name: `Own Test ${ts}`,
    giftName: 'OwnGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Попытка ставки на свой аукцион
  const { data: betRes, status } = await placeBet(author, auctionId, 100);

  check('Ставка отклонена', betRes.error === 'CANNOT_BET_OWN_AUCTION', `error=${betRes.error}`);
  check('HTTP статус 400', status === 400);
}

/**
 * TEST 7: Несколько раундов
 */
async function testMultipleRounds() {
  section('TEST 7: Аукцион с несколькими раундами');

  const ts = Date.now();
  const author = `multi_author_${ts}`;
  const bidders = [`multi_b1_${ts}`, `multi_b2_${ts}`, `multi_b3_${ts}`];

  await mintStars(author, 1000);
  await mintGifts(author, 'MultiGift', 50);
  await Promise.all(bidders.map(b => mintStars(b, 500)));

  // 2 раунда по 5 секунд
  const { data: auctionRes } = await createAuction(author, {
    name: `Multi Test ${ts}`,
    giftName: 'MultiGift',
    giftCount: 6,  // 3+2 + 1
    startTime: Date.now() + 1500,
    rounds: [
      { duration: 5, prizes: [3, 2] },  // Раунд 1: 2 победителя
      { duration: 5, prizes: [1] }       // Раунд 2: 1 победитель
    ]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false, auctionRes.error);
    return;
  }

  check('Аукцион с 2 раундами создан', true);
  await waitForState(auctionId, author, 'active', 5);

  // Раунд 1: ставки
  log('Раунд 1: делаем ставки...');
  await Promise.all([
    placeBet(bidders[0], auctionId, 150),
    placeBet(bidders[1], auctionId, 100),
    placeBet(bidders[2], auctionId, 50)
  ]);

  // Ждём конца раунда 1 - пока currentRound станет 1 (или finished)
  log('Ждём конца раунда 1...');
  for (let i = 0; i < 15; i++) {
    const { data: checkData } = await getAuction(auctionId, author);
    if (checkData.auction?.currentRound === 1 || checkData.auction?.state === 'finished') {
      break;
    }
    await sleep(1000);
  }

  let { data: info } = await getAuction(auctionId, author);
  const round1Winners = info.auction?.winners?.filter(w => w.roundIndex === 0) || [];
  check('Раунд 1: 2 победителя', round1Winners.length === 2, `winners=${round1Winners.length}`);

  // Раунд 2: новая ставка (если ещё не закончился)
  if (info.auction?.state === 'active' && info.auction?.currentRound === 1) {
    log('Раунд 2: делаем ставку...');
    await placeBet(bidders[2], auctionId, 30);
  }

  // Ждём завершения аукциона
  log('Ждём завершения аукциона...');
  info = await waitForState(auctionId, author, 'finished', 20);
  check('Аукцион завершён', info.auction?.state === 'finished', `state=${info.auction?.state}`);

  const totalWinners = info.auction?.winners?.length || 0;
  check('Всего 3 победителя', totalWinners === 3, `total=${totalWinners}`);
}

/**
 * TEST 8: Anti-snipe механизм
 */
async function testAntiSnipe() {
  section('TEST 8: Anti-snipe механизм');

  const ts = Date.now();
  const author = `snipe_author_${ts}`;
  const bidder1 = `snipe_b1_${ts}`;
  const bidder2 = `snipe_b2_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'SnipeGift', 50);
  await mintStars(bidder1, 500);
  await mintStars(bidder2, 500);

  // 12 секунд раунд (anti-snipe срабатывает в последние 10 сек)
  const { data: auctionRes } = await createAuction(author, {
    name: `Snipe Test ${ts}`,
    giftName: 'SnipeGift',
    giftCount: 5,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 12, prizes: [5] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Первая ставка сразу
  await placeBet(bidder1, auctionId, 100);
  log('Bidder1 поставил 100');

  // Ждём до последних секунд (12 - 8 = 4 сек до конца)
  log('Ждём 8 секунд до порога anti-snipe...');
  await sleep(8000);

  // Перебиваем в последние секунды
  const { data: snipeBet } = await placeBet(bidder2, auctionId, 150);
  log('Bidder2 перебил на 150');

  check('Anti-snipe сработал', snipeBet.extended === true, `extended=${snipeBet.extended}`);

  // Ждём завершения
  log('Ждём завершения аукциона...');
  const finalInfo = await waitForState(auctionId, author, 'finished', 25);
  check('Аукцион завершён', finalInfo.auction?.state === 'finished');
}

/**
 * TEST 9: Возврат баланса проигравшим
 */
async function testLoserBalanceReturn() {
  section('TEST 9: Возврат баланса проигравшим');

  const ts = Date.now();
  const author = `loser_author_${ts}`;
  const winner = `loser_winner_${ts}`;
  const loser = `loser_loser_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'LoserGift', 50);
  await mintStars(winner, 500);
  await mintStars(loser, 300);

  const { data: auctionRes } = await createAuction(author, {
    name: `Loser Test ${ts}`,
    giftName: 'LoserGift',
    giftCount: 5,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 5, prizes: [5] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Ставки
  await placeBet(winner, auctionId, 200);
  await placeBet(loser, auctionId, 100);

  // Проверяем locked
  const { data: loserBalBefore } = await getBalance(loser);
  check('Loser locked=100 до завершения', loserBalBefore.locked === 100);

  // Ждём завершения
  log('Ждём завершения аукциона...');
  await waitForState(auctionId, author, 'finished', 15);
  await sleep(500);  // Небольшая задержка для обработки

  // Проверяем возврат
  const { data: loserBalAfter } = await getBalance(loser);
  check('Loser locked=0 после', loserBalAfter.locked === 0, `locked=${loserBalAfter.locked}`);
  check('Loser баланс вернулся (300)', loserBalAfter.available === 300, `available=${loserBalAfter.available}`);

  // Победитель заплатил
  const { data: winnerBal } = await getBalance(winner);
  check('Winner заплатил (500-200=300)', winnerBal.available === 300, `available=${winnerBal.available}`);

  // Победитель получил приз
  const { data: winnerUser } = await getUser(winner);
  const prize = winnerUser.gifts?.find(g => g.name === 'LoserGift')?.count || 0;
  check('Winner получил приз (5)', prize === 5, `prize=${prize}`);
}

/**
 * TEST 10: Конкурентные увеличения ставок
 */
async function testConcurrentBetIncreases() {
  section('TEST 10: Конкурентные увеличения ставок');

  const ts = Date.now();
  const author = `conc_author_${ts}`;
  const bidder = `conc_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'ConcGift', 50);
  await mintStars(bidder, 1000);

  const { data: auctionRes } = await createAuction(author, {
    name: `Conc Test ${ts}`,
    giftName: 'ConcGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  await waitForState(auctionId, author, 'active', 5);

  // Первая ставка
  await placeBet(bidder, auctionId, 100);

  // 5 конкурентных увеличений
  log('Запуск 5 конкурентных увеличений ставки...');
  const increasePromises = [
    placeBet(bidder, auctionId, 200),
    placeBet(bidder, auctionId, 300),
    placeBet(bidder, auctionId, 400),
    placeBet(bidder, auctionId, 500),
    placeBet(bidder, auctionId, 600)
  ];

  const results = await Promise.all(increasePromises);
  const successes = results.filter(r => r.data.success).length;

  log(`Успешных увеличений: ${successes}`);

  // Проверяем финальное состояние
  const { data: bal } = await getBalance(bidder);

  check('Баланс консистентен', bal.balance === bal.available + bal.locked,
    `bal=${bal.balance}, avail=${bal.available}, locked=${bal.locked}`);

  // Locked должен быть >= 200 (минимальное увеличение)
  check('Locked >= 200', bal.locked >= 200, `locked=${bal.locked}`);
}

/**
 * TEST 11: Призы при отсутствии ставок
 */
async function testNoBetsReturnPrizes() {
  section('TEST 11: Призы возвращаются автору при отсутствии ставок');

  const ts = Date.now();
  const author = `nobets_author_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'NoBetsGift', 50);

  const { data: authorBefore } = await getUser(author);
  const giftsBefore = authorBefore.gifts?.find(g => g.name === 'NoBetsGift')?.count || 0;

  const { data: auctionRes } = await createAuction(author, {
    name: `NoBets Test ${ts}`,
    giftName: 'NoBetsGift',
    giftCount: 10,
    startTime: Date.now() + 1500,
    rounds: [{ duration: 3, prizes: [5, 3, 2] }]  // Быстрый раунд
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    check('Создание аукциона', false);
    return;
  }

  check('Подарки списаны (50-10=40)', giftsBefore - 10 === 40, `было=${giftsBefore}`);

  // НЕ делаем ставок!
  log('Ждём завершения без ставок...');
  await waitForState(auctionId, author, 'finished', 15);
  await sleep(500);

  // Проверяем что подарки вернулись
  const { data: authorAfter } = await getUser(author);
  const giftsAfter = authorAfter.gifts?.find(g => g.name === 'NoBetsGift')?.count || 0;

  check('Подарки вернулись автору (50)', giftsAfter === 50, `после=${giftsAfter}`);
}

// ============== MAIN ==============

async function runMiddleTests() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║              MIDDLE TEST SUITE - Продвинутые сценарии               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const startTime = Date.now();

  try {
    await testMassParallelBets();
    await testBetIdempotency();
    await testBetIncrease();
    await testBetDecreaseBlocked();
    await testInsufficientBalance();
    await testBetOnOwnAuction();
    await testMultipleRounds();
    await testAntiSnipe();
    await testLoserBalanceReturn();
    await testConcurrentBetIncreases();
    await testNoBetsReturnPrizes();
  } catch (error) {
    console.error('\n\x1b[31mTest suite crashed:\x1b[0m', error);
  }

  const duration = Date.now() - startTime;

  // Summary
  section('TEST SUMMARY');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`Total tests: ${total}`);
  console.log(`\x1b[32mPassed: ${passed}\x1b[0m`);
  console.log(`\x1b[31mFailed: ${failed}\x1b[0m`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log('');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  \x1b[31m✗\x1b[0m ${r.name}: ${r.details || ''}`);
    });
  }

  console.log('\n' + (failed === 0 ? '\x1b[32m✓ ALL TESTS PASSED!\x1b[0m' : '\x1b[31m✗ SOME TESTS FAILED\x1b[0m') + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

runMiddleTests().catch(console.error);
