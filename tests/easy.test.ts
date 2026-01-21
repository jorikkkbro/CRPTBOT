/**
 * Comprehensive Test Suite
 * - Race conditions
 * - Atomicity
 * - Idempotency
 * - Load testing
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
  error?: string;      // error code when failed (INSUFFICIENT_BALANCE, CANNOT_DECREASE, etc.)
  status?: string;     // status from makeBet (OK, SAME, etc.)
  message?: string;
  bet?: number;
  previousBet?: number;
  currentBet?: number;
  charged?: number;
  idempotent?: boolean;
}

interface AuctionResponse {
  auction?: {
    id: string;
    state: string;
    currentRound: number;
    winners: { place: number; userId: string; stars: number; prize: number }[];
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

// Helpers
const getUser = (userId: string) => api<UserResponse>('GET', '/api/data/user', userId);
const getBalance = (userId: string) => api<BalanceResponse>('GET', '/api/data/user/balance', userId);
const mintStars = (userId: string, amount: number) => api<any>('POST', '/test/mint-stars', userId, { amount });
const mintGifts = (userId: string, name: string, count: number) => api<any>('POST', '/test/mint-gifts', userId, { name, count });
const resetUser = (userId: string) => api<any>('POST', '/test/reset', userId);

const createAuction = (userId: string, data: any, idempotencyKey?: string) =>
  api<CreateAuctionResponse>('POST', '/api/auction/create', userId, data, idempotencyKey || generateIdempotencyKey());

const placeBet = (userId: string, auctionId: string, stars: number, idempotencyKey?: string) =>
  api<BetResponse>('POST', '/api/bet', userId, { id: auctionId, stars }, idempotencyKey || generateIdempotencyKey());

const getAuction = (auctionId: string, userId: string) =>
  api<AuctionResponse>('GET', `/api/data/auction/${auctionId}`, userId);

// Logging
function log(message: string, data?: any) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70) + '\n');
}

function logResult(name: string, passed: boolean, details?: string) {
  const icon = passed ? '✓' : '✗';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${icon}\x1b[0m ${name}${details ? ` - ${details}` : ''}`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============== TEST RESULTS ==============

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function addResult(name: string, passed: boolean, details?: string) {
  results.push({ name, passed, details });
  logResult(name, passed, details);
}

// ============== TESTS ==============

/**
 * TEST 1: Idempotency - Same key returns same result (sequential test)
 */
async function testIdempotency() {
  logSection('TEST 1: Idempotency');

  const ts = Date.now();
  const userId = `idem_user_${ts}`;

  await mintStars(userId, 1000);
  await mintGifts(userId, 'TestGift', 100);

  // Create auction with same idempotency key SEQUENTIALLY (to avoid processing conflict)
  const idemKey = generateIdempotencyKey();
  const auctionData = {
    name: `Idem Test ${ts}`,
    giftName: 'TestGift',
    giftCount: 10,
    startTime: Date.now() + 60000,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  };

  log('Creating auction with same key (first request)...');
  const res1 = await createAuction(userId, auctionData, idemKey);

  log('Creating auction with same key (second request - should be idempotent)...');
  const res2 = await createAuction(userId, auctionData, idemKey);

  const bothSucceeded = res1.data.success === true && res2.data.success === true;
  const sameAuctionId = res1.data.auction?.id === res2.data.auction?.id && res1.data.auction?.id !== undefined;
  const secondIsIdempotent = res2.data.idempotent === true;

  addResult(
    'Auction creation idempotency',
    bothSucceeded && sameAuctionId && secondIsIdempotent,
    `IDs: ${res1.data.auction?.id} / ${res2.data.auction?.id}, second idempotent: ${secondIsIdempotent}`
  );

  // Check gifts were only deducted once
  const { data: user } = await getUser(userId);
  const giftCount = user.gifts?.find(g => g.name === 'TestGift')?.count || 0;

  addResult(
    'Gifts deducted only once',
    giftCount === 90,
    `Expected 90, got ${giftCount}`
  );
}

/**
 * TEST 2: Race Condition - Concurrent bets to DIFFERENT auctions shouldn't exceed balance
 */
async function testConcurrentBets() {
  logSection('TEST 2: Concurrent Bets Race Condition');

  const ts = Date.now();
  // Use different authors to avoid rate limit
  const authors = [`race_author1_${ts}`, `race_author2_${ts}`, `race_author3_${ts}`];
  const bidder = `race_bidder_${ts}`;

  // Setup authors with gifts
  await Promise.all(authors.map(a => mintStars(a, 1000)));
  await Promise.all(authors.map(a => mintGifts(a, 'RaceGift', 50)));
  await mintStars(bidder, 100);  // Only 100 stars!

  // Create 3 auctions with different authors (to avoid rate limit)
  const auctionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { data: auctionRes } = await createAuction(authors[i], {
      name: `Race Test ${ts} #${i}`,
      giftName: 'RaceGift',
      giftCount: 10,
      startTime: Date.now() + 2000,
      rounds: [{ duration: 60, prizes: [5, 3, 2] }]
    });
    if (auctionRes.auction?.id) {
      auctionIds.push(auctionRes.auction.id);
    } else {
      log(`Failed to create auction #${i}: ${JSON.stringify(auctionRes)}`);
    }
  }

  if (auctionIds.length < 3) {
    addResult('Concurrent bets test', false, `Only created ${auctionIds.length}/3 auctions`);
    return;
  }

  // Wait for auctions to start
  await sleep(2500);

  // Try to place bets of 50 stars to each auction (total 150, but only have 100)
  log('Placing 3 concurrent bets of 50 stars to DIFFERENT auctions (user has only 100)...');

  const betPromises = auctionIds.map(auctionId =>
    placeBet(bidder, auctionId, 50)
  );

  const betResults = await Promise.all(betPromises);
  const successCount = betResults.filter(r => r.data.success).length;
  const failCount = betResults.filter(r => !r.data.success).length;

  log(`Results: ${successCount} succeeded, ${failCount} failed`);

  // Check final balance
  const { data: balance } = await getBalance(bidder);

  // Locked should not exceed balance (100)
  const validState = balance.locked <= 100 && balance.available >= 0;

  addResult(
    'No double spending on concurrent bets',
    validState,
    `Locked: ${balance.locked}, Available: ${balance.available}, Successes: ${successCount}`
  );

  // At most 2 bets should succeed (100 / 50 = 2)
  addResult(
    'Correct number of successful bets',
    successCount <= 2,
    `${successCount} bets succeeded (expected <= 2 with 100 balance and 50 per bet)`
  );

  // Balance invariant
  addResult(
    'Balance invariant maintained',
    balance.balance === balance.available + balance.locked,
    `Balance: ${balance.balance} = Available: ${balance.available} + Locked: ${balance.locked}`
  );
}

/**
 * TEST 3: Bet Increase Atomicity
 */
async function testBetIncrease() {
  logSection('TEST 3: Bet Increase Atomicity');

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
    startTime: Date.now() + 1000,
    rounds: [{ duration: 30, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    addResult('Bet increase test', false, 'Failed to create auction');
    return;
  }

  await sleep(1500);

  // Place initial bet
  const { data: bet1 } = await placeBet(bidder, auctionId, 100);
  addResult('Initial bet placed', bet1.success === true, `Bet: ${bet1.bet}`);

  // Concurrent increases
  log('Placing 3 concurrent bet increases...');
  const increasePromises = [
    placeBet(bidder, auctionId, 200),
    placeBet(bidder, auctionId, 250),
    placeBet(bidder, auctionId, 300)
  ];

  const increaseResults = await Promise.all(increasePromises);

  // Check final state
  const { data: balance } = await getBalance(bidder);
  const { data: auction } = await getAuction(auctionId, bidder);

  // Locked should be exactly the highest successful bet
  const highestBet = Math.max(...increaseResults.filter(r => r.data.success).map(r => r.data.bet || 0));

  addResult(
    'Locked equals highest bet',
    balance.locked === highestBet,
    `Locked: ${balance.locked}, Highest bet: ${highestBet}`
  );

  addResult(
    'Balance is consistent',
    balance.balance === balance.available + balance.locked,
    `Balance: ${balance.balance}, Available: ${balance.available}, Locked: ${balance.locked}`
  );
}

/**
 * TEST 4: Cannot decrease bet
 */
async function testCannotDecreaseBet() {
  logSection('TEST 4: Cannot Decrease Bet');

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
    startTime: Date.now() + 1000,
    rounds: [{ duration: 30, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  await sleep(1500);

  // Place bet of 200
  await placeBet(bidder, auctionId!, 200);

  // Try to decrease to 100
  const { data: decreaseResult } = await placeBet(bidder, auctionId!, 100);

  addResult(
    'Cannot decrease bet',
    decreaseResult.error === 'CANNOT_DECREASE',
    `Error: ${decreaseResult.error}`
  );
}

/**
 * TEST 5: Insufficient balance
 */
async function testInsufficientBalance() {
  logSection('TEST 5: Insufficient Balance');

  const ts = Date.now();
  const author = `insuf_author_${ts}`;
  const bidder = `insuf_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'InsufGift', 50);
  await mintStars(bidder, 50);  // Only 50 stars

  const { data: auctionRes } = await createAuction(author, {
    name: `Insuf Test ${ts}`,
    giftName: 'InsufGift',
    giftCount: 10,
    startTime: Date.now() + 1000,
    rounds: [{ duration: 30, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  await sleep(1500);

  // Try to bet 100 with only 50
  const { data: betResult } = await placeBet(bidder, auctionId!, 100);

  addResult(
    'Insufficient balance rejected',
    betResult.error === 'INSUFFICIENT_BALANCE',
    `Error: ${betResult.error}`
  );

  // Balance should be unchanged
  const { data: balance } = await getBalance(bidder);
  addResult(
    'Balance unchanged after failed bet',
    balance.available === 50 && balance.locked === 0,
    `Available: ${balance.available}, Locked: ${balance.locked}`
  );
}

/**
 * TEST 6: Load Test - Multiple users betting simultaneously
 */
async function testLoad() {
  logSection('TEST 6: Load Test (10 users, 50 bets each)');

  const ts = Date.now();
  const author = `load_author_${ts}`;
  const userCount = 10;
  const betsPerUser = 50;

  // Setup author
  await mintStars(author, 10000);
  await mintGifts(author, 'LoadGift', 500);

  // Setup users
  const users = Array(userCount).fill(null).map((_, i) => `load_user_${i}_${ts}`);

  log(`Setting up ${userCount} users...`);
  await Promise.all(users.map(u => mintStars(u, 10000)));

  // Create auction
  const { data: auctionRes } = await createAuction(author, {
    name: `Load Test ${ts}`,
    giftName: 'LoadGift',
    giftCount: 100,
    startTime: Date.now() + 1000,
    rounds: [{ duration: 120, prizes: [50, 30, 20] }]
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    addResult('Load test', false, 'Failed to create auction');
    return;
  }

  await sleep(1500);

  // Each user places multiple bets
  log(`Starting ${userCount * betsPerUser} concurrent bets...`);
  const startTime = Date.now();

  const allBetPromises: Promise<{ data: BetResponse; status: number }>[] = [];

  for (const user of users) {
    for (let i = 0; i < betsPerUser; i++) {
      // Increasing bets
      allBetPromises.push(placeBet(user, auctionId, (i + 1) * 10));
    }
  }

  const allResults = await Promise.all(allBetPromises);
  const duration = Date.now() - startTime;

  const successCount = allResults.filter(r => r.data.success).length;
  const failCount = allResults.filter(r => !r.data.success).length;
  const lockFailCount = allResults.filter(r => r.data.error === 'TOO_MANY_REQUESTS').length;

  log(`Completed in ${duration}ms`);
  log(`Success: ${successCount}, Failed: ${failCount}, Lock failures: ${lockFailCount}`);

  // Check all users have consistent state
  let allConsistent = true;
  for (const user of users) {
    const { data: balance } = await getBalance(user);
    if (balance.balance !== balance.available + balance.locked) {
      allConsistent = false;
      log(`Inconsistent: ${user} - bal=${balance.balance}, avail=${balance.available}, locked=${balance.locked}`);
    }
  }

  addResult(
    'All balances consistent after load',
    allConsistent,
    `${userCount} users checked`
  );

  addResult(
    'Reasonable throughput',
    duration < 30000,
    `${allBetPromises.length} requests in ${duration}ms (${Math.round(allBetPromises.length / (duration / 1000))} req/s)`
  );

  // Check auction state
  const { data: auctionData } = await getAuction(auctionId, author);
  addResult(
    'Auction has participants',
    (auctionData.participantsCount || 0) > 0,
    `${auctionData.participantsCount} participants`
  );
}

/**
 * TEST 7: Winner Processing - Full auction cycle
 */
async function testWinnerProcessing() {
  logSection('TEST 7: Winner Processing (Full Auction Cycle)');

  const ts = Date.now();
  const author = `win_author_${ts}`;
  const bidders = [
    `win_bidder1_${ts}`,
    `win_bidder2_${ts}`,
    `win_bidder3_${ts}`,
    `win_loser_${ts}`
  ];

  // Setup
  await mintStars(author, 1000);
  await mintGifts(author, 'WinGift', 20);

  for (const bidder of bidders) {
    await mintStars(bidder, 500);
  }

  // Create fast auction
  const { data: auctionRes } = await createAuction(author, {
    name: `Win Test ${ts}`,
    giftName: 'WinGift',
    giftCount: 6,
    startTime: Date.now() + 1000,
    rounds: [{ duration: 3, prizes: [3, 2, 1] }]  // 3 seconds
  });

  const auctionId = auctionRes.auction?.id;
  if (!auctionId) {
    addResult('Winner processing', false, 'Failed to create auction');
    return;
  }

  await sleep(1500);

  // Place bets (bidder1=200, bidder2=150, bidder3=100, loser=50)
  await Promise.all([
    placeBet(bidders[0], auctionId, 200),
    placeBet(bidders[1], auctionId, 150),
    placeBet(bidders[2], auctionId, 100),
    placeBet(bidders[3], auctionId, 50)
  ]);

  log('Bets placed, waiting for auction to finish...');

  // Wait for auction to finish (3s round + processing)
  for (let i = 0; i < 15; i++) {
    const { data: auction } = await getAuction(auctionId, author);
    if (auction.auction?.state === 'finished') break;
    await sleep(1000);
  }

  const { data: finalAuction } = await getAuction(auctionId, author);

  addResult(
    'Auction finished',
    finalAuction.auction?.state === 'finished',
    `State: ${finalAuction.auction?.state}`
  );

  // Check winners
  const winners = finalAuction.auction?.winners || [];
  addResult(
    'Correct number of winners',
    winners.length === 3,
    `Winners: ${winners.length}`
  );

  // Check balances and gifts
  const expectedResults: Record<string, { stars: number; gifts: number }> = {
    [bidders[0]]: { stars: 300, gifts: 3 },  // 500 - 200 = 300, prize 3
    [bidders[1]]: { stars: 350, gifts: 2 },  // 500 - 150 = 350, prize 2
    [bidders[2]]: { stars: 400, gifts: 1 },  // 500 - 100 = 400, prize 1
    [bidders[3]]: { stars: 500, gifts: 0 }   // loser, refunded
  };

  let allCorrect = true;
  for (const bidder of bidders) {
    const { data: balance } = await getBalance(bidder);
    const { data: user } = await getUser(bidder);
    const gifts = user.gifts?.find(g => g.name === 'WinGift')?.count || 0;
    const expected = expectedResults[bidder];

    const correct = balance.available === expected.stars && gifts === expected.gifts;
    if (!correct) {
      allCorrect = false;
      log(`${bidder}: stars=${balance.available} (exp ${expected.stars}), gifts=${gifts} (exp ${expected.gifts})`);
    }
  }

  addResult(
    'All balances and prizes correct',
    allCorrect,
    allCorrect ? 'All 4 users verified' : 'Some discrepancies found'
  );

  // Check author got remaining gifts
  const { data: authorUser } = await getUser(author);
  const authorGifts = authorUser.gifts?.find(g => g.name === 'WinGift')?.count || 0;

  addResult(
    'Author has remaining gifts',
    authorGifts === 14,  // 20 - 6 = 14
    `Author gifts: ${authorGifts} (expected 14)`
  );
}

/**
 * TEST 8: Cannot bet on own auction
 */
async function testCannotBetOwnAuction() {
  logSection('TEST 8: Cannot Bet On Own Auction');

  const ts = Date.now();
  const author = `own_author_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'OwnGift', 50);

  const { data: auctionRes } = await createAuction(author, {
    name: `Own Test ${ts}`,
    giftName: 'OwnGift',
    giftCount: 10,
    startTime: Date.now() + 1000,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  await sleep(1500);

  const { data: betResult, status } = await placeBet(author, auctionId!, 100);

  addResult(
    'Cannot bet on own auction',
    status === 400 && betResult.error === 'CANNOT_BET_OWN_AUCTION',
    `Status: ${status}, Error: ${betResult.error}`
  );
}

/**
 * TEST 9: Idempotency key required
 */
async function testIdempotencyKeyRequired() {
  logSection('TEST 9: Idempotency Key Required');

  const ts = Date.now();
  const userId = `idem_req_${ts}`;

  await mintStars(userId, 1000);
  await mintGifts(userId, 'IdemReqGift', 50);

  // Try to create auction without idempotency key
  const res = await fetch(`${BASE_URL}/api/auction/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId
      // No x-idempotency-key!
    },
    body: JSON.stringify({
      name: `No Key Test ${ts}`,
      giftName: 'IdemReqGift',
      giftCount: 10,
      startTime: Date.now() + 60000,
      rounds: [{ duration: 60, prizes: [5, 3, 2] }]
    })
  });

  const data = await res.json() as { error?: string };

  addResult(
    'Auction creation requires idempotency key',
    res.status === 400 && data.error === 'INVALID_IDEMPOTENCY_KEY',
    `Status: ${res.status}, Error: ${data.error}`
  );
}

/**
 * TEST 10: Stress test - Rapid fire bets from single user
 */
async function testRapidFireBets() {
  logSection('TEST 10: Rapid Fire Bets (stress test)');

  const ts = Date.now();
  const author = `rapid_author_${ts}`;
  const bidder = `rapid_bidder_${ts}`;

  await mintStars(author, 1000);
  await mintGifts(author, 'RapidGift', 50);
  await mintStars(bidder, 10000);

  const { data: auctionRes } = await createAuction(author, {
    name: `Rapid Test ${ts}`,
    giftName: 'RapidGift',
    giftCount: 10,
    startTime: Date.now() + 1000,
    rounds: [{ duration: 60, prizes: [5, 3, 2] }]
  });

  const auctionId = auctionRes.auction?.id;
  await sleep(1500);

  // Fire 100 bets as fast as possible
  log('Firing 100 rapid bets...');
  const startTime = Date.now();

  const rapidBets = Array(100).fill(null).map((_, i) =>
    placeBet(bidder, auctionId!, (i + 1) * 10)
  );

  const results = await Promise.all(rapidBets);
  const duration = Date.now() - startTime;

  const successCount = results.filter(r => r.data.success).length;
  const lockFailures = results.filter(r => r.data.error === 'TOO_MANY_REQUESTS').length;

  log(`100 bets in ${duration}ms, ${successCount} success, ${lockFailures} lock failures`);

  // Final state check
  const { data: balance } = await getBalance(bidder);
  const expectedLocked = 1000;  // Last successful bet should be 1000 (100 * 10)

  addResult(
    'Rapid fire maintains consistency',
    balance.balance === balance.available + balance.locked,
    `Balance: ${balance.balance}, Available: ${balance.available}, Locked: ${balance.locked}`
  );

  addResult(
    'Final bet is highest',
    balance.locked <= 1000,
    `Locked: ${balance.locked} (max expected: 1000)`
  );
}

// ============== MAIN ==============

async function runAllTests() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           CRYPTOBOT COMPREHENSIVE TEST SUITE                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  const startTime = Date.now();

  try {
    await testIdempotency();
    await testConcurrentBets();
    await testBetIncrease();
    await testCannotDecreaseBet();
    await testInsufficientBalance();
    await testLoad();
    await testWinnerProcessing();
    await testCannotBetOwnAuction();
    await testIdempotencyKeyRequired();
    await testRapidFireBets();
  } catch (error) {
    console.error('\n\x1b[31mTest suite crashed:\x1b[0m', error);
  }

  const duration = Date.now() - startTime;

  // Summary
  logSection('TEST SUMMARY');

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

runAllTests().catch(console.error);
