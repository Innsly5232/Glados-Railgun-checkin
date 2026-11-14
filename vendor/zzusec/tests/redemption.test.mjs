import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRedemption, maximumDays } from '../redemption.js';

const plans = { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } };
const history = Array.from({ length: 7 }, (_, index) => ({ business: 'system:checkin', time: 100000 - index * 1000, change: '10.00000000' }));
const snapshot = (points, leftDays, extra = {}) => ({ points, leftDays, plans, history, ...extra });

test('prioritizes the 500-point tier and preserves smaller remainder for the next 500', () => {
  const decision = decideRedemption(snapshot('700.000', 1, { history: [] }));
  assert.equal(decision.action, 'redeem');
  assert.equal(decision.mode, 'target');
  assert.deepEqual(decision.steps, [{ planType: 'plan500', points: 500, days: 100, count: 1 }]);
  assert.equal(decision.spentPoints, 500);
  assert.equal(decision.remainingPoints, 200);
});
test('multiple 500-point exchanges do not consume the remaining lower tier', () => {
  const decision = decideRedemption(snapshot(1200, 30));
  assert.equal(decision.spentPoints, 1000);
  assert.equal(decision.gainedDays, 200);
  assert.equal(decision.remainingPoints, 200);
});
test('waits for 500 even when a lower tier is affordable', () => {
  const decision = decideRedemption(snapshot(400, 30));
  assert.equal(decision.action, 'wait');
  assert.equal(decision.estimatedDays, 10);
  assert.equal(decision.neededDays, 11);
});
test('an expiring 400-point balance redeems two 200s for 60 days', () => {
  const decision = decideRedemption(snapshot(400, 10));
  assert.equal(decision.mode, 'expiry');
  assert.equal(decision.action, 'redeem');
  assert.deepEqual(decision.steps, [{ planType: 'plan200', points: 200, days: 30, count: 2 }]);
  assert.equal(decision.gainedDays, 60);
});
test('combines different tiers rather than stopping at one affordable tier', () => {
  const decision = decideRedemption(snapshot(350, 1));
  assert.equal(decision.spentPoints, 300);
  assert.equal(decision.gainedDays, 40);
  assert.equal(decision.remainingPoints, 50);
});
test('one full day of buffer is enough; does not spend at the equality boundary', () => {
  assert.equal(decideRedemption(snapshot(490, 2)).action, 'wait');
  assert.equal(decideRedemption(snapshot(490, 1.99)).action, 'redeem');
});
test('uses only the latest seven positive checkin awards, not bonuses or exchanges', () => {
  const rows = [
    { business: 'system:exchange', time: 999999, change: -100 },
    { business: 'casino:win', time: 999998, change: 1000 },
    ...history.toReversed(),
    { business: 'system:checkin', time: 100, change: 1 },
    { business: 'system:checkin', time: 999999, change: 0 }
  ];
  const decision = decideRedemption(snapshot(400, 30, { history: rows }));
  assert.equal(decision.dailyPoints, 10);
  assert.equal(decision.samples, 7);
});
test('uses available records below seven instead of inventing a daily yield', () => {
  const decision = decideRedemption(snapshot(400, 30, { history: history.slice(0, 2).map(row => ({ ...row, change: 5 })) }));
  assert.equal(decision.dailyPoints, 5);
  assert.equal(decision.samples, 2);
  assert.equal(decision.estimatedDays, 20);
});
test('the observed 142-point, 30-day case cannot reach 500 at its recorded average', () => {
  const changes = [10, 10, 11, 11, 10, 10, 6];
  const decision = decideRedemption(snapshot('142.0', '30.0', { history: history.map((row, index) => ({ ...row, change: changes[index] })) }));
  assert.equal(decision.estimatedDays, 37);
  assert.equal(decision.neededDays, 38);
  assert.equal(decision.spentPoints, 100);
  assert.equal(decision.gainedDays, 10);
  assert.equal(decision.remainingPoints, 42);
});
test('cannot exchange below the minimum tier and does not require an invented history', () => {
  assert.equal(decideRedemption(snapshot(99.99, -1, { history: [] })).action, 'wait');
});
test('missing or invalid data never silently spends points', () => {
  assert.throws(() => decideRedemption(snapshot(300, 1, { history: [] })), /记录/);
  assert.throws(() => decideRedemption(snapshot('bad', 1)), /无效/);
  assert.throws(() => decideRedemption(snapshot(300, undefined)), /无效/);
  assert.throws(() => decideRedemption(snapshot(300, 1, { plans: { plan100: plans.plan100 } })), /500/);
});
test('missing or nonnumeric fields cannot be coerced into a zero-day expiry or zero balance', () => {
  for (const value of [null, '', '  ', false, true, [], {}, Infinity]) {
    assert.throws(() => decideRedemption(snapshot(300, value)));
    assert.throws(() => decideRedemption(snapshot(value, 1)));
    assert.throws(() => maximumDays(value, plans));
  }
});
test('maximum-day solver handles a counterexample to greedy highest-price selection', () => {
  const result = maximumDays(8, { six: { points: 6, days: 8 }, four: { points: 4, days: 7 }, three: { points: 3, days: 5 } });
  assert.equal(result.gainedDays, 14);
  assert.equal(result.spentPoints, 8);
});
test('equal day totals preserve more points', () => {
  const result = maximumDays(150, { cheap: { points: 100, days: 10 }, expensive: { points: 150, days: 10 } });
  assert.equal(result.spentPoints, 100);
  assert.equal(result.remainingPoints, 50);
});
test('solver matches independent exhaustive combinations across balances', () => {
  for (let balance = 0; balance <= 1100; balance += 11) {
    let bestDays = 0, bestCost = 0;
    for (let a = 0; a * 100 <= balance; a++) {
      for (let b = 0; a * 100 + b * 200 <= balance; b++) {
        for (let c = 0; a * 100 + b * 200 + c * 500 <= balance; c++) {
          const cost = a * 100 + b * 200 + c * 500;
          const days = a * 10 + b * 30 + c * 100;
          if (days > bestDays || (days === bestDays && cost < bestCost)) { bestDays = days; bestCost = cost; }
        }
      }
    }
    const actual = maximumDays(balance, plans);
    assert.equal(actual.gainedDays, bestDays, 'days at balance ' + balance);
    assert.equal(actual.spentPoints, bestCost, 'cost at balance ' + balance);
  }
});
