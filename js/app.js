/* app.js - アプリコア（ナビ・モーダル・トースト・初期化）
 * ビューは views.js 側で window.App.views に登録する。
 */
(function () {
  'use strict';
  const S = window.Store;
  const main = document.getElementById('main');

  /* ---------- ユーティリティ ---------- */
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const yen = n => (Number(n) < 0 ? '-' : '') + '¥' + Math.abs(Number(n || 0)).toLocaleString();
  const pad2 = n => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  const nowYm = () => todayStr().slice(0, 7);
  const shiftYm = (ym, diff) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + diff, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  };
  const ymLabel = ym => ym.replace('-', '年') + '月';
  const TYPE_LABEL = { expense: '支出', income: '収入', transfer: '振替' };

  let view = 'home';
  let viewYm = nowYm();
  let txType = 'expense';
  const filters = { q: '', type: '', categoryId: '', accountId: '', dateFrom: '', dateTo: '', minAmount: '', maxAmount: '', tag: '', exclude: '' };

  /* ---------- トースト（Undo対応） ---------- */
  function toast(msg, opts) {
    const t = document.getElementById('toast');
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    if (opts && opts.actionLabel && opts.onAction) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = opts.actionLabel;
      b.addEventListener('click', () => {
        t.classList.add('hidden');
        opts.onAction();
      });
      t.appendChild(b);
    }
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), (opts && opts.duration) || 2600);
  }

  /* ---------- 確認モーダル ---------- */
  let confirmCb = null;
  function confirmBox(text, okLabel, cb, detail) {
    document.getElementById('confirmText').textContent = text;
    document.getElementById('confirmDetail').textContent = detail || '';
    document.getElementById('confirmOk').textContent = okLabel || '削除';
    confirmCb = cb;
    document.getElementById('confirmModal').classList.remove('hidden');
  }
  document.getElementById('confirmOk').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    if (confirmCb) confirmCb();
    confirmCb = null;
  });
  document.getElementById('confirmCancel').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.add('hidden');
    confirmCb = null;
  });

  /* ---------- 汎用シート ---------- */
  function openSheet(title, bodyHtml, onBind) {
    document.getElementById('sheetTitle').textContent = title;
    const body = document.getElementById('sheetBody');
    body.innerHTML = bodyHtml;
    if (onBind) onBind(body);
    document.getElementById('sheet').classList.remove('hidden');
  }
  function closeSheet() { document.getElementById('sheet').classList.add('hidden'); }
  document.getElementById('sheetClose').addEventListener('click', closeSheet);
  document.getElementById('sheet').addEventListener('click', e => { if (e.target === document.getElementById('sheet')) closeSheet(); });

  /* ---------- 取引モーダル ---------- */
  const txModal = document.getElementById('txModal');
  function fillSelect(sel, items, selected, blank) {
    sel.innerHTML = (blank ? '<option value=""' + (!selected ? ' selected' : '') + '>未分類</option>' : '')
      + items.map(i => '<option value="' + i.id + '"' + (i.id === selected ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('');
  }
  function refreshTxFormType() {
    document.querySelectorAll('#txTypeSwitch button').forEach(b =>
      b.classList.toggle('active', b.dataset.type === txType));
    const isTransfer = txType === 'transfer';
    document.getElementById('txCategoryWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txLearnRuleWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txAccountWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txTransferWrap').classList.toggle('hidden', !isTransfer);
    if (!isTransfer) {
      fillSelect(document.getElementById('txCategory'), S.catsOf(txType), document.getElementById('txCategory').value, true);
    }
    fillSelect(document.getElementById('txAccount'), S.state.accounts, document.getElementById('txAccount').value);
    fillSelect(document.getElementById('txFromAccount'), S.state.accounts, document.getElementById('txFromAccount').value);
    fillSelect(document.getElementById('txToAccount'), S.state.accounts, document.getElementById('txToAccount').value);
  }
  function refreshPayeeList() {
    const dl = document.getElementById('payeeList');
    dl.innerHTML = S.payeeSuggestions('', 30).map(p => '<option value="' + esc(p) + '"></option>').join('');
  }
  // 店舗入力 → カテゴリ自動提案
  function applyPayeeSuggestion() {
    const payee = document.getElementById('txPayee').value.trim();
    if (txType === 'transfer') return;
    const select = document.getElementById('txCategory');
    const box = document.getElementById('txCategorySuggestion');
    if (!payee) {
      select.value = '';
      delete select.dataset.suggested;
      delete select.dataset.confidence;
      box.innerHTML = '';
      return;
    }
    const sug = window.Classify.suggest({ payee, type: txType });
    const candidates = window.Classify.candidates({ payee, type: txType }, 3);
    if (sug.categoryId && sug.confidence >= 0.8 && sug.source !== 'fallback') {
      select.value = sug.categoryId;
      select.dataset.suggested = sug.source;
      select.dataset.confidence = String(sug.confidence || 0);
      box.innerHTML = '<small>推奨: ' + esc(S.catById(sug.categoryId).name) + ' · 確信度 ' + Math.round(sug.confidence * 100) + '% (' + esc(sug.label) + ')</small>';
    } else {
      select.value = '';
      delete select.dataset.suggested;
      delete select.dataset.confidence;
      box.innerHTML = candidates.length ? '<small>候補をタップして選択</small><span>' + candidates.map(item => '<button type="button" class="quick-chip" data-tx-candidate="' + item.categoryId + '">' + esc(S.catById(item.categoryId).name) + ' ' + Math.round(item.confidence * 100) + '%</button>').join('') + '</span>' : '';
    }
  }
  document.getElementById('txPayee').addEventListener('input', applyPayeeSuggestion);
  document.getElementById('txPayee').addEventListener('change', applyPayeeSuggestion);
  document.getElementById('txCategory').addEventListener('change', e => {
    delete e.currentTarget.dataset.suggested;
    delete e.currentTarget.dataset.confidence;
    document.getElementById('txCategorySuggestion').innerHTML = '';
  });
  document.getElementById('txCategorySuggestion').addEventListener('click', e => {
    const button = e.target.closest('[data-tx-candidate]');
    if (!button) return;
    const select = document.getElementById('txCategory');
    select.value = button.dataset.txCandidate;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  function renderTplChips() {
    const box = document.getElementById('tplChips');
    const tpls = S.state.templates.slice().sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, 6);
    if (!tpls.length) { box.innerHTML = ''; return; }
    box.innerHTML = tpls.map(t =>
      '<button type="button" class="quick-chip" data-tpl="' + t.id + '">' + esc(t.payee || t.memo || '定型') + ' ' + yen(t.amount) + '</button>'
    ).join('');
    box.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
      const t = S.state.templates.find(x => x.id === b.dataset.tpl);
      if (!t) return;
      txType = t.type;
      refreshTxFormType();
      document.getElementById('txAmount').value = t.amount;
      document.getElementById('txPayee').value = t.payee || '';
      document.getElementById('txMemo').value = t.memo || '';
      if (t.categoryId) document.getElementById('txCategory').value = t.categoryId;
      if (t.accountId) document.getElementById('txAccount').value = t.accountId;
      S.useTemplate(t.id);
      applyPayeeSuggestion();
    }));
  }

  function openTxModal(tx, presetDate) {
    document.getElementById('txModalTitle').textContent = tx ? '取引を編集' : '取引を記録';
    document.getElementById('txId').value = tx ? tx.id : '';
    document.getElementById('txDate').value = tx ? tx.date : (presetDate || todayStr());
    document.getElementById('txAmount').value = tx ? tx.amount : '';
    document.getElementById('txPayee').value = tx ? (tx.payee || '') : '';
    document.getElementById('txMemo').value = tx ? (tx.memo || '') : '';
    document.getElementById('txTags').value = tx ? (tx.tags || []).join(', ') : '';
    document.getElementById('txExclude').checked = tx ? !!tx.exclude : false;
    document.getElementById('txLearnRule').checked = false;
    const categorySelect = document.getElementById('txCategory');
    categorySelect.value = tx ? (tx.categoryId || '') : '';
    delete categorySelect.dataset.suggested;
    delete categorySelect.dataset.confidence;
    document.getElementById('txCategorySuggestion').innerHTML = '';
    txType = tx ? tx.type : 'expense';
    refreshTxFormType();
    refreshPayeeList();
    if (tx) {
      if (tx.categoryId) document.getElementById('txCategory').value = tx.categoryId;
      if (tx.accountId) document.getElementById('txAccount').value = tx.accountId;
      if (tx.fromAccountId) document.getElementById('txFromAccount').value = tx.fromAccountId;
      if (tx.toAccountId) document.getElementById('txToAccount').value = tx.toAccountId;
    }
    renderTplChips();
    txModal.classList.remove('hidden');
    // モバイルは金額にフォーカス
    if (window.innerWidth <= 860) setTimeout(() => document.getElementById('txAmount').focus(), 60);
  }
  function closeTxModal() { txModal.classList.add('hidden'); }

  document.getElementById('txTypeSwitch').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    txType = b.dataset.type;
    refreshTxFormType();
    applyPayeeSuggestion();
  });
  document.getElementById('txModalClose').addEventListener('click', closeTxModal);
  document.getElementById('txModalCancel').addEventListener('click', closeTxModal);
  txModal.addEventListener('click', e => { if (e.target === txModal) closeTxModal(); });

  document.getElementById('txSaveTpl').addEventListener('click', () => {
    const amount = Number(document.getElementById('txAmount').value);
    const payee = document.getElementById('txPayee').value.trim();
    if (!Number.isSafeInteger(amount) || amount <= 0) { toast('金額は1円以上の整数で入力してください'); return; }
    S.addTemplate({
      type: txType, amount,
      categoryId: txType === 'transfer' ? null : document.getElementById('txCategory').value,
      accountId: txType === 'transfer' ? null : document.getElementById('txAccount').value,
      payee, memo: document.getElementById('txMemo').value.trim(),
    });
    toast('定型に保存しました');
    renderTplChips();
  });

  document.getElementById('txForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('txId').value;
    const date = document.getElementById('txDate').value;
    const amount = Number(document.getElementById('txAmount').value);
    const payee = document.getElementById('txPayee').value.trim();
    const memo = document.getElementById('txMemo').value.trim();
    const tags = document.getElementById('txTags').value.split(/[,、]/).map(s => s.trim()).filter(Boolean);
    const exclude = document.getElementById('txExclude').checked;
    if (!date || !Number.isSafeInteger(amount) || amount <= 0) { toast('日付と1円以上の整数金額を入力してください'); return; }
    const data = { date, type: txType, amount, memo, payee, tags, exclude };
    if (txType === 'transfer') {
      const from = document.getElementById('txFromAccount').value;
      const to = document.getElementById('txToAccount').value;
      if (!from || !to || from === to) { toast('振替元と振替先を別の口座にしてください'); return; }
      data.fromAccountId = from; data.toAccountId = to;
      data.categoryId = null; data.accountId = null;
    } else {
      data.categoryId = document.getElementById('txCategory').value;
      data.accountId = document.getElementById('txAccount').value;
      data.categorySource = document.getElementById('txCategory').dataset.suggested || 'manual';
      data.categoryConfidence = Number(document.getElementById('txCategory').dataset.confidence) || null;
      if (!data.categoryId) data.categoryId = null;
    }
    try {
    if (id) {
      const before = S.updateTx(id, data);
      const ruleName = payee;
      const ruleNorm = S.normalizeMerchantName(ruleName);
      const previousRule = ruleName ? S.state.rules.find(r => r.normalizedName === ruleNorm && r.matchMode === 'exact') : null;
      const previousRuleSnapshot = previousRule ? { ...previousRule } : null;
      const learned = document.getElementById('txLearnRule').checked && payee && data.categoryId
        ? window.Classify.learn({ payee }, data.categoryId, { merchantName: payee, matchMode: 'exact', priority: 100 }) : null;
      if (before && learned && before.categoryBatchId) {
        const batch = S.state.categoryChanges.find(x => x.id === before.categoryBatchId);
        if (batch) { batch.learnedRules = [{ id: learned.id, previous: previousRuleSnapshot }]; S.save(); }
      }
      if (before && data.categoryId !== before.categoryId) {
        toast('更新しました' + (learned ? '。分類ルールも保存しました' : ''), {
          actionLabel: '取り消す', onAction: () => {
            S.restoreTxList([before]);
            if (learned && !before.categoryBatchId) {
              const current = S.state.rules.find(r => r.id === learned.id);
              if (previousRuleSnapshot) { if (current) Object.assign(current, previousRuleSnapshot); else S.state.rules.push({ ...previousRuleSnapshot }); }
              else S.state.rules = S.state.rules.filter(r => r.id !== learned.id);
              S.save();
            }
            render();
          }
        });
      } else {
        toast(learned ? '分類ルールを保存しました' : '更新しました');
      }
    } else {
      S.addTx(data);
      if (document.getElementById('txLearnRule').checked && payee && data.categoryId) window.Classify.learn({ payee }, data.categoryId, { merchantName: payee });
      toast('記録しました');
    }
    closeTxModal();
    render();
    } catch (err) { toast(err.message); }
  });

  /* ---------- レシートOCR ---------- */
  const ocrFile = document.getElementById('ocrFile');
  const ocrProgress = document.getElementById('ocrProgress');
  const ocrBarFill = document.getElementById('ocrBarFill');
  const ocrStatus = document.getElementById('ocrStatus');
  function setOcrProgress(pct, msg) {
    ocrProgress.classList.remove('hidden');
    ocrBarFill.style.width = Math.round(pct * 100) + '%';
    if (msg) ocrStatus.textContent = msg;
  }
  document.getElementById('btnOcr').addEventListener('click', () => {
    if (!window.OCR) { toast('OCR機能を読み込めませんでした'); return; }
    ocrFile.value = '';
    ocrFile.click();
  });
  ocrFile.addEventListener('change', async () => {
    const file = ocrFile.files && ocrFile.files[0];
    if (!file) return;
    try {
      setOcrProgress(0, 'OCRエンジンを準備中…（初回は数秒かかります）');
      const text = await window.OCR.recognize(file, setOcrProgress);
      const r = window.OCR.parse(text);
      if (r.amount) document.getElementById('txAmount').value = r.amount;
      if (r.date) document.getElementById('txDate').value = r.date;
      if (r.payee) document.getElementById('txPayee').value = r.payee;
      if (r.memo) document.getElementById('txMemo').value = r.memo;
      txType = 'expense';
      refreshTxFormType();
      applyPayeeSuggestion(); // 店舗名からカテゴリ自動提案
      ocrStatus.textContent = r.amount
        ? '読み取り完了。内容を確認して保存してください'
        : '金額を読み取れませんでした。手入力してください';
      setTimeout(() => ocrProgress.classList.add('hidden'), 4000);
      if (r.amount) toast('レシートを読み取りました');
    } catch (err) {
      ocrProgress.classList.add('hidden');
      toast('読み取りに失敗しました: ' + (err && err.message ? err.message : 'ネットワークを確認してください'));
    }
  });

  /* ---------- 共通部品 ---------- */
  function monthNavHtml() {
    return '<div class="month-nav">'
      + '<button class="btn" data-nav="-1" aria-label="前月">◀</button>'
      + '<button class="btn" data-nav="today">今月</button>'
      + '<button class="btn" data-nav="1" aria-label="翌月">▶</button>'
      + '<h2>' + ymLabel(viewYm) + '</h2>'
      + '</div>';
  }
  function bindMonthNav() {
    main.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      viewYm = b.dataset.nav === 'today' ? nowYm() : shiftYm(viewYm, Number(b.dataset.nav));
      S.applyRecurring(viewYm);
      render();
    }));
  }
  function catBadge(catId) {
    const c = S.catById(catId);
    if (!c) return '<span class="cat-badge">未分類</span>';
    return '<span class="cat-badge"><span class="cat-dot" style="background:' + esc(c.color) + '"></span>'
      + esc(c.icon || '') + ' ' + esc(c.name) + '</span>';
  }
  function accName(id) { const a = S.accById(id); return a ? a.name : ''; }

  function txRow(t, showDate) {
    let desc;
    if (t.type === 'transfer') {
      desc = '<span class="cat-badge">🔁 振替</span> <span class="memo-cell">'
        + esc(accName(t.fromAccountId)) + ' → ' + esc(accName(t.toAccountId)) + '</span>'
        + (t.memo ? ' <span class="memo-cell">' + esc(t.memo) + '</span>' : '');
    } else {
      desc = (t.payee ? '<span class="payee">' + esc(t.payee) + '</span> ' : '')
        + catBadge(t.categoryId)
        + (t.memo ? ' <span class="memo-cell">' + esc(t.memo) + '</span>' : '')
        + (t.exclude ? ' <span class="badge">除外</span>' : '')
        + ((t.tags || []).length ? ' <span class="tags">' + t.tags.map(g => '<span class="tag">' + esc(g) + '</span>').join('') + '</span>' : '');
    }
    const sign = t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '';
    return '<tr>'
      + (showDate ? '<td>' + esc(t.date) + '</td>' : '')
      + '<td>' + desc + '</td>'
      + '<td class="memo-cell">' + esc(t.type === 'transfer' ? '' : accName(t.accountId)) + '</td>'
      + '<td class="amt ' + t.type + '">' + sign + yen(t.amount) + '</td>'
      + '<td class="row-actions-cell"><div class="row-actions">'
      + '<button class="btn" data-edit="' + t.id + '">編集</button>'
      + '<button class="btn" data-del="' + t.id + '">削除</button>'
      + '</div></td></tr>';
  }
  function bindTxRowActions(root) {
    (root || main).querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const t = S.state.transactions.find(t => t.id === b.dataset.edit);
      if (t) openTxModal(t);
    }));
    (root || main).querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      confirmBox('この取引を削除しますか？', '削除', () => {
        S.deleteTx(b.dataset.del); toast('削除しました'); render();
      });
    }));
  }

  /* ---------- ナビゲーション ---------- */
  const NAV = [
    { id: 'home', label: 'ホーム', icon: '🏠' },
    { id: 'transactions', label: '取引', icon: '📋' },
    { id: 'categorize', label: '分類整理', icon: '🗂️' },
    { id: 'analysis', label: '分析', icon: '📊' },
    { id: 'budget', label: '予算', icon: '🎯' },
    { id: 'calendar', label: 'カレンダー', icon: '📅' },
    { id: 'assets', label: '資産', icon: '💰' },
    { id: 'recurring', label: '固定費', icon: '🔁' },
    { id: 'data', label: 'データ', icon: '📂' },
    { id: 'settings', label: '設定', icon: '⚙️' },
  ];
  const MOBILE_NAV = ['home', 'transactions', 'categorize', 'budget', 'menu'];

  function buildNav() {
    // デスクトップ上部タブ
    const tabs = document.getElementById('tabs');
    tabs.innerHTML = NAV.map(n => '<button data-view="' + n.id + '" class="tab' + (n.id === view ? ' active' : '') + '">' + n.icon + ' ' + n.label + '</button>').join('');
    // モバイル下部ナビ
    const bn = document.getElementById('bottomNav');
    bn.innerHTML = MOBILE_NAV.map(id => {
      if (id === 'menu') return '<button data-menu="1"><span class="icon">☰</span>メニュー</button>';
      const n = NAV.find(x => x.id === id);
      return '<button data-view="' + n.id + '" class="' + (n.id === view ? 'active' : '') + '"><span class="icon">' + n.icon + '</span>' + n.label + '</button>';
    }).join('');
  }
  function setView(v) {
    view = v;
    buildNav();
    render();
  }
  function openMenuSheet() {
    openSheet('メニュー', '<div class="sheet-list">' + NAV.map(n =>
      '<button class="sheet-item" data-view="' + n.id + '"><span class="icon">' + n.icon + '</span>' + n.label + '</button>'
    ).join('') + '</div>', body => {
      body.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
        closeSheet(); setView(b.dataset.view);
      }));
    });
  }
  document.getElementById('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) setView(b.dataset.view);
  });
  document.getElementById('bottomNav').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.menu) openMenuSheet();
    else if (b.dataset.view) setView(b.dataset.view);
  });
  document.getElementById('btnAddTx').addEventListener('click', () => openTxModal(null));
  const fab = document.getElementById('fab');
  if (fab) fab.addEventListener('click', () => openTxModal(null));

  document.getElementById('btnTheme').addEventListener('click', () => {
    const cur = S.state.settings.theme === 'dark' ? 'light' : 'dark';
    S.state.settings.theme = cur;
    S.save();
    applyTheme();
  });
  function applyTheme() {
    const dark = S.state.settings.theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.getElementById('btnTheme').textContent = dark ? '☀️' : '🌙';
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeTxModal(); closeSheet(); document.getElementById('confirmModal').classList.add('hidden'); }
  });

  function render() {
    const v = window.App && window.App.views && window.App.views[view];
    if (v) v();
    else main.innerHTML = '<div class="panel"><div class="empty">この画面はまだ実装されていません</div></div>';
  }

  /* ---------- 公開API（views.js から利用） ---------- */
  window.App = {
    get view() { return view; },
    get viewYm() { return viewYm; },
    set viewYm(v) { viewYm = v; },
    get filters() { return filters; },
    setView, render, toast, confirmBox, openSheet, closeSheet,
    openTxModal, closeTxModal,
    monthNavHtml, bindMonthNav, catBadge, accName, txRow, bindTxRowActions,
    esc, yen, pad2, todayStr, nowYm, shiftYm, ymLabel, TYPE_LABEL,
    applyPayeeSuggestion,
  };

  /* ---------- 初期化 ---------- */
  window.addEventListener('kakeibo:storage-error', () => toast('保存に失敗しました。JSONバックアップを保存し、空き容量を確認してください', { duration: 10000 }));
  window.addEventListener('kakeibo:storage-fallback', () => toast('IndexedDBに保存できないため、ブラウザーの予備保存先を使用しています', { duration: 10000 }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') S.flush(); });
  window.addEventListener('pagehide', () => S.flush());
  (async () => {
    try {
      await S.init();
      applyTheme();
      S.applyRecurring(nowYm());
      buildNav();
      render();
    } catch (err) {
      main.innerHTML = '<div class="panel"><h2>保存データを読み込めません</h2><p>ブラウザーを再読み込みしてください。データを削除せず、問題が続く場合はバックアップを確認してください。</p></div>';
      toast(err.message, { duration: 10000 });
    }
  })();
})();
