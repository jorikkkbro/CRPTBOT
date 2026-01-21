/**
 * High Load Test - Стресс-тест системы
 *
 * - 100 пользователей
 * - 10 параллельных аукционов
 * - Каждый аукцион: 3 раунда
 * - Постоянные ставки и перебивания
 */

const BASE_URL = 'http://localhost:3000';

// Типы
interface BalanceResponse { balance: number; available: number; locked: number; }
interface UserResponse { id: string; balance: number; gifts: { name: string; count: number }[]; }
interface BetResponse { success?: boolean; error?: string; bet?: number; status?: string; }
interface AuctionResponse {
  auction?: {
    id: string;
    state: string;
    currentRound: number;
    winners: { roundIndex: number; place: number; userId: string; stars: number; prize: number }[];
  };
}
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

const getBalance = (userId: string) => api<BalanceResponse>('GET', '/api/data/user/balance', userId);
const mintStars = (userId: string, amount: number) => api<any>('POST', '/test/mint-stars', userId, { amount });
const mintGifts = (userId: string, name: string, count: number) => api<any>('POST', '/test/mint-gifts', userId, { name, count });
const createAuction = (userId: string, data: any) => api<CreateAuctionResponse>('POST', '/api/auction/create', userId, data);
const placeBet = (userId: string, auctionId: string, stars: number) => api<BetResponse>('POST', '/api/bet', userId, { id: auctionId, stars });
const getAuction = (auctionId: string, userId: string) => api<AuctionResponse>('GET', `/api/data/auction/${auctionId}`, userId);

// Utils
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const section = (t: string) => {
  console.log('');
  console.log('='.repeat(70));
  console.log(`  ${t}`);
  console.log('='.repeat(70));
  console.log('');
};

// Конфигурация теста
const CONFIG = {
  AUTHORS: 10,           // 10 авторов (10 аукционов)
  BIDDERS: 100,          // 100 участников
  ROUNDS_PER_AUCTION: 3, // 3 раунда в каждом аукционе
  ROUND_DURATION: 30,    // 30 секунд на раунд (больше запас до anti-snipe)
  PRIZES_PER_ROUND: [3, 2, 1], // 3 победителя в раунде
  INITIAL_BALANCE: 50000,// Больше баланса чтобы хватило на все ставки
  BET_WAVES: 2,          // 2 волны ставок за раунд
  ANTI_SNIPE_WINDOW: 10, // Последние 10 сек - зона anti-snipe
  SAFE_BUFFER: 5,        // Дополнительный буфер до anti-snipe окна
};

// Статистика
const stats = {
  totalBets: 0,
  successfulBets: 0,
  failedBets: 0,
  errors: new Map<string, number>(),
};

function recordBet(result: BetResponse) {
  stats.totalBets++;
  if (result.success || result.status === 'SAME') {
    stats.successfulBets++;
  } else {
    stats.failedBets++;
    const err = result.error || 'UNKNOWN';
    stats.errors.set(err, (stats.errors.get(err) || 0) + 1);
  }
}

// ============================================
// MAIN TEST
// ============================================

async function runHighLoadTest() {
  section('HIGH LOAD TEST - Стресс-тест');
  const ts = Date.now();

  // Создаём пользователей
  const authors = Array.from({ length: CONFIG.AUTHORS }, (_, i) => `author_${i}_${ts}`);
  const bidders = Array.from({ length: CONFIG.BIDDERS }, (_, i) => `bidder_${i}_${ts}`);

  log(`Создание ${authors.length} авторов и ${bidders.length} участников...`);

  // Выдаём ресурсы авторам
  section('ШАГ 1: Подготовка авторов');
  await Promise.all(
    authors.map(async (author) => {
      await mintStars(author, 50000);
      await mintGifts(author, 'HighLoadGift', 100);
    })
  );
  log(`Авторы готовы`);

  // Выдаём балансы участникам (батчами по 20)
  section('ШАГ 2: Подготовка участников');
  const BATCH_SIZE = 20;
  for (let i = 0; i < bidders.length; i += BATCH_SIZE) {
    const batch = bidders.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(b => mintStars(b, CONFIG.INITIAL_BALANCE)));
    process.stdout.write(`\r  Участники: ${Math.min(i + BATCH_SIZE, bidders.length)}/${bidders.length}`);
  }
  console.log('');
  log(`Участники готовы`);

  // Создаём аукционы
  section('ШАГ 3: Создание аукционов');
  const totalPrizes = CONFIG.PRIZES_PER_ROUND.reduce((a, b) => a + b, 0) * CONFIG.ROUNDS_PER_AUCTION;

  const auctions: string[] = [];
  for (const author of authors) {
    const res = await createAuction(author, {
      name: `HighLoad Auction ${author}`,
      giftName: 'HighLoadGift',
      giftCount: totalPrizes,
      startTime: Date.now() + 3000, // Старт через 3 сек
      rounds: Array.from({ length: CONFIG.ROUNDS_PER_AUCTION }, () => ({
        duration: CONFIG.ROUND_DURATION,
        prizes: CONFIG.PRIZES_PER_ROUND
      }))
    });

    if (res.auction?.id) {
      auctions.push(res.auction.id);
      log(`Аукцион ${auctions.length}: ${res.auction.id}`);
    } else {
      log(`ОШИБКА создания аукциона для ${author}: ${res.error}`);
    }

    await sleep(100); // Небольшая пауза между созданиями
  }

  log(`Создано аукционов: ${auctions.length}`);

  if (auctions.length === 0) {
    log('НЕТ АУКЦИОНОВ - ТЕСТ ПРЕРВАН');
    return;
  }

  // Ждём старта
  section('ШАГ 4: Ожидание старта');
  log('Ждём 4 секунды до старта...');
  await sleep(4000);

  // Проверяем что аукционы активны
  const activeCheck = await getAuction(auctions[0], bidders[0]);
  log(`Статус первого аукциона: ${activeCheck.auction?.state}`);

  // Запускаем волны ставок
  section('ШАГ 5: Волны ставок');

  // Храним текущие ставки каждого участника на каждый аукцион
  const currentBets: Map<string, Map<string, number>> = new Map();
  for (const bidder of bidders) {
    currentBets.set(bidder, new Map());
  }

  // Безопасное время для ставок (до anti-snipe окна минус буфер)
  // 30s раунд - 10s anti-snipe - 5s буфер = 15s для ставок
  const safeWindow = (CONFIG.ROUND_DURATION - CONFIG.ANTI_SNIPE_WINDOW - CONFIG.SAFE_BUFFER) * 1000;
  const wavePause = Math.floor(safeWindow / CONFIG.BET_WAVES);

  for (let round = 0; round < CONFIG.ROUNDS_PER_AUCTION; round++) {
    log(`\n--- РАУНД ${round + 1}/${CONFIG.ROUNDS_PER_AUCTION} ---`);

    // НЕ очищаем ставки! Старый раунд может ещё не завершиться.
    // Ставки в Redis сохраняются пока раунд активен.
    // Наша стратегия: всегда увеличиваем ставку.

    for (let wave = 0; wave < CONFIG.BET_WAVES; wave++) {
      const waveStart = Date.now();
      log(`Волна ${wave + 1}/${CONFIG.BET_WAVES} (безопасная зона, до anti-snipe)...`);

      // Каждый участник ставит на случайный аукцион
      const betPromises = bidders.map(async (bidder, idx) => {
        // Выбираем аукцион (распределяем равномерно)
        const auctionIdx = (idx + wave) % auctions.length;
        const auctionId = auctions[auctionIdx];

        // Получаем текущую ставку этого юзера на этот аукцион
        const bidderBets = currentBets.get(bidder)!;
        const currentBet = bidderBets.get(auctionId) || 0;

        // Новая ставка ВСЕГДА больше предыдущей
        // Базовая + рост по волне + рост по раунду + случайность
        const newBet = currentBet + 100 + wave * 50 + round * 30 + Math.floor(Math.random() * 50);

        try {
          const result = await placeBet(bidder, auctionId, newBet);
          recordBet(result);

          // Запоминаем ставку (успешную или текущую из ошибки)
          if (result.success) {
            bidderBets.set(auctionId, result.bet || newBet);
          } else if (result.error === 'CANNOT_DECREASE' && (result as any).currentBet) {
            // API вернул текущую ставку - обновляем наше знание
            bidderBets.set(auctionId, (result as any).currentBet);
          }
        } catch (e) {
          stats.failedBets++;
          stats.errors.set('NETWORK', (stats.errors.get('NETWORK') || 0) + 1);
        }
      });

      await Promise.all(betPromises);

      const waveTime = Date.now() - waveStart;
      log(`  Волна завершена за ${waveTime}ms, всего ставок: ${stats.totalBets}`);

      // Пауза между волнами (только в безопасной зоне)
      if (wave < CONFIG.BET_WAVES - 1) {
        await sleep(wavePause);
      }
    }

    // Ждём конец раунда: остаток от safe window + anti-snipe + буфер + запас на продления
    // Не фиксированное время, а относительно того сколько ушло на волны
    const remainingRoundTime = CONFIG.ROUND_DURATION * 1000 - safeWindow;
    log(`Ожидание конца раунда ${round + 1}... (${Math.ceil(remainingRoundTime / 1000)}s + запас на anti-snipe)`);
    await sleep(remainingRoundTime + 10000); // +10s на возможные anti-snipe продления
  }

  // Ждём завершения всех аукционов (динамически)
  section('ШАГ 6: Ожидание завершения');
  log('Ждём завершения всех аукционов...');

  const maxWaitTime = 120000; // Максимум 2 минуты
  const checkInterval = 2000;  // Проверяем каждые 2 сек
  const startWait = Date.now();

  while (Date.now() - startWait < maxWaitTime) {
    let allFinished = true;

    for (const auctionId of auctions) {
      const info = await getAuction(auctionId, bidders[0]);
      if (info.auction?.state !== 'finished') {
        allFinished = false;
        break;
      }
    }

    if (allFinished) {
      log('Все аукционы завершены!');
      break;
    }

    const elapsed = Math.round((Date.now() - startWait) / 1000);
    process.stdout.write(`\r  Ожидание... ${elapsed}s`);
    await sleep(checkInterval);
  }
  console.log('');

  // Проверяем результаты
  section('ШАГ 7: Проверка результатов');

  let finishedCount = 0;
  let totalWinners = 0;
  const expectedWinnersPerAuction = CONFIG.PRIZES_PER_ROUND.length * CONFIG.ROUNDS_PER_AUCTION;

  for (const auctionId of auctions) {
    const info = await getAuction(auctionId, bidders[0]);
    if (info.auction?.state === 'finished') {
      finishedCount++;
      totalWinners += info.auction.winners?.length || 0;
    }
    log(`Аукцион ${auctionId}: ${info.auction?.state}, победителей: ${info.auction?.winners?.length || 0}`);
  }

  // Проверяем балансы нескольких случайных участников
  section('ШАГ 8: Проверка балансов');

  const sampleBidders = bidders.slice(0, 10);
  let balanceOk = 0;

  for (const bidder of sampleBidders) {
    try {
      const bal = await getBalance(bidder);
      // Проверяем что данные есть
      if (bal.balance === undefined) {
        log(`${bidder}: ОШИБКА - данные не получены`);
        continue;
      }
      // locked должен быть 0 (все аукционы завершены)
      // available должен равняться balance (нет заблокированных средств)
      const ok = bal.locked === 0 && bal.available === bal.balance;
      if (ok) balanceOk++;
      log(`${bidder}: balance=${bal.balance}, available=${bal.available}, locked=${bal.locked} ${ok ? '✓' : '✗'}`);
    } catch (e) {
      log(`${bidder}: ОШИБКА - ${e}`);
    }
  }

  // Итоги
  section('ИТОГИ');
  console.log(`  Аукционов создано: ${auctions.length}`);
  console.log(`  Аукционов завершено: ${finishedCount}/${auctions.length}`);
  console.log(`  Всего победителей: ${totalWinners}`);
  console.log(`  Ожидалось победителей: ${expectedWinnersPerAuction * auctions.length}`);
  console.log('');
  console.log(`  Всего ставок: ${stats.totalBets}`);
  console.log(`  Успешных: ${stats.successfulBets}`);
  console.log(`  Неудачных: ${stats.failedBets}`);

  if (stats.errors.size > 0) {
    console.log('  Ошибки:');
    for (const [err, count] of stats.errors) {
      console.log(`    ${err}: ${count}`);
    }
  }

  console.log('');
  const allAuctionsFinished = finishedCount === auctions.length;
  const winnersCorrect = totalWinners === expectedWinnersPerAuction * auctions.length;
  const balancesOk = balanceOk === sampleBidders.length;

  const allOk = allAuctionsFinished && winnersCorrect && balancesOk;

  console.log(`  Все аукционы завершены: ${allAuctionsFinished ? '✓' : '✗'}`);
  console.log(`  Победители корректны: ${winnersCorrect ? '✓' : '✗'}`);
  console.log(`  Балансы корректны: ${balancesOk ? '✓' : '✗'}`);
  console.log('');
  console.log(`  ${allOk ? '✓ HIGH LOAD TEST PASSED!' : '✗ HIGH LOAD TEST FAILED!'}`);
  console.log('');
}

runHighLoadTest().catch(console.error);
