import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { pageAction } from '../page-api.js';

const accounts = [{ userId: 1, email: 'one@example.invalid' }, { userId: 2, email: 'two@example.invalid' }, { userId: 3, email: 'three@example.invalid' }];
const now = Date.now();
const nonce = 'fixture-challenge-123';
const proof = createHash('sha256').update(nonce + '.glados-observe-v1').digest('hex');
async function execute(op, overrides = {}) {
  let current = overrides.initial ?? 1;
  const calls = [];
  const waits = [];
  let clock = now;
  class Clock extends Date { static now() { return clock; } }
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, current, options });
    const custom = overrides.responses?.[url];
    if (custom instanceof Error) throw custom;
    let data;
    if (custom) data = custom;
    else if (url === '/api/user/status') data = { code: 0, data: { ...accounts.find(a => a.userId === current), leftDays: '20.0' } };
    else if (url === '/api/user/accounts') data = { code: 0, data: overrides.accounts || accounts, max: 5 };
    else if (url === '/api/user/accounts/switch') { if (!overrides.noSwitch) current = body.userId; data = { code: 0 }; }
    else if (url === '/api/user/checkin/challenge') data = { code: 0, nonce, ttl: 300000 };
    else if (url === '/api/user/checkin') data = { code: 0, message: 'Checkin! Got 10 Points' };
    else if (url === '/api/user/points') data = { code: 0, points: '330.0' };
    else throw new Error('Unexpected request ' + url);
    return { ok: true, status: 200, json: async () => data };
  };
  const result = await vm.runInNewContext('(' + pageAction.toString() + ')(' + JSON.stringify(op) + ')', {
    fetch, AbortSignal, crypto: webcrypto, TextEncoder, Date: Clock,
    location: { hostname: 'glados.cloud', pathname: '/console/checkin' },
    setTimeout(callback, milliseconds) {
      waits.push(milliseconds); clock += milliseconds;
      if (overrides.switchDuringWait) current = overrides.switchDuringWait;
      queueMicrotask(callback);
      return waits.length;
    },
    ...overrides.globals
  });
  return { result: JSON.parse(JSON.stringify(result)), calls, current, waits };
}

test('discovers all remembered accounts and verifies the original session', async () => {
  const { result, calls } = await execute({ op: 'accounts' });
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 3);
  assert.equal(result.original.email, accounts[0].email);
  assert.equal(result.max, 5);
  assert.ok(calls.every(c => c.options.credentials === 'include' && !c.options.headers?.Cookie));
});
test('switches with native API, verifies email, and signs the requested account once', async () => {
  const { result, calls, current } = await execute({ op: 'checkin', account: accounts[1] });
  assert.equal(result.ok, true);
  assert.equal(current, 2);
  assert.equal(result.email, accounts[1].email);
  assert.equal(result.points, '330.0');
  assert.equal(result.checkinPoints, 10);
  const signs = calls.filter(c => c.url === '/api/user/checkin');
  assert.equal(signs.length, 1);
  assert.equal(signs[0].current, 2);
  assert.deepEqual(signs[0].body, { token: 'glados.cloud', nonce, proof, tsState: 'off' });
  assert.equal(calls.filter(c => c.url.endsWith('/challenge')).length, 1);
});
test('does not switch when the intended account is already current', async () => {
  const { result, calls } = await execute({ op: 'checkin', account: accounts[0] });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(c => c.url.endsWith('/switch')).length, 0);
});
test('the live API code=1 already-recorded response is a completed checkin', async () => {
  const { result, calls } = await execute({ op: 'checkin', account: accounts[0] }, {
    responses: {
      '/api/user/checkin': { code: 1, message: "Today's observation logged. Return tomorrow for more points." },
      '/api/user/points': {
        code: 0, points: '330.0',
        history: [
          { business: 'system:exchange', time: 999, change: -100 },
          { business: 'system:checkin', time: now - 86400000, change: '11.0' },
          { business: 'system:checkin', time: now, change: '12.0' }
        ]
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(result.points, '330.0');
  assert.equal(result.checkinPoints, 12);
  assert.deepEqual(result.checkinHistory, [12, 11]);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 1);
});
test('unrecognized nonzero checkin codes cannot masquerade as success', async () => {
  for (const response of [{ code: 1, message: 'Checkin! Got 10 Points' }, { code: 4, message: "Today's observation logged." }]) {
    const { result } = await execute({ op: 'checkin', account: accounts[0] }, { responses: { '/api/user/checkin': response } });
    assert.equal(result.ok, false);
  }
});
test('a rejected native switch never signs another account', async () => {
  const { result, calls } = await execute({ op: 'checkin', account: accounts[1] }, {
    responses: { '/api/user/accounts/switch': { code: 4, message: '请重新登录' } }
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /请重新登录/);
  assert.equal(result.checkinAttempted, false);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 0);
});
test('a switch response without actual identity change cannot trigger checkin', async () => {
  const { result, calls } = await execute({ op: 'checkin', account: accounts[1] }, { noSwitch: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /账号核对失败/);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 0);
});
test('an uncertain submission remains unknown and is never replayed', async () => {
  const { result, calls } = await execute({ op: 'checkin', account: accounts[0] }, {
    responses: { '/api/user/checkin': new Error('network timeout') }
  });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 1);
});
test('optional points failure preserves an acknowledged checkin', async () => {
  const { result } = await execute({ op: 'checkin', account: accounts[0] }, {
    responses: { '/api/user/points': new Error('HTTP 503') }
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkinPoints, 10);
  assert.match(result.warnings[0], /503/);
});
test('restoration switches back without submitting a checkin', async () => {
  const { result, calls, current } = await execute({ op: 'restore', account: accounts[0] }, { initial: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.email, accounts[0].email);
  assert.equal(current, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 0);
});
test('points inspection reads checkin history without submitting a checkin', async () => {
  const { result, calls, current } = await execute({ op: 'points', account: accounts[1] }, {
    responses: {
      '/api/user/points': {
        code: 0, points: '460.0',
        history: [
          { business: 'system:checkin', time: now, change: '10.0' },
          { business: 'system:checkin', time: now - 86400000, change: '11.0' }
        ]
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(current, 2);
  assert.equal(result.email, accounts[1].email);
  assert.equal(result.points, '460.0');
  assert.equal(result.checkinPoints, 10);
  assert.deepEqual(result.checkinHistory, [10, 11]);
  assert.equal(calls.filter(c => c.url.endsWith('/checkin')).length, 0);
});
test('inconsistent saved accounts stop before any mutation', async () => {
  const { result, calls } = await execute({ op: 'accounts' }, { accounts: [accounts[1]] });
  assert.equal(result.ok, false);
  assert.ok(calls.every(c => !c.options.body));
});
