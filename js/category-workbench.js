/* category-workbench.js - 店舗単位の分類整理・候補管理 */
(function () {
  'use strict';
  const S = () => globalThis.Store;
  let cacheRevision = -1;
  let cachedGroups = [];

  function matches(tx, filters) {
    const f = filters || {};
    if (f.type && tx.type !== f.type) return false;
    if (f.status === 'unclassified' && tx.categoryId) return false;
    if ((f.status === 'auto' || f.status === 'review') && !['rule', 'history', 'dict', 'ai'].includes(tx.categorySource)) return false;
    if (f.status === 'review' && (Number(tx.categoryConfidence) || 0) >= 0.8) return false;
    if (f.status === 'manual' && !(['manual', 'import'].includes(tx.categorySource) || (tx.categorySource === 'unknown' && !!tx.categoryId))) return false;
    if (f.categoryId && tx.categoryId !== f.categoryId) return false;
    if (f.dateFrom && tx.date < f.dateFrom) return false;
    if (f.dateTo && tx.date > f.dateTo) return false;
    if (f.minAmount !== '' && f.minAmount != null && tx.amount < Number(f.minAmount)) return false;
    if (f.maxAmount !== '' && f.maxAmount != null && tx.amount > Number(f.maxAmount)) return false;
    if (f.minConfidence !== '' && f.minConfidence != null && (Number(tx.categoryConfidence) || 0) < Number(f.minConfidence)) return false;
    const q = S().normalizeMerchantName(f.merchant || '');
    if (q && !S().normalizeMerchantName((tx.payee || '') + ' ' + (tx.memo || '')).includes(q)) return false;
    return true;
  }

  function baseGroups() {
    if (cacheRevision === S().revision) return cachedGroups;
    const map = new Map();
    for (const tx of S().state.transactions) {
      if (tx.type !== 'expense' && tx.type !== 'income') continue;
      const label = String(tx.payee || tx.memo || '').trim();
      const resolution = label ? S().merchantResolution(label) : { key: 'unlabeled:' + tx.id, canonicalName: '店舗名なし' };
      const merchantKey = resolution.key || ('unlabeled:' + tx.id);
      const key = merchantKey + '|type:' + tx.type;
      if (!map.has(key)) map.set(key, {
        key, merchantKey, merchant: resolution.canonicalName || label || '店舗名なし', normalizedName: S().normalizeMerchantName(resolution.canonicalName || label),
        allTransactions: [], originalNames: new Set(), categoryCounts: new Map(), latestDate: '', type: tx.type,
      });
      const group = map.get(key);
      group.allTransactions.push(tx);
      if (label) group.originalNames.add(label);
      if (tx.date > group.latestDate) group.latestDate = tx.date;
      if (tx.categoryId) group.categoryCounts.set(tx.categoryId, (group.categoryCounts.get(tx.categoryId) || 0) + 1);
    }
    cachedGroups = [...map.values()].map(g => {
      g.allTransactions.sort((a, b) => b.date.localeCompare(a.date) || (a.payee || '').localeCompare(b.payee || ''));
      g.originalNames = [...g.originalNames].sort((a, b) => a.localeCompare(b, 'ja'));
      g.normalizedName = g.normalizedName || S().normalizeMerchantName(g.merchant);
      g.categoryHistory = [...g.categoryCounts.entries()].map(([id, count]) => ({ category: S().catById(id), count }))
        .filter(x => x.category).sort((a, b) => b.count - a.count);
      const sample = g.allTransactions.find(t => t.payee) || g.allTransactions[0];
      g.suggestion = globalThis.Classify ? globalThis.Classify.suggest(sample) : { categoryId: null, source: 'fallback', confidence: 0 };
      g.candidates = globalThis.Classify && (sample.payee || sample.memo) ? globalThis.Classify.candidates(sample, 3) : [];
      return g;
    });
    cacheRevision = S().revision;
    return cachedGroups;
  }

  function groupTransactions(filters) {
    const f = filters || {};
    const result = [];
    for (const base of baseGroups()) {
      if (f.type && base.type !== f.type) continue;
      const q = S().normalizeMerchantName(f.merchant || '');
      if (q && !S().normalizeMerchantName(base.merchant + ' ' + base.originalNames.join(' ')).includes(q)
        && !base.allTransactions.some(t => S().normalizeMerchantName(t.memo || '').includes(q))) continue;
      const txs = base.allTransactions.filter(tx => matches(tx, { ...f, merchant: '' }));
      if (!txs.length) continue;
      const countByCategory = new Map();
      let totalAmount = 0, confidenceTotal = 0, confidenceCount = 0;
      for (const tx of txs) {
        totalAmount += Number(tx.amount) || 0;
        if (tx.categoryId) countByCategory.set(tx.categoryId, (countByCategory.get(tx.categoryId) || 0) + 1);
        if (Number.isFinite(Number(tx.categoryConfidence))) { confidenceTotal += Number(tx.categoryConfidence); confidenceCount++; }
      }
      const group = {
        key: base.key, merchantKey: base.merchantKey, merchant: base.merchant, normalizedName: base.normalizedName,
        type: base.type, transactions: txs, originalNames: base.originalNames, count: txs.length,
        transactionIds: txs.map(t => t.id), totalAmount, latestDate: txs.reduce((d, t) => t.date > d ? t.date : d, ''),
        categorySummary: [...countByCategory.entries()].map(([id, count]) => ({ category: S().catById(id), count })).filter(x => x.category).sort((a, b) => b.count - a.count),
        categoryHistory: base.categoryHistory,
        unclassifiedCount: txs.filter(t => !t.categoryId).length,
        autoCount: txs.filter(t => ['rule', 'history', 'dict', 'ai'].includes(t.categorySource)).length,
        manualCount: txs.filter(t => ['manual', 'import'].includes(t.categorySource) || (t.categorySource === 'unknown' && !!t.categoryId)).length,
        confidence: confidenceCount ? confidenceTotal / confidenceCount : null,
        suggestion: base.suggestion, candidates: base.candidates,
      };
      result.push(group);
    }
    return result.sort((a, b) => b.unclassifiedCount - a.unclassifiedCount || b.count - a.count || b.latestDate.localeCompare(a.latestDate) || a.merchant.localeCompare(b.merchant, 'ja'));
  }

  function categoryPath(categoryOrId) {
    const category = typeof categoryOrId === 'string' ? S().catById(categoryOrId) : categoryOrId;
    if (!category) return '未分類';
    const parent = category.parentId ? S().catById(category.parentId) : null;
    return parent ? parent.name + ' > ' + category.name : category.name;
  }

  function frequentlyUsed(type, days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days || 90));
    const from = cutoff.toISOString().slice(0, 10);
    const count = new Map();
    for (const tx of S().state.transactions) {
      if (tx.type !== (type || 'expense') || !tx.categoryId || tx.date < from) continue;
      count.set(tx.categoryId, (count.get(tx.categoryId) || 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id, uses]) => ({ category: S().catById(id), uses }))
      .filter(x => x.category).slice(0, 8);
  }

  function groupForTransaction(tx) {
    const label = tx.payee || tx.memo || '';
    return (label ? S().merchantKey(label) : 'unlabeled:' + tx.id) + '|type:' + tx.type;
  }

  function relatedTransactionIds(keys, filters) {
    const set = new Set(keys);
    return S().state.transactions.filter(t => (t.type === 'expense' || t.type === 'income') && matches(t, filters || {}) && set.has(groupForTransaction(t))).map(t => t.id);
  }

  function similarity(a, b) {
    const x = S().normalizeMerchantName(a), y = S().normalizeMerchantName(b);
    if (!x || !y || x === y) return 0;
    const xWithoutSuffixNumber = x.replace(/[0-9]+$/, '');
    const yWithoutSuffixNumber = y.replace(/[0-9]+$/, '');
    if (xWithoutSuffixNumber.length >= 5 && xWithoutSuffixNumber === yWithoutSuffixNumber
      && /(mcdonald|macdonald)/.test(xWithoutSuffixNumber)) return 0.72;
    const latinX = /(mcdonald|macdonald)/.test(x), latinY = /(mcdonald|macdonald)/.test(y);
    const japaneseX = /マクドナルド/.test(x), japaneseY = /マクドナルド/.test(y);
    if ((latinX && japaneseY) || (latinY && japaneseX)) return 0.68;
    const grams = value => {
      const out = new Set();
      if (value.length < 3) { out.add(value); return out; }
      for (let i = 0; i < value.length - 2; i++) out.add(value.slice(i, i + 3));
      return out;
    };
    const gx = grams(x), gy = grams(y);
    let overlap = 0;
    for (const gram of gx) if (gy.has(gram)) overlap++;
    return (2 * overlap) / (gx.size + gy.size);
  }

  function similarMerchantPairs(groups, limit) {
    const list = (groups || groupTransactions()).slice(0, 300);
    const pairs = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[i].key === list[j].key || list[i].type !== list[j].type) continue;
      const score = similarity(list[i].merchant, list[j].merchant);
      if (score >= 0.38) pairs.push({ left: list[i], right: list[j], score });
    }
    return pairs.sort((a, b) => b.score - a.score || b.left.count + b.right.count - a.left.count - a.right.count).slice(0, limit || 10);
  }

  const api = { groupTransactions, categoryPath, frequentlyUsed, relatedTransactionIds, groupForTransaction, similarMerchantPairs };
  if (typeof window !== 'undefined') window.CategoryWorkbench = api;
  globalThis.CategoryWorkbench = api;
})();
