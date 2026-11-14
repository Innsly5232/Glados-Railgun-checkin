// 独立于 Chrome 的批处理规则，方便测试账号隔离、继续执行和最终恢复。
import { checkinAwards, decideRedemption } from './redemption.js';

export async function runAccounts(adapter, source = 'manual', { autoRedeem = false } = {}) {
  const snapshot = await adapter.inspect();
  if (!snapshot.ok || !snapshot.accounts?.length || !snapshot.original) {
    throw new Error(snapshot.message || '没有可用的已登录账号');
  }
  const run = {
    id: crypto.randomUUID(), source, state: 'running', startedAt: Date.now(),
    original: snapshot.original, accounts: snapshot.accounts.map(account => ({ ...account })), results: [], restoration: null
  };
  // 在任何账号切换前落盘，worker 意外停止后仍能恢复原账号。
  await adapter.progress(run);
  try {
    for (const account of run.accounts) {
      run.current = account.email;
      await adapter.progress(run);
      let response;
      try {
        response = await adapter.checkin(account);
        if (!response || typeof response.ok !== 'boolean') throw new Error('签到执行结果结构异常');
        if (response.ok && response.email !== account.email) throw new Error('返回邮箱与目标账号不一致，不能计为成功');
      } catch (error) {
        response = { ok: false, message: error instanceof Error ? error.message : String(error), unknown: true };
      }
      if (response.ok && autoRedeem) {
        let decision;
        let redemption;
        try {
          decision = decideRedemption(response.redemptionSnapshot);
          if (decision.action === 'redeem') {
            run.phase = 'redeem';
            run.pendingRedemption = { account, decision };
            await adapter.progress(run);
            if (typeof adapter.redeem !== 'function') throw new Error('兑换执行接口不可用');
            redemption = await adapter.redeem(account, decision);
            if (!redemption || typeof redemption.ok !== 'boolean') throw new Error('兑换返回结构异常');
            if (redemption.ok && redemption.email !== account.email) throw new Error('兑换返回的邮箱与目标账号不符');
            response.redemption = { ...redemption, action: 'redeem', decision };
            if (redemption.points !== undefined) response.points = redemption.points;
            if (redemption.leftDays !== undefined) response.leftDays = redemption.leftDays;
          } else {
            response.redemption = { ...decision, ok: true };
          }
        } catch (error) {
          response.redemption = { ...redemption, ok: false, action: decision?.action || 'unavailable',
            decision, message: error instanceof Error ? error.message : String(error), unknown: Boolean(decision?.action === 'redeem') };
        }
        run.pendingRedemption = null;
        run.phase = null;
      }
      if (response.ok) {
        if (response.checkinPoints === undefined && typeof response.message === 'string') {
          const matched = response.message.match(/^Checkin!.*?\bGot\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*Points\b/i);
          if (!response.already && matched && Number(matched[1]) > 0) {
            response.checkinPoints = Number(matched[1]);
            response.checkinTime = Date.now();
          }
        }
        if (!Array.isArray(response.checkinHistory) && Array.isArray(response.redemptionSnapshot?.history)) {
          try {
            const awards = checkinAwards(response.redemptionSnapshot.history);
            if (awards.length) {
              response.checkinHistory = awards;
              const today = response.redemptionSnapshot.history
                .filter(row => row?.business === 'system:checkin' && Number(row.change) > 0 &&
                  new Date(Number(row.time)).toDateString() === new Date().toDateString())
                .sort((a, b) => Number(b.time) - Number(a.time))[0];
              if (response.checkinPoints === undefined && today) {
                response.checkinPoints = Number(today.change);
                response.checkinTime = Number(today.time);
              }
            }
          } catch {}
        }
      }
      if (response.points !== undefined) account.points = response.points;
      if (response.leftDays !== undefined) account.leftDays = response.leftDays;
      if (response.checkinPoints !== undefined) {
        account.checkinPoints = response.checkinPoints;
        account.checkinTime = response.checkinTime;
      }
      if (Array.isArray(response.checkinHistory) && response.checkinHistory.length) {
        account.checkinHistory = response.checkinHistory;
      }
      // 原始积分流水只用于本次计算，不重复保存进最近二十轮记录。
      delete response.redemptionSnapshot;
      run.results.push({ ...response, userId: account.userId, email: account.email, finishedAt: Date.now() });
      await adapter.progress(run);
    }
  } finally {
    run.current = null;
    try {
      run.restoration = await adapter.restore(snapshot.original);
      if (!run.restoration?.ok || run.restoration.email !== snapshot.original.email) {
        throw new Error(run.restoration?.message || '原账号未恢复');
      }
    } catch (error) {
      run.restoration = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    run.finishedAt = Date.now();
    const successes = run.results.filter(item => item.ok).length;
    const redemptionFailed = run.results.some(item => item.redemption?.ok === false);
    run.state = run.restoration.ok && successes === snapshot.accounts.length && !redemptionFailed ? 'success' : successes ? 'partial' : 'failed';
    await adapter.progress(run);
  }
  return run;
}

export function nextAlarm(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 35, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}
