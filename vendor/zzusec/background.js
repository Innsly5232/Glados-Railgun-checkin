import { pageAction } from './page-api.js';
import { nextAlarm, runAccounts } from './runner.js';

// 签到页本身会自动创建 challenge/Turnstile；使用普通控制台避免并行创建两套验证。
const URL = 'https://glados.cloud/console';
let busy = false;
let initialization;

async function settings() {
  const { automatic = false, autoRedeem = true } = await chrome.storage.local.get(['automatic', 'autoRedeem']);
  return { automatic, autoRedeem };
}
function mergeAccountDetails(accounts, sources = []) {
  return (accounts || []).map(account => {
    const merged = { ...account };
    for (const list of sources) {
      const match = (list || []).find(item => item && String(item.userId) === String(account.userId));
      if (!match) continue;
      if (merged.points === undefined && match.points !== undefined) merged.points = match.points;
      if (merged.leftDays === undefined && match.leftDays !== undefined) merged.leftDays = match.leftDays;
      if (merged.checkinPoints === undefined && match.checkinPoints !== undefined) {
        merged.checkinPoints = match.checkinPoints;
        merged.checkinTime = match.checkinTime;
      }
      if ((!Array.isArray(merged.checkinHistory) || !merged.checkinHistory.length) &&
          Array.isArray(match.checkinHistory) && match.checkinHistory.length) {
        merged.checkinHistory = match.checkinHistory;
      }
    }
    return merged;
  });
}
async function schedule() {
  const { automatic } = await settings();
  for (const hour of [9, 21]) {
    const name = 'checkin-' + hour;
    if (automatic) await chrome.alarms.create(name, { when: nextAlarm(hour) });
    else await chrome.alarms.clear(name);
  }
}
async function waitForTab(tabId) {
  if ((await chrome.tabs.get(tabId)).status === 'complete') return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed); };
    const updated = (id, info) => { if (id === tabId && info.status === 'complete') { cleanup(); resolve(); } };
    const removed = id => { if (id === tabId) { cleanup(); reject(new Error('签到标签页已被关闭')); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('GLaDOS 页面加载超时')); }, 45000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    // 避免 get() 与注册监听之间页面恰好完成造成漏通知。
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') { cleanup(); resolve(); } }, error => { cleanup(); reject(error); });
  });
}
async function withTab(work) {
  let tab = await chrome.tabs.create({ url: URL, active: false });
  try {
    await waitForTab(tab.id);
    const execute = async input => {
      const response = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: pageAction, args: [input],
        world: input.op === 'checkin' ? 'MAIN' : 'ISOLATED'
      });
      if (!response[0]?.result || typeof response[0].result.ok !== 'boolean') throw new Error('页面未返回有效执行结果');
      return response[0].result;
    };
    return await work(async input => {
      // 用户关闭验证页后仍须恢复账号，用新控制台页恢复；绝不重放签到请求。
      if (input.op === 'restore') {
        try { await chrome.tabs.get(tab.id); }
        catch {
          tab = await chrome.tabs.create({ url: URL, active: false });
          await waitForTab(tab.id);
        }
      }
      if (input.op !== 'checkin') return execute(input);
      const initial = await execute(input);
      if (!initial.retryInteractive) return initial;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return execute({ ...input, interactive: true });
    });
  } finally {
    try { await chrome.tabs.remove(tab.id); }
    catch (error) { await chrome.storage.local.set({ cleanupWarning: String(error) }); }
  }
}
async function saveProgress(run) {
  const journal = run.state === 'running' || !run.restoration?.ok ? { original: run.original, runId: run.id } : null;
  await chrome.storage.local.set({ lastRun: run, journal, lastError: null });
  await chrome.action.setBadgeText({ text: run.state === 'running' ? '…' : run.state === 'success' ? '✓' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: run.state === 'success' ? '#257255' : '#294fc7' });
}
async function recover() {
  const { journal, lastRun } = await chrome.storage.local.get(['journal', 'lastRun']);
  if (!journal) return;
  let restoration;
  try { restoration = await withTab(execute => execute({ op: 'restore', account: journal.original })); }
  catch (error) { restoration = { ok: false, message: String(error) }; }
  const restored = restoration.ok && restoration.email === journal.original.email;
  await chrome.storage.local.set({
    journal: restored ? null : journal,
    lastRun: { ...(lastRun || {}), state: 'interrupted', finishedAt: Date.now(), current: null,
      restoration, message: restored ? '上次任务中断，已恢复原账号；未重复提交未知的签到或兑换请求，请核对记录' : '上次任务中断，原账号恢复失败，请重试恢复' }
  });
}
function initialize() {
  return initialization ||= (async () => { await schedule(); await recover(); })();
}
async function run(source) {
  await initialize();
  if (busy) throw new Error('签到任务正在运行，请稍候');
  busy = true;
  // 仅在有限批处理期间保活；每次 API 调用重置 worker 空闲计时。
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(console.error), 20000);
  try {
    if ((await chrome.storage.local.get('journal')).journal) {
      await recover();
      if ((await chrome.storage.local.get('journal')).journal) throw new Error('原账号尚未恢复，暂不启动新任务');
    }
    const policy = await settings();
    const { accounts: storedAccounts = [] } = await chrome.storage.local.get('accounts');
    const result = await withTab(execute => runAccounts({
      inspect: async () => {
        const inspected = await execute({ op: 'accounts' });
        if (inspected?.ok) inspected.accounts = mergeAccountDetails(inspected.accounts, [storedAccounts]);
        return inspected;
      },
      checkin: account => execute({ op: 'checkin', account }),
      redeem: (account, decision) => execute({ op: 'redeem', account, decision }),
      restore: account => execute({ op: 'restore', account }),
      progress: saveProgress
    }, source, { autoRedeem: policy.autoRedeem }));
    const success = result.results.filter(item => item.ok).length;
    const accounts = mergeAccountDetails(result.accounts, [result.results, storedAccounts]);
    await chrome.storage.local.set({ accounts, lastRefresh: Date.now() });
    const { history = [] } = await chrome.storage.local.get('history');
    await chrome.storage.local.set({ history: [result, ...history].slice(0, 20) });
    if (result.state !== 'success') {
      try {
        await chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: 'GLaDOS 签到需查看',
          message: '签到成功 ' + success + '/' + result.results.length + '。' +
            (result.results.some(item => item.redemption?.ok === false) ? '自动兑换需检查。' : '') +
            (result.restoration.ok ? '已恢复原账号。' : '原账号恢复失败，请打开插件。') });
      } catch (error) { await chrome.storage.local.set({ notificationWarning: String(error) }); }
    }
    return result;
  } catch (error) {
    const { lastRun } = await chrome.storage.local.get('lastRun');
    if (!lastRun || lastRun.state !== 'running') await chrome.storage.local.set({ lastError: String(error) });
    throw error;
  } finally { clearInterval(keepAlive); busy = false; await chrome.storage.local.set({ workerBusy: false }); }
}
async function dispatch(message) {
  await initialize();
  if (message.type === 'state') return { ...(await chrome.storage.local.get(null)), busy, ...(await settings()) };
  if (message.type === 'run') return run('manual');
  if (message.type === 'refresh') {
    if (busy) throw new Error('任务运行中，请等待完成后刷新');
    // 刷新也会切换账号；和签到共用锁，避免 challenge 等待时被刷新串号。
    busy = true;
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(console.error), 20000);
    try {
      if ((await chrome.storage.local.get('journal')).journal) {
        await recover();
        if ((await chrome.storage.local.get('journal')).journal) throw new Error('原账号尚未恢复，暂不刷新账号');
      }
      const snapshot = await withTab(async execute => {
        const inspected = await execute({ op: 'accounts' });
        if (!inspected.ok) return inspected;
        const { lastRun, accounts: storedAccounts = [] } = await chrome.storage.local.get(['lastRun', 'accounts']);
        const today = value => value && new Date(value).toDateString() === new Date().toDateString();
        const needBackfill = inspected.accounts.some(account => {
          const previous = lastRun?.results?.find(item => String(item.userId) === String(account.userId));
          const stored = storedAccounts.find(item => String(item.userId) === String(account.userId));
          const hasPoints = (previous?.points ?? stored?.points) !== undefined;
          const hasHistory = (Array.isArray(previous?.checkinHistory) && previous.checkinHistory.length > 0) ||
            (Array.isArray(stored?.checkinHistory) && stored.checkinHistory.length > 0);
          const hasToday = (today(previous?.checkinTime) && previous?.checkinPoints !== undefined) ||
            (today(stored?.checkinTime) && stored?.checkinPoints !== undefined);
          return !hasPoints || !hasHistory || !hasToday;
        });
        if (needBackfill) {
          const details = new Map();
          await chrome.storage.local.set({ journal: { original: inspected.original, runId: 'refresh' } });
          try {
            for (const account of inspected.accounts) {
              const info = await execute({ op: 'points', account });
              if (!info.ok || info.email !== account.email) throw new Error(info.message || '刷新积分时账号核对失败');
              details.set(String(account.userId), info);
            }
          } finally {
            const restoration = await execute({ op: 'restore', account: inspected.original });
            if (!restoration?.ok || restoration.email !== inspected.original.email) {
              throw new Error(restoration?.message || '刷新后原账号未恢复，请重试恢复');
            }
            await chrome.storage.local.set({ journal: null });
          }
          if (details.size) {
            inspected.accounts = inspected.accounts.map(account => {
              const info = details.get(String(account.userId));
              return info ? { ...account, points: info.points, leftDays: info.leftDays, checkinPoints: info.checkinPoints, checkinTime: info.checkinTime, checkinHistory: info.checkinHistory } : account;
            });
            if (lastRun?.results) {
              lastRun.results = lastRun.results.map(item => {
                const info = details.get(String(item.userId));
                if (!info) return item;
                return {
                  ...item,
                  points: item.points ?? info.points,
                  leftDays: item.leftDays ?? info.leftDays,
                  checkinPoints: today(item.checkinTime) && item.checkinPoints !== undefined ? item.checkinPoints : info.checkinPoints,
                  checkinTime: today(item.checkinTime) && item.checkinPoints !== undefined ? item.checkinTime : info.checkinTime,
                  checkinHistory: Array.isArray(item.checkinHistory) && item.checkinHistory.length ? item.checkinHistory : info.checkinHistory
                };
              });
              await chrome.storage.local.set({ lastRun });
            }
          }
        }
        inspected.accounts = mergeAccountDetails(inspected.accounts, [lastRun?.results, storedAccounts]);
        return inspected;
      });
      if (!snapshot.ok) throw new Error(snapshot.message);
      await chrome.storage.local.set({ accounts: snapshot.accounts, accountLimit: snapshot.max, lastRefresh: Date.now(), lastError: null });
      return snapshot;
    } catch (error) {
      await chrome.storage.local.set({ lastError: String(error) });
      throw error;
    } finally {
      clearInterval(keepAlive);
      busy = false;
      await chrome.storage.local.set({ workerBusy: false });
    }
  }
  if (message.type === 'automatic') {
    await chrome.storage.local.set({ automatic: message.enabled === true });
    await schedule();
    return settings();
  }
  if (message.type === 'auto-redeem') {
    if (busy) throw new Error('任务运行中，请完成后再修改兑换设置');
    await chrome.storage.local.set({ autoRedeem: message.enabled === true });
    return settings();
  }
  if (message.type === 'restore') { if (busy) throw new Error('任务运行中'); await recover(); return chrome.storage.local.get(['journal', 'lastRun']); }
  if (message.type === 'add-account') {
    if (busy) throw new Error('签到期间不能添加账号，请等待原账号恢复');
    const tab = await chrome.tabs.create({ url: 'https://glados.cloud/console', active: true });
    await waitForTab(tab.id);
    const [response] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageAction, args: [{ op: 'add-account' }] });
    if (!response?.result?.ok) throw new Error(response?.result?.message || '请在网站点击当前邮箱 → 添加账号');
    return response.result;
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  dispatch(message).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: String(error) }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => { initialize().catch(console.error); });
chrome.runtime.onStartup.addListener(() => {
  initialize().then(async () => {
    const { automatic, lastRun } = await chrome.storage.local.get(['automatic', 'lastRun']);
    const now = new Date();
    const morning = new Date(now); morning.setHours(9, 35, 0, 0);
    if (automatic && now >= morning && (!lastRun?.finishedAt || new Date(lastRun.finishedAt).toDateString() !== now.toDateString())) await run('startup');
  }).catch(console.error);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (!['checkin-9', 'checkin-21'].includes(alarm.name)) return;
  initialize().then(async () => {
    await schedule();
    if ((await settings()).automatic && !busy) await run('alarm');
  }).catch(async error => { console.error(error); await chrome.storage.local.set({ lastError: String(error) }); });
});
