import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { pageAction } from '../page-api.js';

const account = { userId: 1, email: 'one@example.invalid' };
const start = new Date(2026, 10, 13, 12).getTime();
const nonce = 'native-fixture-nonce';
const expectedProof = createHash('sha256').update(nonce + '.glados-observe-v1').digest('hex');

async function run(options = {}) {
  let clock = start;
  let identity = account;
  const calls = [], waits = [], widgets = [], removed = [], elements = [], resets = [];
  const window = { addEventListener() {}, removeEventListener() {} };
  const click = text => elements.find(node => node.textContent === text).listeners.click();
  const document = {
    body: { append() {} },
    head: { append(script) { queueMicrotask(() => {
      if (options.loadWidget) { window.turnstile = turnstile; script.onload(); }
      else script.onerror();
    }); } },
    createElement(tag) {
      const node = { tag, style: {}, listeners: {}, isConnected: true, children: [],
        setAttribute() {}, append(...children) { this.children.push(...children); },
        addEventListener(event, callback) { this.listeners[event] = callback; },
        remove() { this.isConnected = false; removed.push(tag); } };
      elements.push(node); return node;
    }
  };
  const timers = new Map();
  let timerId = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const history = options.history ?? [{ business: 'system:checkin', time: start, change: '14.0' }];
  const fetch = async (url, init) => {
    const call = { url, at: clock, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url === '/api/user/status') return reply({ code: 0, data: { ...identity, leftDays: 30 } });
    if (url === '/api/user/checkin/challenge') {
      if (options.challengeError) throw new Error('Challenge unavailable');
      return reply(options.challenge ?? { code: 0, nonce, ttl: 300000 });
    }
    if (url === '/api/user/checkin') {
      if (options.postError) throw new Error('Response lost after POST');
      return reply(options.response ?? { code: 0, message: "Today's observation logged. Return tomorrow for more points.", points: '14.0', repeated: false }, options.status ?? 200);
    }
    if (url === '/api/user/points') return reply({ code: 0, points: 330, history });
    throw new Error('Unexpected endpoint ' + url);
  };
  const turnstile = {
    render(container, configuration) {
      widgets.push(configuration);
      const id = ++timerId;
      queueMicrotask(() => {
        const interactive = Boolean(options.interactive);
        if (options.verification === 'interactive') {
          configuration['before-interactive-callback']();
          if (interactive) {
            clock += 20000;
            configuration.callback('real-widget-fixture-token');
          }
        } else if (options.verification === 'transient-300010') {
          configuration['error-callback']('300010');
        } else if (options.verification === 'persistent-300030') {
          configuration['error-callback']('300030');
        } else if (options.verification === 'retry') {
          configuration['error-callback']('600010');
          if (interactive) click('重试验证');
        } else if (options.verification === 'error') {
          configuration['error-callback']('600010');
          if (interactive) click('跳过此账号');
        } else if (options.verification === 'skip') {
          if (interactive) click('跳过此账号');
        } else if (options.verification === 'widget-timeout') {
          configuration['timeout-callback']();
          if (interactive) click('跳过此账号');
        } else if (options.verification === 'expired') configuration['expired-callback']();
        else if (options.verification === 'empty') configuration.callback('');
        else if (options.verification === 'timeout') {
          const timer = [...timers.values()][0];
          clock += timer.milliseconds;
          timer.callback();
        } else configuration.callback('real-widget-fixture-token');
      });
      return id;
    },
    remove(id) { removed.push(id); },
    reset(id) {
      resets.push(id);
      queueMicrotask(() => {
        if (options.verification === 'persistent-300030') widgets.at(-1)['error-callback']('300030');
        else widgets.at(-1).callback('real-widget-fixture-token');
      });
    }
  };
  if (!options.noWidget) window.turnstile = turnstile;
  function reply(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  }
  const output = await vm.runInNewContext('(' + pageAction.toString() + ')(input)', {
    input: { op: options.op ?? 'checkin', account, interactive: options.interactive }, fetch, AbortSignal,
    crypto: options.noCrypto ? {} : webcrypto, TextEncoder, Date: Clock,
    location: { hostname: 'glados.cloud', pathname: '/console/checkin' },
    window, document,
    setTimeout(callback, milliseconds) {
      const id = ++timerId;
      if (milliseconds > 2600) timers.set(id, { callback, milliseconds });
      else {
        waits.push(milliseconds);
        clock += milliseconds + (options.waitOverrun ?? 0);
        if (options.changeIdentity) identity = { userId: 2, email: 'two@example.invalid' };
        queueMicrotask(callback);
      }
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  assert.equal(timers.size, 0, 'Verification timers must be cleared');
  return { result: JSON.parse(JSON.stringify(output)), calls, waits, widgets, removed, elements, resets };
}
const posts = run => run.calls.filter(call => call.url === '/api/user/checkin');

test('native challenge is acquired, aged, signed and submitted once before accepting structured reward', async () => {
  const attempt = await run();
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.result.already, false, 'Observation logged is also used for a first success');
  assert.equal(attempt.result.checkinPoints, 14);
  assert.equal(posts(attempt).length, 1);
  assert.deepEqual(posts(attempt)[0].body, { token: 'glados.cloud', nonce, proof: expectedProof, tsState: 'off' });
  const challenge = attempt.calls.find(call => call.url.endsWith('/challenge'));
  assert.ok(posts(attempt)[0].at - challenge.at >= 2600);
  assert.equal(attempt.calls[attempt.calls.indexOf(posts(attempt)[0]) - 1].url, '/api/user/status');
});

test('challenge network failure never falls back to the one-field legacy POST', async () => {
  const attempt = await run({ challengeError: true });
  assert.equal(attempt.result.ok, false);
  assert.equal(attempt.result.unknown, false);
  assert.equal(attempt.result.checkinAttempted, false);
  assert.equal(posts(attempt).length, 0);
  assert.match(attempt.result.message, /Challenge unavailable/);
});

test('invalid or denied challenges stop without consuming the daily checkin', async () => {
  for (const challenge of [{ code: 4, message: '请重新登录' }, { code: 0 }, { code: 0, nonce: 42 },
    { code: 0, nonce: '  ' }, { code: 0, nonce, ttl: 2000 }, { code: 0, nonce, ttl: null },
    { code: 0, nonce, turnstile: { sitekey: 'unknown-shape' } }]) {
    const attempt = await run({ challenge });
    assert.equal(attempt.result.ok, false);
    assert.equal(posts(attempt).length, 0);
  }
});

test('missing digest support and expired nonce do not trigger legacy fallback', async () => {
  for (const options of [{ noCrypto: true }, { waitOverrun: 300001 }]) {
    const attempt = await run(options);
    assert.equal(attempt.result.ok, false);
    assert.equal(posts(attempt).length, 0);
  }
});

test('account changes while waiting abort before sending a nonce to the wrong account', async () => {
  const attempt = await run({ changeIdentity: true });
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.message, /账号被其他页面切换/);
  assert.equal(posts(attempt).length, 0);
});

test('a real widget callback is bound to the current nonce, submitted and cleaned up', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' } });
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.result.verificationRequired, false);
  assert.equal(attempt.widgets[0].action, 'checkin');
  assert.equal(attempt.widgets[0].cData, nonce);
  assert.equal(attempt.widgets[0].sitekey, 'fixture-sitekey');
  assert.equal(posts(attempt)[0].body.turnstile, 'real-widget-fixture-token');
  assert.equal(posts(attempt)[0].body.tsState, 'ok');
  assert.equal(attempt.removed.length, 2);
});

for (const verification of ['error', 'expired', 'empty', 'timeout', 'widget-timeout', 'interactive']) {
  test('background Turnstile ' + verification + ' still submits challenge+proof without blocking checkin', async () => {
    const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification });
    assert.equal(attempt.result.ok, true);
    assert.equal(attempt.result.checkinPoints, 14);
    assert.equal(posts(attempt).length, 1);
    assert.deepEqual(posts(attempt)[0].body, { token: 'glados.cloud', nonce, proof: expectedProof });
    assert.equal(attempt.removed.length, 2);
  });
}

test('background check-in succeeds with challenge+proof even when Turnstile script is blocked by adblocker', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, noWidget: true });
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.result.checkinPoints, 14);
  assert.equal(attempt.result.points, 330);
  assert.equal(posts(attempt).length, 1);
  assert.deepEqual(posts(attempt)[0].body, { token: 'glados.cloud', nonce, proof: expectedProof });
});

for (const verification of ['skip', 'error', 'expired', 'empty', 'timeout', 'widget-timeout']) {
  test('interactive Turnstile ' + verification + ' is visible and never submitted as a downgraded checkin', async () => {
    const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification, interactive: true });
    assert.equal(attempt.result.ok, false);
    assert.equal(attempt.result.verificationRequired, true);
    assert.equal(attempt.result.checkinAttempted, false);
    assert.equal( attempt.result.points, 330 );
    assert.equal(posts(attempt).length, 0);
    assert.equal(attempt.removed.length, 2);
  });
}

test('interactive verification remains available past fifteen seconds and continues after the user succeeds', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification: 'interactive', interactive: true });
  assert.equal(attempt.result.ok, true);
  assert.equal(posts(attempt).length, 1);
  assert.ok(posts(attempt)[0].at - start >= 20000);
  assert.equal(attempt.widgets[0].appearance, 'always');
  assert.ok(attempt.elements.find(node => node.id === 'glados-checkin-verification').style.cssText.includes('position:fixed'));
});

test('a recoverable widget error retains its code and allows an explicit retry without replaying checkin', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification: 'retry', interactive: true });
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.result.verificationError, '600010');
  assert.equal(attempt.resets.length, 1);
  assert.equal(posts(attempt).length, 1);
});

test('transient 300010/300030 Turnstile errors auto-reset and recover in both silent and interactive modes', async () => {
  for (const interactive of [false, true]) {
    const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification: 'transient-300010', interactive });
    assert.equal(attempt.result.ok, true);
    assert.equal(attempt.result.verificationRequired, false);
    assert.equal(attempt.resets.length, 1);
    assert.equal(posts(attempt)[0].body.turnstile, 'real-widget-fixture-token');
    assert.equal(posts(attempt)[0].body.tsState, 'ok');
  }
});

test('persistent 300030 Turnstile errors fail fast after bounded auto-resets without hanging 90s for timeout', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification: 'persistent-300030', interactive: true });
  assert.equal(attempt.result.ok, false);
  assert.equal(attempt.result.verificationRequired, true);
  assert.equal(attempt.result.checkinAttempted, false);
  assert.equal(attempt.resets.length, 2);
  assert.match(attempt.result.message, /官网验证失败（Turnstile 300030）；本次未提交签到/);
  assert.equal(posts(attempt).length, 0);
});

test('the official script can load on a console without an existing native widget', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, noWidget: true, loadWidget: true });
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.elements.find(node => node.tag === 'script').src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  assert.equal(posts(attempt).length, 1);
});

test('widget failure reports the actionable Turnstile error code in interactive mode', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, verification: 'error', interactive: true });
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.message, /600010/);
  assert.equal(attempt.result.verificationError, '600010');
});

test('missing official widget in interactive mode produces an actionable error rather than a fake verification token', async () => {
  const attempt = await run({ challenge: { code: 0, nonce, turnstile: 'fixture-sitekey' }, noWidget: true, interactive: true });
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.message, /组件加载失败/);
  assert.equal(posts(attempt).length, 0);
});

test('uncertain POST is not replayed with the same or a new nonce', async () => {
  const attempt = await run({ postError: true });
  assert.equal(attempt.result.unknown, true);
  assert.equal(posts(attempt).length, 1);
  assert.equal(attempt.calls.filter(call => call.url.endsWith('/challenge')).length, 1);
});

test('structured reward wins over unrelated historical awards and message text', async () => {
  const attempt = await run({ response: { code: 0, points: 16, message: 'Checkin! Got 1 Points' } });
  assert.equal(attempt.result.checkinPoints, 16);
});

test('repeated:true never treats response points as a new award and uses only today ledger', async () => {
  const attempt = await run({ response: { code: 0, repeated: true, points: 99, message: "Today's observation logged." } });
  assert.equal(attempt.result.ok, true);
  assert.equal(attempt.result.already, true);
  assert.equal(attempt.result.checkinPoints, 14);
});

test('yesterday ledger remains history, not today reward, for repeated checkin or refresh', async () => {
  for (const op of ['checkin', 'points']) {
    const attempt = await run({ op, response: { code: 1, message: 'Checkin Repeats!' },
      history: [{ business: 'system:checkin', time: start - 86400000, change: 18 }] });
    assert.equal(attempt.result.ok, true);
    assert.equal(attempt.result.checkinPoints, undefined);
    assert.deepEqual(attempt.result.checkinHistory, [18]);
  }
});

test('server validation failures and non-2xx responses cannot masquerade as success', async () => {
  for (const options of [
    { response: { code: 4, reason: 'device-mismatch', message: 'Device mismatch' } },
    { response: { code: 4, reason: 'turnstile', message: 'Verification required' } },
    { response: { code: 0, message: 'Automated check-in detected' } },
    { status: 503 }
  ]) {
    const attempt = await run(options);
    assert.equal(attempt.result.ok, false);
    assert.equal(posts(attempt).length, 1);
  }
});
