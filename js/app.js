/* app.js - UIロジック */
(function () {
  'use strict';
  const S = window.Store;
  const main = document.getElementById('main');

  /* ---------- ユーティリティ ---------- */
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const yen = n => '¥' + Number(n || 0).toLocaleString();
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

  let view = 'dashboard';
  let viewYm = nowYm();
  let txType = 'expense';
  const filters = { q: '', type: '', categoryId: '', accountId: '' };

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  /* ---------- 確認モーダル ---------- */
  let confirmCb = null;
  function confirmBox(text, okLabel, cb) {
    document.getElementById('confirmText').textContent = text;
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

  /* ---------- 取引モーダル ---------- */
  const txModal = document.getElementById('txModal');
  function fillSelect(sel, items, selected) {
    sel.innerHTML = items.map(i => '<option value="' + i.id + '"' + (i.id === selected ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('');
  }
  function refreshTxFormType() {
    document.querySelectorAll('#txTypeSwitch button').forEach(b =>
      b.classList.toggle('active', b.dataset.type === txType));
    const isTransfer = txType === 'transfer';
    document.getElementById('txCategoryWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txAccountWrap').classList.toggle('hidden', isTransfer);
    document.getElementById('txTransferWrap').classList.toggle('hidden', !isTransfer);
    if (!isTransfer) {
      fillSelect(document.getElementById('txCategory'), S.catsOf(txType), document.getElementById('txCategory').value);
    }
    fillSelect(document.getElementById('txAccount'), S.state.accounts, document.getElementById('txAccount').value);
    fillSelect(document.getElementById('txFromAccount'), S.state.accounts, document.getElementById('txFromAccount').value);
    fillSelect(document.getElementById('txToAccount'), S.state.accounts, document.getElementById('txToAccount').value);
  }
  function openTxModal(tx, presetDate) {
    document.getElementById('txModalTitle').textContent = tx ? '取引を編集' : '取引を記録';
    document.getElementById('txId').value = tx ? tx.id : '';
    document.getElementById('txDate').value = tx ? tx.date : (presetDate || todayStr());
    document.getElementById('txAmount').value = tx ? tx.amount : '';
    document.getElementById('txMemo').value = tx ? (tx.memo || '') : '';
    txType = tx ? tx.type : 'expense';
    refreshTxFormType();
    if (tx) {
      if (tx.categoryId) document.getElementById('txCategory').value = tx.categoryId;
      if (tx.accountId) document.getElementById('txAccount').value = tx.accountId;
      if (tx.fromAccountId) document.getElementById('txFromAccount').value = tx.fromAccountId;
      if (tx.toAccountId) document.getElementById('txToAccount').value = tx.toAccountId;
    }
    txModal.classList.remove('hidden');
  }
  function closeTxModal() { txModal.classList.add('hidden'); }

  document.getElementById('txTypeSwitch').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    txType = b.dataset.type;
    refreshTxFormType();
  });
  document.getElementById('txModalClose').addEventListener('click', closeTxModal);
  document.getElementById('txModalCancel').addEventListener('click', closeTxModal);
  txModal.addEventListener('click', e => { if (e.target === txModal) closeTxModal(); });

  document.getElementById('txForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('txId').value;
    const date = document.getElementById('txDate').value;
    const amount = Number(document.getElementById('txAmount').value);
    const memo = document.getElementById('txMemo').value.trim();
    if (!date || !amount || amount <= 0) { toast('日付と金額を入力してください'); return; }
    const data = { date, type: txType, amount, memo };
    if (txType === 'transfer') {
      const from = document.getElementById('txFromAccount').value;
      const to = document.getElementById('txToAccount').value;
      if (from === to) { toast('振替元と振替先が同じです'); return; }
      data.fromAccountId = from; data.toAccountId = to;
      data.categoryId = null; data.accountId = null;
    } else {
      data.categoryId = document.getElementById('txCategory').value;
      data.accountId = document.getElementById('txAccount').value;
    }
    if (id) { S.updateTx(id, data); toast('更新しました'); }
    else { S.addTx(data); toast('記録しました'); }
    closeTxModal();
    render();
  });

  /* ---------- 共通部品 ---------- */
  function monthNavHtml() {
    return '<div class="month-nav">'
      + '<button class="btn" data-nav="-1">◀</button>'
      + '<button class="btn" data-nav="today">今月</button>'
      + '<button class="btn" data-nav="1">▶</button>'
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
      desc = catBadge(t.categoryId) + (t.memo ? ' <span class="memo-cell">' + esc(t.memo) + '</span>' : '');
    }
    const sign = t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '';
    return '<tr>'
      + (showDate ? '<td>' + esc(t.date) + '</td>' : '')
      + '<td>' + desc + '</td>'
      + '<td class="memo-cell">' + esc(t.type === 'transfer' ? '' : accName(t.accountId)) + '</td>'
      + '<td class="amt ' + t.type + '">' + sign + yen(t.amount) + '</td>'
      + '<td><div class="row-actions">'
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

  /* ---------- ダッシュボード ---------- */
  function renderDashboard() {
    const tot = S.monthTotals(viewYm);
    const catExp = S.byCategory(viewYm, 'expense');
    const daily = S.dailyTotals(viewYm);
    const [y, m] = viewYm.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const isCur = viewYm === nowYm();
    const upto = isCur ? new Date().getDate() : lastDay;
    const dailyItems = [];
    for (let d = 1; d <= lastDay; d++) {
      const key = viewYm + '-' + pad2(d);
      const v = daily.get(key) || { expense: 0 };
      dailyItems.push({ label: String(d), value: v.expense, showLabel: d === 1 || d % 5 === 0, highlight: isCur && d === upto });
    }
    const recent = S.txInMonth(viewYm).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const budgetRows = Object.entries(S.state.budgets).map(([cid, amt]) => {
      const spent = (catExp.find(x => x.category && x.category.id === cid) || {}).total || 0;
      return { cat: S.catById(cid), amt, spent };
    }).filter(r => r.cat);

    let html = monthNavHtml();
    html += '<div class="cards">'
      + '<div class="card"><div class="label">収入</div><div class="value income">' + yen(tot.income) + '</div></div>'
      + '<div class="card"><div class="label">支出</div><div class="value expense">' + yen(tot.expense) + '</div></div>'
      + '<div class="card"><div class="label">収支</div><div class="value ' + (tot.diff >= 0 ? 'income' : 'expense') + '">' + (tot.diff >= 0 ? '+' : '') + yen(tot.diff) + '</div></div>'
      + '<div class="card"><div class="label">資産合計</div><div class="value">' + yen(S.state.accounts.reduce((s, a) => s + S.accountBalance(a.id), 0)) + '</div>'
      + '<div class="sub">' + S.state.accounts.map(a => esc(a.name) + ' ' + yen(S.accountBalance(a.id))).join(' / ') + '</div></div>'
      + '</div>';

    html += '<div class="grid-2">';
    html += '<div class="panel"><h3>カテゴリ別支出</h3><div class="donut-wrap"><span id="donut"></span><div class="legend" style="flex:1;min-width:180px">'
      + (catExp.length ? catExp.slice(0, 8).map(x => {
        const pct = Math.round(x.total / tot.expense * 100);
        return '<div class="legend-item"><span class="cat-dot" style="background:' + esc(x.category.color) + '"></span>'
          + '<span class="name">' + esc(x.category.icon || '') + ' ' + esc(x.category.name) + '</span>'
          + '<span class="val">' + yen(x.total) + '</span><span class="pct">' + pct + '%</span></div>';
      }).join('') : '<div class="empty">データがありません</div>')
      + '</div></div></div>';

    html += '<div class="panel"><h3>日別の支出</h3><span id="dailyBars"></span></div>';
    html += '</div>';

    if (budgetRows.length) {
      html += '<div class="panel"><h3>予算の状況</h3>' + budgetRows.map(r => {
        const pct = Math.min(r.spent / r.amt * 100, 100);
        const cls = r.spent > r.amt ? 'over' : pct >= 80 ? 'warn' : '';
        return '<div class="budget-row"><div class="top"><span>' + esc(r.cat.icon || '') + ' ' + esc(r.cat.name)
          + '</span><span>' + yen(r.spent) + ' / ' + yen(r.amt) + '</span></div>'
          + '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div></div>';
      }).join('') + '</div>';
    }

    html += '<div class="panel"><div class="flex-between"><h3>最近の取引</h3>'
      + '<button class="btn btn-sm" data-goto="transactions">すべて見る</button></div>'
      + (recent.length
        ? '<table class="list"><thead><tr><th>日付</th><th>内容</th><th>口座</th><th class="amt">金額</th><th></th></tr></thead><tbody>'
          + recent.map(t => txRow(t, true)).join('') + '</tbody></table>'
        : '<div class="empty">まだ取引がありません。右上の「＋ 記録する」から追加してください。</div>')
      + '</div>';

    main.innerHTML = html;
    document.getElementById('donut').appendChild(
      window.Charts.donut(catExp.map(x => ({ label: x.category.name, value: x.total, color: x.category.color }))));
    document.getElementById('dailyBars').appendChild(window.Charts.bars(dailyItems));
    bindMonthNav();
    bindTxRowActions();
    main.querySelector('[data-goto]').addEventListener('click', () => setView('transactions'));
  }

  /* ---------- 取引一覧 ---------- */
  function renderTransactions() {
    function filtered() {
      let list = S.state.transactions.slice().sort((a, b) => b.date.localeCompare(a.date));
      if (filters.type) list = list.filter(t => t.type === filters.type);
      if (filters.categoryId) list = list.filter(t => t.categoryId === filters.categoryId);
      if (filters.accountId) list = list.filter(t => t.accountId === filters.accountId || t.fromAccountId === filters.accountId || t.toAccountId === filters.accountId);
      if (filters.q) {
        const q = filters.q.toLowerCase();
        list = list.filter(t => (t.memo || '').toLowerCase().includes(q)
          || (S.catById(t.categoryId) && S.catById(t.categoryId).name.toLowerCase().includes(q)));
      }
      return list;
    }
    function resultsHtml() {
      const list = filtered();
      const total = list.reduce((s, t) => s + (t.type === 'expense' ? -t.amount : t.type === 'income' ? t.amount : 0), 0);
      return '<div class="muted" style="margin-bottom:8px">' + list.length + '件 / 収支 ' + (total >= 0 ? '+' : '') + yen(total) + '</div>'
        + (list.length
          ? '<table class="list"><thead><tr><th>日付</th><th>内容</th><th>口座</th><th class="amt">金額</th><th></th></tr></thead><tbody>'
            + list.slice(0, 300).map(t => txRow(t, true)).join('') + '</tbody></table>'
            + (list.length > 300 ? '<div class="empty">300件まで表示しています。検索で絞り込んでください。</div>' : '')
          : '<div class="empty">条件に合う取引がありません</div>');
    }

    let html = '<div class="panel"><div class="filters">'
      + '<input type="search" id="fQ" placeholder="メモ・カテゴリで検索" value="' + esc(filters.q) + '">'
      + '<select id="fType"><option value="">すべての種別</option>'
      + ['expense', 'income', 'transfer'].map(t => '<option value="' + t + '"' + (filters.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>').join('') + '</select>'
      + '<select id="fCat"><option value="">すべてのカテゴリ</option>'
      + S.state.categories.map(c => '<option value="' + c.id + '"' + (filters.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>'
      + '<select id="fAcc"><option value="">すべての口座</option>'
      + S.state.accounts.map(a => '<option value="' + a.id + '"' + (filters.accountId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>'
      + '</div>'
      + '<div id="txResults">' + resultsHtml() + '</div>'
      + '</div>';
    main.innerHTML = html;

    const refresh = () => {
      const box = document.getElementById('txResults');
      box.innerHTML = resultsHtml();
      bindTxRowActions(box);
    };
    document.getElementById('fQ').addEventListener('input', e => { filters.q = e.target.value; refresh(); });
    document.getElementById('fType').addEventListener('change', e => { filters.type = e.target.value; refresh(); });
    document.getElementById('fCat').addEventListener('change', e => { filters.categoryId = e.target.value; refresh(); });
    document.getElementById('fAcc').addEventListener('change', e => { filters.accountId = e.target.value; refresh(); });
    bindTxRowActions();
  }

  /* ---------- カレンダー ---------- */
  function renderCalendar() {
    const [y, m] = viewYm.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const daily = S.dailyTotals(viewYm);
    const today = todayStr();

    let html = monthNavHtml() + '<div class="panel"><div class="calendar">';
    for (const w of ['日', '月', '火', '水', '木', '金', '土']) html += '<div class="cal-head">' + w + '</div>';
    for (let i = 0; i < first.getDay(); i++) html += '<div class="cal-day other"></div>';
    for (let d = 1; d <= lastDay; d++) {
      const key = viewYm + '-' + pad2(d);
      const v = daily.get(key);
      html += '<div class="cal-day' + (key === today ? ' today' : '') + '" data-day="' + key + '">'
        + '<div class="d">' + d + '</div>'
        + (v && v.income ? '<div class="i">+' + v.income.toLocaleString() + '</div>' : '')
        + (v && v.expense ? '<div class="e">-' + v.expense.toLocaleString() + '</div>' : '')
        + '</div>';
    }
    html += '</div><div class="muted mt">日付をクリックすると、その日の取引を追加できます。</div></div>';
    html += '<div class="panel"><h3>この日の取引</h3><div id="dayDetail"><div class="empty">日付を選択してください</div></div></div>';
    main.innerHTML = html;
    bindMonthNav();

    function showDay(dateStr) {
      const list = S.txOfDay(dateStr);
      const el = document.getElementById('dayDetail');
      el.innerHTML = '<div class="flex-between"><strong>' + esc(dateStr) + '</strong>'
        + '<button class="btn btn-sm btn-primary" id="addOnDay">＋ この日に追加</button></div>'
        + (list.length
          ? '<table class="list mt"><tbody>' + list.map(t => txRow(t, false)).join('') + '</tbody></table>'
          : '<div class="empty">取引がありません</div>');
      document.getElementById('addOnDay').addEventListener('click', () => openTxModal(null, dateStr));
      bindTxRowActions();
    }
    main.querySelectorAll('.cal-day[data-day]').forEach(c => c.addEventListener('click', () => showDay(c.dataset.day)));
    showDay(today.startsWith(viewYm) ? today : viewYm + '-01');
  }

  /* ---------- 予算 ---------- */
  function renderBudget() {
    const catExp = S.byCategory(viewYm, 'expense');
    const expCats = S.catsOf('expense');
    const spentOf = cid => (catExp.find(x => x.category && x.category.id === cid) || {}).total || 0;
    const totalBudget = Object.values(S.state.budgets).reduce((s, v) => s + v, 0);
    const totalSpent = expCats.reduce((s, c) => S.state.budgets[c.id] ? s + spentOf(c.id) : s, 0);

    let html = monthNavHtml();
    html += '<div class="panel"><div class="flex-between"><h3>月間予算（カテゴリ別）</h3>'
      + '<span class="muted">予算合計 ' + yen(totalBudget) + ' / 使用 ' + yen(totalSpent) + '</span></div>'
      + expCats.map(c => {
        const b = S.state.budgets[c.id] || 0;
        const spent = spentOf(c.id);
        const pct = b ? Math.min(spent / b * 100, 100) : 0;
        const cls = b && spent > b ? 'over' : pct >= 80 ? 'warn' : '';
        return '<div class="budget-row"><div class="top"><span>' + esc(c.icon || '') + ' ' + esc(c.name)
          + '</span><span>' + yen(spent) + ' / ' + (b ? yen(b) : '未設定') + '</span></div>'
          + '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div>'
          + '<div class="inline-form"><input type="number" min="0" step="1000" placeholder="月の予算額" value="' + (b || '') + '" data-budget="' + c.id + '">'
          + '<button class="btn btn-sm" data-savebudget="' + c.id + '">設定</button></div></div>';
      }).join('') + '</div>';
    main.innerHTML = html;
    bindMonthNav();
    main.querySelectorAll('[data-savebudget]').forEach(b => b.addEventListener('click', () => {
      const cid = b.dataset.savebudget;
      const input = main.querySelector('input[data-budget="' + cid + '"]');
      S.setBudget(cid, Number(input.value) || 0);
      toast('予算を保存しました');
      renderBudget();
    }));
  }
  /* ---------- 固定費 ---------- */
  function renderRecurring() {
    const list = S.state.recurring;
    let html = '<div class="panel"><h3>固定費・定期収支</h3>'
      + '<p class="muted">登録すると、毎月自動で取引が記録されます（家賃・給与・サブスクなど）。</p>'
      + '<div class="inline-form">'
      + '<select id="rType"><option value="expense">支出</option><option value="income">収入</option></select>'
      + '<input type="number" id="rDay" min="1" max="31" placeholder="日" style="flex:0 0 70px" value="1">'
      + '<input type="number" id="rAmount" min="1" placeholder="金額">'
      + '<select id="rCat"></select>'
      + '<select id="rAcc">' + S.state.accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + '</option>').join('') + '</select>'
      + '<input type="text" id="rMemo" placeholder="メモ（例: 家賃）">'
      + '<button class="btn btn-primary btn-sm" id="rAdd">追加</button>'
      + '</div>'
      + (list.length
        ? '<table class="list mt"><thead><tr><th>毎月</th><th>種別</th><th>カテゴリ</th><th>口座</th><th>メモ</th><th class="amt">金額</th><th></th></tr></thead><tbody>'
          + list.map(r => {
            const c = S.catById(r.categoryId);
            return '<tr><td>' + r.day + '日' + (r.active ? '' : '（停止中）') + '</td><td>' + TYPE_LABEL[r.type] + '</td>'
              + '<td>' + (c ? esc(c.icon || '') + ' ' + esc(c.name) : '') + '</td>'
              + '<td>' + esc(accName(r.accountId)) + '</td><td class="memo-cell">' + esc(r.memo || '') + '</td>'
              + '<td class="amt ' + r.type + '">' + yen(r.amount) + '</td>'
              + '<td><div class="row-actions">'
              + '<button class="btn" data-rtoggle="' + r.id + '">' + (r.active ? '停止' : '再開') + '</button>'
              + '<button class="btn" data-rdel="' + r.id + '">削除</button>'
              + '</div></td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty mt">登録された固定費はありません</div>')
      + '</div>';
    main.innerHTML = html;

    const rType = document.getElementById('rType');
    const rCat = document.getElementById('rCat');
    const fillCats = () => { rCat.innerHTML = S.catsOf(rType.value).map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join(''); };
    rType.addEventListener('change', fillCats);
    fillCats();

    document.getElementById('rAdd').addEventListener('click', () => {
      const day = Number(document.getElementById('rDay').value);
      const amount = Number(document.getElementById('rAmount').value);
      if (!day || day < 1 || day > 31 || !amount) { toast('日と金額を入力してください'); return; }
      S.addRecurring({
        type: rType.value, day, amount,
        categoryId: rCat.value, accountId: document.getElementById('rAcc').value,
        memo: document.getElementById('rMemo').value.trim(),
        startYm: viewYm,
      });
      S.applyRecurring(viewYm);
      toast('固定費を追加しました');
      renderRecurring();
    });
    main.querySelectorAll('[data-rtoggle]').forEach(b => b.addEventListener('click', () => { S.toggleRecurring(b.dataset.rtoggle); renderRecurring(); }));
    main.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', () => {
      confirmBox('この固定費を削除しますか？（すでに記録された取引は残ります）', '削除', () => {
        S.deleteRecurring(b.dataset.rdel); renderRecurring();
      });
    }));
  }

  /* ---------- 設定 ---------- */
  function renderSettings() {
    const expCats = S.catsOf('expense'), incCats = S.catsOf('income');
    const accs = S.state.accounts;
    let html = '<div class="manage-grid">';

    html += '<div class="panel"><h3>カテゴリ管理</h3>'
      + '<div class="muted">支出カテゴリ</div><div class="chip-list">'
      + expCats.map(c => '<span class="chip"><span class="cat-dot" style="background:' + esc(c.color) + '"></span>' + esc(c.icon || '') + ' ' + esc(c.name)
        + '<button data-delcat="' + c.id + '" title="削除">✕</button></span>').join('') + '</div>'
      + '<div class="muted mt">収入カテゴリ</div><div class="chip-list">'
      + incCats.map(c => '<span class="chip"><span class="cat-dot" style="background:' + esc(c.color) + '"></span>' + esc(c.icon || '') + ' ' + esc(c.name)
        + '<button data-delcat="' + c.id + '" title="削除">✕</button></span>').join('') + '</div>'
      + '<div class="inline-form"><select id="ncType"><option value="expense">支出</option><option value="income">収入</option></select>'
      + '<input type="text" id="ncName" placeholder="新しいカテゴリ名"><input type="text" id="ncIcon" placeholder="絵文字" style="flex:0 0 70px">'
      + '<input type="color" id="ncColor" value="#3b82f6"><button class="btn btn-sm" id="ncAdd">追加</button></div>'
      + '</div>';

    html += '<div class="panel"><h3>口座管理</h3><div class="chip-list">'
      + accs.map(a => '<span class="chip">' + esc(a.name) + ' <span class="muted">' + yen(S.accountBalance(a.id)) + '</span>'
        + '<button data-delacc="' + a.id + '" title="削除">✕</button></span>').join('') + '</div>'
      + '<div class="inline-form"><input type="text" id="naName" placeholder="口座名（例: 楽天銀行）">'
      + '<input type="number" id="naBal" placeholder="初期残高">'
      + '<button class="btn btn-sm" id="naAdd">追加</button></div>'
      + '</div>';

    html += '<div class="panel"><h3>データの入出力</h3>'
      + '<p class="muted">データはこのブラウザの localStorage に保存されます。定期的にCSVエクスポートでバックアップしてください。</p>'
      + '<div class="inline-form">'
      + '<button class="btn" id="btnExport">CSVエクスポート</button>'
      + '<label class="btn" style="flex:0 0 auto">CSVインポート<input type="file" id="fileImport" accept=".csv" class="hidden"></label>'
      + '</div>'
      + '<p class="muted mt">マネーフォワードMEのCSV（日付/内容/金額（円）/保有金融機関/大項目/中項目）もそのまま取り込めます。</p>'
      + '</div>';

    html += '<div class="panel"><h3>その他</h3><div class="inline-form">'
      + '<button class="btn" id="btnSeed">サンプルデータを入れる</button>'
      + '<button class="btn btn-danger" id="btnReset">全データを削除</button>'
      + '</div></div>';

    html += '</div>';
    main.innerHTML = html;

    main.querySelectorAll('[data-delcat]').forEach(b => b.addEventListener('click', () => {
      confirmBox('カテゴリを削除しますか？（既存の取引は「未分類」表示になります）', '削除', () => {
        S.deleteCategory(b.dataset.delcat); renderSettings();
      });
    }));
    main.querySelectorAll('[data-delacc]').forEach(b => b.addEventListener('click', () => {
      confirmBox('口座を削除しますか？（残高計算から外れます）', '削除', () => {
        S.deleteAccount(b.dataset.delacc); renderSettings();
      });
    }));
    document.getElementById('ncAdd').addEventListener('click', () => {
      const name = document.getElementById('ncName').value.trim();
      if (!name) { toast('カテゴリ名を入力してください'); return; }
      S.addCategory({ name, type: document.getElementById('ncType').value, icon: document.getElementById('ncIcon').value.trim(), color: document.getElementById('ncColor').value });
      toast('カテゴリを追加しました'); renderSettings();
    });
    document.getElementById('naAdd').addEventListener('click', () => {
      const name = document.getElementById('naName').value.trim();
      if (!name) { toast('口座名を入力してください'); return; }
      S.addAccount({ name, kind: 'other', initialBalance: Number(document.getElementById('naBal').value) || 0 });
      toast('口座を追加しました'); renderSettings();
    });
    document.getElementById('btnExport').addEventListener('click', () => {
      const blob = new Blob([S.exportCSV()], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kakeibo_' + todayStr() + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('CSVをエクスポートしました');
    });
    document.getElementById('fileImport').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result;
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (err) {
          // UTF-8で読めないCSV（Shift_JISなど）に対応
          text = new TextDecoder('shift_jis').decode(buf);
        }
        const res = S.importCSV(text);
        toast(res.count + '件インポートしました' + (res.skipped ? '（' + res.skipped + '件スキップ）' : ''));
        render();
      };
      reader.readAsArrayBuffer(f);
      e.target.value = '';
    });
    document.getElementById('btnSeed').addEventListener('click', () => {
      confirmBox('デモ用のサンプルデータを追加しますか？', '追加', () => {
        S.seedDemo(); toast('サンプルデータを追加しました'); render();
      });
    });
    document.getElementById('btnReset').addEventListener('click', () => {
      confirmBox('すべてのデータを削除します。元に戻せません。よろしいですか？', '全削除', () => {
        S.resetAll(); toast('全データを削除しました'); render();
      });
    });
  }

  /* ---------- ナビゲーション・初期化 ---------- */
  function setView(v) {
    view = v;
    document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
    render();
  }
  function render() {
    if (view === 'dashboard') renderDashboard();
    else if (view === 'transactions') renderTransactions();
    else if (view === 'calendar') renderCalendar();
    else if (view === 'budget') renderBudget();
    else if (view === 'recurring') renderRecurring();
    else if (view === 'settings') renderSettings();
  }

  document.getElementById('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) setView(b.dataset.view);
  });
  document.getElementById('btnAddTx').addEventListener('click', () => openTxModal(null));
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
    if (e.key === 'Escape') { closeTxModal(); document.getElementById('confirmModal').classList.add('hidden'); }
  });

  applyTheme();
  S.applyRecurring(nowYm());
  render();
})();
