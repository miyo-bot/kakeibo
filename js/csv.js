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
    if (inQ) throw new Error('引用符が閉じられていません');
    row.push(cur);
    if (row.some(v => v !== '')) rows.push(row);
    return rows;
  }

  /* ---------- 日付・金額の自動判定 ---------- */
  function normDate(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/)
      || s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (!m) {
      m = s.match(/^(\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
      if (!m) return null;
      m[1] = String(2000 + Number(m[1]));
    }
    const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const d = new Date(y, month - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  }
  function normAmount(v) {
    // ¥1,234 / (1234) / -1234 / 1234円 等
    const s = String(v || '').trim();
    if (!s) return null;
    const neg = /^\(.*\)$|^\-|△|▲/.test(s);
    const plain = s.replace(/[¥￥円\s(),△▲+\-]/g, '');
    if (!/^[0-9]+(?:\.[0]+)?$/.test(plain.replace(/,/g, ''))) return null;
    const n = Number(plain.replace(/,/g, ''));
    if (!Number.isSafeInteger(n)) return null;
    return neg ? -n : n;
  }

  /* ---------- 列マッピングの自動推定 ---------- */
  const COL_PATTERNS = {
    date:   /日付|date|取引日|利用日|ご利用日|年月日|利用年月日|ご利用年月日/i,
    amount: /金額|amount|利用金額|支払金額|出金|入金|金額（円）/i,
    type:   /種別|type|入出金|収支/i,
    payee:  /店舗|利用店|加盟店|merchant|payee|摘要|内容|取引内容|利用先|利用場所|ご利用場所/i,
    memo:   /メモ|memo|備考|摘要|内容/i,
    category: /カテゴリ|大項目|中項目|分類/i,
    account: /口座|保有金融機関|金融機関|account|カード/i,
    fromAccount: /^(振替元|fromAccount)$/i,
    toAccount: /^(振替先|toAccount)$/i,
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

  /* ---------- ヘッダー行の自動検出 ----------
   * エポスカード等、1行目がタイトル行でヘッダーが2行目以降にあるCSVに対応。
   * 先頭から10行まで走査し、日付+金額が揃う行をヘッダーとみなす。
   */
  function findHeaderRow(rows) {
    let best = 0, bestScore = -1;
    const limit = Math.min(rows.length, 10);
    for (let i = 0; i < limit; i++) {
      const head = rows[i].map(h => String(h || '').trim());
      const map = guessMapping(head);
      let score = 0;
      if (map.date != null) score += 2;
      if (map.amount != null) score += 2;
      score += Object.keys(map).length;
      if (score > bestScore) { bestScore = score; best = i; }
      if (map.date != null && map.amount != null) break; // 十分
    }
    return best;
  }

  /* ---------- 行 → 取引 ---------- */
  // mapping: {date,amount,type,payee,memo,category,account,fromAccount,toAccount,target,transfer}
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
    const fromName = get(mapping.fromAccount);
    const toName = get(mapping.toAccount);
    if (type === 'transfer' && (!fromName || !toName || fromName === toName)) {
      return { error: '振替元・振替先の口座が必要です' };
    }

    return {
      date, type, amount: Math.abs(amount),
      payee, memo,
      _catName: catName, _accName: accName, _fromName: fromName, _toName: toName,
    };
  }

  // findOrCreate helpers
  function findOrCreateCategory(name, type) {
    name = name || '';
    if (/^[\-‐‑–—―−ｰ－─━]+$/.test(name)) name = ''; // 「－」のみは未分類扱い
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
    if (!rows.length) return { txs: [], errors: [], dupCount: 0, newCount: 0, head: [], headerRow: 0 };
    const headerRow = findHeaderRow(rows);
    const head = rows[headerRow].map(h => String(h || '').trim());
    const isMF = head.includes('大項目') && head.includes('金額（円）');
    const map = mapping || guessMapping(head);
    const seen = new Set(S().existingFingerprints());
    const txs = [], errors = [];
    let dupCount = 0;

    const body = rows.slice(headerRow + 1);
    for (let i = 0; i < body.length; i++) {
      const r = body[i];
      // 注釈・合計・空行など実質的な取引行でない行は静かにスキップ
      if (r.filter(c => String(c || '').trim()).length < 3) continue;
      const built = buildTx(r, head, map, { ...options, mfMode: isMF });
      if (built.skip) continue;
      if (built.error) { errors.push({ row: headerRow + i + 2, error: built.error }); continue; }
      // カテゴリ・口座を解決
      const type = built.type === 'transfer' ? null : built.type;
      const hasCat = built._catName && !/^[\-‐‑–—―−ｰ－─━]+$/.test(built._catName);
      const cat = (type && hasCat) ? S().catByName(built._catName, type) : null;
      const acc = built._accName ? S().state.accounts.find(a => a.name === built._accName) : null;
      const tx = {
        date: built.date, type: built.type, amount: built.amount,
        categoryId: cat ? cat.id : null,
        categorySource: cat ? 'import' : 'unknown',
        accountId: built.type === 'transfer' ? null : (acc ? acc.id : built._accName ? 'pending:' + built._accName : options.defaultAccountId || (S().state.accounts[0] && S().state.accounts[0].id)),
        payee: built.payee, memo: built.memo,
        tags: [], exclude: false,
      };
      if (hasCat && !cat) tx._catName = built._catName;
      if (built._accName && !acc) tx._accName = built._accName;
      if (built.type === 'transfer') {
        const from = S().state.accounts.find(a => a.name === built._fromName);
        const to = S().state.accounts.find(a => a.name === built._toName);
        tx.fromAccountId = from ? from.id : 'pending:' + built._fromName;
        tx.toAccountId = to ? to.id : 'pending:' + built._toName;
        tx._fromName = built._fromName;
        tx._toName = built._toName;
      }
      // 自動分類（カテゴリ未指定で店舗がある場合）
      if (!hasCat && !tx.categoryId && tx.payee && globalThis.Classify) {
        const sug = Classify.suggest(tx);
        if (sug.categoryId && sug.source !== 'fallback' && sug.confidence >= 0.8) {
          tx.categoryId = sug.categoryId;
          tx.categorySource = sug.source;
          tx.categoryConfidence = sug.confidence;
        }
      }
      const fp = S().fingerprint(tx);
      if (seen.has(fp)) { dupCount++; continue; }
      seen.add(fp);
      txs.push(tx);
    }
    return { txs, errors, dupCount, newCount: txs.length, head, headerRow, isMF };
  }

  /* ---------- 実行 ---------- */
  function commit(txs, fileName) {
    if (!Array.isArray(txs)) throw new Error('取込データが正しくありません');
    for (const source of txs) {
      if (!source || normDate(source.date) !== source.date || !Number.isSafeInteger(source.amount) || source.amount <= 0 ||
          !['income', 'expense', 'transfer'].includes(source.type) ||
          (source.type === 'transfer' && (!source._fromName || !source._toName || source._fromName === source._toName)) ||
          (source.type !== 'transfer' && !source._accName && !S().accById(source.accountId)) ||
          (source.categoryId && S().catById(source.categoryId) && S().catById(source.categoryId).type !== source.type)) {
        throw new Error('日付・金額・口座が正しくありません');
      }
    }
    const resolved = [];
    const seen = new Set(S().existingFingerprints());
    for (const source of txs) {
      const tx = { ...source, tags: (source.tags || []).slice() };
      if (tx._catName) tx.categoryId = findOrCreateCategory(tx._catName, tx.type).id;
      if (tx._accName) tx.accountId = findOrCreateAccount(tx._accName).id;
      if (tx.type === 'transfer') {
        tx.fromAccountId = findOrCreateAccount(tx._fromName).id;
        tx.toAccountId = findOrCreateAccount(tx._toName).id;
        if (!tx.fromAccountId || !tx.toAccountId || tx.fromAccountId === tx.toAccountId) throw new Error('振替元・振替先が正しくありません');
      }
      delete tx._catName; delete tx._accName; delete tx._fromName; delete tx._toName;
      const fp = S().fingerprint(tx);
      if (seen.has(fp)) continue;
      seen.add(fp);
      resolved.push(tx);
    }
    if (!resolved.length) return { count: 0, batchId: null };
    S().addTxList(resolved);
    const ids = resolved.map(t => t.id);
    const batch = S().addImportBatch({ fileName: fileName || '', count: ids.length, txIds: ids });
    return { count: ids.length, batchId: batch.id };
  }

  const api = { parseCSV, normDate, normAmount, guessMapping, findHeaderRow, buildTx, preview, commit, findOrCreateCategory, findOrCreateAccount };
  if (typeof window !== 'undefined') window.KakeiboCSV = api;
  globalThis.KakeiboCSV = api;
})();
