/* store.js - データ層
 *
 * 永続化: IndexedDB（フォールバック: localStorage）
 * 読み取りはすべて同期（メモリ上の state を参照）。書き込みは state 更新後に
 * デバウンスして永続化する。Node のテストでも読み込めるよう末尾で globalThis に公開。
 */
(function () {
  'use strict';
  const LS_KEY = 'kakeibo.v1';
  const IDB_NAME = 'kakeibo';
  const IDB_STORE = 'kv';
  const SCHEMA_VERSION = 3;

  const uid = () => (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  const DEFAULT_EXPENSE_CATS = [
    ['食費', '#f97316', '🍚'], ['外食', '#fb7185', '🍜'], ['日用品', '#84cc16', '🧻'],
    ['住居', '#8b5cf6', '🏠'], ['光熱・水道', '#06b6d4', '💡'], ['通信', '#3b82f6', '📱'],
    ['交通', '#22c55e', '🚃'], ['車', '#14b8a6', '🚗'], ['医療', '#ef4444', '💊'],
    ['娯楽', '#ec4899', '🎮'], ['衣服・美容', '#d946ef', '👕'], ['教育', '#6366f1', '📚'],
    ['交際', '#f43f5e', '🍻'], ['その他', '#64748b', '📦'],
    // 事業用（個人事業主・副業の経費）
    ['消耗品費', '#0891b2', '🖊️'], ['旅費交通費', '#65a30d', '🧳'], ['会議・接待費', '#c026d3', '🤝'],
    ['広告宣伝費', '#ea580c', '📣'], ['外注費', '#7c3aed', '🧑‍💻'], ['地代家賃', '#be185d', '🏢'],
    ['雑費（事業）', '#475569', '🧾'],
  ];
  const DEFAULT_INCOME_CATS = [
    ['給与', '#059669', '💼'], ['副業', '#10b981', '💻'], ['賞与', '#34d399', '🎁'],
    ['投資', '#0ea5e9', '📈'], ['事業収入', '#16a34a', '🏪'], ['その他収入', '#64748b', '💴'],
  ];

  const ACCOUNT_KINDS = {
    cash: '現金', bank: '銀行口座', credit: 'クレジットカード',
    invest: '投資', emoney: '電子マネー', other: 'その他',
  };

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      transactions: [],          // {id,date,type,amount,categoryId,accountId,fromAccountId,toAccountId,payee,memo,tags[],exclude,recurringId,recurringMonth,importId}
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
      recurring: [],             // {id,type,amount,categoryId,accountId,toAccountId,day,memo,payee,active,startYm}
      recurringSkipped: [],      // 'recurringId:YYYY-MM' 手動削除済み
      rules: [],                 // {id,keyword(正規化済み),categoryId,createdAt} カテゴリ学習ルール
      templates: [],             // {id,type,amount,categoryId,accountId,payee,memo,useCount,lastUsedAt} ワンタップ登録
      assetSnapshots: [],        // {id,accountId,date,value} 投資口座の評価額
      importBatches: [],         // {id,at,fileName,count,txIds}
      settings: {
        theme: 'light',
        cardOrder: null,         // ダッシュボードのカード並び順
      },
    };
  }

  /* ---------- マイグレーション ---------- */
  function migrate(s) {
    const d = defaultState();
    const out = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    if (!Array.isArray(out.rules)) out.rules = [];
    if (!Array.isArray(out.templates)) out.templates = [];
    if (!Array.isArray(out.assetSnapshots)) out.assetSnapshots = [];
    if (!Array.isArray(out.importBatches)) out.importBatches = [];
    if (!out.budgets || typeof out.budgets !== 'object') out.budgets = {};
    for (const t of out.transactions) {
      if (t.payee === undefined) t.payee = '';
      if (!Array.isArray(t.tags)) t.tags = [];
      if (t.exclude === undefined) t.exclude = false;
    }
    for (const a of out.accounts) {
      if (!a.kind) a.kind = 'other';
      if (a.initialBalance === undefined) a.initialBalance = 0;
    }
    // バージョンアップ時のみ、デフォルトカテゴリのうち未作成のものを追加
    // （ユーザーが削除したカテゴリは同一バージョン内では復活させない）
    if ((s.version || 0) < SCHEMA_VERSION) {
      for (const [name, color, icon] of DEFAULT_EXPENSE_CATS) {
        if (!out.categories.some(c => c.name === name && c.type === 'expense')) {
          out.categories.push({ id: uid(), name, color, icon, type: 'expense' });
        }
      }
      for (const [name, color, icon] of DEFAULT_INCOME_CATS) {
        if (!out.categories.some(c => c.name === name && c.type === 'income')) {
          out.categories.push({ id: uid(), name, color, icon, type: 'income' });
        }
      }
    }
    out.version = SCHEMA_VERSION;
    return out;
  }

  /* ---------- 永続化 ---------- */
  let state = null;
  let idb = null;
  let useIdb = false;
  let saveTimer = null;
  let lastSaveError = null;

  function idbOpen() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* noop */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  function idbGet(key) {
    return new Promise((resolve) => {
      if (!idb) return resolve(null);
      try {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function idbSet(key, val) {
    return new Promise((resolve) => {
      if (!idb) return resolve(false);
      try {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  function lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSave(json) {
    try {
      localStorage.setItem(LS_KEY, json);
      return true;
    } catch (e) {
      lastSaveError = e;
      return false;
    }
  }

  function persist() {
    let json;
    try { json = JSON.stringify(state); } catch (e) { lastSaveError = e; return; }
    if (useIdb) {
      idbSet('state', json).then(ok => { if (!ok) lsSave(json); });
    } else {
      lsSave(json);
    }
  }
  function save() {
    _invalidate();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persist();
  }

  // 起動: localStorage を即時ロード → IndexedDB があればそちらを優先
  async function init() {
    const lsData = lsLoad();
    state = migrate(lsData || defaultState());
    idb = await idbOpen();
    if (idb) {
      const idbJson = await idbGet('state');
      if (idbJson) {
        try {
          const s = JSON.parse(idbJson);
          if (s && typeof s === 'object') state = migrate(s);
        } catch (e) { /* 破損時は localStorage 側を使う */ }
      } else {
        // 既存 localStorage データを IndexedDB へ移行
        idbSet('state', JSON.stringify(state));
      }
      useIdb = true;
    }
    return state;
  }

  /* ---------- インデックス（遅延構築・変更時破棄） ---------- */
  let _idx = null;
  function _invalidate() { _idx = null; }

  function buildIndex() {
    const byMonth = new Map();   // 'YYYY-MM' -> tx[]
    const byDate = new Map();    // 'YYYY-MM-DD' -> tx[]
    const balMap = new Map();    // accountId -> balance
    const monthEnd = new Map();  // 'YYYY-MM' -> Map(accountId -> balance)
    const fingerprints = new Set();

    for (const a of state.accounts) balMap.set(a.id, a.initialBalance || 0);

    const sorted = state.transactions.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    let curYm = null;
    for (const t of sorted) {
      const ym = t.date.slice(0, 7);
      if (curYm !== null && ym !== curYm) monthEnd.set(curYm, new Map(balMap));
      curYm = ym;
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(t);
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
      fingerprints.add(fingerprint(t));
      if (t.type === 'expense' && balMap.has(t.accountId)) balMap.set(t.accountId, balMap.get(t.accountId) - t.amount);
      else if (t.type === 'income' && balMap.has(t.accountId)) balMap.set(t.accountId, balMap.get(t.accountId) + t.amount);
      else if (t.type === 'transfer') {
        if (balMap.has(t.fromAccountId)) balMap.set(t.fromAccountId, balMap.get(t.fromAccountId) - t.amount);
        if (balMap.has(t.toAccountId)) balMap.set(t.toAccountId, balMap.get(t.toAccountId) + t.amount);
      }
    }
    if (curYm !== null) monthEnd.set(curYm, new Map(balMap));
    return { byMonth, byDate, balMap, monthEnd, fingerprints };
  }
  function idx() {
    if (!_idx) _idx = buildIndex();
    return _idx;
  }

  /* ---------- クエリ ---------- */
  const catById = id => state.categories.find(c => c.id === id);
  const accById = id => state.accounts.find(a => a.id === id);
  const catsOf = type => state.categories.filter(c => c.type === type);
  const catByName = (name, type) => state.categories.find(c => c.name === name && (!type || c.type === type));

  function txInMonth(ym) { return idx().byMonth.get(ym) || []; }
  function txOfDay(date) { return idx().byDate.get(date) || []; }

  function monthTotals(ym) {
    let expense = 0, income = 0;
    for (const t of txInMonth(ym)) {
      if (t.exclude) continue;
      if (t.type === 'expense') expense += t.amount;
      else if (t.type === 'income') income += t.amount;
    }
    return { expense, income, diff: income - expense };
  }

  function byCategory(ym, type) {
    const map = new Map();
    for (const t of txInMonth(ym)) {
      if (t.type !== type || t.exclude) continue;
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
      if (t.type === 'transfer' || t.exclude) continue;
      const d = map.get(t.date) || { expense: 0, income: 0 };
      d[t.type] += t.amount;
      map.set(t.date, d);
    }
    return map;
  }

  // 全口座残高を O(N) で一括計算
  function accountBalances() { return idx().balMap; }
  function accountBalance(accountId) { return idx().balMap.get(accountId) || 0; }
  // 月末残高 'YYYY-MM' -> Map(accountId -> balance)
  function monthEndBalances() { return idx().monthEnd; }

  // 口座種別ごとの合計
  function balanceByKind() {
    const out = { cash: 0, bank: 0, credit: 0, invest: 0, emoney: 0, other: 0 };
    for (const a of state.accounts) {
      const bal = accountBalance(a.id);
      out[a.kind || 'other'] = (out[a.kind || 'other'] || 0) + bal;
    }
    return out;
  }
  // 純資産 = 全口座残高の合計（クレカのマイナス=負債を含む）
  function totalAssets() {
    let s = 0;
    for (const a of state.accounts) s += accountBalance(a.id);
    return s;
  }
  // クレカ利用残高（負債額、正の数で返す）
  function cardDebt() {
    let s = 0;
    for (const a of state.accounts) {
      if (a.kind !== 'credit') continue;
      const bal = accountBalance(a.id);
      if (bal < 0) s += -bal;
    }
    return s;
  }

  /* ---------- 検索（複合フィルタ） ---------- */
  // f: {q, type, categoryId, accountId, dateFrom, dateTo, minAmount, maxAmount, tag, exclude}
  function search(f) {
    const q = (f.q || '').toLowerCase();
    const out = [];
    for (const t of state.transactions) {
      if (f.type && t.type !== f.type) continue;
      if (f.categoryId && t.categoryId !== f.categoryId) continue;
      if (f.accountId && !(t.accountId === f.accountId || t.fromAccountId === f.accountId || t.toAccountId === f.accountId)) continue;
      if (f.dateFrom && t.date < f.dateFrom) continue;
      if (f.dateTo && t.date > f.dateTo) continue;
      if (f.minAmount != null && f.minAmount !== '' && t.amount < f.minAmount) continue;
      if (f.maxAmount != null && f.maxAmount !== '' && t.amount > f.maxAmount) continue;
      if (f.tag && !(t.tags || []).includes(f.tag)) continue;
      if (f.exclude === 'hide' && t.exclude) continue;
      if (f.exclude === 'only' && !t.exclude) continue;
      if (q) {
        const cat = catById(t.categoryId);
        const hay = ((t.payee || '') + ' ' + (t.memo || '') + ' ' + (cat ? cat.name : '') + ' ' + (t.tags || []).join(' ')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(t);
    }
    return out;
  }

  // 店舗名の候補（頻度順）
  function payeeSuggestions(prefix, limit) {
    const p = normalizeText(prefix || '');
    const freq = new Map();
    for (const t of state.transactions) {
      if (!t.payee) continue;
      const n = normalizeText(t.payee);
      if (p && !n.includes(p)) continue;
      freq.set(t.payee, (freq.get(t.payee) || 0) + 1);
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit || 8).map(e => e[0]);
  }
  function allTags() {
    const s = new Set();
    for (const t of state.transactions) for (const tag of (t.tags || [])) s.add(tag);
    return [...s].sort();
  }

  /* ---------- テキスト正規化・指紋 ---------- */
  function normalizeText(s) {
    return String(s || '')
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角英数→半角
      .replace(/　/g, ' ')
      .toLowerCase()
      .replace(/[（(].*?[)）]/g, '')        // 括弧内を除去
      .replace(/[0-9]+/g, '')             // 数字を除去（店舗番号対策）
      .replace(/[\s\-‐‑‒–—―_・.。,,、/／]/g, '')
      .trim();
  }
  function fingerprint(t) {
    return [t.date, t.type, t.amount, normalizeText(t.payee || ''),
      normalizeText(t.memo || ''), t.accountId || '', t.fromAccountId || '', t.toAccountId || ''].join('|');
  }
  function existingFingerprints() { return idx().fingerprints; }

  /* ---------- 固定費の自動反映 ---------- */
  function nowYmStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
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
      const tx = {
        id: uid(),
        date: ym + '-' + String(day).padStart(2, '0'),
        type: r.type, amount: r.amount, categoryId: r.categoryId,
        accountId: r.accountId, memo: r.memo || '', payee: r.payee || '',
        tags: [], exclude: false,
        recurringId: r.id, recurringMonth: ym,
      };
      // 振替型の固定費（カード引き落とし等）
      if (r.type === 'transfer') {
        tx.fromAccountId = r.accountId;
        tx.toAccountId = r.toAccountId;
        tx.accountId = null; tx.categoryId = null;
      }
      state.transactions.push(tx);
      changed = true;
    }
    if (changed) save();
  }

  /* ---------- 取引の更新系 ---------- */
  function addTx(tx) {
    tx.id = uid();
    if (tx.payee === undefined) tx.payee = '';
    if (!Array.isArray(tx.tags)) tx.tags = [];
    if (tx.exclude === undefined) tx.exclude = false;
    state.transactions.push(tx);
    save();
    return tx;
  }
  function updateTx(id, patch) {
    const t = state.transactions.find(t => t.id === id);
    if (!t) return null;
    const before = { ...t, tags: (t.tags || []).slice() };
    Object.assign(t, patch);
    if (t.type !== 'transfer') { delete t.fromAccountId; delete t.toAccountId; }
    save();
    return before;
  }
  function deleteTx(id) {
    const t = state.transactions.find(t => t.id === id);
    if (t && t.recurringId && t.recurringMonth) {
      state.recurringSkipped.push(t.recurringId + ':' + t.recurringMonth);
    }
    state.transactions = state.transactions.filter(t => t.id !== id);
    save();
  }
  // 一括更新: patch を適用し、Undo 用の変更前スナップショットを返す
  function bulkUpdate(ids, patch) {
    const before = [];
    const set = new Set(ids);
    for (const t of state.transactions) {
      if (!set.has(t.id)) continue;
      before.push({ ...t, tags: (t.tags || []).slice() });
      for (const k in patch) {
        if (patch[k] === undefined) continue;
        t[k] = patch[k];
      }
      if (t.type !== 'transfer') { delete t.fromAccountId; delete t.toAccountId; }
    }
    save();
    return before;
  }
  // Undo: スナップショットを書き戻す
  function restoreTxList(beforeList) {
    const map = new Map(beforeList.map(t => [t.id, t]));
    state.transactions = state.transactions.map(t => map.has(t.id) ? map.get(t.id) : t);
    save();
  }
  function addTxList(list) {
    for (const tx of list) {
      if (!tx.id) tx.id = uid();
      state.transactions.push(tx);
    }
    save();
  }
  function deleteTxList(ids) {
    const set = new Set(ids);
    const removed = [];
    const kept = [];
    for (const t of state.transactions) (set.has(t.id) ? removed : kept).push(t);
    state.transactions = kept;
    save();
    return removed;
  }

  /* ---------- マスタ更新系 ---------- */
  function addCategory(c) { c.id = uid(); state.categories.push(c); save(); return c; }
  function deleteCategory(id) {
    state.categories = state.categories.filter(c => c.id !== id);
    delete state.budgets[id];
    state.rules = state.rules.filter(r => r.categoryId !== id);
    save();
  }
  function addAccount(a) { a.id = uid(); a.initialBalance = a.initialBalance || 0; state.accounts.push(a); save(); return a; }
  function updateAccount(id, patch) {
    const a = accById(id);
    if (a) { Object.assign(a, patch); save(); }
  }
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
  function updateRecurring(id, patch) {
    const r = state.recurring.find(r => r.id === id);
    if (r) { Object.assign(r, patch); save(); }
  }
  function deleteRecurring(id) {
    state.recurring = state.recurring.filter(r => r.id !== id);
    save();
  }
  function toggleRecurring(id) {
    const r = state.recurring.find(r => r.id === id);
    if (r) { r.active = !r.active; save(); }
  }

  /* ---------- 学習ルール ---------- */
  function learnRule(payeeOrKeyword, categoryId) {
    const keyword = normalizeText(payeeOrKeyword);
    if (!keyword || !categoryId) return null;
    const existing = state.rules.find(r => r.keyword === keyword);
    if (existing) { existing.categoryId = categoryId; save(); return existing; }
    const rule = { id: uid(), keyword, categoryId, createdAt: new Date().toISOString() };
    state.rules.push(rule);
    save();
    return rule;
  }
  function deleteRule(id) {
    state.rules = state.rules.filter(r => r.id !== id);
    save();
  }

  /* ---------- テンプレート（ワンタップ登録） ---------- */
  function addTemplate(t) { t.id = uid(); t.useCount = 0; state.templates.push(t); save(); return t; }
  function deleteTemplate(id) { state.templates = state.templates.filter(t => t.id !== id); save(); }
  function useTemplate(id) {
    const t = state.templates.find(t => t.id === id);
    if (!t) return null;
    t.useCount = (t.useCount || 0) + 1;
    t.lastUsedAt = new Date().toISOString();
    save();
    return t;
  }

  /* ---------- 資産スナップショット ---------- */
  function setAssetSnapshot(accountId, date, value) {
    const existing = state.assetSnapshots.find(s => s.accountId === accountId && s.date === date);
    if (existing) { existing.value = value; }
    else state.assetSnapshots.push({ id: uid(), accountId, date, value });
    save();
  }
  function latestSnapshot(accountId) {
    let best = null;
    for (const s of state.assetSnapshots) {
      if (s.accountId !== accountId) continue;
      if (!best || s.date > best.date) best = s;
    }
    return best;
  }
  // 投資口座の損益: 直近評価額 - (初期残高 + 純入金額)
  function investPerf(accountId) {
    const a = accById(accountId);
    if (!a) return null;
    let invested = a.initialBalance || 0;
    for (const t of state.transactions) {
      if (t.type === 'transfer') {
        if (t.toAccountId === accountId) invested += t.amount;
        if (t.fromAccountId === accountId) invested -= t.amount;
      } else if (t.accountId === accountId) {
        invested += t.type === 'income' ? t.amount : -t.amount;
      }
    }
    const snap = latestSnapshot(accountId);
    const market = snap ? snap.value : invested;
    return { invested, market, pnl: market - invested, pnlRate: invested ? (market - invested) / invested : 0, snapDate: snap ? snap.date : null };
  }

  /* ---------- インポートバッチ ---------- */
  function addImportBatch(batch) { batch.id = uid(); batch.at = new Date().toISOString(); state.importBatches.push(batch); save(); return batch; }
  function undoImport(batchId) {
    const b = state.importBatches.find(b => b.id === batchId);
    if (!b) return 0;
    const set = new Set(b.txIds);
    const n0 = state.transactions.length;
    state.transactions = state.transactions.filter(t => !set.has(t.id));
    state.importBatches = state.importBatches.filter(x => x.id !== batchId);
    save();
    return n0 - state.transactions.length;
  }

  /* ---------- エクスポート / バックアップ ---------- */
  function csvEsc(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCSV() {
    const head = ['日付', '種別', '金額', 'カテゴリ', '口座', '振替元', '振替先', '店舗', 'メモ', 'タグ', '除外'];
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
        t.payee || '',
        t.memo || '',
        (t.tags || []).join(';'),
        t.exclude ? '1' : '',
      ].map(csvEsc).join(','));
    return '﻿' + head.join(',') + '\n' + rows.join('\n');
  }
  function exportJSON() {
    return JSON.stringify({ app: 'kakeibo', version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: state }, null, 2);
  }
  function importJSON(jsonText) {
    const obj = JSON.parse(jsonText);
    const data = obj && obj.data ? obj.data : obj;
    if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.categories) || !Array.isArray(data.accounts)) {
      throw new Error('バックアップ形式が正しくありません');
    }
    state = migrate(data);
    save();
    flush();
    return state;
  }

  /* ---------- サンプルデータ ---------- */
  function seedDemo() {
    const now = new Date();
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const expCats = catsOf('expense'), incCats = catsOf('income');
    const accs = state.accounts;
    if (!accs.length || !expCats.length) return;
    const salary = incCats.find(c => c.name === '給与') || incCats[0];
    const payees = {
      '食費': ['イオン', 'セブン-イレブン', 'マクドナルド'], '外食': ['サイゼリヤ', 'スターバックス'],
      '日用品': ['Amazon', 'ドラッグストア'], '交通': ['JR東日本', 'Suicaチャージ'],
      '娯楽': ['Netflix', 'Steam'], '車': ['ENEOS'],
    };
    for (let back = 5; back >= 0; back--) {
      const base = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const ym = base.getFullYear() + '-' + String(base.getMonth() + 1).padStart(2, '0');
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      const maxDay = back === 0 ? now.getDate() : lastDay;
      if (maxDay >= 25) addTx({ date: ym + '-25', type: 'income', amount: 280000, categoryId: salary.id, accountId: (accs[1] || accs[0]).id, memo: '給与', payee: '会社' });
      const fixed = { '住居': [1, 78000, '管理会社'], '光熱・水道': [10, 9000, '東京電力'], '通信': [15, 5500, 'NTTドコモ'], '娯楽': [3, 1490, 'Netflix'] };
      for (const name in fixed) {
        const c = expCats.find(c => c.name === name);
        const [day, amount, payee] = fixed[name];
        if (c && day <= maxDay) {
          addTx({ date: ym + '-' + String(day).padStart(2, '0'), type: 'expense', amount, categoryId: c.id, accountId: pick(accs).id, memo: name, payee });
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
          payee: pick((payees[cat.name] || [''])),
        });
      }
    }
  }

  function resetAll() {
    state = defaultState();
    save();
    flush();
  }

  // テスト用フック（Node から直接状態を差し替える）
  function _setState(s) { state = migrate(s); _invalidate(); }
  function _defaultState() { return defaultState(); }

  const api = {
    get state() { return state; },
    get lastSaveError() { return lastSaveError; },
    get storageKind() { return useIdb ? 'indexeddb' : 'localstorage'; },
    init, save, flush, uid,
    catById, accById, catsOf, catByName,
    txInMonth, txOfDay, monthTotals, byCategory, dailyTotals,
    accountBalance, accountBalances, monthEndBalances, balanceByKind, totalAssets, cardDebt,
    search, payeeSuggestions, allTags,
    normalizeText, fingerprint, existingFingerprints,
    applyRecurring, nowYmStr,
    addTx, updateTx, deleteTx, bulkUpdate, restoreTxList, addTxList, deleteTxList,
    addCategory, deleteCategory, addAccount, updateAccount, deleteAccount,
    setBudget, addRecurring, updateRecurring, deleteRecurring, toggleRecurring,
    learnRule, deleteRule,
    addTemplate, deleteTemplate, useTemplate,
    setAssetSnapshot, latestSnapshot, investPerf,
    addImportBatch, undoImport,
    exportCSV, exportJSON, importJSON,
    seedDemo, resetAll,
    ACCOUNT_KINDS,
    _setState, _defaultState,
  };

  if (typeof window !== 'undefined') window.Store = api;
  globalThis.Store = api;
})();
