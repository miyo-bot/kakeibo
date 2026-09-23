/* views.js - 画面描画（App.views に登録） */
(function () {
  'use strict';
  const A = window.App;
  const S = window.Store;
  const I = window.Insights;
  const C = window.Charts;
  const CSV = window.KakeiboCSV;
  const NLQ = window.NLQ;
  const main = document.getElementById('main');
  const esc = A.esc, yen = A.yen, pad2 = A.pad2, ymLabel = A.ymLabel, TYPE_LABEL = A.TYPE_LABEL;
  const views = {};
  A.views = views;

  /* ==================== ホーム ==================== */
  const CARD_DEFS = [
    { id: 'assets',   label: '総資産',      icon: '💰' },
    { id: 'liquid',   label: '現金・預金',  icon: '💵' },
    { id: 'invest',   label: '投資資産',    icon: '📈' },
    { id: 'carddebt', label: 'カード利用残高', icon: '💳' },
    { id: 'income',   label: '今月収入',    icon: '➕' },
    { id: 'expense',  label: '今月支出',    icon: '➖' },
    { id: 'diff',     label: '今月収支',    icon: '📊' },
    { id: 'budget',   label: '予算残額',    icon: '🎯' },
    { id: 'forecast', label: '月末予想残高', icon: '🔮' },
  ];
  function cardOrder() {
    const saved = S.state.settings.cardOrder;
    const ids = CARD_DEFS.map(c => c.id);
    if (!saved || !Array.isArray(saved)) return ids;
    const rest = ids.filter(id => !saved.includes(id));
    return saved.filter(id => ids.includes(id)).concat(rest);
  }
  function kpiValue(id, ctx) {
    switch (id) {
      case 'assets':   return { v: yen(ctx.totalAssets), sub: ctx.assetSub };
      case 'liquid':   return { v: yen(ctx.liquid), sub: ctx.liquidSub };
      case 'invest':   return { v: yen(ctx.invest), sub: ctx.investSub };
      case 'carddebt': return { v: yen(ctx.cardDebt), sub: ctx.cardDebtSub };
      case 'income':   return { v: yen(ctx.tot.income), cls: 'income' };
      case 'expense':  return { v: yen(ctx.tot.expense), cls: 'expense' };
      case 'diff':     return { v: (ctx.tot.diff >= 0 ? '+' : '') + yen(ctx.tot.diff), cls: ctx.tot.diff >= 0 ? 'income' : 'expense', delta: ctx.momDiff };
      case 'budget':   return { v: yen(ctx.budgetRemain), sub: ctx.budgetSub };
      case 'forecast': return { v: yen(ctx.forecastEnd), sub: ctx.forecastSub };
      default: return { v: '-' };
    }
  }
  function renderHome() {
    const ym = A.viewYm;
    const tot = S.monthTotals(ym);
    const catExp = S.byCategory(ym, 'expense');
    const daily = S.dailyTotals(ym);
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const isCur = ym === A.nowYm();
    const upto = isCur ? new Date().getDate() : lastDay;

    // 資産
    const byKind = S.balanceByKind();
    const liquid = (byKind.cash || 0) + (byKind.bank || 0) + (byKind.emoney || 0);
    const invest = byKind.invest || 0;
    const cardDebt = S.cardDebt();
    const totalAssets = S.totalAssets();
    const assetSub = S.state.accounts.map(a => esc(a.name) + ' ' + yen(S.accountBalance(a.id))).join(' / ');

    // 前月比
    const prevTot = S.monthTotals(I.shiftYm(ym, -1));
    const momDiff = prevTot.diff ? (tot.diff - prevTot.diff) : null;

    // 予算
    const budgetRows = I.budgetStatus(ym);
    const budgetTotal = budgetRows.reduce((s, r) => s + r.budget, 0);
    const budgetSpent = budgetRows.reduce((s, r) => s + r.spent, 0);
    const budgetRemain = budgetTotal - budgetSpent;
    const budgetSub = budgetTotal ? '予算 ' + yen(budgetTotal) + ' / 使用 ' + yen(budgetSpent) : '未設定';

    // 月末予想
    const fc = I.forecastBalances([30]);
    const forecastEnd = fc.horizons[30].projectedTotal;
    const forecastSub = '確定 ' + yen(fc.horizons[30].confirmedTotal) + ' / 変動費見込 -' + yen(fc.horizons[30].variableEstimate);

    const ctx = { tot, totalAssets, liquid, invest, cardDebt, assetSub, liquidSub: '現金+銀行+電子マネー', investSub: '評価額ベース', cardDebtSub: '負債', momDiff, budgetRemain, budgetSub, forecastEnd, forecastSub };

    // カードHTML
    const order = cardOrder();
    let html = A.monthNavHtml();
    html += '<div class="kpi-grid" id="kpiGrid">' + order.map(id => {
      const def = CARD_DEFS.find(c => c.id === id);
      const kv = kpiValue(id, ctx);
      return '<div class="kpi" draggable="true" data-card="' + id + '">'
        + '<span class="drag" title="並び替え">⠿</span>'
        + '<div class="label">' + def.icon + ' ' + def.label + '</div>'
        + '<div class="value ' + (kv.cls || '') + '">' + kv.v + '</div>'
        + (kv.delta != null ? '<div class="delta ' + (kv.delta >= 0 ? 'up' : 'down') + '">前月比 ' + (kv.delta >= 0 ? '+' : '') + yen(kv.delta) + '</div>' : '')
        + (kv.sub ? '<div class="sub">' + kv.sub + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';

    // インサイト
    const insights = I.generate(ym);
    if (insights.length) {
      html += '<div class="panel"><h3>📌 今月のポイント</h3><div class="insights">'
        + insights.slice(0, 5).map(i => '<div class="insight ' + i.severity + '">' + esc(i.text) + '</div>').join('')
        + '</div></div>';
    }

    // グラフ
    html += '<div class="grid-2">';
    html += '<div class="panel"><h3>カテゴリ別支出</h3><div class="donut-wrap"><span id="donut"></span><div class="legend" style="flex:1;min-width:160px">'
      + (catExp.length ? catExp.slice(0, 7).map(x => {
        const pct = tot.expense ? Math.round(x.total / tot.expense * 100) : 0;
        return '<div class="legend-item"><span class="cat-dot" style="background:' + esc(x.category.color) + '"></span>'
          + '<span class="name">' + esc(x.category.icon || '') + ' ' + esc(x.category.name) + '</span>'
          + '<span class="val">' + yen(x.total) + '</span><span class="pct">' + pct + '%</span></div>';
      }).join('') : '<div class="empty">データがありません</div>')
      + '</div></div></div>';

    const dailyItems = [];
    for (let d = 1; d <= lastDay; d++) {
      const key = ym + '-' + pad2(d);
      const v = daily.get(key) || { expense: 0 };
      dailyItems.push({ label: String(d), value: v.expense, showLabel: d === 1 || d % 5 === 0, highlight: isCur && d === upto });
    }
    html += '<div class="panel"><h3>日別の支出</h3><span id="dailyBars"></span></div>';
    html += '</div>';

    // 月別収支（6ヶ月）
    html += '<div class="panel"><h3>月別収支（6ヶ月）</h3><span id="monthBars"></span></div>';

    // 予算の状況
    if (budgetRows.length) {
      html += '<div class="panel"><h3>予算の状況</h3>' + budgetRows.slice(0, 6).map(r => {
        const pct = Math.min(r.pct * 100, 100);
        const cls = r.status === 'over' ? 'over' : r.status === 'warn' ? 'warn' : '';
        return '<div class="budget-row"><div class="top"><span>' + esc(r.category.icon || '') + ' ' + esc(r.category.name)
          + '</span><span>' + yen(r.spent) + ' / ' + yen(r.budget) + '</span></div>'
          + '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div>'
          + '<div class="meta"><span>残り ' + yen(r.remaining) + '</span><span>月末予測 ' + yen(r.forecast) + '</span></div></div>';
      }).join('') + '</div>';
    }

    // 最近の取引
    const recent = S.txInMonth(ym).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    html += '<div class="panel"><div class="flex-between"><h3>最近の取引</h3>'
      + '<button class="btn btn-sm" data-goto="transactions">すべて見る</button></div>'
      + (recent.length
        ? '<table class="list"><thead><tr><th>日付</th><th>内容</th><th>口座</th><th class="amt">金額</th><th></th></tr></thead><tbody>'
          + recent.map(t => A.txRow(t, true)).join('') + '</tbody></table>'
        : '<div class="empty"><span class="icon">🧾</span>まだ取引がありません。右下の「＋」から追加してください。</div>')
      + '</div>';

    main.innerHTML = html;
    document.getElementById('donut').appendChild(C.donut(catExp.map(x => ({ label: x.category.name, value: x.total, color: x.category.color }))));
    document.getElementById('dailyBars').appendChild(C.bars(dailyItems));
    // 月別収支
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(I.shiftYm(ym, -i));
    document.getElementById('monthBars').appendChild(C.bars(months.map(m2 => {
      const t = S.monthTotals(m2);
      return { label: m2.slice(5) + '月', value: t.income, value2: t.expense, showLabel: true };
    }), { height: 160 }));
    A.bindMonthNav();
    A.bindTxRowActions();
    const goto = main.querySelector('[data-goto]');
    if (goto) goto.addEventListener('click', () => A.setView('transactions'));
    bindCardDrag();
  }
  // カード並び替え（ドラッグ＆ドロップ）
  function bindCardDrag() {
    const grid = document.getElementById('kpiGrid');
    if (!grid) return;
    let dragEl = null;
    grid.querySelectorAll('.kpi').forEach(card => {
      card.addEventListener('dragstart', () => { dragEl = card; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        const order = [...grid.querySelectorAll('.kpi')].map(c => c.dataset.card);
        S.state.settings.cardOrder = order;
        S.save();
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragEl || dragEl === card) return;
        const rect = card.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        grid.insertBefore(dragEl, after ? card.nextSibling : card);
      });
    });
  }
  views.home = renderHome;

  /* ==================== 取引一覧 ==================== */
  const selected = new Set();
  function renderTransactions() {
    const f = A.filters;
    function filtered() {
      return S.search({
        q: f.q, type: f.type, categoryId: f.categoryId, accountId: f.accountId,
        dateFrom: f.dateFrom, dateTo: f.dateTo,
        minAmount: f.minAmount === '' ? null : Number(f.minAmount),
        maxAmount: f.maxAmount === '' ? null : Number(f.maxAmount),
        tag: f.tag, exclude: f.exclude,
      }).sort((a, b) => b.date.localeCompare(a.date));
    }
    function resultsHtml() {
      const list = filtered();
      const total = list.reduce((s, t) => s + (t.type === 'expense' ? -t.amount : t.type === 'income' ? t.amount : 0), 0);
      let h = '<div class="muted" style="margin-bottom:8px">' + list.length + '件 / 収支 ' + (total >= 0 ? '+' : '') + yen(total) + '</div>';
      if (list.length) {
        h += '<div style="margin-bottom:6px"><label class="muted"><input type="checkbox" id="selAll"> 全選択</label></div>';
        h += '<table class="list"><thead><tr><th></th><th>日付</th><th>内容</th><th>口座</th><th class="amt">金額</th><th></th></tr></thead><tbody>';
        h += list.slice(0, 400).map(t => {
          const row = A.txRow(t, true);
          // 先頭にチェックボックス列を足す
          return row.replace('<tr>', '<tr><td><input type="checkbox" class="sel" data-id="' + t.id + '"' + (selected.has(t.id) ? ' checked' : '') + '></td>');
        }).join('');
        h += '</tbody></table>';
        if (list.length > 400) h += '<div class="empty">400件まで表示しています。条件で絞り込んでください。</div>';
      } else {
        h += '<div class="empty"><span class="icon">🔍</span>条件に合う取引がありません</div>';
      }
      return h;
    }

    let html = '<div class="panel"><div class="filters">'
      + '<input type="search" id="fQ" placeholder="店舗・メモ・カテゴリ・タグで検索" value="' + esc(f.q) + '">'
      + '<select id="fType"><option value="">すべての種別</option>'
      + ['expense', 'income', 'transfer'].map(t => '<option value="' + t + '"' + (f.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>').join('') + '</select>'
      + '<select id="fCat"><option value="">すべてのカテゴリ</option>'
      + S.state.categories.map(c => '<option value="' + c.id + '"' + (f.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>'
      + '<select id="fAcc"><option value="">すべての口座</option>'
      + S.state.accounts.map(a => '<option value="' + a.id + '"' + (f.accountId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>'
      + '<details><summary>詳細フィルタ</summary><div class="adv">'
      + '<input type="date" id="fFrom" value="' + esc(f.dateFrom) + '" title="開始日">'
      + '<input type="date" id="fTo" value="' + esc(f.dateTo) + '" title="終了日">'
      + '<input type="number" id="fMin" placeholder="最小金額" value="' + esc(f.minAmount) + '">'
      + '<input type="number" id="fMax" placeholder="最大金額" value="' + esc(f.maxAmount) + '">'
      + '<input type="text" id="fTag" placeholder="タグ" value="' + esc(f.tag) + '" list="tagList">'
      + '<select id="fExclude"><option value="">除外を含む</option><option value="hide"' + (f.exclude === 'hide' ? ' selected' : '') + '>除外を隠す</option><option value="only"' + (f.exclude === 'only' ? ' selected' : '') + '>除外のみ</option></select>'
      + '</div></details>'
      + '<datalist id="tagList">' + S.allTags().map(t => '<option value="' + esc(t) + '"></option>').join('') + '</datalist>'
      + '</div>'
      + '<div id="txResults">' + resultsHtml() + '</div>'
      + '<div id="bulkBar" class="bulk-bar hidden"></div>'
      + '</div>';
    main.innerHTML = html;

    const refresh = () => {
      const box = document.getElementById('txResults');
      box.innerHTML = resultsHtml();
      bindRows(box);
      updateBulkBar();
    };
    const bind = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    bind('fQ', 'input', e => { f.q = e.target.value; refresh(); });
    bind('fType', 'change', e => { f.type = e.target.value; refresh(); });
    bind('fCat', 'change', e => { f.categoryId = e.target.value; refresh(); });
    bind('fAcc', 'change', e => { f.accountId = e.target.value; refresh(); });
    bind('fFrom', 'change', e => { f.dateFrom = e.target.value; refresh(); });
    bind('fTo', 'change', e => { f.dateTo = e.target.value; refresh(); });
    bind('fMin', 'input', e => { f.minAmount = e.target.value; refresh(); });
    bind('fMax', 'input', e => { f.maxAmount = e.target.value; refresh(); });
    bind('fTag', 'input', e => { f.tag = e.target.value; refresh(); });
    bind('fExclude', 'change', e => { f.exclude = e.target.value; refresh(); });

    function bindRows(root) {
      A.bindTxRowActions(root);
      const all = root.querySelector('#selAll');
      if (all) all.addEventListener('change', () => {
        root.querySelectorAll('.sel').forEach(cb => {
          cb.checked = all.checked;
          if (all.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
        });
        updateBulkBar();
      });
      root.querySelectorAll('.sel').forEach(cb => cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
        updateBulkBar();
      }));
    }
    function updateBulkBar() {
      const bar = document.getElementById('bulkBar');
      if (!bar) return;
      if (!selected.size) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      bar.innerHTML = '<span class="muted">' + selected.size + '件選択</span>'
        + '<select id="bulkCat"><option value="">カテゴリを変更…</option>'
        + S.catsOf('expense').map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select>'
        + '<select id="bulkAcc"><option value="">口座を変更…</option>'
        + S.state.accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + '</option>').join('') + '</select>'
        + '<button class="btn btn-sm" id="bulkExclude">除外にする</button>'
        + '<button class="btn btn-sm" id="bulkInclude">除外を解除</button>'
        + '<button class="btn btn-sm btn-danger" id="bulkDelete">削除</button>'
        + '<button class="btn btn-sm" id="bulkClear">解除</button>';
      const bc = bar.querySelector('#bulkCat');
      const ba = bar.querySelector('#bulkAcc');
      if (bc) bc.addEventListener('change', () => {
        const cid = bc.value; if (!cid) return;
        const n = selected.size;
        A.confirmBox(n + '件のカテゴリを「' + esc(S.catById(cid).name) + '」に変更しますか？', '変更', () => {
          const before = S.bulkUpdate([...selected], { categoryId: cid });
          const payees = new Set();
          for (const id of selected) {
            const t = S.state.transactions.find(t => t.id === id);
            if (t && t.payee) payees.add(t.payee);
          }
          // 店舗ルールを学習（選択中の店舗ごと）
          for (const p of payees) window.Classify.learn({ payee: p }, cid);
          selected.clear();
          A.toast(n + '件を変更しました', { actionLabel: '元に戻す', onAction: () => { S.restoreTxList(before); A.render(); } });
          A.render();
        });
      });
      if (ba) ba.addEventListener('change', () => {
        const aid = ba.value; if (!aid) return;
        const n = selected.size;
        A.confirmBox(n + '件の口座を「' + esc(S.accById(aid).name) + '」に変更しますか？', '変更', () => {
          const before = S.bulkUpdate([...selected], { accountId: aid });
          selected.clear();
          A.toast(n + '件を変更しました', { actionLabel: '元に戻す', onAction: () => { S.restoreTxList(before); A.render(); } });
          A.render();
        });
      });
      const be = bar.querySelector('#bulkExclude');
      if (be) be.addEventListener('click', () => {
        const before = S.bulkUpdate([...selected], { exclude: true });
        const n = selected.size; selected.clear();
        A.toast(n + '件を除外にしました', { actionLabel: '元に戻す', onAction: () => { S.restoreTxList(before); A.render(); } });
        A.render();
      });
      const bi = bar.querySelector('#bulkInclude');
      if (bi) bi.addEventListener('click', () => {
        const before = S.bulkUpdate([...selected], { exclude: false });
        const n = selected.size; selected.clear();
        A.toast(n + '件の除外を解除しました', { actionLabel: '元に戻す', onAction: () => { S.restoreTxList(before); A.render(); } });
        A.render();
      });
      const bd = bar.querySelector('#bulkDelete');
      if (bd) bd.addEventListener('click', () => {
        const n = selected.size;
        A.confirmBox(n + '件を削除しますか？（元に戻せます）', '削除', () => {
          const removed = S.deleteTxList([...selected]);
          selected.clear();
          A.toast(n + '件を削除しました', { actionLabel: '元に戻す', onAction: () => { S.addTxList(removed); A.render(); } });
          A.render();
        });
      });
      const clr = bar.querySelector('#bulkClear');
      if (clr) clr.addEventListener('click', () => { selected.clear(); refresh(); });
    }
    bindRows(document.getElementById('txResults'));
  }
  views.transactions = renderTransactions;

  /* ==================== 分析（AI） ==================== */
  function renderAnalysis() {
    const ym = A.viewYm;
    const insights = I.generate(ym);
    const mom = I.monthOverMonth(ym);
    const subs = I.detectSubscriptions();
    const fs = I.fixedCostShare();
    const fc = I.forecastBalances([7, 30, 90, 180]);

    let html = A.monthNavHtml();

    // 自然言語検索
    html += '<div class="panel"><h3>💬 家計に質問する</h3>'
      + '<div class="nlq-form"><input id="nlqInput" placeholder="例: 今月 Amazon でいくら使った？">'
      + '<button class="btn btn-primary" id="nlqAsk">聞く</button></div>'
      + '<div class="muted" style="margin-bottom:8px">例: 「今年の外食費は？」「先月より増えた支出は？」「固定費はいくら？」</div>'
      + '<div id="nlqOut"></div>'
      + '</div>';

    // インサイト
    html += '<div class="panel"><h3>📌 今月のポイント</h3><div class="insights">'
      + (insights.length ? insights.map(i => '<div class="insight ' + i.severity + '">' + esc(i.text) + '</div>').join('') : '<div class="empty">特筆すべき変化はありません</div>')
      + '</div></div>';

    // 支出が増えた理由
    const why = I.whyIncreased(ym);
    if (why) {
      html += '<div class="panel"><h3>🔍 先月より支出が増えた理由</h3>'
        + why.map(w => '<div class="sub-card"><div><div class="name">' + esc(w.icon || '') + ' ' + esc(w.name) + '</div>'
          + '<div class="meta">前月 ' + yen(w.prev) + ' → 今月 ' + yen(w.cur) + '</div></div>'
          + '<span class="badge ' + (w.pct !== null && w.pct >= 50 ? 'warn' : '') + '">+' + yen(w.diff) + (w.pct !== null ? '（' + w.pct + '%）' : '') + '</span></div>').join('')
        + '</div>';
    }

    // 固定費・サブスク
    html += '<div class="panel"><div class="flex-between"><h3>🔁 固定費・サブスク（自動検出）</h3>'
      + '<span class="muted">月 ' + yen(fs.fixedMonthly) + ' / 年 ' + yen(fs.yearlyFixed) + '</span></div>'
      + (subs.length ? subs.map(s => {
        const cat = S.catById(s.categoryId);
        return '<div class="sub-card"><div><div class="name">' + esc(s.label) + '</div>'
          + '<div class="meta">' + (cat ? esc(cat.name) + ' / ' : '') + '毎月' + s.day + '日頃 / 次回 ' + esc(s.nextDate)
          + (s.inactiveMonths >= 3 ? ' / <span class="badge warn">' + s.inactiveMonths + 'ヶ月未使用</span>' : '')
          + '</div></div>'
          + '<div style="text-align:right"><div>' + yen(s.monthly) + '<span class="muted">/月</span></div>'
          + (s.priceUp ? '<div class="badge warn">値上げ ' + yen(s.prevAmount) + '→' + yen(s.lastAmount) + '</div>' : '')
          + '</div></div>';
      }).join('') : '<div class="empty">固定費はまだ検出されていません（3ヶ月以上の履歴が必要です）</div>')
      + '</div>';

    // 将来残高予測
    html += '<div class="panel"><h3>🔮 残高予測</h3>'
      + '<table class="list"><thead><tr><th>期間</th><th class="amt">確定残高</th><th class="amt">予測残高</th><th>内訳</th></tr></thead><tbody>'
      + [7, 30, 90, 180].map(h => {
        const r = fc.horizons[h];
        return '<tr><td>' + h + '日後（' + esc(r.date) + '）</td>'
          + '<td class="amt">' + yen(r.confirmedTotal) + '</td>'
          + '<td class="amt">' + yen(r.projectedTotal) + '</td>'
          + '<td class="memo-cell">固定費 ' + yen(fc.fixedMonthly) + '/月 + 変動費 ' + yen(r.variableEstimate) + '</td></tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="muted mt">確定 = 現在残高 + 期間内の登録済み定期収支。予測 = 確定 − 変動費見込（過去3ヶ月平均）。</div>'
      + '</div>';

    // 月次比較
    html += '<div class="panel"><h3>📊 カテゴリ別 前月比較</h3>'
      + (mom.length ? '<table class="list"><thead><tr><th>カテゴリ</th><th class="amt">前月</th><th class="amt">今月</th><th class="amt">差</th></tr></thead><tbody>'
        + mom.slice(0, 10).map(x => '<tr><td>' + esc(x.category.icon || '') + ' ' + esc(x.category.name) + '</td>'
          + '<td class="amt">' + yen(x.prev) + '</td><td class="amt">' + yen(x.cur) + '</td>'
          + '<td class="amt ' + (x.diff > 0 ? 'expense' : 'income') + '">' + (x.diff > 0 ? '+' : '') + yen(x.diff) + (x.pct !== null ? '（' + x.pct + '%）' : '') + '</td></tr>').join('')
        + '</tbody></table>' : '<div class="empty">比較できるデータがありません</div>')
      + '</div>';

    main.innerHTML = html;
    A.bindMonthNav();

    const ask = () => {
      const q = document.getElementById('nlqInput').value;
      const out = document.getElementById('nlqOut');
      if (!q.trim()) return;
      const res = NLQ.ask(q);
      let h = '<div class="nlq-answer">' + esc(res.answer) + '</div>';
      if (res.rows && res.rows.length) {
        h += '<table class="nlq-rows">' + res.rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';
      }
      out.innerHTML = h;
    };
    document.getElementById('nlqAsk').addEventListener('click', ask);
    document.getElementById('nlqInput').addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
  }
  views.analysis = renderAnalysis;

  /* ==================== 予算 ==================== */
  function renderBudget() {
    const ym = A.viewYm;
    const rows = I.budgetStatus(ym);
    const expCats = S.catsOf('expense');
    const catExp = S.byCategory(ym, 'expense');
    const spentOf = cid => (catExp.find(x => x.category && x.category.id === cid) || {}).total || 0;
    const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
    const totalSpent = rows.reduce((s, r) => s + r.spent, 0);

    let html = A.monthNavHtml();
    html += '<div class="panel"><div class="flex-between"><h3>月間予算（カテゴリ別）</h3>'
      + '<span class="muted">予算 ' + yen(totalBudget) + ' / 使用 ' + yen(totalSpent) + ' / 残 ' + yen(totalBudget - totalSpent) + '</span></div>'
      + expCats.map(c => {
        const b = S.state.budgets[c.id] || 0;
        const r = rows.find(x => x.category.id === c.id);
        const spent = r ? r.spent : spentOf(c.id);
        const pct = b ? Math.min(spent / b * 100, 100) : 0;
        const cls = b && spent > b ? 'over' : pct >= 80 ? 'warn' : '';
        return '<div class="budget-row"><div class="top"><span>' + esc(c.icon || '') + ' ' + esc(c.name) + '</span><span>' + yen(spent) + ' / ' + (b ? yen(b) : '未設定') + '</span></div>'
          + '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div>'
          + (b ? '<div class="meta"><span>残り ' + yen(b - spent) + ' / 1日あたり ' + yen(r ? r.perDay : 0) + '</span><span>月末予測 ' + yen(r ? r.forecast : 0) + '</span></div>' : '')
          + '<div class="inline-form"><input type="number" min="0" step="1000" placeholder="月の予算額" value="' + (b || '') + '" data-budget="' + c.id + '">'
          + '<button class="btn btn-sm" data-savebudget="' + c.id + '">設定</button></div></div>';
      }).join('') + '</div>';
    main.innerHTML = html;
    A.bindMonthNav();
    main.querySelectorAll('[data-savebudget]').forEach(b => b.addEventListener('click', () => {
      const cid = b.dataset.savebudget;
      const input = main.querySelector('input[data-budget="' + cid + '"]');
      S.setBudget(cid, Number(input.value) || 0);
      A.toast('予算を保存しました');
      renderBudget();
    }));
  }
  views.budget = renderBudget;

  /* ==================== カレンダー ==================== */
  function renderCalendar() {
    const ym = A.viewYm;
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const daily = S.dailyTotals(ym);
    const today = A.todayStr();

    let html = A.monthNavHtml() + '<div class="panel"><div class="calendar">';
    for (const w of ['日', '月', '火', '水', '木', '金', '土']) html += '<div class="cal-head">' + w + '</div>';
    for (let i = 0; i < first.getDay(); i++) html += '<div class="cal-day other"></div>';
    for (let d = 1; d <= lastDay; d++) {
      const key = ym + '-' + pad2(d);
      const v = daily.get(key);
      html += '<div class="cal-day' + (key === today ? ' today' : '') + '" data-day="' + key + '">'
        + '<div class="d">' + d + '</div>'
        + (v && v.income ? '<div class="i">+' + v.income.toLocaleString() + '</div>' : '')
        + (v && v.expense ? '<div class="e">-' + v.expense.toLocaleString() + '</div>' : '')
        + '</div>';
    }
    html += '</div><div class="muted mt">日付をタップすると、その日の取引を追加できます。</div></div>';
    html += '<div class="panel"><h3>この日の取引</h3><div id="dayDetail"><div class="empty">日付を選択してください</div></div></div>';
    main.innerHTML = html;
    A.bindMonthNav();

    function showDay(dateStr) {
      const list = S.txOfDay(dateStr);
      const el = document.getElementById('dayDetail');
      el.innerHTML = '<div class="flex-between"><strong>' + esc(dateStr) + '</strong>'
        + '<button class="btn btn-sm btn-primary" id="addOnDay">＋ この日に追加</button></div>'
        + (list.length
          ? '<table class="list mt"><tbody>' + list.map(t => A.txRow(t, false)).join('') + '</tbody></table>'
          : '<div class="empty">取引がありません</div>');
      document.getElementById('addOnDay').addEventListener('click', () => A.openTxModal(null, dateStr));
      A.bindTxRowActions();
    }
    main.querySelectorAll('.cal-day[data-day]').forEach(c => c.addEventListener('click', () => showDay(c.dataset.day)));
    showDay(today.startsWith(ym) ? today : ym + '-01');
  }
  views.calendar = renderCalendar;

  /* ==================== 資産 ==================== */
  function renderAssets() {
    const accs = S.state.accounts;
    const byKind = S.balanceByKind();
    const monthEnd = S.monthEndBalances();

    // 月次資産推移（直近12ヶ月、月末残高合計）
    const months = [];
    for (let i = 11; i >= 0; i--) months.push(I.shiftYm(A.nowYm(), -i));
    const trend = months.map(m => {
      const map = monthEnd.get(m);
      let sum = 0;
      if (map) for (const v of map.values()) sum += v;
      else sum = S.totalAssets(); // 当月は現在値
      return { label: m.slice(5) + '月', y: sum, x: 0 };
    });
    trend.forEach((p, i) => p.x = i);

    let html = '<div class="panel"><h3>💰 資産状況</h3>'
      + '<div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">'
      + '<div class="kpi"><div class="label">総資産</div><div class="value">' + yen(S.totalAssets()) + '</div></div>'
      + '<div class="kpi"><div class="label">現金・預金・電子マネー</div><div class="value">' + yen((byKind.cash||0)+(byKind.bank||0)+(byKind.emoney||0)) + '</div></div>'
      + '<div class="kpi"><div class="label">投資資産</div><div class="value">' + yen(byKind.invest||0) + '</div></div>'
      + '</div>'
      + '<div id="assetTrend"></div>'
      + '</div>';

    // 口座一覧
    html += '<div class="panel"><h3>口座一覧</h3>'
      + accs.map(a => {
        const bal = S.accountBalance(a.id);
        const kind = S.ACCOUNT_KINDS[a.kind] || a.kind;
        let extra = '';
        if (a.kind === 'invest') {
          const p = S.investPerf(a.id);
          if (p) {
            const cls = p.pnl >= 0 ? 'up' : 'down';
            extra = '<div class="meta">投入 ' + yen(p.invested) + ' / 評価 ' + yen(p.market)
              + ' / 損益 <span class="pnl ' + cls + '">' + (p.pnl >= 0 ? '+' : '') + yen(p.pnl) + '（' + Math.round(p.pnlRate * 100) + '%）</span></div>';
          }
        }
        if (a.kind === 'credit' && bal < 0) {
          extra = '<div class="meta">利用残高 ' + yen(-bal) + '</div>';
        }
        return '<div class="asset-row"><div><div class="name">' + esc(a.name) + '</div><div class="kind">' + esc(kind) + '</div>' + extra + '</div>'
          + '<div style="text-align:right"><div class="amt">' + yen(bal) + '</div>'
          + (a.kind === 'invest' ? '<button class="btn btn-sm" data-snap="' + a.id + '">評価額を更新</button>' : '')
          + '</div></div>';
      }).join('')
      + '<div class="muted mt">投資口座は「評価額を更新」で現在の時価を記録すると損益が計算されます。日常の収支とは分離して管理されます。</div>'
      + '</div>';

    // 口座追加
    html += '<div class="panel"><h3>口座を追加</h3><div class="inline-form">'
      + '<input type="text" id="naName" placeholder="口座名（例: 楽天銀行、SBI証券）">'
      + '<select id="naKind">' + Object.entries(S.ACCOUNT_KINDS).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('') + '</select>'
      + '<input type="number" id="naBal" placeholder="初期残高">'
      + '<button class="btn btn-sm btn-primary" id="naAdd">追加</button></div></div>';

    main.innerHTML = html;
    document.getElementById('assetTrend').appendChild(C.line([{ name: '総資産', color: 'var(--primary)', points: trend }], { height: 180 }));

    main.querySelectorAll('[data-snap]').forEach(b => b.addEventListener('click', () => {
      const a = S.accById(b.dataset.snap);
      const cur = S.latestSnapshot(a.id);
      const val = prompt(a.name + ' の現在の評価額を入力してください', cur ? cur.value : '');
      if (val === null) return;
      const n = Number(String(val).replace(/[^0-9]/g, ''));
      if (!n) { A.toast('金額を入力してください'); return; }
      S.setAssetSnapshot(a.id, A.todayStr(), n);
      A.toast('評価額を記録しました');
      renderAssets();
    }));
    document.getElementById('naAdd').addEventListener('click', () => {
      const name = document.getElementById('naName').value.trim();
      if (!name) { A.toast('口座名を入力してください'); return; }
      S.addAccount({ name, kind: document.getElementById('naKind').value, initialBalance: Number(document.getElementById('naBal').value) || 0 });
      A.toast('口座を追加しました');
      renderAssets();
    });
  }
  views.assets = renderAssets;

  /* ==================== 固定費 ==================== */
  function renderRecurring() {
    const list = S.state.recurring;
    const subs = I.detectSubscriptions();
    let html = '<div class="panel"><h3>固定費・定期収支</h3>'
      + '<p class="muted">登録すると毎月自動で取引が記録されます。種別「振替」はカード引き落とし（銀行→クレカ）に使えます。</p>'
      + '<div class="inline-form">'
      + '<select id="rType"><option value="expense">支出</option><option value="income">収入</option><option value="transfer">振替（引落）</option></select>'
      + '<input type="number" id="rDay" min="1" max="31" placeholder="日" style="flex:0 0 70px" value="1">'
      + '<input type="number" id="rAmount" min="1" placeholder="金額">'
      + '<select id="rCat"></select>'
      + '<select id="rAcc">' + S.state.accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + '</option>').join('') + '</select>'
      + '<select id="rToAcc" class="hidden">' + S.state.accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + '</option>').join('') + '</select>'
      + '<input type="text" id="rPayee" placeholder="店舗（例: Netflix）">'
      + '<input type="text" id="rMemo" placeholder="メモ">'
      + '<button class="btn btn-primary btn-sm" id="rAdd">追加</button>'
      + '</div>'
      + (list.length
        ? '<table class="list mt"><thead><tr><th>毎月</th><th>種別</th><th>内容</th><th>口座</th><th class="amt">金額</th><th></th></tr></thead><tbody>'
          + list.map(r => {
            const c = S.catById(r.categoryId);
            const desc = r.type === 'transfer'
              ? '🔁 ' + esc(A.accName(r.accountId)) + ' → ' + esc(A.accName(r.toAccountId))
              : (c ? esc(c.icon || '') + ' ' + esc(c.name) : '') + (r.payee ? ' ' + esc(r.payee) : '');
            return '<tr><td>' + r.day + '日' + (r.active ? '' : '（停止中）') + '</td><td>' + TYPE_LABEL[r.type] + '</td>'
              + '<td>' + desc + '</td>'
              + '<td>' + esc(A.accName(r.accountId)) + '</td>'
              + '<td class="amt ' + r.type + '">' + yen(r.amount) + '</td>'
              + '<td><div class="row-actions">'
              + '<button class="btn" data-rtoggle="' + r.id + '">' + (r.active ? '停止' : '再開') + '</button>'
              + '<button class="btn" data-rdel="' + r.id + '">削除</button>'
              + '</div></td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="empty mt">登録された固定費はありません</div>')
      + '</div>';

    // 検出された固定費の提案
    if (subs.length) {
      html += '<div class="panel"><h3>🔁 検出された固定費</h3>'
        + '<p class="muted">取引履歴から定期っぽい支出を検出しています。「登録」で自動記録に変換できます。</p>'
        + subs.slice(0, 8).map(s => {
          const already = list.some(r => S.normalizeText(r.payee || r.memo || '') === s.key);
          return '<div class="sub-card"><div><div class="name">' + esc(s.label) + '</div>'
            + '<div class="meta">毎月' + s.day + '日頃 / ' + yen(s.monthly) + '/月 / 年 ' + yen(s.yearly) + '</div></div>'
            + (already ? '<span class="badge ok">登録済み</span>'
              : '<button class="btn btn-sm" data-regsub="' + esc(s.key) + '" data-day="' + s.day + '" data-amt="' + s.monthly + '" data-label="' + esc(s.label) + '" data-cat="' + (s.categoryId || '') + '">登録</button>')
            + '</div>';
        }).join('')
        + '</div>';
    }
    main.innerHTML = html;

    const rType = document.getElementById('rType');
    const rCat = document.getElementById('rCat');
    const rToAcc = document.getElementById('rToAcc');
    const fillCats = () => {
      const isT = rType.value === 'transfer';
      rCat.disabled = isT;
      rToAcc.classList.toggle('hidden', !isT);
      rCat.innerHTML = S.catsOf(isT ? 'expense' : rType.value).map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
    };
    rType.addEventListener('change', fillCats);
    fillCats();

    document.getElementById('rAdd').addEventListener('click', () => {
      const day = Number(document.getElementById('rDay').value);
      const amount = Number(document.getElementById('rAmount').value);
      if (!day || day < 1 || day > 31 || !amount) { A.toast('日と金額を入力してください'); return; }
      const type = rType.value;
      const r = {
        type, day, amount,
        categoryId: type === 'transfer' ? null : rCat.value,
        accountId: document.getElementById('rAcc').value,
        toAccountId: type === 'transfer' ? rToAcc.value : undefined,
        payee: document.getElementById('rPayee').value.trim(),
        memo: document.getElementById('rMemo').value.trim(),
        startYm: A.viewYm,
      };
      S.addRecurring(r);
      S.applyRecurring(A.viewYm);
      A.toast('固定費を追加しました');
      renderRecurring();
    });
    main.querySelectorAll('[data-rtoggle]').forEach(b => b.addEventListener('click', () => { S.toggleRecurring(b.dataset.rtoggle); renderRecurring(); }));
    main.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', () => {
      A.confirmBox('この固定費を削除しますか？（すでに記録された取引は残ります）', '削除', () => {
        S.deleteRecurring(b.dataset.rdel); renderRecurring();
      });
    }));
    main.querySelectorAll('[data-regsub]').forEach(b => b.addEventListener('click', () => {
      S.addRecurring({
        type: 'expense', day: Number(b.dataset.day), amount: Number(b.dataset.amt),
        categoryId: b.dataset.cat || null, accountId: S.state.accounts[0] && S.state.accounts[0].id,
        payee: b.dataset.label, memo: '', startYm: A.viewYm,
      });
      A.toast('固定費に登録しました');
      renderRecurring();
    }));
  }
  views.recurring = renderRecurring;

  /* ==================== データ（入出力・インポート） ==================== */
  let importPreview = null; // {txs, errors, dupCount, head, mapping, fileName}
  function renderData() {
    const batches = S.state.importBatches.slice().sort((a, b) => b.at.localeCompare(a.at));
    let html = '<div class="manage-grid">';

    // CSVインポート
    html += '<div class="panel"><h3>📂 CSVインポート</h3>'
      + '<p class="muted">銀行・クレジットカードのCSVを取り込めます。列は自動判定します。同じCSVを再読み込みしても二重登録されません。</p>'
      + '<div class="inline-form"><label class="btn">ファイルを選択<input type="file" id="csvFile" accept=".csv,.txt" class="hidden"></label>'
      + '<select id="csvAccount"><option value="">取込先口座（自動）</option>' + S.state.accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + '</option>').join('') + '</select></div>'
      + '<div id="csvMapWrap" class="hidden"><div class="muted mt">列の対応を確認してください</div><div id="csvMap" class="inline-form"></div></div>'
      + '<div id="csvPreview"></div>'
      + '</div>';

    // インポート履歴
    html += '<div class="panel"><h3>インポート履歴</h3>'
      + (batches.length
        ? batches.map(b => '<div class="sub-card"><div><div class="name">' + esc(b.fileName || '（名前なし）') + '</div>'
          + '<div class="meta">' + esc(b.at.slice(0, 16).replace('T', ' ')) + ' / ' + b.count + '件</div></div>'
          + '<button class="btn btn-sm" data-undoimport="' + b.id + '">取り消し</button></div>').join('')
        : '<div class="empty">インポート履歴はありません</div>')
      + '</div>';

    // エクスポート・バックアップ
    html += '<div class="panel"><h3>📤 エクスポート・バックアップ</h3>'
      + '<p class="muted">データはブラウザ内に保存されます。定期的にエクスポートしてバックアップしてください。JSONは完全な復元に対応しています。</p>'
      + '<div class="inline-form">'
      + '<button class="btn" id="btnExportCSV">CSVエクスポート</button>'
      + '<button class="btn" id="btnExportJSON">JSONバックアップ</button>'
      + '<label class="btn">JSONから復元<input type="file" id="fileRestore" accept=".json" class="hidden"></label>'
      + '</div>'
      + '<p class="muted mt">マネーフォワードMEのCSV（日付/内容/金額（円）/保有金融機関/大項目/中項目）もそのまま取り込めます。</p>'
      + '</div>';

    // 金融機関連携
    html += '<div class="panel"><h3>🏦 金融機関連携</h3>'
      + '<p class="muted">現在はCSVと手動入力に対応しています。公式APIが提供されている金融機関は、今後アダプタを追加して自動連携できる設計です（スクレイピングは行いません）。</p>'
      + '<div class="chip-list">' + window.Providers.list().map(p => '<span class="chip">' + esc(p.name) + '</span>').join('') + '</div>'
      + '</div>';
    html += '</div>';
    main.innerHTML = html;

    // CSV選択
    document.getElementById('csvFile').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (err) { text = new TextDecoder('shift_jis').decode(buf); }
        runCsvPreview(text, f.name);
      };
      reader.readAsArrayBuffer(f);
      e.target.value = '';
    });

    function runCsvPreview(text, fileName) {
      const rows = CSV.parseCSV(text.replace(/^﻿/, ''));
      if (rows.length < 2) { A.toast('CSVにデータがありません'); return; }
      const head = rows[0].map(h => String(h || '').trim());
      const mapping = CSV.guessMapping(head);
      const optAccount = document.getElementById('csvAccount').value || null;
      importPreview = { text, head, mapping, fileName, optAccount };

      // 列マッピングUI
      const mapWrap = document.getElementById('csvMapWrap');
      mapWrap.classList.remove('hidden');
      const fields = [['date', '日付'], ['amount', '金額'], ['type', '種別'], ['payee', '店舗/内容'], ['memo', 'メモ'], ['category', 'カテゴリ'], ['account', '口座']];
      document.getElementById('csvMap').innerHTML = fields.map(([k, label]) =>
        '<label style="flex:0 0 130px;font-size:12px">' + label
        + '<select data-map="' + k + '"><option value="">（なし）</option>'
        + head.map((h, i) => '<option value="' + i + '"' + (mapping[k] === i ? ' selected' : '') + '>' + esc(h || ('列' + (i + 1))) + '</option>').join('')
        + '</select></label>').join('');
      document.getElementById('csvMap').querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', () => {
        const k = sel.dataset.map;
        importPreview.mapping[k] = sel.value === '' ? undefined : Number(sel.value);
        showPreview();
      }));
      showPreview();
    }
    function showPreview() {
      const p = importPreview;
      const res = CSV.preview(p.text, p.mapping, { defaultAccountId: p.optAccount });
      p.txs = res.txs; p.errors = res.errors; p.dupCount = res.dupCount;
      const box = document.getElementById('csvPreview');
      let h = '<div class="mt"><strong>' + res.newCount + '件</strong> を取り込みます'
        + (res.dupCount ? '（重複 ' + res.dupCount + '件はスキップ）' : '')
        + (res.errors.length ? '<div class="badge warn">' + res.errors.length + '件エラー</div>' : '')
        + '</div>';
      if (res.txs.length) {
        h += '<table class="list mt"><thead><tr><th>日付</th><th>種別</th><th>内容</th><th class="amt">金額</th></tr></thead><tbody>'
          + res.txs.slice(0, 20).map(t => '<tr><td>' + esc(t.date) + '</td><td>' + TYPE_LABEL[t.type] + '</td><td>' + esc(t.payee || t.memo || '') + '</td><td class="amt">' + yen(t.amount) + '</td></tr>').join('')
          + '</tbody></table>'
          + (res.txs.length > 20 ? '<div class="muted">…他 ' + (res.txs.length - 20) + '件</div>' : '');
        h += '<div class="inline-form mt"><button class="btn btn-primary" id="csvCommit">この ' + res.newCount + '件を取り込む</button></div>';
      }
      if (res.errors.length) {
        h += '<details class="mt"><summary class="muted">エラーのある行（' + res.errors.length + '）</summary>'
          + res.errors.slice(0, 10).map(e => '<div class="muted">行' + e.row + ': ' + esc(e.error) + '</div>').join('') + '</details>';
      }
      box.innerHTML = h;
      const btn = document.getElementById('csvCommit');
      if (btn) btn.addEventListener('click', () => {
        const r = CSV.commit(p.txs, p.fileName);
        A.toast(r.count + '件インポートしました');
        importPreview = null;
        renderData();
      });
    }

    // インポート取り消し
    main.querySelectorAll('[data-undoimport]').forEach(b => b.addEventListener('click', () => {
      A.confirmBox('このインポートを取り消しますか？（取り込んだ取引が削除されます）', '取り消す', () => {
        const n = S.undoImport(b.dataset.undoimport);
        A.toast(n + '件を取り消しました');
        renderData();
      });
    }));

    // エクスポート
    const dl = (content, name, type) => {
      const blob = new Blob([content], { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    document.getElementById('btnExportCSV').addEventListener('click', () => {
      dl(S.exportCSV(), 'kakeibo_' + A.todayStr() + '.csv', 'text/csv;charset=utf-8');
      A.toast('CSVをエクスポートしました');
    });
    document.getElementById('btnExportJSON').addEventListener('click', () => {
      dl(S.exportJSON(), 'kakeibo_backup_' + A.todayStr() + '.json', 'application/json');
      A.toast('JSONバックアップを保存しました');
    });
    document.getElementById('fileRestore').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        A.confirmBox('現在のデータをバックアップで上書きします。よろしいですか？', '復元', () => {
          try {
            S.importJSON(reader.result);
            A.toast('復元しました');
            A.render();
          } catch (err) {
            A.toast('復元に失敗しました: ' + err.message);
          }
        });
      };
      reader.readAsText(f);
      e.target.value = '';
    });
  }
  views.data = renderData;

  /* ==================== 設定 ==================== */
  function renderSettings() {
    const expCats = S.catsOf('expense'), incCats = S.catsOf('income');
    const accs = S.state.accounts;
    const rules = S.state.rules;
    const templates = S.state.templates;
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
      + '<div class="inline-form"><input type="text" id="naName" placeholder="口座名">'
      + '<select id="naKind">' + Object.entries(S.ACCOUNT_KINDS).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('') + '</select>'
      + '<input type="number" id="naBal" placeholder="初期残高">'
      + '<button class="btn btn-sm" id="naAdd">追加</button></div>'
      + '</div>';

    // 学習ルール
    html += '<div class="panel"><h3>🧠 カテゴリ学習ルール</h3>'
      + '<p class="muted">取引のカテゴリを修正すると「この店舗は今後このカテゴリ」というルールが保存されます。</p>'
      + (rules.length
        ? rules.map(r => {
          const c = S.catById(r.categoryId);
          return '<div class="sub-card"><div><div class="name">' + esc(r.keyword) + '</div>'
            + '<div class="meta">→ ' + (c ? esc(c.icon || '') + ' ' + esc(c.name) : '（削除済み）') + '</div></div>'
            + '<button class="btn btn-sm" data-delrule="' + r.id + '">削除</button></div>';
        }).join('')
        : '<div class="empty">ルールはまだありません</div>')
      + '</div>';

    // テンプレート
    html += '<div class="panel"><h3>⚡ よく使う取引</h3>'
      + '<p class="muted">取引入力時にワンタップで呼び出せます。</p>'
      + (templates.length
        ? templates.map(t => '<div class="sub-card"><div><div class="name">' + esc(t.payee || t.memo || '（無題）') + '</div>'
          + '<div class="meta">' + TYPE_LABEL[t.type] + ' ' + yen(t.amount) + ' / ' + (t.useCount || 0) + '回使用</div></div>'
          + '<button class="btn btn-sm" data-deltpl="' + t.id + '">削除</button></div>').join('')
        : '<div class="empty">テンプレートはまだありません</div>')
      + '</div>';

    html += '<div class="panel"><h3>その他</h3><div class="inline-form">'
      + '<button class="btn" id="btnSeed">サンプルデータを入れる</button>'
      + '<button class="btn btn-danger" id="btnReset">全データを削除</button>'
      + '</div>'
      + '<p class="muted mt">保存先: ' + esc(S.storageKind === 'indexeddb' ? 'IndexedDB（大容量対応）' : 'localStorage') + '</p>'
      + '</div>';
    html += '</div>';
    main.innerHTML = html;

    main.querySelectorAll('[data-delcat]').forEach(b => b.addEventListener('click', () => {
      A.confirmBox('カテゴリを削除しますか？（既存の取引は「未分類」表示になります）', '削除', () => {
        S.deleteCategory(b.dataset.delcat); renderSettings();
      });
    }));
    main.querySelectorAll('[data-delacc]').forEach(b => b.addEventListener('click', () => {
      A.confirmBox('口座を削除しますか？（残高計算から外れます）', '削除', () => {
        S.deleteAccount(b.dataset.delacc); renderSettings();
      });
    }));
    main.querySelectorAll('[data-delrule]').forEach(b => b.addEventListener('click', () => {
      S.deleteRule(b.dataset.delrule); renderSettings();
    }));
    main.querySelectorAll('[data-deltpl]').forEach(b => b.addEventListener('click', () => {
      S.deleteTemplate(b.dataset.deltpl); renderSettings();
    }));
    document.getElementById('ncAdd').addEventListener('click', () => {
      const name = document.getElementById('ncName').value.trim();
      if (!name) { A.toast('カテゴリ名を入力してください'); return; }
      S.addCategory({ name, type: document.getElementById('ncType').value, icon: document.getElementById('ncIcon').value.trim(), color: document.getElementById('ncColor').value });
      A.toast('カテゴリを追加しました'); renderSettings();
    });
    document.getElementById('naAdd').addEventListener('click', () => {
      const name = document.getElementById('naName').value.trim();
      if (!name) { A.toast('口座名を入力してください'); return; }
      S.addAccount({ name, kind: document.getElementById('naKind').value, initialBalance: Number(document.getElementById('naBal').value) || 0 });
      A.toast('口座を追加しました'); renderSettings();
    });
    document.getElementById('btnSeed').addEventListener('click', () => {
      A.confirmBox('デモ用のサンプルデータを追加しますか？', '追加', () => {
        S.seedDemo(); A.toast('サンプルデータを追加しました'); A.render();
      });
    });
    document.getElementById('btnReset').addEventListener('click', () => {
      A.confirmBox('すべてのデータを削除します。元に戻せません。よろしいですか？', '全削除', () => {
        S.resetAll(); A.toast('全データを削除しました'); A.render();
      });
    });
  }
  views.settings = renderSettings;
})();
