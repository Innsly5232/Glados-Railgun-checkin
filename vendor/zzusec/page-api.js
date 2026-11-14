// 此函数会完整注入 GLaDOS 标签页，必须保持自包含；不读取或导出 Cookie。
export async function pageAction(input) {
  const result = { ok: false, stage: input.op, warnings: [], checkinAttempted: false };
  const errorMessage = error => error instanceof Error ? error.message : String(error).replace(/^Error:\s*/, '');
  const numeric = (value, label) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
      throw new Error(label + '无效');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(label + '无效');
    return parsed;
  };
  const request = async (path, body, timeout = 25000) => {
    const response = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include', cache: 'no-store',
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(timeout)
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(path + ': HTTP ' + response.status + ', ' + (data.message || 'code=' + data.code));
    }
    return data;
  };
  const current = async () => {
    const { data } = await request('/user/status');
    if (!data || typeof data.email !== 'string' || !data.email) throw new Error('当前账号未登录，请先在网站添加账号');
    return data;
  };
  const validateTarget = target => {
    if (!target || !['number', 'string'].includes(typeof target.userId) || !String(target.userId) ||
        typeof target.email !== 'string' || !target.email) throw new Error('目标账号资料不完整，未执行切换');
  };
  const select = async target => {
    validateTarget(target);
    let account = await current();
    if (account.email !== target.email) {
      result.stage = 'switch';
      await request('/user/accounts/switch', { userId: target.userId });
      try {
        for (const key of Object.keys(globalThis.localStorage || {})) {
          if (key.startsWith('_cftscs_')) globalThis.localStorage.removeItem(key);
        }
      } catch {}
      account = await current();
    }
    if (account.email !== target.email) throw new Error('账号核对失败：预期 ' + target.email + '，实际 ' + account.email + '，未执行签到');
    result.email = account.email;
    result.leftDays = account.leftDays;
    return account;
  };
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const isTransientTurnstileError = code => /^[123]00\d{3}$/.test(String(code));
  const loadTurnstile = async timeoutMs => {
    if (globalThis.window?.turnstile?.render) return globalThis.window.turnstile;
    await new Promise((loaded, loadFailed) => {
      const script = document.createElement('script');
      let loadTimer;
      const cleanup = () => { clearTimeout(loadTimer); script.onload = null; script.onerror = null; };
      if (timeoutMs > 0) {
        loadTimer = setTimeout(() => { cleanup(); script.remove(); loadFailed(new Error('官网验证组件加载超时')); }, timeoutMs);
      }
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => { cleanup(); loaded(); };
      script.onerror = () => { cleanup(); script.remove(); loadFailed(new Error('官网验证组件加载失败，请检查网络或拦截扩展')); };
      document.head.append(script);
    });
    return globalThis.window?.turnstile;
  };
  // 后台静默尝试 Turnstile；若被广告拦截扩展拦截或后台标签页无法无感通过，不阻断基于 challenge + proof 的签到请求。
  const tryTurnstile = async (sitekey, nonce, expiresAt) => {
    result.verificationRequired = false;
    if (!globalThis.document?.body || !globalThis.document?.head) return null;
    const timeoutMs = Math.min(12000, expiresAt - Date.now() - 500);
    if (timeoutMs <= 0) return null;
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;right:16px;bottom:16px;min-width:300px;min-height:65px;z-index:2147483646;pointer-events:none;';
    document.body.append(container);
    let widget;
    let turnstile;
    let timer;
    let settled = false;
    let autoRetries = 0;
    try {
      return await new Promise(resolve => {
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(() => done(null), timeoutMs);
        const start = async () => {
          turnstile = await loadTurnstile(0);
          if (settled || !turnstile?.render) return done(null);
          widget = turnstile.render(container, {
            sitekey, theme: 'auto', action: 'checkin', cData: nonce, appearance: 'interaction-only',
            callback: value => done(typeof value === 'string' && value ? value : null),
            'error-callback': code => {
              result.verificationError = /^[A-Za-z0-9_-]{1,32}$/.test(String(code)) ? String(code) : 'unknown';
              if (isTransientTurnstileError(result.verificationError) && autoRetries < 2 && turnstile?.reset) {
                autoRetries += 1;
                Promise.resolve().then(() => {
                  if (settled) return;
                  try { if (widget !== undefined) turnstile.reset(widget); else done(null); }
                  catch { done(null); }
                });
                return true;
              }
              done(null);
              return true;
            },
            'expired-callback': () => done(null),
            'timeout-callback': () => done(null),
            'before-interactive-callback': () => done(null)
          });
        };
        start().catch(() => done(null));
      });
    } finally {
      clearTimeout(timer);
      try { if (widget !== undefined) turnstile?.remove?.(widget); } catch {}
      container.remove();
    }
  };
  // 仅当服务端明确要求交互式 Turnstile（或显式传入 interactive）时，才在前台官网页显示真实验证组件。
  const verifyTurnstile = async (sitekey, nonce, expiresAt) => {
    result.stage = 'verification';
    result.verificationRequired = true;
    const deadline = Math.min(Date.now() + 90000, expiresAt - 1000);
    const panel = document.createElement('section');
    panel.id = 'glados-checkin-verification';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '签到助手官网验证');
    panel.style.cssText = 'position:fixed;z-index:2147483647;top:24px;left:16px;right:16px;margin:auto;box-sizing:border-box;width:364px;max-width:calc(100% - 32px);max-height:calc(100vh - 48px);overflow:auto;padding:20px;border:1px solid var(--border-color,#dce3ef);border-radius:12px;background:var(--bg-primary,#fff);color:var(--text-primary,#18243b);box-shadow:0 8px 32px #0003;font:14px/1.6 system-ui,sans-serif;';
    const heading = document.createElement('strong');
    heading.textContent = '签到助手 · 官网验证';
    const account = document.createElement('p');
    account.textContent = input.account.email;
    account.style.cssText = 'margin:8px 0;overflow-wrap:anywhere;';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = '正在加载验证。验证通过后继续签到，请勿切换网站账号。';
    status.style.cssText = 'margin:8px 0;';
    const container = document.createElement('div');
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = '重试验证'; retry.hidden = true;
    const skip = document.createElement('button');
    skip.type = 'button'; skip.textContent = '跳过此账号';
    for (const button of [retry, skip]) button.style.cssText = 'min-height:44px;padding:8px 12px;margin:12px 8px 0 0;cursor:pointer;font:inherit;';
    panel.append(heading, account, status, container, retry, skip);
    document.body.append(panel);
    let widget;
    let turnstile;
    let timer;
    let settled = false;
    let autoRetries = 0;
    let rejectVerification;
    const failed = message => new Error(message + (result.verificationError ? '（Turnstile ' + result.verificationError + '）' : '') + '；本次未提交签到');
    const verification = new Promise((resolve, reject) => {
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      rejectVerification = error => done(reject, error);
      timer = setTimeout(() => done(reject, failed('等待官网验证超时')), Math.max(1, deadline - Date.now()));
      skip.addEventListener('click', () => done(reject, failed('已跳过此账号的官网验证')));
      const start = async () => {
        turnstile = await loadTurnstile(15000).catch(error => { throw failed(errorMessage(error)); });
        if (settled || !panel.isConnected) return;
        if (!turnstile?.render) throw failed('官网验证组件未加载');
        widget = turnstile.render(container, {
          sitekey, theme: 'auto', action: 'checkin', cData: nonce, appearance: 'always',
          callback: value => typeof value === 'string' && value ? done(resolve, value) : done(reject, failed('官网验证未返回有效凭证')),
          'error-callback': code => {
            result.verificationError = /^[A-Za-z0-9_-]{1,32}$/.test(String(code)) ? String(code) : 'unknown';
            if (isTransientTurnstileError(result.verificationError)) {
              if (autoRetries < 2 && turnstile?.reset) {
                autoRetries += 1;
                status.textContent = '官网验证遇到临时异常（Turnstile ' + result.verificationError + '），正在自动重试（' + autoRetries + '/2）…';
                Promise.resolve().then(() => {
                  if (settled) return;
                  try { if (widget !== undefined) turnstile.reset(widget); else done(reject, failed('官网验证失败')); }
                  catch { done(reject, failed('官网验证失败')); }
                });
                return true;
              }
              done(reject, failed('官网验证失败'));
              return true;
            }
            status.textContent = '官网验证失败（Turnstile ' + result.verificationError + '）。可点击重试，或跳过此账号。';
            retry.hidden = false;
            return true;
          },
          'expired-callback': () => done(reject, failed('官网验证凭证已过期')),
          'timeout-callback': () => {
            status.textContent = '验证操作超时，可点击重试，或跳过此账号。';
            retry.hidden = false;
          },
          'before-interactive-callback': () => { status.textContent = '请在下方完成官网验证，成功后会自动继续签到。'; }
        });
        retry.addEventListener('click', () => {
          try {
            if (Date.now() >= deadline) throw failed('本轮验证已超时');
            retry.hidden = true;
            status.textContent = '正在重新验证，请按下方提示操作。';
            turnstile.reset(widget);
          } catch (error) { done(reject, error); }
        });
      };
      start().catch(error => done(reject, error));
    });
    const cancelOnLeave = () => rejectVerification(failed('验证页面已关闭或离开'));
    globalThis.window.addEventListener('pagehide', cancelOnLeave, { once: true });
    try {
      const token = await verification;
      result.verificationRequired = false;
      return token;
    } finally {
      clearTimeout(timer);
      globalThis.window.removeEventListener('pagehide', cancelOnLeave);
      try { if (widget !== undefined) turnstile.remove(widget); }
      catch (error) { result.warnings.push('验证组件清理失败：' + errorMessage(error)); }
      panel.remove();
    }
  };
  const loadChallenge = async () => {
    result.stage = 'challenge';
    const challenge = await request('/user/checkin/challenge');
    if (typeof challenge.nonce !== 'string' || !challenge.nonce.trim()) throw new Error('签到 challenge 缺少 nonce，未降级提交普通签到');
    const ttl = challenge.ttl === undefined ? 300000 : numeric(challenge.ttl, '签到 challenge 有效期');
    if (ttl <= 2600) throw new Error('签到 challenge 有效期不足，未提交签到');
    if (challenge.turnstile && typeof challenge.turnstile !== 'string') throw new Error('官网验证配置无效，未提交签到');
    return { nonce: challenge.nonce, ttl, turnstile: challenge.turnstile || null, receivedAt: Date.now(), email: input.account.email };
  };
  const prepareCheckin = async () => {
    const challenge = input.challenge || await loadChallenge();
    const { receivedAt, ttl } = challenge;
    if (challenge.email !== input.account.email || !Number.isFinite(receivedAt) ||
        !Number.isFinite(ttl) || Date.now() >= receivedAt + ttl) throw new Error('签到 challenge 与账号不符或已过期，未提交签到');
    let turnstileToken = null;
    if (challenge.turnstile) {
      turnstileToken = input.interactive
        ? await verifyTurnstile(challenge.turnstile, challenge.nonce, receivedAt + ttl)
        : await tryTurnstile(challenge.turnstile, challenge.nonce, receivedAt + ttl);
    }
    // 官网要求 challenge 至少等待 2.5 秒；和参考插件一致等待 2.6 秒。
    const remaining = 2600 - (Date.now() - receivedAt);
    if (remaining > 0) await wait(remaining);
    if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) throw new Error('浏览器不支持签到 proof，未降级提交普通签到');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(challenge.nonce + '.glados-observe-v1'));
    const proof = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    // 等待和验证期间会话可能被别的标签页切换，不得用其他账号的 challenge 签到。
    if ((await current()).email !== input.account.email) throw new Error('准备签到期间账号被其他页面切换，未提交签到');
    if (Date.now() - receivedAt >= ttl) throw new Error('签到 challenge 已过期，未提交签到');
    const payload = { token: location.hostname, nonce: challenge.nonce, proof };
    if (turnstileToken) {
      payload.turnstile = turnstileToken;
      payload.tsState = 'ok';
    } else if (!challenge.turnstile) {
      payload.tsState = 'off';
    }
    return { payload, challenge };
  };
  const extractCheckins = rawHistory => {
    const validNumber = value => (typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) && Number.isFinite(Number(value)) ? Number(value) : NaN;
    const history = (Array.isArray(rawHistory) ? rawHistory : []).filter(row => row?.business === 'system:checkin')
      .map(row => ({ business: row.business, time: row.time, change: row.change, detail: row.detail }));
    const records = history
      .map(row => ({ time: validNumber(row.time), change: validNumber(row.change) }))
      .filter(row => Number.isFinite(row.time) && row.change > 0)
      .sort((a, b) => b.time - a.time)
      .slice(0, 7);
    const today = records.find(row => new Date(row.time).toDateString() === new Date().toDateString());
    return { history, records, today, awards: records.map(row => row.change) };
  };
  const populatePoints = async includeSnapshot => {
    try {
      const [status, points] = await Promise.all([current(), request('/user/points', undefined, 15000)]);
      if (status.email !== input.account.email) throw new Error('运行期间账号被其他页面切换，未采纳积分信息');
      result.leftDays = status.leftDays;
      result.points = points.points;
      const { history, today, awards } = extractCheckins(points.history);
      result.checkinHistory = awards;
      if (includeSnapshot && result.checkinPoints === undefined && today) {
        result.checkinPoints = today.change;
        result.checkinTime = today.time;
      }
      if (includeSnapshot) {
        result.redemptionSnapshot = { points: points.points, leftDays: status.leftDays, plans: points.plans, history };
      }
    } catch (error) {
      if (includeSnapshot) result.warnings.push(errorMessage(error));
    }
  };

  try {
    if (location.hostname !== 'glados.cloud') throw new Error('只允许在 glados.cloud 页面执行');
    if (input.op === 'add-account') {
      if (location.pathname.startsWith('/login')) return { ok: true, loginPage: true };
      const account = await current();
      // 只打开网站自己的“添加账号”对话框，密码和验证码仍交给网站处理。
      const findAdd = () => [...document.querySelectorAll('button')]
        .find(node => /^(Add account|添加账号|添加帐号)$/i.test(node.textContent.trim()));
      let button = findAdd();
      if (!button) {
        const email = [...document.querySelectorAll('span,button,a')]
          .find(node => node.textContent.trim() === account.email);
        if (!email) throw new Error('未找到当前邮箱菜单，请在 GLaDOS 页面点击邮箱 → 添加账号');
        email.click();
        for (let attempt = 0; attempt < 20 && !button; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          button = findAdd();
        }
      }
      if (!button) throw new Error('未找到添加入口，可能已达到网站账号上限；请从邮箱菜单查看');
      button.click();
      return { ok: true, opened: true };
    }
    if (input.op === 'accounts') {
      const [list, status] = await Promise.all([request('/user/accounts'), current()]);
      if (!Array.isArray(list.data) || !list.data.length) throw new Error('网站未返回已保存账号，请先添加账号');
      const accounts = list.data.map(account => {
        validateTarget(account);
        return { userId: account.userId, email: account.email, current: account.email === status.email };
      });
      const original = accounts.filter(account => account.current);
      if (original.length !== 1 || new Set(accounts.map(account => String(account.userId))).size !== accounts.length) {
        throw new Error('账号列表与当前会话不一致，停止操作');
      }
      return { ok: true, accounts, original: original[0], max: list.max, leftDays: status.leftDays };
    }
    if (!['checkin', 'prepare-checkin', 'restore', 'redeem', 'points'].includes(input.op)) throw new Error('不支持的操作');
    await select(input.account);
    if (input.op === 'prepare-checkin') return { ...result, ok: true, challenge: await loadChallenge() };
    if (input.op === 'restore') return { ...result, ok: true, stage: 'restored' };
    if (input.op === 'points') {
      const points = await request('/user/points', undefined, 15000);
      const status = await current();
      if (status.email !== input.account.email) throw new Error('运行期间账号被其他页面切换，未采纳积分信息');
      const { today, awards } = extractCheckins(points.history);
      return {
        ...result, ok: true, stage: 'points', points: points.points, leftDays: status.leftDays,
        checkinPoints: today?.change, checkinTime: today?.time, checkinHistory: awards
      };
    }
    if (input.op === 'redeem') {
      result.stage = 'redemption';
      result.redemptionAttempted = false;
      result.receipts = [];
      const decision = input.decision;
      const initial = await request('/user/points');
      let balance = numeric(initial.points, '当前积分余额');
      let leftDays = numeric(result.leftDays, '当前有效期');
      if (!decision || decision.action !== 'redeem' || !Array.isArray(decision.steps) || !decision.steps.length ||
          Math.abs(balance - numeric(decision.balance, '计划余额')) > 0.000001 ||
          leftDays > numeric(decision.leftDays, '计划有效期') + 0.001) {
        throw new Error('兑换判断后的余额或有效期已变化，未自动提交，请刷新后重算');
      }
      let totalCost = 0;
      let totalDays = 0;
      for (const step of decision.steps) {
        const offer = initial.plans?.[step.planType];
        if (!offer || !Number.isSafeInteger(step.count) || step.count <= 0 ||
            !Number.isSafeInteger(step.points) || step.points <= 0 || !Number.isSafeInteger(step.days) || step.days <= 0 ||
            numeric(offer.points, '兑换档位积分') !== step.points || numeric(offer.days, '兑换档位天数') !== step.days) {
          throw new Error('兑换档位已变化或组合无效，未自动花积分');
        }
        totalCost += step.count * step.points;
        totalDays += step.count * step.days;
      }
      if (!Number.isSafeInteger(totalCost) || totalCost > balance || totalCost !== decision.spentPoints || totalDays !== decision.gainedDays) {
        throw new Error('兑换组合超出余额或与计算不一致，未自动提交');
      }
      for (const step of decision.steps) {
        for (let count = 0; count < step.count; count++) {
          // 每次扣分前重新核对身份、余额和档位；任何未知结果都停止，不重复 POST。
          const [account, before] = await Promise.all([current(), request('/user/points')]);
          if (account.email !== input.account.email || Math.abs(numeric(before.points, '兑换前余额') - balance) > 0.000001 ||
              numeric(before.plans?.[step.planType]?.points, '兑换档位积分') !== step.points ||
              numeric(before.plans?.[step.planType]?.days, '兑换档位天数') !== step.days) {
            throw new Error('兑换期间账号、余额或档位发生变化，已停止后续兑换');
          }
          leftDays = numeric(account.leftDays, '兑换前有效期');
          result.redemptionAttempted = true;
          const acknowledgement = await request('/user/exchange', { planType: step.planType }, 45000);
          const receipt = { planType: step.planType, points: step.points, days: step.days,
            confirmed: true, verified: false, beforePoints: balance, beforeDays: leftDays, message: acknowledgement.message };
          result.receipts.push(receipt);
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
            const [afterAccount, after] = await Promise.all([current(), request('/user/points')]);
            if (afterAccount.email !== input.account.email) throw new Error('兑换后账号被其他页面切换，结果需核实');
            const afterPoints = numeric(after.points, '兑换后余额');
            const afterDays = numeric(afterAccount.leftDays, '兑换后有效期');
            result.points = after.points;
            result.leftDays = afterAccount.leftDays;
            receipt.afterPoints = afterPoints;
            receipt.afterDays = afterDays;
            // leftDays 可能按整天取整；跨日允许最多一天的显示差，但必须实际延长。
            if (Math.abs(afterPoints - (balance - step.points)) < 0.000001 &&
                afterDays > leftDays && afterDays >= leftDays + step.days - 1.001) {
              receipt.verified = true;
              balance = afterPoints;
              leftDays = afterDays;
              break;
            }
          }
          if (!receipt.verified) throw new Error('兑换接口已确认，但扣分或有效期变化未核实；已停止后续兑换，请查看网站');
        }
      }
      return { ...result, ok: true, stage: 'redeemed', spentPoints: totalCost, gainedDays: totalDays,
        message: '已兑换 ' + totalCost + ' 积分，档位合计 ' + totalDays + ' 天' };
    }

    const { payload, challenge } = await prepareCheckin();
    result.stage = 'checkin';
    result.checkinAttempted = true;
    const response = await fetch('/api/user/checkin', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000)
    });
    result.httpStatus = response.status;
    const data = await response.json();
    result.code = data.code;
    result.message = typeof data.message === 'string' ? data.message : '签到接口未返回 message';
    result.reason = data.reason;
    result.already = data.repeated === true || /^(Checkin Repeats!?|Please Try Tomorrow\b)/i.test(result.message);
    // 新版首次成功也使用 Today's observation logged，必须优先按 code/repeated 判断。
    result.ok = response.ok && (data.code === 0 || (data.code === 1 &&
      (result.already || /^Today's observation logged\./.test(result.message))));
    if (result.ok && data.code === 1) result.already = true;
    if (data.reason === 'turnstile' || data.reason === 'device-mismatch' || /automated check-in detected/i.test(result.message)) {
      result.ok = false;
      result.verificationRequired = true;
      if (data.reason === 'turnstile' && !input.interactive && challenge.turnstile && !payload.turnstile) {
        result.retryInteractive = true;
      }
      result.message += data.reason === 'device-mismatch' ? '；请在当前浏览器重新登录官网后再签到' : '；请打开官网完成验证，本次不自动重试';
    }
    if (!result.ok) {
      if (!result.retryInteractive) await populatePoints(false);
      return result;
    }
    if (!result.already) {
      try {
        if (data.points !== undefined && data.points !== null) {
          const award = numeric(data.points, '本次签到积分');
          if (award < 0) throw new Error('本次签到积分无效');
          result.checkinPoints = award;
        }
      } catch (error) { result.warnings.push(errorMessage(error)); }
      const messageAward = result.message.match(/^Checkin!.*?\bGot\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*Points\b/i);
      if (result.checkinPoints === undefined && messageAward && Number(messageAward[1]) > 0) result.checkinPoints = Number(messageAward[1]);
      if (result.checkinPoints !== undefined) result.checkinTime = Date.now();
    }

    // 附加查询失败只显示警告，不重复已提交的签到。
    await populatePoints(true);
    return result;
  } catch (error) {
    if (input.op === 'checkin' && result.email === input.account?.email && !result.checkinAttempted) {
      await populatePoints(false);
    }
    return { ...result, ok: false, message: errorMessage(error), unknown: result.checkinAttempted || result.redemptionAttempted === true };
  }
}
