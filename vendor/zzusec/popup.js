const $ = id => document.getElementById(id);
let pending = false;
let state = {};
const rpc = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应，请重新打开插件');
  return response.data;
};
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) ? Math.floor(Number(value)).toString() : '—';
const gain = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) > 0 ? '+' + Math.floor(Number(value)) + ' 分' : '';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const redeemedDays = result => (result?.redemption?.receipts || []).filter(receipt => receipt.verified).reduce((sum, receipt) => sum + receipt.days, 0);
function message(text, error = false) {
  $('message').hidden = !text;
  $('message').className = 'message' + (error ? ' error' : '');
  $('message').textContent = text || '';
}
function render() {
  const accounts = state.accounts || [];
  const run = state.lastRun;
  $('accounts').replaceChildren();
  $('account-count').textContent = accounts.length ? accounts.length + ' 个' : '';
  if (!accounts.length) $('accounts').append(element('div', 'empty', '添加第一个账号后，其他账号也能保存在这里。\n首次登录请在 GLaDOS 网站完成。'));
  for (const account of accounts) {
    const row = element('div', 'account');
    row.append(element('div', 'account-mark', account.email.slice(0, 1).toUpperCase()));
    const body = element('div');
    const name = element('div', 'account-name');
    const email = element('span', 'email', account.email); email.title = account.email; name.append(email);
    if (account.current) name.append(element('span', 'current', '原账号'));
    body.append(name);
    const result = run?.results?.find(item => String(item.userId) === String(account.userId));
    const today = value => value && new Date(value).toDateString() === new Date().toDateString();
    const todayGain = (today(result?.checkinTime) ? gain(result.checkinPoints) : '') ||
      (today(account.checkinTime) ? gain(account.checkinPoints) : '');
    const historySource = Array.isArray(result?.checkinHistory) && result.checkinHistory.length ? result.checkinHistory : account.checkinHistory;
    const awards = (Array.isArray(historySource) ? historySource : [])
      .filter(item => Number.isFinite(Number(item)) && Number(item) > 0).slice(0, 7);
    body.append(element('div', 'account-meta', '积分 ' + number(result?.points ?? account.points) + (todayGain ? '（今日 ' + todayGain + '）' : '') + ' / 剩余 ' + number(result?.leftDays ?? account.leftDays) + ' 天'));
    if (state.busy && run?.current === account.email) body.append(element('div', 'account-result pending', run.phase === 'redeem' ? '正在核对并兑换积分…' : '正在核对账号并签到…'));
    else if (result) {
      const statusText = result.ok
        ? (result.already ? '已签到（无需重复）' : '签到成功') + (todayGain ? ' · 今日 ' + todayGain : '')
        : '未确认成功：' + result.message;
      body.append(element('div', 'account-result' + (result.ok ? '' : ' error'), time(result.finishedAt) + ' ' + statusText));
      if (awards.length) {
        body.append(element('div', 'account-result pending checkin-history',
          '近 ' + awards.length + ' 次：' + awards.map(item => '+' + Math.floor(Number(item))).join(' / ') + ' 分'));
      }
      if (result.warnings?.length) body.append(element('div', 'account-result pending', '签到成功，附加信息暂未取得'));
      const redemption = result.redemption;
      if (redemption) {
        let text;
        if (!redemption.ok) text = (redeemedDays(result) ? '已核实兑换 ' + redeemedDays(result) + ' 天；' : '') + '自动兑换需核实：' + redemption.message;
        else if (redemption.action === 'redeem') text = '已兑换 ' + redemption.spentPoints + ' 分，档位合计 ' + redemption.gainedDays + ' 天' + (redemption.decision?.mode === 'target' ? '；余分继续攒 500' : '');
        else text = redemption.estimatedDays !== undefined ? '保留积分冲 500：预计还需 ' + redemption.estimatedDays + ' 天，另留 1 天缓冲' : redemption.reason;
        body.append(element('div', 'account-result' + (!redemption.ok ? ' error' : redemption.action === 'wait' ? ' pending' : '') + ' redemption-result', text));
      }
    } else {
      if (awards.length) {
        body.append(element('div', 'account-result pending checkin-history',
          '近 ' + awards.length + ' 次：' + awards.map(item => '+' + Math.floor(Number(item))).join(' / ') + ' 分'));
      }
      body.append(element('div', 'account-result pending', '尚无签到记录'));
    }
    row.append(body); $('accounts').append(row);
  }
  const disabled = pending || state.busy;
  for (const id of ['run', 'add', 'refresh', 'restore']) $(id).disabled = disabled;
  $('run').textContent = state.busy ? '正在逐个签到…' : '全部签到';
  $('automatic').checked = state.automatic === true;
  $('automatic').disabled = pending;
  $('auto-redeem').checked = state.autoRedeem === true;
  $('auto-redeem').disabled = disabled;
  $('restore').hidden = !state.journal || state.busy;
  $('updated').textContent = state.busy ? '请勿手动切换网站账号' : state.lastRefresh ? '更新于 ' + time(state.lastRefresh) : '只使用本机登录态';
  if (state.busy) message('正在逐个处理。你可以关闭弹窗，任务会在后台继续，结束后恢复原账号。');
  else if (state.journal) message('原账号尚未恢复。请点击“重试恢复原账号”，暂不启动新的签到。', true);
  else if (state.lastError) message(state.lastError, true);
  else if (run?.state === 'interrupted') message(run.message || '上次任务中断，请核对记录。', true);
  else if (run?.finishedAt) {
    const success = run.results?.filter(item => item.ok).length || 0;
    const failures = (run.results || []).filter(item => item.redemption?.ok === false).length;
    const days = (run.results || []).reduce((sum, item) => sum + redeemedDays(item), 0);
    message('最近一轮成功 ' + success + '/' + (run.results?.length || 0) + '，' +
      (days ? '已核实兑换 ' + days + ' 天，' : '') + (failures ? '自动兑换有 ' + failures + ' 个需检查，' : '') +
      (run.restoration?.ok ? '已恢复原账号。' : '原账号恢复失败。'), run.state !== 'success');
  } else message('');
  $('history-list').replaceChildren();
  for (const item of (state.history || []).slice(0, 8)) {
    $('history-list').append(element('li', '', time(item.finishedAt) + '　成功 ' + item.results.filter(result => result.ok).length + '/' + item.results.length + '　' + (item.restoration?.ok ? '原账号已恢复' : '请检查账号恢复')));
  }
  if (!state.history?.length) $('history-list').append(element('li', '', '完成签到后将在这里显示。'));
}
async function load() { state = await rpc({ type: 'state' }); render(); }
async function action(type, extra = {}) {
  if (pending) return;
  pending = true; render();
  try { await rpc({ type, ...extra }); await load(); }
  catch (error) { await load().catch(() => {}); message(String(error), true); }
  finally { pending = false; renderControls(); }
}
function renderControls() {
  for (const id of ['run', 'add', 'refresh', 'restore']) $(id).disabled = pending || state.busy;
  $('automatic').disabled = pending;
  $('auto-redeem').disabled = pending || state.busy;
}
$('run').addEventListener('click', () => action('run'));
$('add').addEventListener('click', () => action('add-account'));
$('refresh').addEventListener('click', () => action('refresh'));
$('restore').addEventListener('click', () => action('restore'));
$('automatic').addEventListener('change', event => {
  state.automatic = event.target.checked;
  action('automatic', { enabled: state.automatic });
});
$('auto-redeem').addEventListener('change', event => {
  state.autoRedeem = event.target.checked;
  action('auto-redeem', { enabled: state.autoRedeem });
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') load().catch(error => message(String(error), true)); });
load().then(() => action('refresh')).catch(error => message(String(error), true));
