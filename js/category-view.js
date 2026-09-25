/* category-view.js - モバイル対応の分類整理画面 */
(function () {
  'use strict';
  const A = window.App, S = window.Store, W = window.CategoryWorkbench, C = window.Classify;
  const main = document.getElementById('main');
  const esc = A.esc, yen = A.yen;
  let mode = 'groups';
  let filters = { type: 'expense', status: '', merchant: '', categoryId: '', dateFrom: '', dateTo: '', minAmount: '', maxAmount: '', minConfidence: '' };
  let selectedIds = new Set(), expandedKeys = new Set(), detailOffsets = new Map(), page = 0, activeCategoryId = null, queueOffset = 0, queueSelectionKey = '';
  let visibleGroups = [], allVisibleGroups = [], shortcutsHandler = null;
  const PAGE_SIZE = 50;
  const modes = [['groups', 'まとめて分類'], ['queue', '未分類キュー'], ['review', '自動分類レビュー'], ['rules', '分類ルール'], ['aliases', '店舗エイリアス'], ['history', '変更履歴'], ['keys', 'キー設定']];

  function categoryButton(category, meta) {
    const fav = S.state.settings.favoriteCategoryIds.includes(category.id);
    const key = shortcutFor(category.id);
    return '<span class="cw-category-choice">'
      + '<button type="button" class="cw-cat-button' + (activeCategoryId === category.id ? ' is-active' : '') + '" data-category-choice="' + category.id + '" title="' + esc(W.categoryPath(category)) + '">'
      + '<span class="cat-dot" style="background:' + esc(category.color || '#64748b') + '"></span>' + esc(category.icon || '') + ' ' + esc(W.categoryPath(category))
      + (key ? '<kbd>' + esc(key) + '</kbd>' : '') + (meta ? '<small>' + esc(meta) + '</small>' : '') + '</button>'
      + '<button type="button" class="cw-fav' + (fav ? ' is-favorite' : '') + '" data-favorite="' + category.id + '" aria-label="' + (fav ? 'お気に入り解除' : 'お気に入り登録') + '" title="お気に入り">' + (fav ? '★' : '☆') + '</button></span>';
  }
  function categoryOptions(type, selected) {
    return S.catsOf(type).map(c => '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(W.categoryPath(c)) + '</option>').join('');
  }
  function currentType() {
    const selected = [...selectedIds].map(id => S.state.transactions.find(t => t.id === id)).find(t => t && (t.type === 'expense' || t.type === 'income'));
    if (selected) return selected.type;
    if (mode === 'queue' && visibleGroups[queueOffset]) return visibleGroups[queueOffset].type;
    return filters.type || 'expense';
  }
  function shortcutFor(id) {
    const saved = S.state.settings.categoryShortcuts || {};
    if (Object.prototype.hasOwnProperty.call(saved, id)) return saved[id] || '';
    const cat = S.catById(id);
    const defaults = { '食費': '1', '日用品': '2', '外食': '3', '車': '4' };
    return cat ? (defaults[cat.name] || '') : '';
  }
  function effectiveFilters() {
    const f = { ...filters };
    if (mode === 'queue') f.status = 'unclassified';
    if (mode === 'review') f.status = filters.status === 'review' ? 'review' : 'auto';
    return f;
  }
  function filteredGroups() {
    const f = effectiveFilters();
    let groups = W.groupTransactions(f);
    if (mode === 'review') groups = groups.filter(g => g.autoCount > 0);
    return groups;
  }
  function selectedIn(ids) { let n = 0; for (const id of ids) if (selectedIds.has(id)) n++; return n; }
  function transactionRow(tx, selectable) {
    const cat = S.catById(tx.categoryId);
    const source = tx.categorySource === 'unknown' ? '既存（分類元不明）' : ({ rule: 'ルール', history: '過去履歴', dict: '店舗辞書', ai: 'AI', manual: '手動', import: '取込' }[tx.categorySource] || '未分類');
    return '<div class="cw-tx-row">' + (selectable ? '<label class="cw-tx-check"><input type="checkbox" class="cw-tx-select" data-tx="' + tx.id + '"' + (selectedIds.has(tx.id) ? ' checked' : '') + ' aria-label="' + esc(tx.date + ' ' + (tx.payee || tx.memo || '取引')) + '"></label>' : '')
      + '<div class="cw-tx-copy"><strong>' + esc(tx.payee || '店舗名なし') + '</strong>'
      + (tx.memo ? '<span>' + esc(tx.memo) + '</span>' : '')
      + '<small>' + esc(tx.date) + ' · ' + (cat ? esc(W.categoryPath(cat)) : '未分類') + ' · ' + source
      + (tx.categoryConfidence != null ? ' · ' + Math.round(tx.categoryConfidence * 100) + '%' : '') + '</small></div>'
      + '<strong class="cw-tx-amount">' + yen(tx.amount) + '</strong></div>';
  }
  function groupCard(group, index) {
    const ids = group.transactionIds;
    const picked = selectedIn(ids);
    const categoryText = group.categorySummary.length
      ? group.categorySummary.map(x => esc(W.categoryPath(x.category)) + ' ' + x.count + '件').join(' / ')
      : '未分類';
    const historyText = group.categoryHistory && group.categoryHistory.length
      ? group.categoryHistory.map(x => esc(W.categoryPath(x.category)) + ' ' + x.count + '件').join(' / ')
      : '履歴なし';
    const candidate = group.candidates[0];
    const candidateCategory = candidate && candidate.category;
    const normalized = group.normalizedName || '(店舗名なし)';
    const names = group.originalNames.length ? group.originalNames.map(n => '<span class="cw-name-chip">' + esc(n) + '</span>').join('') : '<span class="cw-name-chip">店舗名なし</span>';
    const detailStart = detailOffsets.get(group.key) || 0;
    const detailEnd = Math.min(detailStart + 100, group.transactions.length);
    return '<article class="cw-group' + (mode === 'queue' && index === queueOffset ? ' cw-current' : '') + (index === page * PAGE_SIZE ? ' cw-active-row' : '') + '" data-group-card="' + esc(group.key) + '">'
      + '<div class="cw-group-head"><label class="cw-group-check"><input type="checkbox" class="cw-group-select" data-group="' + esc(group.key) + '"' + (picked === ids.length ? ' checked' : '') + (picked && picked !== ids.length ? ' data-partial="1"' : '') + ' aria-label="' + esc(group.merchant + ' 全' + ids.length + '件を選択') + '"></label>'
      + '<button type="button" class="cw-group-title" data-expand="' + esc(group.key) + '"><strong>' + esc(group.merchant) + '</strong><span class="cw-group-stat">' + group.count + '件 <b>' + yen(group.totalAmount) + '</b></span><small>正規化: ' + esc(normalized) + ' · 最新 ' + esc(group.latestDate || '—') + '</small><small>現在: ' + categoryText + '</small><small>過去: ' + historyText + '</small></button>'
      + '<div class="cw-group-actions"><button type="button" class="btn btn-sm" data-expand="' + esc(group.key) + '">' + (expandedKeys.has(group.key) ? '閉じる' : '取引を見る') + '</button>'
      + (mode === 'queue' ? '<span class="badge warn">未分類 ' + group.unclassifiedCount + '件</span>' : '') + '</div></div>'
      + '<div class="cw-group-meta"><span>元の表記</span>' + names + '</div>'
      + (candidateCategory ? '<div class="cw-inline-recommend"><span>推奨 ' + esc(W.categoryPath(candidateCategory)) + ' · ' + Math.round((candidate.confidence || 0) * 100) + '%</span><button class="btn btn-sm btn-primary" data-group-cat="' + esc(group.key) + '" data-cat="' + candidateCategory.id + '">' + (mode === 'queue' ? group.unclassifiedCount + '件を分類して次へ' : 'このグループへ適用') + '</button></div>' : '')
      + (expandedKeys.has(group.key) ? '<div class="cw-group-details"><div class="cw-detail-head"><span><b>正規化後:</b> ' + esc(normalized) + '</span><span><b>過去の分類:</b> ' + historyText + '</span></div>'
        + '<div class="cw-tx-list">' + group.transactions.slice(detailStart, detailEnd).map(t => transactionRow(t, true)).join('') + '</div>'
        + (group.transactions.length > detailEnd ? '<button type="button" class="btn btn-sm" data-detail-next="' + esc(group.key) + '">次の取引を表示 (' + (group.transactions.length - detailEnd) + '件残り)</button>' : '') + '</div>' : '')
      + '</article>';
  }
  function renderGroupList() {
    allVisibleGroups = filteredGroups();
    if (mode === 'queue') {
      if (queueOffset >= allVisibleGroups.length) queueOffset = Math.max(0, allVisibleGroups.length - 1);
      visibleGroups = allVisibleGroups;
      const current = visibleGroups[queueOffset];
      if (current && queueSelectionKey !== current.key) {
        queueSelectionKey = current.key;
        selectedIds = new Set(current.transactionIds);
      } else if (current && !current.transactionIds.some(id => selectedIds.has(id))) {
        selectedIds = new Set(current.transactionIds);
      }
      const list = current ? groupCard(current, queueOffset) : '<div class="panel empty"><span class="icon">🎉</span>未分類の取引はありません</div>';
      const next = current && visibleGroups.length > queueOffset + 1 ? visibleGroups[queueOffset + 1] : null;
      document.getElementById('cwResults').innerHTML = '<div class="cw-queue-progress"><b>' + Math.min(queueOffset + 1, visibleGroups.length) + ' / ' + visibleGroups.length + ' グループ</b><span>未分類取引 ' + visibleGroups.reduce((n, g) => n + g.unclassifiedCount, 0) + '件</span></div>'
        + list + (next ? '<button type="button" class="btn btn-block cw-next" id="cwQueueNext">↓ 次へ · ' + esc(next.merchant) + ' (' + next.unclassifiedCount + '件)</button>' : '');
      const btn = document.getElementById('cwQueueNext');
      if (btn) btn.addEventListener('click', () => moveQueue(1));
    } else {
      visibleGroups = allVisibleGroups;
      const start = page * PAGE_SIZE;
      const current = visibleGroups.slice(start, start + PAGE_SIZE);
      const pickedCount = [...selectedIds].length;
      document.getElementById('cwResults').innerHTML = '<div class="cw-results-meta">' + visibleGroups.length + 'グループ · ' + visibleGroups.reduce((n, g) => n + g.count, 0) + '件' + (pickedCount ? ' · ' + pickedCount + '件選択中' : '') + '</div>'
        + (current.length ? current.map((g, i) => groupCard(g, start + i)).join('') : '<div class="empty">条件に合う取引がありません</div>')
        + (visibleGroups.length > PAGE_SIZE ? '<div class="cw-pagination"><button class="btn" id="cwPrev"' + (page === 0 ? ' disabled' : '') + '>前へ</button><span>' + (page + 1) + ' / ' + Math.ceil(visibleGroups.length / PAGE_SIZE) + '</span><button class="btn" id="cwNext"' + (start + PAGE_SIZE >= visibleGroups.length ? ' disabled' : '') + '>次へ</button></div>' : '');
      const prev = document.getElementById('cwPrev'), next = document.getElementById('cwNext');
      if (prev) prev.addEventListener('click', () => { page--; renderGroupList(); });
      if (next) next.addEventListener('click', () => { page++; renderGroupList(); });
    }
    bindGroupList();
    renderCategoryPanel();
    updateSelectionBar();
  }
  function bindGroupList() {
    main.querySelectorAll('[data-expand]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.expand;
      if (expandedKeys.has(key)) expandedKeys.delete(key); else expandedKeys.add(key);
      renderGroupList();
    }));
    main.querySelectorAll('.cw-group-select').forEach(input => {
      input.indeterminate = input.dataset.partial === '1';
      input.addEventListener('change', () => {
        const group = visibleGroups.find(g => g.key === input.dataset.group);
        if (!group) return;
        for (const id of group.transactionIds) input.checked ? selectedIds.add(id) : selectedIds.delete(id);
        renderGroupList();
      });
    });
    main.querySelectorAll('.cw-tx-select').forEach(input => input.addEventListener('change', () => {
      if (input.checked) selectedIds.add(input.dataset.tx); else selectedIds.delete(input.dataset.tx);
      updateSelectionBar(); renderCategoryPanel();
    }));
    main.querySelectorAll('[data-group-cat]').forEach(button => button.addEventListener('click', () => {
      const group = visibleGroups.find(g => g.key === button.dataset.groupCat);
      if (!group) return;
      if (mode === 'queue') selectedIds = new Set(group.transactionIds);
      else selectedIds = new Set(group.transactionIds);
      renderCategoryPanel();
      applyCategory(button.dataset.cat, group.transactionIds, mode === 'queue');
    }));
    main.querySelectorAll('[data-detail-next]').forEach(button => button.addEventListener('click', () => {
      const group = visibleGroups.find(g => g.key === button.dataset.detailNext);
      if (!group) return;
      detailOffsets.set(group.key, Math.min(group.transactions.length - 1, (detailOffsets.get(group.key) || 0) + 100));
      renderGroupList();
    }));
  }
  function selectedTargetGroups(ids) {
    const idSet = new Set(ids);
    const groups = visibleGroups.filter(g => g.transactionIds.some(id => idSet.has(id)));
    return groups;
  }
  function categorySuggestions(ids) {
    const groups = selectedTargetGroups(ids).filter(g => g.type === currentType());
    const score = new Map();
    for (const group of groups) for (const candidate of group.candidates) {
      const item = score.get(candidate.categoryId) || { categoryId: candidate.categoryId, votes: 0, confidence: 0 };
      item.votes++; item.confidence += candidate.confidence || 0; score.set(candidate.categoryId, item);
    }
    return [...score.values()].sort((a, b) => b.votes - a.votes || b.confidence - a.confidence)
      .slice(0, 3).map(item => ({ ...item, category: S.catById(item.categoryId) })).filter(item => item.category);
  }
  function renderChoiceList(query) {
    const root = document.getElementById('cwAllCategories');
    if (!root) return;
    const type = currentType();
    const ids = targetIds();
    const eligibleCount = ids.filter(id => { const tx = S.state.transactions.find(t => t.id === id); return tx && tx.type === type; }).length;
    const list = S.catsOf(type);
    const q = S.normalizeMerchantName(query || '');
    const filtered = q ? list.filter(c => S.normalizeMerchantName(W.categoryPath(c)).includes(q)) : list;
    if (q) {
      root.innerHTML = filtered.length ? filtered.map(c => categoryButton(c, '')).join('') : '<p class="muted">一致するカテゴリがありません</p>';
    } else {
      const parents = list.filter(c => !c.parentId);
      root.innerHTML = parents.map(parent => {
        const children = list.filter(c => c.parentId === parent.id);
        return '<section class="cw-category-tree">' + categoryButton(parent, '')
          + (children.length ? '<details><summary>' + children.length + '個のサブカテゴリ</summary>' + children.map(c => categoryButton(c, '')).join('') + '</details>' : '')
          + '</section>';
      }).join('');
      const orphaned = list.filter(c => c.parentId && !S.catById(c.parentId));
      if (orphaned.length) root.innerHTML += orphaned.map(c => categoryButton(c, '')).join('');
    }
    root.querySelectorAll('[data-category-choice]').forEach(button => button.addEventListener('click', () => {
      activeCategoryId = button.dataset.categoryChoice;
      const ids = targetIds();
      if (ids.length) applyCategory(activeCategoryId, ids, mode === 'queue');
    }));
    root.querySelectorAll('[data-favorite]').forEach(button => button.addEventListener('click', e => {
      e.stopPropagation(); S.toggleFavoriteCategory(button.dataset.favorite); renderCategoryPanel();
    }));
  }
  function targetIds() {
    if (mode === 'queue') return [...selectedIds].filter(id => {
      const t = S.state.transactions.find(x => x.id === id); return t && !t.categoryId;
    });
    return [...selectedIds];
  }
  function renderCategoryPanel() {
    const panel = document.getElementById('cwCategoryPanel');
    if (!panel) return;
    const ids = targetIds();
    if (!ids.length) {
      panel.innerHTML = '<h3>カテゴリをすばやく選択</h3><p class="muted">グループまたは取引を選ぶと、推奨カテゴリと一括適用が表示されます。</p>';
      return;
    }
    const type = currentType();
    const eligibleCount = ids.filter(id => { const tx = S.state.transactions.find(t => t.id === id); return tx && tx.type === type; }).length;
    const suggested = categorySuggestions(ids);
    const recent = (S.state.settings.recentCategoryIds || []).map(id => S.catById(id)).filter(c => c && c.type === type).slice(0, 6);
    const favorites = (S.state.settings.favoriteCategoryIds || []).map(id => S.catById(id)).filter(c => c && c.type === type);
    const frequent = W.frequentlyUsed(type, 90).map(x => x.category);
    panel.innerHTML = '<div class="flex-between"><div><h3>カテゴリを選択</h3><p class="muted">' + eligibleCount + '件を対象 · 変更後はUndoできます</p></div>'
      + '<span class="cw-key-hint">数字キー → カテゴリ · Enter → 適用 · ↓ → 次のグループ</span></div>'
      + (suggested.length ? '<div class="cw-category-section"><b>推奨カテゴリー</b><div class="cw-category-buttons">' + suggested.map(x => categoryButton(x.category, Math.round((x.confidence / Math.max(1, x.votes)) * 100) + '%')).join('') + '</div></div>' : '')
      + (recent.length ? '<div class="cw-category-section"><b>最近使用</b><div class="cw-category-buttons">' + recent.map(c => categoryButton(c, '')).join('') + '</div></div>' : '')
      + (frequent.length ? '<div class="cw-category-section"><b>よく使う（過去90日）</b><div class="cw-category-buttons">' + frequent.map(c => categoryButton(c, '')).join('') + '</div></div>' : '')
      + (favorites.length ? '<div class="cw-category-section"><b>お気に入り</b><div class="cw-category-buttons">' + favorites.map(c => categoryButton(c, '')).join('') + '</div></div>' : '')
      + '<label class="cw-search-label">全カテゴリを検索<input type="search" id="cwCategorySearch" placeholder="カテゴリ名・サブカテゴリを検索（例: ガソ）" autocomplete="off"></label>'
      + '<div id="cwAllCategories" class="cw-all-categories"></div>'
      + '<div class="cw-apply-options"><label><input id="cwLearnRule" type="checkbox"> 今後、選択した店舗をこのカテゴリに自動分類</label>'
      + '<label><input id="cwPastStore" type="checkbox"> 過去の同じ店舗取引にも適用</label></div>';
    bindCategoryButtons(panel);
    const search = panel.querySelector('#cwCategorySearch');
    search.addEventListener('input', () => renderChoiceList(search.value));
    renderChoiceList('');
  }
  function bindCategoryButtons(root) {
    root.querySelectorAll('[data-category-choice]').forEach(button => button.addEventListener('click', () => {
      activeCategoryId = button.dataset.categoryChoice;
      const ids = targetIds();
      if (ids.length) applyCategory(activeCategoryId, ids, mode === 'queue');
    }));
    root.querySelectorAll('[data-favorite]').forEach(button => button.addEventListener('click', e => {
      e.stopPropagation(); S.toggleFavoriteCategory(button.dataset.favorite); renderCategoryPanel();
    }));
  }
  function applyCategory(categoryId, idsOverride, fastQueue) {
    const category = S.catById(categoryId);
    if (!category) return;
    const requested = idsOverride || targetIds();
    const selected = requested.filter(id => {
      const t = S.state.transactions.find(x => x.id === id);
      return t && t.type === category.type && (mode !== 'queue' || !t.categoryId);
    });
    if (!selected.length) { A.toast('このカテゴリに変更できる取引がありません'); return; }
    const targetTransactions = S.state.transactions.filter(t => selected.includes(t.id));
    const keys = [...new Set(targetTransactions.map(W.groupForTransaction))];
    const past = document.getElementById('cwPastStore') && document.getElementById('cwPastStore').checked;
    const saveRule = document.getElementById('cwLearnRule') && document.getElementById('cwLearnRule').checked;
    let finalIds = selected.slice();
    if (past) finalIds = [...new Set(finalIds.concat(W.relatedTransactionIds(keys, { type: category.type })))];
    const commit = () => {
      const before = S.bulkUpdate(finalIds, { categoryId: category.id, categorySource: 'manual', categoryConfidence: null }, {
        categoryId: category.id, merchantKeys: keys, merchantNames: [...new Set(targetTransactions.map(t => t.payee || t.memo).filter(Boolean))], action: 'classification-workbench',
      });
      const learned = [];
      if (saveRule) {
        for (const key of keys) {
          const tx = targetTransactions.find(t => W.groupForTransaction(t) === key);
          if (tx && (tx.payee || tx.memo)) {
            const name = tx.payee || tx.memo;
            const normalized = S.normalizeMerchantName(name);
            const previous = S.state.rules.find(r => r.normalizedName === normalized && r.matchMode === 'exact');
            const previousSnapshot = previous ? { ...previous } : null;
            const rule = S.learnRule(tx.payee || tx.memo, category.id, { merchantName: tx.payee || tx.memo, matchMode: 'exact', priority: 100 });
            if (rule) learned.push({ id: rule.id, previous: previousSnapshot });
          }
        }
      }
      const batchId = before.find(x => x.categoryBatchId) && before.find(x => x.categoryBatchId).categoryBatchId;
      if (batchId && learned.length) {
        const batch = S.state.categoryChanges.find(x => x.id === batchId);
        if (batch) { batch.learnedRules = learned; S.save(); }
      }
      S.recordRecentCategory(category.id);
      selectedIds.clear(); queueSelectionKey = '';
      const count = finalIds.length;
      const undo = () => {
        S.restoreTxList(before);
        if (!batchId) {
          for (const change of learned) {
            const current = S.state.rules.find(r => r.id === change.id);
            if (change.previous) { if (current) Object.assign(current, change.previous); else S.state.rules.push({ ...change.previous }); }
            else S.state.rules = S.state.rules.filter(r => r.id !== change.id);
          }
          S.save();
        }
        renderScreen();
      };
      A.toast(count + '件を「' + category.name + '」に変更しました', { actionLabel: 'Undo', duration: 6000, onAction: undo });
      if (mode === 'queue') queueOffset = 0;
      renderScreen();
    };
    if (fastQueue) {
      commit();
      return;
    }
    const pastText = past ? '（同じ店舗の過去取引を含む）' : '';
    A.confirmBox(finalIds.length + '件の取引を「' + esc(W.categoryPath(category)) + '」へ変更します' + pastText + '。', '変更', commit,
      saveRule ? '「今後も自動分類」ルールを' + keys.length + '店舗分作成します。' : '選択を確認してから一括変更します。');
  }
  function selectionTools() {
    return '<div class="cw-selection-tools"><div class="cw-tool-row"><span id="cwSelectedCount" class="muted">0件選択中</span>'
      + '<button type="button" class="btn btn-sm" id="cwSelectAll">すべて選択</button><button type="button" class="btn btn-sm" id="cwSelectVisible">表示中のみ選択</button>'
      + '<button type="button" class="btn btn-sm" id="cwSelectUnclassified">未分類のみ選択</button><button type="button" class="btn btn-sm" id="cwClearSelection">選択解除</button></div></div>';
  }
  function updateSelectionBar() {
    const count = document.getElementById('cwSelectedCount');
    if (count) count.textContent = selectedIds.size + '件選択中';
  }
  function bindSelectionTools() {
    const setIds = ids => { selectedIds = new Set(ids); renderGroupList(); };
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('cwSelectAll', () => setIds(allVisibleGroups.flatMap(g => g.transactionIds)));
    bind('cwSelectVisible', () => setIds(visibleGroups.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).flatMap(g => g.transactionIds)));
    bind('cwSelectUnclassified', () => setIds(allVisibleGroups.flatMap(g => g.transactions.filter(t => !t.categoryId).map(t => t.id))));
    bind('cwClearSelection', () => setIds([]));
  }
  function filterControls() {
    return '<div class="cw-filters"><div class="cw-filter-quick">'
      + '<button class="btn btn-sm' + (filters.status === 'unclassified' || mode === 'queue' ? ' btn-primary' : '') + '" id="cwUnclassified">未分類のみ</button>'
      + '<button class="btn btn-sm' + (filters.status === 'auto' || mode === 'review' ? ' btn-primary' : '') + '" id="cwAutoOnly">自動分類済み</button>'
      + '<button class="btn btn-sm' + (filters.status === 'manual' ? ' btn-primary' : '') + '" id="cwManualOnly">手動・既存</button>'
      + '<button class="btn btn-sm' + (filters.status === 'review' ? ' btn-primary' : '') + '" id="cwLowConfidence">要確認のみ</button>'
      + '<button class="btn btn-sm" id="cwAllStatus">すべて</button></div>'
      + '<div class="cw-filter-grid"><input type="search" id="cwMerchantFilter" placeholder="店舗・摘要" value="' + esc(filters.merchant) + '">'
      + '<select id="cwTypeFilter"><option value="">支出・収入</option><option value="expense"' + (filters.type === 'expense' ? ' selected' : '') + '>支出</option><option value="income"' + (filters.type === 'income' ? ' selected' : '') + '>収入</option></select>'
      + '<select id="cwCategoryFilter"><option value="">カテゴリすべて</option>' + S.state.categories.map(c => '<option value="' + c.id + '"' + (filters.categoryId === c.id ? ' selected' : '') + '>' + esc(W.categoryPath(c)) + '</option>').join('') + '</select>'
      + '<input type="date" id="cwDateFrom" aria-label="開始日" value="' + esc(filters.dateFrom) + '"><input type="date" id="cwDateTo" aria-label="終了日" value="' + esc(filters.dateTo) + '">'
      + '<input type="number" id="cwMinAmount" placeholder="最小金額" value="' + esc(filters.minAmount) + '"><input type="number" id="cwMaxAmount" placeholder="最大金額" value="' + esc(filters.maxAmount) + '">'
      + '<select id="cwConfidence"><option value="">推定確信度すべて</option><option value="0.8"' + (filters.minConfidence === '0.8' ? ' selected' : '') + '>80%以上</option><option value="0.9"' + (filters.minConfidence === '0.9' ? ' selected' : '') + '>90%以上</option></select></div></div>';
  }
  function bindFilters() {
    const inputs = [['cwMerchantFilter', 'merchant', 'input'], ['cwTypeFilter', 'type', 'change'], ['cwCategoryFilter', 'categoryId', 'change'], ['cwDateFrom', 'dateFrom', 'change'], ['cwDateTo', 'dateTo', 'change'], ['cwMinAmount', 'minAmount', 'input'], ['cwMaxAmount', 'maxAmount', 'input'], ['cwConfidence', 'minConfidence', 'change']];
    let timer = null;
    for (const [id, key, event] of inputs) {
      const el = document.getElementById(id); if (!el) continue;
      el.addEventListener(event, () => {
        filters[key] = el.value; page = 0; queueOffset = 0; queueSelectionKey = '';
        if (event === 'input') { clearTimeout(timer); timer = setTimeout(renderGroupList, 120); }
        else renderGroupList();
      });
    }
    const quick = (id, status) => { const b = document.getElementById(id); if (b) b.addEventListener('click', () => { filters.status = status; page = 0; queueOffset = 0; renderScreen(); }); };
    quick('cwUnclassified', 'unclassified'); quick('cwAutoOnly', 'auto'); quick('cwManualOnly', 'manual'); quick('cwLowConfidence', 'review'); quick('cwAllStatus', '');
  }
  function groupFiltersView() {
    const groupSummary = mode === 'queue' ? '<p class="muted">店舗ごとに未分類だけを集めました。カテゴリを押すと全件へ適用し、次の店舗へ進みます。</p>'
      : mode === 'review' ? reviewSummary() : '<p class="muted">表記ゆれをまとめたグループです。取引を開いて一部だけ外すこともできます。</p>';
    return '<section class="panel cw-work-area">' + groupSummary + filterControls() + (mode === 'queue' ? '' : selectionTools())
      + '<section id="cwCategoryPanel" class="cw-category-panel"></section><div id="cwResults" class="cw-results"></div></section>';
  }
  function reviewSummary() {
    const autos = S.state.transactions.filter(t => ['rule', 'history', 'dict', 'ai'].includes(t.categorySource));
    const low = autos.filter(t => (Number(t.categoryConfidence) || 0) < 0.8).length;
    return '<div class="cw-review-summary"><div><strong>自動分類済み ' + autos.length + '件</strong><span>高確信度 ' + (autos.length - low) + '件 · 要確認 ' + low + '件</span></div><p class="muted">このアプリではルール・過去履歴・店舗辞書を使って分類します。外部AIは接続していません。</p></div>';
  }
  function managementHeader() {
    return '<div class="cw-subnav">' + modes.filter(x => ['rules', 'aliases', 'history', 'keys'].includes(x[0])).map(([id, label]) => '<button class="btn btn-sm' + (mode === id ? ' btn-primary' : '') + '" data-cw-mode="' + id + '">' + label + '</button>').join('') + '</div>';
  }
  function renderRules() {
    const rules = S.state.rules.slice().sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (a.merchantName || '').localeCompare(b.merchantName || '', 'ja'));
    return managementHeader() + '<section class="panel"><h3>分類ルールを追加</h3><form id="cwRuleForm" class="cw-admin-form">'
      + '<input required name="merchantName" placeholder="店舗名・キーワード"><select name="matchMode"><option value="exact">完全一致（推奨）</option><option value="partial">部分一致</option></select>'
      + '<select name="type" id="cwRuleType"><option value="expense">支出</option><option value="income">収入</option></select><select name="categoryId" id="cwRuleCategory">' + categoryOptions('expense', '') + '</select>'
      + '<input name="priority" type="number" value="100" aria-label="優先順位"><button class="btn btn-primary">ルールを追加</button></form>'
      + '<p class="muted">優先順位と一致方式で評価します。完全一致を標準にして誤分類を防ぎます。</p></section>'
      + '<section class="panel"><h3>分類ルール ' + rules.length + '件</h3>'
      + (rules.length ? rules.map(r => {
        const cat = S.catById(r.subCategoryId || r.categoryId);
        return '<div class="cw-admin-row"><div class="cw-admin-name"><b>' + esc(r.merchantName || r.keyword) + '</b><small>正規化: ' + esc(r.normalizedName || S.normalizeMerchantName(r.keyword)) + ' · 作成 ' + esc((r.createdAt || '').slice(0, 10)) + '</small></div>'
          + '<select data-rule-mode="' + r.id + '"><option value="exact"' + (r.matchMode !== 'partial' ? ' selected' : '') + '>完全一致</option><option value="partial"' + (r.matchMode === 'partial' ? ' selected' : '') + '>部分一致</option></select>'
          + '<select data-rule-category="' + r.id + '">' + categoryOptions(cat ? cat.type : 'expense', r.subCategoryId || r.categoryId) + '</select>'
          + '<label class="cw-toggle"><input type="checkbox" data-rule-active="' + r.id + '"' + (r.active !== false ? ' checked' : '') + '>有効</label>'
          + '<label class="cw-priority">優先 <input type="number" data-rule-priority="' + r.id + '" value="' + esc(r.priority == null ? 100 : r.priority) + '"></label>'
          + '<button class="btn btn-sm" data-rule-delete="' + r.id + '">削除</button></div>';
      }).join('') : '<div class="empty">ルールはまだありません</div>') + '</section>';
  }
  function renderAliases() {
    const aliases = S.state.merchantAliases.slice().sort((a, b) => (a.canonicalName || '').localeCompare(b.canonicalName || '', 'ja'));
    const pairs = W.similarMerchantPairs(W.groupTransactions(), 8);
    return managementHeader() + '<section class="panel"><h3>店舗エイリアスを登録</h3><form id="cwAliasForm" class="cw-admin-form">'
      + '<input required name="aliasName" placeholder="別表記（例: AMAZON MARKETPLACE）"><input required name="canonicalName" placeholder="統一後の店舗名（例: Amazon）">'
      + '<select name="matchMode"><option value="exact">完全一致（推奨）</option><option value="partial">部分一致</option></select><input name="priority" type="number" value="100" aria-label="優先順位"><button class="btn btn-primary">エイリアスを登録</button></form>'
      + '<p class="muted">完全一致は同じ表記だけを統合します。部分一致は記載された文字列を含む店舗名に適用されます。</p></section>'
      + '<section class="panel"><h3>類似店舗の候補</h3><p class="muted">類似名は自動統合していません。候補を確認して承認してください。</p>'
      + (pairs.length ? pairs.map((p, i) => '<div class="cw-similar-row"><div><b>' + esc(p.left.merchant) + '</b> <span>↔</span> <b>' + esc(p.right.merchant) + '</b><small>類似度 ' + Math.round(p.score * 100) + '% · ' + p.left.count + '件 / ' + p.right.count + '件</small></div>'
        + '<input data-pair-name="' + i + '" value="' + esc(p.left.count >= p.right.count ? p.left.merchant : p.right.merchant) + '" aria-label="統一後の店舗名">'
        + '<button class="btn btn-sm btn-primary" data-approve-pair="' + i + '">同一店舗としてまとめる</button></div>').join('') : '<div class="empty">今のところ確認が必要な候補はありません</div>') + '</section>'
      + '<section class="panel"><h3>登録済みエイリアス ' + aliases.length + '件</h3>'
      + (aliases.length ? aliases.map(a => '<div class="cw-admin-row"><div class="cw-admin-name"><b>' + esc(a.aliasName) + '</b><small>正規化: ' + esc(a.normalizedName) + ' → ' + esc(a.canonicalName) + ' · ' + (a.matchMode === 'partial' ? '部分一致' : '完全一致') + ' · 優先 ' + a.priority + '</small></div>'
        + '<label class="cw-toggle"><input type="checkbox" data-alias-active="' + a.id + '"' + (a.active !== false ? ' checked' : '') + '>有効</label><button class="btn btn-sm" data-alias-delete="' + a.id + '">削除</button></div>').join('') : '<div class="empty">エイリアスはまだありません</div>') + '</section>';
  }
  function renderHistory() {
    const batches = S.state.categoryChanges.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 100);
    return managementHeader() + '<section class="panel"><h3>カテゴリ変更履歴</h3><p class="muted">直近100回を表示します。変更単位で一括Undoできます。</p>'
      + (batches.length ? batches.map(b => {
        const cat = S.catById(b.categoryId);
        const beforeNames = [...new Set(b.changes.map(c => { const x = S.catById(c.fromCategoryId); return x ? W.categoryPath(x) : '未分類'; }))];
        return '<div class="cw-history-row"><div><b>' + esc((b.at || '').replace('T', ' ').slice(0, 16)) + '</b><small>' + b.changes.length + '件 · ' + esc(beforeNames.join(' / ')) + ' → ' + esc(cat ? W.categoryPath(cat) : '変更済み') + '</small></div>'
          + (b.undone ? '<span class="badge">Undo済み</span>' : '<button class="btn btn-sm" data-undo-batch="' + b.id + '">この一括変更をUndo</button>') + '</div>';
      }).join('') : '<div class="empty">変更履歴はまだありません</div>') + '</section>';
  }
  function renderKeys() {
    const cats = S.state.categories;
    return managementHeader() + '<section class="panel"><h3>キーボードショートカット</h3><p class="muted">分類整理画面で数字キーを押すとカテゴリを選択し、Enterで適用します。↓で次のグループへ移動します。入力欄にカーソルがある間は無効です。</p>'
      + '<div class="cw-shortcut-list">' + cats.map(c => '<label><span>' + esc(W.categoryPath(c)) + '</span><input data-shortcut="' + c.id + '" maxlength="1" inputmode="numeric" value="' + esc(shortcutFor(c.id)) + '" placeholder="—" aria-label="' + esc(W.categoryPath(c)) + ' のショートカット"></label>').join('') + '</div>'
      + '<p class="muted">初期設定: 1 食費 · 2 日用品 · 3 外食 · 4 車</p></section>'
      + '<section class="panel"><h3>カテゴリ階層</h3><p class="muted">親カテゴリと子カテゴリを登録すると、選択画面では折りたたんで表示します。</p>'
      + '<form id="cwCategoryForm" class="cw-admin-form"><select name="type"><option value="expense">支出</option><option value="income">収入</option></select><input required name="name" placeholder="新しいカテゴリ名"><select name="parentId"><option value="">親カテゴリなし</option>'
      + cats.filter(c => !c.parentId).map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select><input name="icon" maxlength="4" placeholder="絵文字"><input name="color" type="color" value="#3b82f6"><button class="btn btn-primary">追加</button></form></section>';
  }
  function bindManagement() {
    main.querySelectorAll('[data-cw-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.cwMode; renderScreen(); }));
    const ruleForm = document.getElementById('cwRuleForm');
    if (ruleForm) {
      const type = ruleForm.querySelector('#cwRuleType'), category = ruleForm.querySelector('#cwRuleCategory');
      type.addEventListener('change', () => { category.innerHTML = categoryOptions(type.value, ''); });
      ruleForm.addEventListener('submit', e => {
        e.preventDefault(); const d = new FormData(ruleForm);
        S.learnRule(d.get('merchantName'), d.get('categoryId'), { merchantName: d.get('merchantName'), matchMode: d.get('matchMode'), priority: Number(d.get('priority')) || 100 });
        A.toast('分類ルールを保存しました'); renderScreen();
      });
    }
    main.querySelectorAll('[data-rule-mode]').forEach(el => el.addEventListener('change', () => { S.updateRule(el.dataset.ruleMode, { matchMode: el.value }); renderScreen(); }));
    main.querySelectorAll('[data-rule-category]').forEach(el => el.addEventListener('change', () => {
      const r = S.state.rules.find(x => x.id === el.dataset.ruleCategory);
      if (r) S.learnRule(r.merchantName || r.keyword, el.value, { merchantName: r.merchantName || r.keyword, matchMode: r.matchMode, priority: r.priority, active: r.active });
      renderScreen();
    }));
    main.querySelectorAll('[data-rule-active]').forEach(el => el.addEventListener('change', () => { S.updateRule(el.dataset.ruleActive, { active: el.checked }); A.toast(el.checked ? 'ルールを有効にしました' : 'ルールを無効にしました'); }));
    main.querySelectorAll('[data-rule-priority]').forEach(el => el.addEventListener('change', () => S.updateRule(el.dataset.rulePriority, { priority: Number(el.value) || 0 })));
    main.querySelectorAll('[data-rule-delete]').forEach(el => el.addEventListener('click', () => { S.deleteRule(el.dataset.ruleDelete); renderScreen(); }));
    const aliasForm = document.getElementById('cwAliasForm');
    if (aliasForm) aliasForm.addEventListener('submit', e => {
      e.preventDefault(); const d = new FormData(aliasForm);
      S.addMerchantAlias({ aliasName: d.get('aliasName'), canonicalName: d.get('canonicalName'), matchMode: d.get('matchMode'), priority: Number(d.get('priority')) || 100 });
      A.toast('店舗エイリアスを登録しました'); renderScreen();
    });
    main.querySelectorAll('[data-alias-active]').forEach(el => el.addEventListener('change', () => { S.updateMerchantAlias(el.dataset.aliasActive, { active: el.checked }); renderScreen(); }));
    main.querySelectorAll('[data-alias-delete]').forEach(el => el.addEventListener('click', () => { S.deleteMerchantAlias(el.dataset.aliasDelete); renderScreen(); }));
    const pairs = W.similarMerchantPairs(W.groupTransactions(), 8);
    main.querySelectorAll('[data-approve-pair]').forEach(el => el.addEventListener('click', () => {
      const pair = pairs[Number(el.dataset.approvePair)]; if (!pair) return;
      const canonical = main.querySelector('[data-pair-name="' + el.dataset.approvePair + '"]').value.trim();
      if (!canonical) { A.toast('統一後の店舗名を入力してください'); return; }
      for (const name of new Set(pair.left.originalNames.concat(pair.right.originalNames))) {
        if (S.normalizeMerchantName(name) !== S.normalizeMerchantName(canonical)) S.addMerchantAlias({ aliasName: name, canonicalName: canonical, matchMode: 'exact', priority: 200 });
      }
      // canonical spelling itself shares the same alias key.
      S.addMerchantAlias({ aliasName: canonical, canonicalName: canonical, matchMode: 'exact', priority: 200 });
      A.toast('エイリアスを承認し、今後同じ店舗としてまとめます'); renderScreen();
    }));
    main.querySelectorAll('[data-undo-batch]').forEach(el => el.addEventListener('click', () => {
      const count = S.undoCategoryBatch(el.dataset.undoBatch); A.toast(count + '件のカテゴリ変更をUndoしました'); renderScreen();
    }));
    main.querySelectorAll('[data-shortcut]').forEach(el => el.addEventListener('change', () => {
      const value = /^[1-9]$/.test(el.value) ? el.value : '';
      S.state.settings.categoryShortcuts[el.dataset.shortcut] = value; S.save();
      if (value && [...main.querySelectorAll('[data-shortcut]')].some(other => other !== el && other.value === value)) A.toast('同じキーが複数カテゴリに割り当てられています');
      else A.toast('ショートカットを保存しました');
    }));
    const categoryForm = document.getElementById('cwCategoryForm');
    if (categoryForm) categoryForm.addEventListener('submit', e => {
      e.preventDefault(); const d = new FormData(categoryForm);
      S.addCategory({ name: d.get('name').trim(), type: d.get('type'), parentId: d.get('parentId') || null, icon: d.get('icon').trim(), color: d.get('color') });
      A.toast('カテゴリを追加しました'); renderScreen();
    });
  }
  function moveQueue(delta) {
    queueOffset = Math.max(0, Math.min(visibleGroups.length - 1, queueOffset + delta));
    queueSelectionKey = ''; renderGroupList();
  }
  function bindKeyboard() {
    if (shortcutsHandler) document.removeEventListener('keydown', shortcutsHandler);
    shortcutsHandler = e => {
      if (A.view !== 'categorize' || !['groups', 'queue', 'review'].includes(mode)) return;
      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key)) {
        const found = S.state.categories.find(c => shortcutFor(c.id) === e.key && c.type === currentType());
        if (!found) return;
        if (!selectedIds.size && mode !== 'queue') {
          const active = main.querySelector('.cw-group.cw-active-row');
          const group = active && visibleGroups.find(g => g.key === active.dataset.groupCard);
          if (group) { selectedIds = new Set(group.transactionIds); renderGroupList(); }
        }
        e.preventDefault(); activeCategoryId = found.id; renderCategoryPanel(); return;
      }
      if (e.key === 'Enter' && activeCategoryId) {
        e.preventDefault(); const ids = targetIds(); if (ids.length) applyCategory(activeCategoryId, ids, mode === 'queue'); return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (mode === 'queue') moveQueue(1);
        else {
          const cards = [...main.querySelectorAll('.cw-group')];
          if (!cards.length) return;
          const current = cards.findIndex(x => x.classList.contains('cw-active-row'));
          const next = cards[Math.min(cards.length - 1, current + 1)];
          cards.forEach(x => x.classList.remove('cw-active-row'));
          if (next) { next.classList.add('cw-active-row'); next.scrollIntoView({ block: 'nearest' }); }
        }
      }
    };
    document.addEventListener('keydown', shortcutsHandler);
  }
  function renderScreen() {
    const isManagement = ['rules', 'aliases', 'history', 'keys'].includes(mode);
    const viewTabs = modes.map(([id, label]) => '<button type="button" class="cw-mode-tab' + (mode === id ? ' active' : '') + '" data-cw-mode="' + id + '">' + label + '</button>').join('');
    let body = '';
    if (isManagement) {
      body = mode === 'rules' ? renderRules() : mode === 'aliases' ? renderAliases() : mode === 'history' ? renderHistory() : renderKeys();
    } else body = groupFiltersView();
    main.innerHTML = '<div class="cw-page"><header class="cw-page-head"><div><p class="cw-eyebrow">Kakeibo · 取引のまとめ分類</p><h2>カテゴリ分類を効率化</h2><p class="muted">店舗ごとに確認し、必要な取引だけをすばやく分類します。</p></div><span class="cw-total-pill">' + S.state.transactions.length.toLocaleString() + ' 取引</span></header>'
      + '<nav class="cw-mode-tabs" aria-label="分類モード">' + viewTabs + '</nav>' + body + '</div>';
    main.querySelectorAll('[data-cw-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.cwMode; if (mode === 'queue') { filters.type = 'expense'; queueOffset = 0; queueSelectionKey = ''; } renderScreen(); }));
    if (isManagement) bindManagement();
    else { renderGroupList(); bindFilters(); bindSelectionTools(); }
    bindKeyboard();
  }

  A.views.categorize = renderScreen;
})();
