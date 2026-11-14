import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageAction } from '../page-api.js';
import { decideRedemption } from '../redemption.js';

const TARGET = { userId: 101, email: 'redeemer@example.invalid' };
const OTHER = { userId: 202, email: 'other@example.invalid' };
const PLANS = {
  plan100: { points: 100, days: 10 },
  plan200: { points: 200, days: 30 },
  plan500: { points: 500, days: 100 }
};
const clone = value => JSON.parse(JSON.stringify(value));
const reply = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => clone(payload)
});
const decisionFor = (points = 400, leftDays = 2) => decideRedemption({
  points, leftDays, plans: clone(PLANS),
  history: [{ business: 'system:checkin', time: 1700000000000, change: 10 }]
});

// A stateful native-API model, not a queue of implementation-specific responses.
// Hooks can corrupt live state or lose a response; fetch never reaches the network.
async function execute({
  decision = decisionFor(), points = decision.balance, leftDays = decision.leftDays,
  identity = TARGET, noSwitch = false, onRequest = () => undefined
} = {}) {
  const state = { ...identity, points, leftDays, plans: clone(PLANS) };
  const calls = [];
  const counts = new Map();
  const waits = [];
  const fetch = async (url, options) => {
    const ordinal = (counts.get(url) || 0) + 1;
    counts.set(url, ordinal);
    const call = { url, options, ordinal, email: state.email,
      body: options.body === undefined ? null : JSON.parse(options.body) };
    calls.push(call);
    const override = await onRequest({ ...call, state, calls });
    if (override !== undefined) return override;
    if (url === '/api/user/status') {
      return reply({ code: 0, data: { userId: state.userId, email: state.email, leftDays: String(state.leftDays) } });
    }
    if (url === '/api/user/points') {
      return reply({ code: 0, points: String(state.points), plans: state.plans });
    }
    if (url === '/api/user/accounts/switch') {
      if (!noSwitch) Object.assign(state, TARGET);
      return reply({ code: 0 });
    }
    if (url === '/api/user/exchange') {
      const offer = state.plans[call.body?.planType];
      if (!offer || state.points < offer.points) return reply({ code: 4, message: 'Fixture rejects invalid exchange' });
      state.points -= offer.points;
      state.leftDays += offer.days;
      return reply({ code: 0, message: 'Fixture exchange acknowledged' });
    }
    throw new Error('Unexpected mock endpoint ' + url);
  };
  const raw = await vm.runInNewContext('(' + pageAction.toString() + ')(' + JSON.stringify({
    op: 'redeem', account: TARGET, decision
  }) + ')', {
    fetch, AbortSignal, location: { hostname: 'glados.cloud', pathname: '/console/checkin' },
    setTimeout(callback, milliseconds) {
      waits.push(milliseconds);
      queueMicrotask(callback);
      return waits.length;
    }
  });
  // Check transport outside pageAction's catch, so mock/protocol errors cannot
  // masquerade as the expected business failure in a negative test.
  const methods = {
    '/api/user/status': 'GET', '/api/user/points': 'GET',
    '/api/user/accounts/switch': 'POST', '/api/user/exchange': 'POST'
  };
  for (const call of calls) {
    assert.ok(Object.hasOwn(methods, call.url), 'Only native redemption/account endpoints are permitted');
    assert.equal(call.options.method, methods[call.url]);
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.cache, 'no-store');
    if (call.options.method === 'GET') assert.equal(call.body, null);
    if (call.url === '/api/user/accounts/switch') assert.deepEqual(call.body, { userId: TARGET.userId });
    if (call.url === '/api/user/exchange') {
      assert.deepEqual(Object.keys(call.body || {}), ['planType']);
      assert.equal(typeof call.body.planType, 'string');
      assert.equal(call.options.headers['Content-Type'].split(';')[0], 'application/json');
    }
  }
  return { result: clone(raw), calls, state, waits };
}

const exchanges = run => run.calls.filter(call => call.url === '/api/user/exchange');
function assertFailed(run, attempts, { receipts = 0, unknown } = {}) {
  assert.equal(run.result.ok, false, 'An unverified or rejected operation must not report success');
  assert.equal(exchanges(run).length, attempts, 'Never replay or continue a failed exchange');
  assert.equal((run.result.receipts || []).length, receipts);
  assert.equal(run.result.checkinAttempted, false);
  assert.equal(typeof run.result.message, 'string');
  assert.ok(run.result.message.length > 0, 'Failure must remain visible');
  if (unknown !== undefined) assert.equal(run.result.unknown, unknown);
}
function receiptValues(receipts) {
  return receipts.map(({ planType, points, days, confirmed, verified, beforePoints, afterPoints, beforeDays, afterDays }) =>
    ({ planType, points, days, confirmed, verified, beforePoints, afterPoints, beforeDays, afterDays }));
}
function assertSuccessful(run, { spent, gained, points, days, types }) {
  assert.equal(run.result.ok, true);
  assert.equal(run.result.stage, 'redeemed');
  assert.equal(run.result.spentPoints, spent);
  assert.equal(run.result.gainedDays, gained);
  assert.equal(Number(run.result.points), points);
  assert.equal(Number(run.result.leftDays), days);
  assert.equal(run.state.points, points);
  assert.equal(run.state.leftDays, days);
  assert.deepEqual(exchanges(run).map(call => call.body.planType), types);
  assert.equal(run.result.receipts.length, types.length);
  assert.ok(run.result.receipts.every(receipt => receipt.confirmed === true && receipt.verified === true));
}

test('400 points executes two native 200-point exchanges and returns two independently verified receipts', async () => {
  const decision = decisionFor();
  assert.deepEqual(decision.steps, [{ planType: 'plan200', points: 200, days: 30, count: 2 }]);
  const run = await execute({ decision });
  assertSuccessful(run, { spent: 400, gained: 60, points: 0, days: 62, types: ['plan200', 'plan200'] });
  assert.deepEqual(receiptValues(run.result.receipts), [
    { planType: 'plan200', points: 200, days: 30, confirmed: true, verified: true,
      beforePoints: 400, afterPoints: 200, beforeDays: 2, afterDays: 32 },
    { planType: 'plan200', points: 200, days: 30, confirmed: true, verified: true,
      beforePoints: 200, afterPoints: 0, beforeDays: 32, afterDays: 62 }
  ]);
});

for (const [balance, count] of [[700, 1], [1200, 2]]) {
  test(`${balance} points spends only the planned 500-point tiers and retains 200 points`, async () => {
    const decision = decisionFor(balance);
    assert.deepEqual(decision.steps, [{ planType: 'plan500', points: 500, days: 100, count }]);
    assert.equal(decision.remainingPoints, 200);
    const run = await execute({ decision });
    assertSuccessful(run, { spent: 500 * count, gained: 100 * count, points: 200,
      days: 2 + 100 * count, types: Array(count).fill('plan500') });
  });
}

test('switches once and verifies the target email before spending', async () => {
  const run = await execute({ identity: OTHER, decision: decisionFor(700) });
  assertSuccessful(run, { spent: 500, gained: 100, points: 200, days: 102, types: ['plan500'] });
  assert.equal(run.calls.filter(call => call.url === '/api/user/accounts/switch').length, 1);
  assert.ok(exchanges(run).every(call => call.email === TARGET.email));
});

test('a successful switch response without an email change submits no exchange', async () => {
  const run = await execute({ identity: OTHER, noSwitch: true });
  assertFailed(run, 0, { unknown: false });
  assert.equal(run.state.points, 400);
  assert.equal(run.calls.filter(call => call.url === '/api/user/accounts/switch').length, 1);
});

test('a rejected switch submits no exchange', async () => {
  const run = await execute({ identity: OTHER, onRequest({ url }) {
    if (url === '/api/user/accounts/switch') return reply({ code: 4, message: 'Fixture switch rejected' }, 403);
  } });
  assertFailed(run, 0, { unknown: false });
  assert.equal(run.state.points, 400);
});

test('an email change during preflight submits no exchange', async () => {
  const run = await execute({ onRequest({ url, ordinal, state }) {
    if (url === '/api/user/status' && ordinal === 2) Object.assign(state, OTHER);
  } });
  assertFailed(run, 0, { unknown: false });
});

for (const [label, url, ordinal, mutate] of [
  ['stale decision balance', '/api/user/points', 1, state => { state.points = 399; }],
  ['initial tier changed', '/api/user/points', 1, state => { state.plans.plan200.days = 29; }],
  ['initial tier disappeared', '/api/user/points', 1, state => { delete state.plans.plan200; }],
  ['balance changed just before POST', '/api/user/points', 2, state => { state.points = 399; }],
  ['tier changed just before POST', '/api/user/points', 2, state => { state.plans.plan200.points = 201; }]
]) {
  test(`${label}: zero exchange submissions`, async () => {
    const run = await execute({ onRequest(event) {
      if (event.url === url && event.ordinal === ordinal) mutate(event.state);
    } });
    assertFailed(run, 0, { unknown: false });
    assert.equal(run.calls.filter(call => call.options.method === 'POST').length, 0);
  });
}

for (const [label, mutate] of [
  ['inconsistent total cost', decision => { decision.spentPoints = 399; }],
  ['inconsistent total days', decision => { decision.gainedDays = 61; }],
  ['fractional count', decision => { decision.steps[0].count = 1.5; }],
  ['unknown plan', decision => { decision.steps[0].planType = 'plan999'; }]
]) {
  test(`${label}: rejects an invalid execution plan without spending`, async () => {
    const decision = decisionFor();
    mutate(decision);
    assertFailed(await execute({ decision }), 0, { unknown: false });
  });
}

test('an exchange timeout after server-side consumption remains unknown and is submitted exactly once', async () => {
  const run = await execute({ onRequest({ url, state }) {
    if (url !== '/api/user/exchange') return;
    state.points -= 200;
    state.leftDays += 30;
    const error = new Error('Fixture response timed out after commit');
    error.name = 'TimeoutError';
    throw error;
  } });
  assertFailed(run, 1, { unknown: true });
  assert.equal(run.state.points, 200);
  assert.equal(run.state.leftDays, 32);
  assert.equal(run.calls.at(-1).url, '/api/user/exchange');
});

test('an unreadable exchange acknowledgement is not replayed', async () => {
  const run = await execute({ onRequest({ url, state }) {
    if (url !== '/api/user/exchange') return;
    state.points -= 200;
    state.leftDays += 30;
    return { ok: true, status: 200, json: async () => { throw new SyntaxError('Fixture truncated JSON'); } };
  } });
  assertFailed(run, 1, { unknown: true });
  assert.equal(run.state.points, 200);
});

for (const [label, points, days] of [
  ['neither balance nor days updated', 400, 2],
  ['only balance updated', 200, 2],
  ['only days updated', 400, 32],
  ['wrong amount deducted', 199, 32],
  ['insufficient validity increase', 200, 12]
]) {
  test(`acknowledged exchange with ${label} stops and never repeats POST`, async () => {
    const run = await execute({ onRequest({ url, state }) {
      if (url !== '/api/user/exchange') return;
      Object.assign(state, { points, leftDays: days });
      return reply({ code: 0, message: 'Fixture acknowledged without matching effects' });
    } });
    assertFailed(run, 1, { receipts: 1, unknown: true });
    assert.equal(run.result.receipts[0].confirmed, true);
    assert.equal(run.result.receipts[0].verified, false);
    assert.equal(run.result.receipts[0].afterPoints, points);
    assert.equal(run.result.receipts[0].afterDays, days);
    const after = run.calls.slice(run.calls.indexOf(exchanges(run)[0]) + 1);
    assert.ok(after.some(call => call.url === '/api/user/points'));
    assert.ok(after.some(call => call.url === '/api/user/status'));
    assert.ok(after.every(call => call.options.method === 'GET'), 'Only observations may be polled');
  });
}

test('eventually visible balance and validity may be polled without repeating the exchange', async () => {
  const run = await execute({ decision: decisionFor(700), onRequest({ url, ordinal, state }) {
    if (url === '/api/user/exchange') return reply({ code: 0, message: 'Fixture pending visibility' });
    if (url === '/api/user/status' && ordinal === 4) Object.assign(state, { points: 200, leftDays: 102 });
  } });
  assertSuccessful(run, { spent: 500, gained: 100, points: 200, days: 102, types: ['plan500'] });
  const after = run.calls.slice(run.calls.indexOf(exchanges(run)[0]) + 1);
  assert.ok(after.filter(call => call.url === '/api/user/status').length >= 2);
  assert.ok(after.filter(call => call.url === '/api/user/points').length >= 2);
  assert.ok(after.every(call => call.options.method === 'GET'));
});

test('the second exchange fails: retains the first verified receipt and never attempts the third', async () => {
  const run = await execute({ decision: decisionFor(1500), onRequest({ url, ordinal }) {
    if (url === '/api/user/exchange' && ordinal === 2) return reply({ code: 4, message: 'Fixture second exchange rejected' }, 503);
  } });
  assertFailed(run, 2, { receipts: 1 });
  assert.deepEqual(receiptValues(run.result.receipts), [
    { planType: 'plan500', points: 500, days: 100, confirmed: true, verified: true,
      beforePoints: 1500, afterPoints: 1000, beforeDays: 2, afterDays: 102 }
  ]);
  assert.equal(run.state.points, 1000);
  assert.equal(Number(run.result.points), 1000);
  assert.equal(Number(run.result.leftDays), 102);
});

for (const [label, url, mutate] of [
  ['email', '/api/user/status', state => { Object.assign(state, OTHER); }],
  ['balance', '/api/user/points', state => { state.points = 199; }],
  ['tier', '/api/user/points', state => { state.plans.plan200.days = 31; }]
]) {
  test(`${label} changes between exchanges: preserves the first receipt and stops before spending again`, async () => {
    const run = await execute({ onRequest(event) {
      if (event.url === url && event.ordinal === 4) mutate(event.state);
    } });
    assertFailed(run, 1, { receipts: 1 });
    assert.equal(run.result.receipts[0].verified, true);
    assert.equal(run.result.receipts[0].afterPoints, 200);
    assert.equal(run.result.receipts[0].afterDays, 32);
  });
}

test('identity changes after acknowledgement: does not verify the receipt or submit another exchange', async () => {
  const run = await execute({ onRequest({ url, ordinal, state }) {
    if (url === '/api/user/status' && ordinal === 3) Object.assign(state, OTHER);
  } });
  assertFailed(run, 1, { receipts: 1, unknown: true });
  assert.equal(run.result.receipts[0].verified, false);
});

test('a verification query failure leaves an unverified receipt and never retries the mutation', async () => {
  const run = await execute({ onRequest({ url, ordinal }) {
    if (url === '/api/user/points' && ordinal === 3) return reply({ code: 4, message: 'Fixture query unavailable' }, 503);
  } });
  assertFailed(run, 1, { receipts: 1, unknown: true });
  assert.equal(run.result.receipts[0].verified, false);
});

test('null balance is missing evidence, not a verified zero balance after spending the full balance', async () => {
  const run = await execute({ decision: decisionFor(200), onRequest({ url, ordinal, state }) {
    if (url === '/api/user/exchange') {
      // Validity changed, but the server has not established any point deduction.
      state.leftDays += 30;
      return reply({ code: 0, message: 'Fixture acknowledgement with incomplete accounting' });
    }
    if (url === '/api/user/points' && ordinal >= 3) return reply({ code: 0, points: null, plans: state.plans });
  } });
  assertFailed(run, 1, { receipts: 1, unknown: true });
  assert.equal(run.result.receipts[0].verified, false, 'A null balance cannot prove a 200-point deduction');
});
