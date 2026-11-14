import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { runAccounts } from '../runner.js';

const source = (await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const account = { userId: 1, email: 'one@example.invalid', current: true };
const event = () => ({ addListener() {}, removeListener() {} });
async function backend({ stored = {}, points, restore, checkin, turnstile = null, closeDuringCheckin = false } = {}) {
  const data = structuredClone(stored);
  const calls = [];
  const tabEvents = [];
  let tabExists = false;
  let listener;
  const chrome = {
    runtime: { id: 'fixture', onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event(), onStartup: event(),
      getPlatformInfo: async () => ({}) },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event() },
    storage: { local: {
      async get(keys) {
        if (keys === null) return structuredClone(data);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); }
    } },
    tabs: {
      create: async options => { tabEvents.push(['create', options]); tabExists = true; return { id: 1, windowId: 2 }; },
      get: async () => { if (!tabExists) throw new Error('No tab'); return { status: 'complete' }; },
      update: async (id, options) => { tabEvents.push(['update', options]); },
      remove: async () => { tabEvents.push(['remove']); tabExists = false; },
      onUpdated: event(), onRemoved: event()
    },
    windows: { update: async (id, options) => { tabEvents.push(['window', options]); } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { create: async () => {} },
    scripting: { async executeScript({ args, world }) {
      const input = args[0]; calls.push({ ...input, world });
      let result;
      if (input.op === 'accounts') result = { ok: true, accounts: [account], original: account, max: 5 };
      else if (input.op === 'points') result = await (points?.() ?? { ok: true, email: account.email, points: 330, leftDays: 20,
        checkinPoints: 14, checkinTime: Date.now(), checkinHistory: [14, 12] });
      else if (input.op === 'restore') result = await (restore?.() ?? { ok: true, email: account.email });
      else throw new Error('Unexpected op ' + input.op);
      return [{ result }];
    } }
  };
  vm.runInNewContext(source, { chrome, pageAction() {}, nextAlarm() {}, setInterval: () => 1, clearInterval() {}, console });
  const rpc = type => new Promise(resolve => listener({ type }, { id: 'fixture' }, resolve));
  await rpc('state');
  return { rpc, data, calls };
}

test('refresh account switching holds the same lock as checkin and releases it after restore', async () => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const app = await backend({ points: async () => { entered(); await pending; return { ok: true, email: account.email, checkinHistory: [] }; } });
  const refreshing = app.rpc('refresh');
  await started;
  assert.equal((await app.rpc('state')).data.busy, true);
  const denied = await app.rpc('run');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /正在运行/);
  release();
  assert.equal((await refreshing).ok, true);
  assert.equal((await app.rpc('state')).data.busy, false);
  assert.equal(app.data.journal, null);
  assert.equal(app.calls.at(-1).op, 'restore');
});

test('refresh recovers a missing today reward despite an old result timestamp', async () => {
  const app = await backend({ stored: { lastRun: { results: [{ userId: 1, email: account.email, ok: true,
    already: true, checkinTime: Date.now(), checkinHistory: [] }] } } });
  assert.equal((await app.rpc('refresh')).ok, true);
  assert.equal(app.data.lastRun.results[0].checkinPoints, 14);
  assert.equal(app.data.accounts[0].checkinPoints, 14);
  assert.equal(app.data.accounts[0].checkinTime, app.data.lastRun.results[0].checkinTime);
});

test('refresh lookup failure remains visible and still restores and releases the lock', async () => {
  const app = await backend({ points: async () => ({ ok: false, message: 'fixture points failure' }) });
  const result = await app.rpc('refresh');
  assert.equal(result.ok, false);
  assert.match(app.data.lastError, /fixture points failure/);
  assert.equal(app.calls.at(-1).op, 'restore');
  assert.equal(app.data.journal, null);
  assert.equal((await app.rpc('state')).data.busy, false);
});

test('failed restoration preserves the journal and blocks subsequent runs', async () => {
  const app = await backend({ restore: async () => ({ ok: false, message: 'fixture restore failure' }) });
  assert.equal((await app.rpc('refresh')).ok, false);
  assert.ok(app.data.journal);
  assert.match(app.data.lastError, /fixture restore failure/);
  assert.equal((await app.rpc('state')).data.busy, false);
  const denied = await app.rpc('run');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /原账号尚未恢复/);
  assert.ok(app.data.journal);
});
