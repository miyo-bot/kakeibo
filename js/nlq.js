/* nlq.js - 自然言語検索（安全な Query Layer）
 *
 * 日本語の質問を構造化クエリに変換し、Store の公開関数だけを経由して集計する。
 * 生のコード/SQL を生成・実行しないため安全。
 *
 * 対応例:
 *   「今月 Amazon でいくら使った？」
 *   「今年の外食費はいくら？」
 *   「先月より増えた支出は？」
 *   「年間の固定費はいくら？」
 *   「一番お金を使っているカテゴリは？」
 */
(function () {
  'use strict';
  const S = () => globalThis.Store;
  const I = () => globalThis.Insights;

  const pad2 = n => String(n).padStart(2, '0');
  const fmt = n => '¥' + Number(n || 0).toLocaleString();
  const nowYm = () => S().nowYmStr();
  const shiftYm = (ym, d) => I().shiftYm(ym, d);

  function parsePeriod(q) {
    const today = new Date();
    const ym = nowYm();
    if (/今月/.test(q)) return { label: '今月', from: ym + '-01', to: ym + '-31', months: [ym] };
    if (/先月/.test(q)) {
      const p = shiftYm(ym, -1);
      return { label: '先月', from: p + '-01', to: p + '-31', months: [p] };
    }
    if (/先々月|2ヶ月前/.test(q)) {
      const p = shiftYm(ym, -2);
      return { label: '先々月', from: p + '-01', to: p + '-31', months: [p] };
    }
    if (/今年|本年/.test(q)) {
      const y = today.getFullYear();
      const months = [];
      for (let m = 1; m <= today.getMonth() + 1; m++) months.push(y + '-' + pad2(m));
      return { label: '今年', from: y + '-01-01', to: y + '-12-31', months };
    }
    if (/去年|昨年/.test(q)) {
      const y = today.getFullYear() - 1;
      const months = [];
      for (let m = 1; m <= 12; m++) months.push(y + '-' + pad2(m));
      return { label: '去年', from: y + '-01-01', to: y + '-12-31', months };
    }
    const mMatch = q.match(/(\d{4})年(\d{1,2})月/);
    if (mMatch) {
      const p = mMatch[1] + '-' + pad2(Number(mMatch[2]));
      return { label: mMatch[1] + '年' + mMatch[2] + '月', from: p + '-01', to: p + '-31', months: [p] };
    }
    const mOnly = q.match(/(\d{1,2})月/);
    if (mOnly) {
      const m = Number(mOnly[1]);
      let y = today.getFullYear();
      if (m > today.getMonth() + 1) y--;
      const p = y + '-' + pad2(m);
      return { label: y + '年' + m + '月', from: p + '-01', to: p + '-31', months: [p] };
    }
    return { label: '今月', from: ym + '-01', to: ym + '-31', months: [ym] };
  }

  // 質問文中の店舗名・カテゴリ名を抽出
  function findCategory(q) {
    const cats = S().state.categories;
    let best = null;
    for (const c of cats) {
      if (q.includes(c.name)) { best = c; break; }
    }
    if (best) return best;
    // よくある言い換え
    const alias = { '外食費': '外食', '食費': '食費', '電気代': '光熱・水道', '光熱費': '光熱・水道', 'ガス代': '光熱・水道', '水道代': '光熱・水道', '固定費': null, 'サブスク': null };
    for (const k in alias) {
      if (q.includes(k)) {
        if (!alias[k]) return null;
        return cats.find(c => c.name === alias[k]) || null;
      }
    }
    return null;
  }
  function findPayee(q) {
    // カテゴリ名以外の名詞を店舗として扱う: 辞書と履歴から候補を探す
    const st = S().state;
    const nq = S().normalizeText(q);
    if (!nq) return null;
    // 履歴の店舗名で質問文に含まれるもの
    const seen = new Set();
    for (const t of st.transactions) {
      if (!t.payee) continue;
      const np = S().normalizeText(t.payee);
      if (np && np.length >= 2 && nq.includes(np)) {
        if (!seen.has(np)) { seen.add(np); return t.payee; }
      }
    }
    // 辞書キーワード
    const dict = (globalThis.Classify && Classify.DICT) || [];
    for (const [kw] of dict) {
      const nk = S().normalizeText(kw);
      if (nk && nq.includes(nk)) return kw;
    }
    return null;
  }

  function sumInPeriod(period, filter) {
    let sum = 0, count = 0;
    for (const ym of period.months) {
      for (const t of S().txInMonth(ym)) {
        if (t.exclude) continue;
        if (filter(t)) { sum += t.amount; count++; }
      }
    }
    return { sum, count };
  }

  // メイン: 質問文字列 → {answer, detail?, rows?}
  function ask(q) {
    const query = String(q || '').trim();
    if (!query) return { answer: '質問を入力してください。' };
    const period = parsePeriod(query);
    const cat = findCategory(query);
    const payee = findPayee(query);
    const isExpenseQ = /支出|使っ|費|いくら/.test(query) || !/収入/.test(query);
    const isIncomeQ = /収入|給料|給与/.test(query);

    // 「一番お金を使っているカテゴリ」
    if (/一番|最も|トップ|最大/.test(query) && /カテゴリ|項目/.test(query)) {
      const list = [];
      for (const ym of period.months) {
        for (const x of S().byCategory(ym, 'expense')) {
          const ex = list.find(e => e.category.id === x.category.id);
          if (ex) ex.total += x.total; else list.push({ category: x.category, total: x.total });
        }
      }
      list.sort((a, b) => b.total - a.total);
      if (!list.length) return { answer: period.label + 'の支出データがありません。' };
      const top = list[0];
      return {
        answer: period.label + 'で一番使っているのは ' + (top.category.icon || '') + top.category.name + ' で ' + fmt(top.total) + ' です。',
        rows: list.slice(0, 5).map(x => [x.category.name, fmt(x.total)]),
      };
    }

    // 「先月より増えた支出」
    if (/増えた|増加|上がった/.test(query) && /先月|前月/.test(query)) {
      const diffs = I().monthOverMonth(nowYm()).filter(x => x.diff > 0);
      if (!diffs.length) return { answer: '先月より増えた支出はありません。' };
      return {
        answer: '先月より増えた支出は ' + diffs.slice(0, 3).map(x => x.category.name + '（+' + fmt(x.diff) + '）').join('、') + ' です。',
        rows: diffs.map(x => [x.category.name, '+' + fmt(x.diff), x.pct !== null ? x.pct + '%' : '新規']),
      };
    }

    // 「固定費」「サブスク」
    if (/固定費|サブスク|定額|毎月の支払い/.test(query)) {
      const fs = I().fixedCostShare();
      const subs = I().detectSubscriptions();
      return {
        answer: '固定費は月 ' + fmt(fs.fixedMonthly) + '（年間 ' + fmt(fs.yearlyFixed) + '、月平均支出の約 ' + Math.round(fs.share * 100) + '%）です。検出数: ' + fs.count + '件。',
        rows: subs.slice(0, 8).map(s => [s.label, fmt(s.monthly) + '/月', '毎月' + s.day + '日頃']),
      };
    }

    // 「予測」「残高」
    if (/予測|予想|残高|いくら残/.test(query)) {
      const fc = I().forecastBalances([7, 30, 90, 180]);
      const rows = [7, 30, 90, 180].map(h => {
        const r = fc.horizons[h];
        return [h + '日後（' + r.date + '）', fmt(r.projectedTotal), '確定 ' + fmt(r.confirmedTotal)];
      });
      return {
        answer: '現在の総資産は ' + fmt(S().totalAssets()) + '。30日後の予想残高は約 ' + fmt(fc.horizons[30].projectedTotal) + ' です。',
        rows,
      };
    }

    // 「収入」
    if (isIncomeQ) {
      const f = t => t.type === 'income' && (!cat || t.categoryId === cat.id);
      const r = sumInPeriod(period, f);
      return {
        answer: period.label + 'の収入' + (cat ? '（' + cat.name + '）' : '') + 'は ' + fmt(r.sum) + '（' + r.count + '件）です。',
      };
    }

    // 店舗指定
    if (payee) {
      const np = S().normalizeText(payee);
      const f = t => t.type === 'expense' && S().normalizeText(t.payee || '') === np;
      const r = sumInPeriod(period, f);
      if (!r.count) {
        // 緩和: 部分一致
        const f2 = t => t.type === 'expense' && S().normalizeText((t.payee || '') + ' ' + (t.memo || '')).includes(np);
        const r2 = sumInPeriod(period, f2);
        return { answer: period.label + 'に ' + payee + ' で使った金額は ' + fmt(r2.sum) + '（' + r2.count + '件）です。' };
      }
      return { answer: period.label + 'に ' + payee + ' で使った金額は ' + fmt(r.sum) + '（' + r.count + '件）です。' };
    }

    // カテゴリ指定
    if (cat) {
      const f = t => t.type === 'expense' && t.categoryId === cat.id;
      const r = sumInPeriod(period, f);
      // 前年同期比較があれば付記
      let extra = '';
      if (/去年|昨年|前年/.test(query) === false && period.months.length === 1) {
        const prevYm = shiftYm(period.months[0], -12);
        const pv = (S().byCategory(prevYm, 'expense').find(x => x.category && x.category.id === cat.id) || {}).total || 0;
        if (pv) {
          const d = r.sum - pv;
          extra = '前年同月は ' + fmt(pv) + '（' + (d >= 0 ? '+' : '') + fmt(d) + '）。';
        }
      }
      return { answer: period.label + 'の' + cat.name + 'は ' + fmt(r.sum) + '（' + r.count + '件）です。' + extra };
    }

    // 総支出
    if (isExpenseQ) {
      const f = t => t.type === 'expense';
      const r = sumInPeriod(period, f);
      const inc = sumInPeriod(period, t => t.type === 'income');
      return {
        answer: period.label + 'の支出は ' + fmt(r.sum) + '（' + r.count + '件）、収入は ' + fmt(inc.sum) + '、収支は ' + (inc.sum - r.sum >= 0 ? '+' : '') + fmt(inc.sum - r.sum) + ' です。',
      };
    }

    return { answer: 'すみません、その質問にはまだ答えられません。例: 「今月 Amazon でいくら使った？」「今年の外食費は？」「固定費はいくら？」' };
  }

  const api = { ask, parsePeriod };
  if (typeof window !== 'undefined') window.NLQ = api;
  globalThis.NLQ = api;
})();
