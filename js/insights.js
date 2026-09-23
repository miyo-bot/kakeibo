/* insights.js - 家計分析エンジン（オンデバイス、外部API不要）
 *
 * すべてローカルデータから計算する。外部AI API がなくても動く。
 * 将来 LLM を接続する場合はここに「説明文生成アダプタ」を差し込む設計。
 */
(function () {
  'use strict';
  const S = () => globalThis.Store;
  const pad2 = n => String(n).padStart(2, '0');
  const ymOf = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  const shiftYm = (ym, diff) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + diff, 1);
    return ymOf(d);
  };
  const daysInMonth = ym => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  };
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  const fmt = n => '¥' + Number(n || 0).toLocaleString();

  /* ---------- 月次比較 ---------- */
  function monthOverMonth(ym) {
    const prev = shiftYm(ym, -1);
    const cur = S().byCategory(ym, 'expense');
    const prv = S().byCategory(prev, 'expense');
    const prvMap = new Map(prv.map(x => [x.category && x.category.id, x.total]));
    return cur.map(x => {
      const cid = x.category && x.category.id;
      const p = prvMap.get(cid) || 0;
      const diff = x.total - p;
      const pct = p ? Math.round(diff / p * 100) : null;
      return { category: x.category, cur: x.total, prev: p, diff, pct };
    }).filter(x => x.category).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }

  /* ---------- 固定費・サブスク検出 ---------- */
  // 正規化した店舗/メモでグループ化し、月次・金額が安定したものを固定費とみなす
  function detectSubscriptions() {
    const st = S().state;
    const groups = new Map();  // key -> txs[]
    for (const t of st.transactions) {
      if (t.type !== 'expense' || t.exclude) continue;
      const label = t.payee || t.memo || '';
      const key = S().normalizeText(label);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const out = [];
    const today = todayStr();
    for (const [key, txs] of groups) {
      if (txs.length < 3) continue;
      txs.sort((a, b) => a.date.localeCompare(b.date));
      const months = new Set(txs.map(t => t.date.slice(0, 7)));
      if (months.size < 3) continue;
      const days = txs.map(t => Number(t.date.slice(8, 10)));
      const amounts = txs.map(t => t.amount);
      const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const avgDay = Math.round(days.reduce((s, v) => s + v, 0) / days.length);
      const daySpread = Math.max(...days) - Math.min(...days);
      if (daySpread > 8) continue;
      // 金額は中央値ベースで判定（値上げ・一時的な変動を許容）
      const sortedAmt = amounts.slice().sort((a, b) => a - b);
      const median = sortedAmt[Math.floor(sortedAmt.length / 2)];
      const stable = amounts.filter(v => median > 0 && Math.abs(v - median) / median <= 0.2).length;
      if (median > 0 && stable < Math.ceil(amounts.length * 0.6)) continue;
      const last = txs[txs.length - 1];
      const prev = txs.length >= 2 ? txs[txs.length - 2] : null;
      const priceUp = prev && last.amount > prev.amount * 1.03;
      const [ly, lm] = last.date.slice(0, 7).split('-').map(Number);
      let nextD = new Date(ly, lm, Math.min(avgDay, 28));
      if (nextD <= new Date()) nextD = new Date(ly, lm + 1, Math.min(avgDay, 28));
      const monthsSince = (Number(today.slice(0, 4)) - ly) * 12 + (Number(today.slice(5, 7)) - lm);
      out.push({
        key, label: last.payee || last.memo || key,
        monthly: Math.round(avgAmt), yearly: Math.round(avgAmt * 12),
        day: avgDay, count: txs.length, months: months.size,
        lastDate: last.date, lastAmount: last.amount,
        prevAmount: prev ? prev.amount : null,
        priceUp: !!priceUp,
        nextDate: nextD.getFullYear() + '-' + pad2(nextD.getMonth() + 1) + '-' + pad2(nextD.getDate()),
        inactiveMonths: monthsSince,
        categoryId: last.categoryId,
      });
    }
    return out.sort((a, b) => b.monthly - a.monthly);
  }

  // 固定費合計（月平均支出に占める割合）
  function fixedCostShare() {
    const subs = detectSubscriptions();
    const fixedSum = subs.reduce((s, x) => s + x.monthly, 0);
    const ym = S().nowYmStr();
    let total = 0, n = 0;
    for (let i = 0; i < 12; i++) {
      const t = S().monthTotals(shiftYm(ym, -i));
      if (t.expense > 0) { total += t.expense; n++; }
    }
    const monthlyAvg = n ? total / n : 0;
    return {
      fixedMonthly: fixedSum,
      monthlyAvg: Math.round(monthlyAvg),
      share: monthlyAvg ? fixedSum / monthlyAvg : 0,
      yearlyFixed: fixedSum * 12,
      count: subs.length,
    };
  }

  /* ---------- 予算ペース ---------- */
  function budgetStatus(ym) {
    const st = S().state;
    const catExp = S().byCategory(ym, 'expense');
    const spentOf = cid => (catExp.find(x => x.category && x.category.id === cid) || {}).total || 0;
    const lastDay = daysInMonth(ym);
    const isCur = ym === S().nowYmStr();
    const elapsed = isCur ? new Date().getDate() : lastDay;
    const remain = Math.max(lastDay - elapsed, 0);
    const rows = [];
    for (const c of S().catsOf('expense')) {
      const budget = st.budgets[c.id] || 0;
      if (!budget) continue;
      const spent = spentOf(c.id);
      const pct = spent / budget;
      const dailyPace = elapsed ? spent / elapsed : 0;
      const forecast = Math.round(dailyPace * lastDay);
      const perDay = remain > 0 ? Math.max(Math.round((budget - spent) / remain), 0) : 0;
      rows.push({
        category: c, budget, spent, pct,
        remaining: budget - spent,
        forecast, overForecast: Math.max(forecast - budget, 0),
        perDay, elapsed, remain, lastDay,
        status: spent > budget ? 'over' : pct >= 0.8 ? 'warn' : 'ok',
      });
    }
    return rows.sort((a, b) => b.pct - a.pct);
  }

  /* ---------- カード引き落とし予定 ---------- */
  function cardPaymentSchedule() {
    const st = S().state;
    return st.recurring
      .filter(r => r.active && r.type === 'transfer')
      .filter(r => {
        const to = S().accById(r.toAccountId);
        return to && to.kind === 'credit';
      })
      .map(r => ({
        id: r.id, day: r.day, amount: r.amount,
        from: S().accById(r.accountId), to: S().accById(r.toAccountId),
        memo: r.memo || '',
      }));
  }

  /* ---------- 将来残高予測 ---------- */
  // horizons: 日数の配列 [7,30,90,180]
  // 確定: 既存残高 + 期間内に発生する recurring（収入・支出・振替）
  // 予測: 確定 + 変動費の見積（過去3ヶ月の変動費日割り × 日数）
  function forecastBalances(horizons) {
    const st = S().state;
    const today = todayStr();
    const base = {};
    for (const a of st.accounts) base[a.id] = S().accountBalance(a.id);

    const subs = detectSubscriptions();
    const fixedMonthly = subs.reduce((s, x) => s + x.monthly, 0);
    const ym = S().nowYmStr();
    let varSum = 0, varDays = 0;
    for (let i = 1; i <= 3; i++) {
      const m = shiftYm(ym, -i);
      const t = S().monthTotals(m);
      if (t.expense > 0) {
        varSum += Math.max(t.expense - fixedMonthly, 0);
        varDays += daysInMonth(m);
      }
    }
    const varPerDay = varDays ? varSum / varDays : 0;

    function scheduledBetween(fromDate, toDate) {
      const deltas = [];
      const from = new Date(fromDate), to = new Date(toDate);
      for (const r of st.recurring) {
        if (!r.active) continue;
        const d = new Date(from.getFullYear(), from.getMonth(), 1);
        for (let k = 0; k < 24; k++) {
          const y = d.getFullYear(), m = d.getMonth();
          const last = new Date(y, m + 1, 0).getDate();
          const day = Math.min(r.day, last);
          const occ = new Date(y, m, day);
          const occStr = occ.getFullYear() + '-' + pad2(occ.getMonth() + 1) + '-' + pad2(occ.getDate());
          if (occ > to) break;
          if (occ > from) {
            const ymOcc = occStr.slice(0, 7);
            const already = st.transactions.some(t => t.recurringId === r.id && t.recurringMonth === ymOcc);
            if (!already && !(r.startYm && ymOcc < r.startYm)) {
              if (r.type === 'income') deltas.push({ accountId: r.accountId, delta: r.amount });
              else if (r.type === 'expense') deltas.push({ accountId: r.accountId, delta: -r.amount });
              else if (r.type === 'transfer') {
                deltas.push({ accountId: r.accountId, delta: -r.amount });
                deltas.push({ accountId: r.toAccountId, delta: r.amount });
              }
            }
          }
          d.setMonth(d.getMonth() + 1);
        }
      }
      return deltas;
    }

    const results = {};
    for (const h of horizons) {
      const toDate = new Date();
      toDate.setDate(toDate.getDate() + h);
      const toStr = toDate.getFullYear() + '-' + pad2(toDate.getMonth() + 1) + '-' + pad2(toDate.getDate());
      const deltas = scheduledBetween(today, toStr);
      const confirmed = { ...base };
      for (const d of deltas) {
        if (confirmed[d.accountId] !== undefined) confirmed[d.accountId] += d.delta;
      }
      const liquidIds = st.accounts.filter(a => a.kind !== 'credit' && a.kind !== 'invest').map(a => a.id);
      const projected = { ...confirmed };
      const varTotal = Math.round(varPerDay * h);
      if (liquidIds.length) {
        const main = liquidIds.reduce((a, b) => (confirmed[a] || 0) >= (confirmed[b] || 0) ? a : b);
        projected[main] = (projected[main] || 0) - varTotal;
      }
      const sum = obj => Object.values(obj).reduce((s, v) => s + v, 0);
      results[h] = {
        date: toStr,
        confirmedTotal: sum(confirmed),
        projectedTotal: sum(projected),
        variableEstimate: varTotal,
        scheduled: deltas,
      };
    }
    return { base, horizons: results, varPerDay: Math.round(varPerDay), fixedMonthly };
  }

  /* ---------- 支出増の理由 ---------- */
  function whyIncreased(ym) {
    const diffs = monthOverMonth(ym).filter(x => x.diff > 0);
    if (!diffs.length) return null;
    return diffs.slice(0, 3).map(x => ({
      name: x.category.name, icon: x.category.icon,
      diff: x.diff, pct: x.pct, cur: x.cur, prev: x.prev,
    }));
  }

  /* ---------- インサイト生成 ---------- */
  function generate(ym) {
    const out = [];
    const isCur = ym === S().nowYmStr();
    const tot = S().monthTotals(ym);
    const prevTot = S().monthTotals(shiftYm(ym, -1));

    if (prevTot.expense > 0 && tot.expense > 0) {
      const pct = Math.round((tot.expense - prevTot.expense) / prevTot.expense * 100);
      if (Math.abs(pct) >= 8) {
        out.push({
          kind: 'mom', severity: pct > 15 ? 'warn' : 'info',
          text: '今月の支出は前月比 ' + (pct > 0 ? '+' : '') + pct + '%（' + fmt(tot.expense) + '）です。',
        });
      }
    }

    for (const x of monthOverMonth(ym)) {
      if (x.pct !== null && x.pct >= 25 && x.diff >= 3000) {
        out.push({
          kind: 'cat-spike', severity: x.pct >= 50 ? 'warn' : 'info',
          text: (x.category.icon || '') + ' ' + x.category.name + ' が前月より ' + x.pct + '% 増（+' + fmt(x.diff) + '）です。',
        });
      }
    }

    for (const b of budgetStatus(ym)) {
      if (b.overForecast > 0 && isCur) {
        out.push({
          kind: 'budget-over', severity: b.pct > 1 ? 'alert' : 'warn',
          text: (b.category.icon || '') + ' ' + b.category.name + ' はこのペースだと予算を約 ' + fmt(b.overForecast) + ' 超過する見込みです。',
        });
      } else if (b.status === 'warn' && isCur) {
        out.push({
          kind: 'budget-warn', severity: 'warn',
          text: (b.category.icon || '') + ' ' + b.category.name + ' の予算消化率が ' + Math.round(b.pct * 100) + '% に達しています。',
        });
      }
    }

    const subs = detectSubscriptions();
    for (const s of subs) {
      if (s.priceUp) {
        out.push({
          kind: 'price-up', severity: 'warn',
          text: s.label + ' が値上がりしています（' + fmt(s.prevAmount) + ' → ' + fmt(s.lastAmount) + '）。',
        });
      }
      if (s.inactiveMonths >= 3) {
        out.push({
          kind: 'unused-sub', severity: 'info',
          text: s.label + ' は ' + s.inactiveMonths + ' ヶ月利用履歴がありません。解約を検討できます。',
        });
      }
    }
    const fs = fixedCostShare();
    if (fs.share > 0.2 && fs.count >= 3) {
      out.push({
        kind: 'fixed-share', severity: 'info',
        text: '固定費は月平均支出の約 ' + Math.round(fs.share * 100) + '%（年間 ' + fmt(fs.yearlyFixed) + '）を占めています。',
      });
    }

    for (const cp of cardPaymentSchedule()) {
      out.push({
        kind: 'card-pay', severity: 'info',
        text: '毎月 ' + cp.day + ' 日前後に ' + (cp.to ? cp.to.name : 'カード') + ' の支払い（約 ' + fmt(cp.amount) + '）があります。',
      });
    }

    const utilCat = S().catByName('光熱・水道');
    if (utilCat) {
      const cur = (S().byCategory(ym, 'expense').find(x => x.category && x.category.id === utilCat.id) || {}).total || 0;
      let sum = 0, n = 0;
      for (let i = 1; i <= 6; i++) {
        const m = shiftYm(ym, -i);
        const v = (S().byCategory(m, 'expense').find(x => x.category && x.category.id === utilCat.id) || {}).total || 0;
        if (v) { sum += v; n++; }
      }
      const avg = n ? sum / n : 0;
      if (cur > 0 && avg > 0 && cur > avg * 1.2) {
        out.push({
          kind: 'utility', severity: 'warn',
          text: '光熱・水道費が過去6ヶ月平均（' + fmt(Math.round(avg)) + '）より高くなっています（今月 ' + fmt(cur) + '）。',
        });
      }
    }

    const fc = forecastBalances([30]);
    const end = fc.horizons[30];
    if (end) {
      out.push({
        kind: 'forecast', severity: 'info',
        text: '30日後の予想残高は約 ' + fmt(end.projectedTotal) + '（確定 ' + fmt(end.confirmedTotal) + '、変動費見込 -' + fmt(end.variableEstimate) + '）です。',
      });
    }

    const why = whyIncreased(ym);
    if (why && prevTot.expense > 0 && tot.expense > prevTot.expense) {
      out.push({
        kind: 'why', severity: 'info',
        text: '先月より支出が増えた主な理由: ' + why.map(w => w.name + '（+' + fmt(w.diff) + '）').join('、'),
      });
    }

    const rank = { alert: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  const api = {
    monthOverMonth, detectSubscriptions, fixedCostShare,
    budgetStatus, cardPaymentSchedule, forecastBalances,
    whyIncreased, generate,
    shiftYm, daysInMonth,
  };
  if (typeof window !== 'undefined') window.Insights = api;
  globalThis.Insights = api;
})();
