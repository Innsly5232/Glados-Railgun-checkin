import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccounts } from '../runner.js';

const accounts = [{ userId: 1, email: 'one@example.invalid' }, { userId: 2, email: 'two@example.invalid' }, { userId: 3, email: 'three@example.invalid' }];
const plans = { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } };
const history = Array.from({ length: 7 }, (_, index) => ({ business: 'system:checkin', time: Date.now() - index * 86400000, change: 10 }));
function make({ points = 400, leftDays = 2, ...overrides } = {}) {
  const redemptions = [], progress = [], restored = [];
  return {
    redemptions, records: progress, restored,
    inspect: async () => ({ ok: true, accounts, original: accounts[0] }),
    checkin: async account => ({ ok: true, email: account.email, points, leftDays,
      redemptionSnapshot: { points, leftDays, plans, history } }),
    redeem: async (account, decision) => {
      assert.equal(progress.at(-1).pendingRedemption.account.email, account.email, 'journal before mutation');
      redemptions.push({ account, decision });
      return { ok: true, email: account.email, points: decision.remainingPoints,
        leftDays: leftDays + decision.gainedDays, spentPoints: decision.spentPoints, gainedDays: decision.gainedDays,
        receipts: decision.steps.flatMap(step => Array.from({ length: step.count }, () => ({ ...step, verified: true }))) };
    },
    restore: async account => { restored.push(account.email); return { ok: true, email: account.email }; },
    progress: async run => { progress.push(structuredClone(run)); },
    ...overrides
  };
}

test('disabled automatic redemption never submits a financial action', async () => {
  const adapter = make();
  const result = await runAccounts(adapter, 'manual', { autoRedeem: false });
  assert.equal(result.state, 'success');
  assert.equal(adapter.redemptions.length, 0);
});
test('enough validity preserves points while continuing all account checkins', async () => {
  const adapter = make({ leftDays: 30 });
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'success');
  assert.equal(adapter.redemptions.length, 0);
  assert.ok(result.results.every(row => row.redemption.action === 'wait' && row.points === 400));
});
test('expiry policy passes the maximum-day combination to every account and refreshes displayed balances', async () => {
  const adapter = make();
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'success');
  assert.equal(adapter.redemptions.length, 3);
  assert.ok(adapter.redemptions.every(row => row.decision.gainedDays === 60 && row.decision.steps[0].count === 2));
  assert.ok(result.results.every(row => row.points === 0 && row.leftDays === 62 &&
    row.checkinPoints === 10 && row.checkinHistory.length === 7 && !('redemptionSnapshot' in row)));
  assert.deepEqual(adapter.restored, [accounts[0].email]);
});
test('500-first policy exchanges only the highest tier and keeps the smaller remainder', async () => {
  const adapter = make({ points: 700 });
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'success');
  assert.ok(adapter.redemptions.every(row => row.decision.steps.length === 1 && row.decision.steps[0].planType === 'plan500'));
  assert.ok(result.results.every(row => row.points === 200));
});
test('unknown redemption failure is not replayed and does not block the other accounts or final restoration', async () => {
  const seen = [];
  const adapter = make({ redeem: async (account, decision) => {
    seen.push(account.userId);
    if (account.userId === 2) throw new Error('response lost after exchange');
    return { ok: true, email: account.email, points: decision.remainingPoints, leftDays: 62 };
  }});
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'partial');
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.results.filter(row => row.ok).length, 3);
  assert.equal(result.results[1].redemption.ok, false);
  assert.equal(result.results[1].redemption.unknown, true);
  assert.equal(result.restoration.ok, true);
});
test('missing forecasts are visible and never turn into guessed financial requests', async () => {
  const adapter = make({ checkin: async account => ({ ok: true, email: account.email }) });
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'partial');
  assert.equal(adapter.redemptions.length, 0);
  assert.ok(result.results.every(row => row.ok && row.redemption.ok === false));
});
test('partial exchange receipts and acknowledged balance remain visible', async () => {
  const adapter = make({ redeem: async account => ({ ok: false, email: account.email, message: 'second exchange unknown',
    points: 200, leftDays: 32, receipts: [{ planType: 'plan200', points: 200, days: 30, verified: true }] }) });
  const result = await runAccounts(adapter, 'manual', { autoRedeem: true });
  assert.equal(result.state, 'partial');
  assert.equal(result.results[0].points, 200);
  assert.equal(result.results[0].redemption.receipts[0].verified, true);
  assert.equal(result.restoration.ok, true);
});
