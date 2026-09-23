/* csv.js - CSV パース・列マッピング・インポート
 *
 * 対応:
 *   - このアプリのエクスポートCSV（日付,種別,金額,...）
 *   - マネーフォワードME形式（計算対象/日付/内容/金額（円）/保有金融機関/大項目/中項目/振替）
 *   - 汎用CSV（列マッピングを自動推定、手動で修正可）
 *
 * 重複検出: 日付+種別+金額+店舗+メモ+口座の指紋で既存取引と照合。
 * インポートはバッチ単位で記録し、後から取り消せる。
 */
(function () {
  'use strict';
  const S = () => globalThis.Store;

  /* ---------- CSVパーサ（引用符・改行対応） ---------- */
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

  /* ---------- 日付・金額の自動判定 ---------- */
  function normDate(v) {
    const s = String(v || '').trim();
    let m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = s.match(/^(\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // 短縮年
    if (m) return '20' + m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return null;
  }
  function normAmount(v) {
    // ¥1,234 / (1234) / -1234 / 1234円 等
    const s = String(v || '').trim();
    if (!s) return null;
    const neg = /^\(.*\)$|^\-|△|▲/.test(s);
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return neg ? -n : n;
  }

  /* ---------- 列マッピングの自動推定 ---------- */
  const COL_PATTERNS = {
    date:   /日付|date|取引日|利用日|ご利用日/i,
    amount: /金額|amount|利用金額|支払金額|出金|入金|金額（円）/i,
    type:   /種別|type|入出金|収支/i,
    payee:  /店舗|利用店|加盟店|merchant|payee|摘要|内容|取引内容|利用先/i,
    memo:   /メモ|memo|備考|摘要|内容/i,
    category: /カテゴリ|大項目|中項目|分類/i,
    account: /口座|保有金融機関|金融機関|account|カード/i,
    target: /計算対象/i,
    transfer: /振替/i,
  };
  function guessMapping(head) {
    const map = {};
    for (const key in COL_PATTERNS) {
      const idx = head.findIndex(h => COL_PATTERNS[key].test(String(h || '').trim()));
      if (idx >= 0) map[key] = idx;
    }
    return map;
  }

  /* ---------- 行 → 取引 ---------- */
  // mapping: {date,amount,type,payee,memo,category,account,target,transfer}
  // options: {defaultAccountId, invertAmount, mfMode}
  function buildTx(row, head, mapping, options) {
    const get = i => (i == null || i < 0) ? '' : (row[i] || '').trim();
    const date = normDate(get(mapping.date));
    if (!date) return { error: '日付を解釈できません' };

    // 計算対象=0 / 振替=1 をスキップ（MF形式）
    if (mapping.target != null && get(mapping.target) === '0') return { skip: true };
    if (mapping.transfer != null && get(mapping.transfer) === '1') return { skip: true };

    let amount = normAmount(get(mapping.amount));
    if (amount == null || amount === 0) return { error: '金額を解釈できません' };
    if (options.invertAmount) amount = -amount;

    let type = 'expense';
    const typeStr = get(mapping.type);
    if (/収入|入金|income|deposit/i.test(typeStr)) type = 'income';
    else if (/振替|transfer/i.test(typeStr)) type = 'transfer';
    else if (amount < 0) type = 'expense';
    else if (amount > 0 && /給与|売上|入金/.test(get(mapping.payee) + get(mapping.memo))) type = 'income';

    const payee = get(mapping.payee);
    const memo = get(mapping.memo);
    const catName = get(mapping.category);
    const accName = get(mapping.account);

    return {
      date, type, amount: Math.abs(amount),
      payee, memo,
      _catName: catName, _accName: accName,
    };
  }

  // findOrCreate helpers
  function findOrCreateCategory(name, type) {
    name = name || '';
    if (name) {
      const c = S().catByName(name, type);
      if (c) return c;
    }
    if (!name) {
      const c = S().catByName(type === 'income' ? 'その他収入' : 'その他', type);
      if (c) return c;
    }
    return S().addCategory({ name: name || 'その他', type, color: '#64748b', icon: type === 'income' ? '💴' : '📦' });
  }
  function findOrCreateAccount(name) {
    name = name || '';
    if (name) {
      const a = S().state.accounts.find(a => a.name === name);
      if (a) return a;
    }
    if (!name) return { id: null };
    return S().addAccount({ name, kind: 'other', initialBalance: 0 });
  }

  /* ---------- プレビュー ---------- */
  // rows を解析して {txs, errors, dupCount, newCount} を返す（まだ保存しない）
  function preview(text, mapping, options) {
    options = options || {};
    const rows = parseCSV(text.replace(/^﻿/, ''));
    if (!rows.length) return { txs: [], errors: [], dupCount: 0, newCount: 0, head: [] };
    const head = rows[0].map(h => String(h || '').trim());
    const isMF = head.includes('大項目') && head.includes('金額（円）');
    const map = mapping || guessMapping(head);
    const seen = S().existingFingerprints();
    const txs = [], errors = [];
    let dupCount = 0;

    const body = rows.slice(1);
    for (let i = 0; i < body.length; i++) {
      const r = body[i];
      const built = buildTx(r, head, map, { ...options, mfMode: isMF });
      if (built.skip) continue;
      if (built.error) { errors.push({ row: i + 2, error: built.error }); continue; }
      // カテゴリ・口座を解決
      const type = built.type === 'transfer' ? null : built.type;
      const cat = type ? findOrCreateCategory(built._catName, type) : null;
      const acc = findOrCreateAccount(built._accName);
      const tx = {
        date: built.date, type: built.type, amount: built.amount,
        categoryId: cat ? cat.id : null,
        accountId: acc.id || options.defaultAccountId || (S().state.accounts[0] && S().state.accounts[0].id),
        payee: built.payee, memo: built.memo,
        tags: [], exclude: false,
      };
      // 自動分類（カテゴリ未指定で店舗がある場合）
      if (!tx.categoryId && tx.payee && globalThis.Classify) {
        const sug = Classify.suggest(tx);
        if (sug.categoryId) tx.categoryId = sug.categoryId;
      }
      const fp = S().fingerprint(tx);
      if (seen.has(fp)) { dupCount++; continue; }
      seen.add(fp);
      txs.push(tx);
    }
    return { txs, errors, dupCount, newCount: txs.length, head, isMF };
  }

  /* ---------- 実行 ---------- */
  function commit(txs, fileName) {
    const ids = [];
    for (const tx of txs) {
      const t = S().addTx(tx);
      ids.push(t.id);
    }
    const batch = S().addImportBatch({ fileName: fileName || '', count: ids.length, txIds: ids });
    return { count: ids.length, batchId: batch.id };
  }

  const api = { parseCSV, normDate, normAmount, guessMapping, buildTx, preview, commit, findOrCreateCategory, findOrCreateAccount };
  if (typeof window !== 'undefined') window.KakeiboCSV = api;
  globalThis.KakeiboCSV = api;
})();
