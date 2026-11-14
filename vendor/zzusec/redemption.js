// 兑换决策独立于浏览器和网络；价格始终来自当前账号的原生 plans。
function numeric(value, label) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) throw new Error(label + '无效');
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(label + '无效');
  return parsed;
}
function plansFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('兑换档位资料缺失');
  const plans = Object.entries(data).map(([planType, plan]) => ({
    planType, points: numeric(plan?.points, '档位积分'), days: numeric(plan?.days, '档位天数')
  }));
  if (!plans.length || plans.some(plan => !Number.isSafeInteger(plan.points) || plan.points <= 0 ||
      !Number.isSafeInteger(plan.days) || plan.days <= 0)) throw new Error('兑换档位资料无效');
  return plans.sort((a, b) => a.points - b.points || b.days - a.days);
}

// 完全背包：同档可兑换多次；天数相同时优先保留更多积分。
export function maximumDays(points, rawPlans) {
  const balance = numeric(points, '积分余额');
  if (!Number.isFinite(balance) || balance < 0 || balance > Number.MAX_SAFE_INTEGER) throw new Error('积分余额无效');
  const plans = plansFrom(rawPlans).filter(plan => plan.points <= balance);
  if (!plans.length) return { steps: [], spentPoints: 0, gainedDays: 0, remainingPoints: balance };
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const unit = plans.map(plan => plan.points).reduce(gcd);
  const budget = Math.floor(balance / unit);
  // 实际临期路径在 500 分以下；异常输入应可见，而不是静默截断预算。
  if (budget > 1000000) throw new Error('兑换计算规模异常，未自动花积分');
  const best = new Float64Array(budget + 1).fill(-Infinity);
  const chosen = new Int32Array(budget + 1).fill(-1);
  best[0] = 0;
  let winningCost = 0;
  for (let cost = 1; cost <= budget; cost++) {
    for (let index = 0; index < plans.length; index++) {
      const weight = plans[index].points / unit;
      if (weight <= cost && best[cost - weight] + plans[index].days > best[cost]) {
        best[cost] = best[cost - weight] + plans[index].days;
        chosen[cost] = index;
      }
    }
    if (best[cost] > best[winningCost]) winningCost = cost;
  }
  const counts = new Map();
  for (let cost = winningCost; cost > 0;) {
    const index = chosen[cost];
    if (index < 0) throw new Error('兑换组合计算失败');
    counts.set(index, (counts.get(index) || 0) + 1);
    cost -= plans[index].points / unit;
  }
  const steps = [...counts].map(([index, count]) => ({ ...plans[index], count }))
    .sort((a, b) => b.points - a.points);
  return { steps, spentPoints: winningCost * unit, gainedDays: best[winningCost], remainingPoints: balance - winningCost * unit };
}

export function checkinAwards(history) {
  return (Array.isArray(history) ? history : [])
    .filter(row => row?.business === 'system:checkin')
    .map(row => ({ time: numeric(row.time, '签到时间'), change: numeric(row.change, '签到积分') }))
    .filter(row => row.change > 0).sort((a, b) => b.time - a.time).slice(0, 7)
    .map(row => row.change);
}

export function decideRedemption(snapshot) {
  if (!snapshot) throw new Error('未取得积分和有效期资料，未自动兑换');
  const points = numeric(snapshot.points, '积分余额');
  const leftDays = numeric(snapshot.leftDays, '有效期');
  if (!Number.isFinite(points) || points < 0 || points > Number.MAX_SAFE_INTEGER || !Number.isFinite(leftDays)) {
    throw new Error('积分或有效期无效，未自动兑换');
  }
  const plans = plansFrom(snapshot.plans);
  const target = plans.find(plan => plan.points === 500);
  if (!target) throw new Error('当前账号没有 500 积分档，未擅自更改兑换目标');
  const common = { balance: points, leftDays, targetPoints: 500, bufferDays: 1 };
  if (points >= target.points) {
    const count = Math.floor(points / target.points);
    return { ...common, action: 'redeem', mode: 'target',
      steps: [{ ...target, count }], spentPoints: count * target.points, gainedDays: count * target.days,
      remainingPoints: points - count * target.points, reason: '已达到 500 分档，优先兑换该档；余分继续攒' };
  }
  if (points < plans[0].points) return { ...common, action: 'wait', reason: '积分不足最低兑换档，继续攒 500 分' };
  const records = checkinAwards(snapshot.history);
  if (!records.length) throw new Error('没有可用的签到积分记录，无法估算；未自动花积分');
  const dailyPoints = records.reduce((sum, change) => sum + change, 0) / records.length;
  if (!Number.isFinite(dailyPoints) || dailyPoints <= 0) throw new Error('签到平均积分无效，未自动兑换');
  const estimatedDays = Math.ceil((target.points - points) / dailyPoints);
  const forecast = { dailyPoints, samples: records.length, estimatedDays, neededDays: estimatedDays + 1 };
  if (leftDays >= forecast.neededDays) {
    return { ...common, ...forecast, action: 'wait', reason: '预计 ' + estimatedDays + ' 天可攒到 500，另留 1 天缓冲，暂不兑换' };
  }
  return { ...common, ...forecast, ...maximumDays(points, snapshot.plans), action: 'redeem', mode: 'expiry',
    reason: '攒到 500 预计需 ' + estimatedDays + ' 天，加 1 天缓冲超过剩余有效期，兑换现有积分可得的最多天数' };
}
