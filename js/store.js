/* store.js - データ層 (localStorage) */
(function () {
  'use strict';
  const KEY = 'kakeibo.v1';

  const uid = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  const DEFAULT_EXPENSE_CATS = [
    ['食費', '#f97316', '🍚'], ['日用品', '#84cc16', '🧻'], ['住居', '#8b5cf6', '🏠'],
    ['光熱・水道', '#06b6d4', '💡'], ['通信', '#3b82f6', '📱'], ['交通', '#22c55e', '🚃'],
    ['医療', '#ef4444', '💊'], ['娯楽', '#ec4899', '🎮'], ['衣服・美容', '#d946ef', '👕'],
    ['教育', '#6366f1', '📚'], ['交際', '#f43f5e', '🍻'], ['その他', '#64748b', '📦'],
  ];
  const DEFAULT_INCOME_CATS = [
    ['給与', '#059669', '💼'], ['副業', '#10b981', '💻'], ['賞与', '#34d399', '🎁'],
    ['投資', '#0ea5e9', '📈'], ['その他収入', '#64748b', '💴'],
  ];

  function defaultState() {
    return {
      version: 1,
      transactions: [],          // {id,date:'YYYY-MM-DD',type:'expense'|'income'|'transfer',amount,categoryId,accountId,fromAccountId,toAccountId,memo,recurringId,recurringMonth}
      categories: [
        ...DEFAULT_EXPENSE_CATS.map(([name, color, icon]) => ({ id: uid(), name, color, icon, type: 'expense' })),
        ...DEFAULT_INCOME_CATS.map(([name, color, icon]) => ({ id: uid(), name, color, icon, type: 'income' })),
      ],
      accounts: [
        { id: uid(), name: '現金', kind: 'cash', initialBalance: 0 },
        { id: uid(), name: '銀行口座', kind: 'bank', initialBalance: 0 },
        { id: uid(), name: 'クレジットカード', kind: 'credit', initialBalance: 0 },
      ],
      budgets: {},               // {categoryId: monthlyAmount}
      recurring: [],             // {id,type,amount,categoryId,accountId,day,memo,active}
      recurringSkipped: [],      // 'recurringId:YYYY-MM' 手動削除済み
      settings: { theme: 'light' },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    } catch (e) {
      console.error('load failed', e);
      return defaultState();
    }
  }

  let state = load();
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

  function nowYmStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /* ---------- クエリ ---------- */
  const catById = id => state.categories.find(c => c.id === id);
  const accById = id => state.accounts.find(a => a.id === id);
  const catsOf = type => state.categories.filter(c => c.type === type);

  function txInMonth(ym) { return state.transactions.filter(t => t.date.startsWith(ym)); }
  function txOfDay(date) { return state.transactions.filter(t => t.date === date); }

  function monthTotals(ym) {
    let expense = 0, income = 0;
    for (const t of txInMonth(ym)) {
      if (t.type === 'expense') expense += t.amount;
      else if (t.type === 'income') income += t.amount;
    }
    return { expense, income, diff: income - expense };
  }

  function byCategory(ym, type) {
    const map = new Map();
    for (const t of txInMonth(ym)) {
      if (t.type !== type) continue;
      map.set(t.categoryId, (map.get(t.categoryId) || 0) + t.amount);
    }
    return [...map.entries()]
      .map(([categoryId, total]) => ({ category: catById(categoryId), total }))
      .filter(x => x.total > 0)
      .sort((a, b) => b.total - a.total);
  }

  function dailyTotals(ym) {
    const map = new Map();
    for (const t of txInMonth(ym)) {
      if (t.type === 'transfer') continue;
      const d = map.get(t.date) || { expense: 0, income: 0 };
      d[t.type] += t.amount;
      map.set(t.date, d);
    }
    return map;
  }

  function accountBalance(accountId) {
    const acc = accById(accountId);
    if (!acc) return 0;
    let bal = acc.initialBalance || 0;
    for (const t of state.transactions) {
      if (t.type === 'expense' && t.accountId === accountId) bal -= t.amount;
      else if (t.type === 'income' && t.accountId === accountId) bal += t.amount;
      else if (t.type === 'transfer') {
        if (t.fromAccountId === accountId) bal -= t.amount;
        if (t.toAccountId === accountId) bal += t.amount;
      }
    }
    return bal;
  }

  /* ---------- 固定費の自動反映 ---------- */
  function applyRecurring(ym) {
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    let changed = false;
    for (const r of state.recurring) {
      if (!r.active) continue;
      if (r.startYm && ym < r.startYm) continue;
      const key = r.id + ':' + ym;
      if (state.recurringSkipped.includes(key)) continue;
      if (state.transactions.some(t => t.recurringId === r.id && t.recurringMonth === ym)) continue;
      const day = Math.min(r.day, lastDay);
      state.transactions.push({
        id: uid(),
        date: ym + '-' + String(day).padStart(2, '0'),
        type: r.type, amount: r.amount, categoryId: r.categoryId,
        accountId: r.accountId, memo: r.memo || '',
        recurringId: r.id, recurringMonth: ym,
      });
      changed = true;
    }
    if (changed) save();
  }

  /* ---------- 更新系 ---------- */
  function addTx(tx) {
    tx.id = uid();
    state.transactions.push(tx);
    save();
    return tx;
  }
  function updateTx(id, patch) {
    const t = state.transactions.find(t => t.id === id);
    if (!t) return;
    Object.assign(t, patch);
    // 種別が変わったら不要フィールドを掃除
    if (t.type !== 'transfer') { delete t.fromAccountId; delete t.toAccountId; }
    save();
  }
  function deleteTx(id) {
    const t = state.transactions.find(t => t.id === id);
    if (t && t.recurringId && t.recurringMonth) {
      state.recurringSkipped.push(t.recurringId + ':' + t.recurringMonth);
    }
    state.transactions = state.transactions.filter(t => t.id !== id);
    save();
  }

  function addCategory(c) { c.id = uid(); state.categories.push(c); save(); return c; }
  function deleteCategory(id) {
    state.categories = state.categories.filter(c => c.id !== id);
    delete state.budgets[id];
    save();
  }
  function addAccount(a) { a.id = uid(); a.initialBalance = a.initialBalance || 0; state.accounts.push(a); save(); return a; }
  function deleteAccount(id) {
    state.accounts = state.accounts.filter(a => a.id !== id);
    save();
  }
  function setBudget(categoryId, amount) {
    if (amount > 0) state.budgets[categoryId] = amount;
    else delete state.budgets[categoryId];
    save();
  }
  function addRecurring(r) { r.id = uid(); r.active = true; if (!r.startYm) r.startYm = nowYmStr(); state.recurring.push(r); save(); return r; }
  function deleteRecurring(id) {
    state.recurring = state.recurring.filter(r => r.id !== id);
    save();
  }
  function toggleRecurring(id) {
    const r = state.recurring.find(r => r.id === id);
    if (r) { r.active = !r.active; save(); }
  }

  /* ---------- CSV ---------- */
  function csvEsc(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCSV() {
    const head = ['日付', '種別', '金額', 'カテゴリ', '口座', '振替元', '振替先', 'メモ'];
    const rows = state.transactions
      .slice().sort((a, b) => a.date.localeCompare(b.date))
      .map(t => [
        t.date,
        t.type === 'expense' ? '支出' : t.type === 'income' ? '収入' : '振替',
        t.amount,
        t.categoryId ? (catById(t.categoryId) || {}).name || '' : '',
        t.accountId ? (accById(t.accountId) || {}).name || '' : '',
        t.fromAccountId ? (accById(t.fromAccountId) || {}).name || '' : '',
        t.toAccountId ? (accById(t.toAccountId) || {}).name || '' : '',
        t.memo || '',
      ].map(csvEsc).join(','));
    return '\uFEFF' + head.join(',') + '\n' + rows.join('\n');
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.some(v => v !== '')) rows.push(row);
    return rows;
  }

  function findOrCreateCategory(name, type) {
    name = name || 'その他';
    let c = state.categories.find(c => c.name === name && c.type === type);
    if (!c) c = addCategory({ name, type, color: '#64748b', icon: type === 'income' ? '💴' : '📦' });
    return c;
  }
  function findOrCreateAccount(name) {
    name = name || '現金';
    let a = state.accounts.find(a => a.name === name);
    if (!a) a = addAccount({ name, kind: 'other', initialBalance: 0 });
    return a;
  }

  const num = v => Number(String(v).replace(/[^0-9\-]/g, '')) || 0;
  const normDate = v => {
    const m = String(v).trim().match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (!m) return null;
    return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  };

  // マネーフォワードME形式も取り込み可（計算対象/日付/内容/金額/保有金融機関/大項目/中項目...）
  function importCSV(text) {
    const rows = parseCSV(text.replace(/^\uFEFF/, ''));
    if (!rows.length) return { count: 0, skipped: 0 };
    const head = rows[0].map(h => h.trim());
    const isMF = head.includes('大項目') && head.includes('金額（円）');
    let count = 0, skipped = 0;
    const defaultAcc = state.accounts[0] && state.accounts[0].id;
    const seen = new Set(state.transactions.map(t =>
      [t.date, t.type, t.amount, t.categoryId || '', t.accountId || '', t.fromAccountId || '', t.toAccountId || '', t.memo || ''].join('|')));
    const push = tx => {
      const key = [tx.date, tx.type, tx.amount, tx.categoryId || '', tx.accountId || '', tx.fromAccountId || '', tx.toAccountId || '', tx.memo || ''].join('|');
      if (seen.has(key)) { skipped++; return; }
      seen.add(key);
      addTx(tx);
      count++;
    };

    if (isMF) {
      const iDate = head.indexOf('日付');
      const iMemo = head.indexOf('内容');
      const iAmt = head.indexOf('金額（円）');
      const iAcc = head.indexOf('保有金融機関');
      const iCat = head.indexOf('大項目');
      const iSub = head.indexOf('中項目');
      const iTarget = head.indexOf('計算対象');
      const iTransfer = head.indexOf('振替');
      for (const r of rows.slice(1)) {
        const date = normDate(r[iDate]);
        const amt = num(r[iAmt]);
        if (!date || !amt) { skipped++; continue; }
        if (iTarget >= 0 && String(r[iTarget]).trim() === '0') { skipped++; continue; }
        if (iTransfer >= 0 && String(r[iTransfer]).trim() === '1') { skipped++; continue; }
        const type = amt < 0 ? 'expense' : 'income';
        const catName = (r[iSub] && r[iSub].trim()) || (r[iCat] && r[iCat].trim()) || '';
        const cat = findOrCreateCategory(catName, type);
        const acc = findOrCreateAccount(iAcc >= 0 ? r[iAcc].trim() : '');
        push({ date, type, amount: Math.abs(amt), categoryId: cat.id, accountId: acc.id, memo: (r[iMemo] || '').trim() });
      }
    } else {
      // 自アプリ形式 or 汎用: 日付,種別(支出/収入/振替),金額,カテゴリ,口座,[振替元,振替先,]メモ
      const hasHead = /日付|date/i.test(head[0] || '');
      const col = (name, fallback) => hasHead && head.indexOf(name) >= 0 ? head.indexOf(name) : fallback;
      const idx = {
        date: col('日付', 0), type: col('種別', 1), amount: col('金額', 2),
        cat: col('カテゴリ', 3), acc: col('口座', 4),
        from: col('振替元', -1), to: col('振替先', -1), memo: col('メモ', 5),
      };
      for (const r of rows.slice(hasHead ? 1 : 0)) {
        const date = normDate(r[idx.date]);
        if (!date) { skipped++; continue; }
        const typeStr = r[idx.type] || '';
        const type = /収入|income/i.test(typeStr) ? 'income'
          : /振替|transfer/i.test(typeStr) ? 'transfer' : 'expense';
        const amt = num(r[idx.amount]);
        if (!amt) { skipped++; continue; }
        const memo = idx.memo >= 0 ? (r[idx.memo] || '').trim() : '';
        if (type === 'transfer') {
          const from = idx.from >= 0 && r[idx.from] ? findOrCreateAccount(r[idx.from].trim()) : { id: defaultAcc };
          const to = idx.to >= 0 && r[idx.to] ? findOrCreateAccount(r[idx.to].trim()) : null;
          if (!from.id || !to || !to.id || from.id === to.id) { skipped++; continue; }
          push({ date, type, amount: Math.abs(amt), categoryId: null, accountId: null, fromAccountId: from.id, toAccountId: to.id, memo });
        } else {
          const cat = idx.cat >= 0 ? findOrCreateCategory((r[idx.cat] || '').trim(), type) : findOrCreateCategory('', type);
          const acc = idx.acc >= 0 && r[idx.acc] ? findOrCreateAccount(r[idx.acc].trim()) : { id: defaultAcc };
          push({ date, type, amount: Math.abs(amt), categoryId: cat.id, accountId: acc.id, memo });
        }
      }
    }
    save();
    return { count, skipped };
  }

  /* ---------- サンプルデータ ---------- */
  function seedDemo() {
    const now = new Date();
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const expCats = catsOf('expense'), incCats = catsOf('income');
    const accs = state.accounts;
    if (!accs.length || !expCats.length) return;
    const salary = incCats.find(c => c.name === '給与') || incCats[0];
    for (let back = 2; back >= 0; back--) {
      const base = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const ym = base.getFullYear() + '-' + String(base.getMonth() + 1).padStart(2, '0');
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      const maxDay = back === 0 ? now.getDate() : lastDay;
      addTx({ date: ym + '-25', type: 'income', amount: 280000, categoryId: salary.id, accountId: (accs[1] || accs[0]).id, memo: '給与' });
      // 固定費は月1回
      const fixed = { '住居': [1, 78000], '光熱・水道': [10, 9000], '通信': [15, 5500] };
      for (const name in fixed) {
        const c = expCats.find(c => c.name === name);
        const [day, amount] = fixed[name];
        if (c && day <= maxDay) {
          addTx({ date: ym + '-' + String(day).padStart(2, '0'), type: 'expense', amount, categoryId: c.id, accountId: pick(accs).id, memo: name });
        }
      }
      const varCats = expCats.filter(c => !fixed[c.name]);
      const n = 18 + Math.floor(Math.random() * 8);
      for (let i = 0; i < n; i++) {
        const day = 1 + Math.floor(Math.random() * maxDay);
        const cat = pick(varCats.length ? varCats : expCats);
        const amount = 300 + Math.floor(Math.random() * 60) * 100;
        addTx({
          date: ym + '-' + String(day).padStart(2, '0'),
          type: 'expense', amount, categoryId: cat.id,
          accountId: pick(accs).id, memo: '',
        });
      }
    }
  }

  function resetAll() {
    state = defaultState();
    save();
  }

  window.Store = {
    get state() { return state; },
    save, uid,
    catById, accById, catsOf,
    txInMonth, txOfDay, monthTotals, byCategory, dailyTotals, accountBalance,
    applyRecurring,
    addTx, updateTx, deleteTx,
    addCategory, deleteCategory, addAccount, deleteAccount,
    setBudget, addRecurring, deleteRecurring, toggleRecurring,
    exportCSV, importCSV, seedDemo, resetAll,
  };
})();
