/* providers.js - 金融サービス連携アダプタ層
 *
 * 方針:
 *   - 銀行/カード/証券サイトのスクレイピングは行わない（規約・安全性のため）
 *   - 公式APIが存在する場合はそのAPIを使うアダプタを差し込める構造にする
 *   - 現状は「CSVインポート」「手動入力」「APIアダプタの雛形」を実装
 *
 * アダプタの共通インターフェース:
 *   {
 *     id: 'csv' | 'manual' | 'api:<provider>',
 *     name: 'CSVインポート',
 *     kind: 'file' | 'manual' | 'api',
 *     fetch(options) -> Promise<{transactions: RawTx[], accounts?: RawAccount[]}>,
 *     normalize(raw) -> Tx
 *   }
 */
(function () {
  'use strict';
  const S = () => globalThis.Store;

  /* ---------- 共通の正規化 ---------- */
  function normalizeTx(raw, fallbackAccountId) {
    const date = raw.date;
    const amount = Math.abs(Number(raw.amount) || 0);
    if (!date || !amount) return null;
    let type = raw.type;
    if (!type) type = Number(raw.amount) < 0 ? 'expense' : 'income';
    const cat = raw.categoryName && globalThis.KakeiboCSV
      ? KakeiboCSV.findOrCreateCategory(raw.categoryName, type)
      : null;
    const acc = raw.accountName && globalThis.KakeiboCSV
      ? KakeiboCSV.findOrCreateAccount(raw.accountName)
      : null;
    return {
      date, type, amount,
      categoryId: cat ? cat.id : null,
      accountId: (acc && acc.id) || fallbackAccountId || (S().state.accounts[0] && S().state.accounts[0].id),
      payee: raw.payee || '', memo: raw.memo || '',
      tags: [], exclude: false,
    };
  }

  /* ---------- CSV アダプタ ---------- */
  const csvAdapter = {
    id: 'csv',
    name: 'CSVインポート',
    kind: 'file',
    async fetch(options) {
      const res = globalThis.KakeiboCSV.preview(options.text, options.mapping, options.options || {});
      return { transactions: res.txs, meta: { errors: res.errors, dupCount: res.dupCount } };
    },
    normalize(raw) { return raw; },
    async commit(txs, fileName) {
      return globalThis.KakeiboCSV.commit(txs, fileName);
    },
  };

  /* ---------- 手動入力アダプタ ---------- */
  const manualAdapter = {
    id: 'manual',
    name: '手動入力',
    kind: 'manual',
    async fetch() { return { transactions: [] }; },
    normalize(raw, fallbackAccountId) { return normalizeTx(raw, fallbackAccountId); },
  };

  /* ---------- API アダプタの雛形 ----------
   * 公式API（銀行のオープンAPI、Moneytree、freee 等）が利用可能になったとき、
   * この形式でアダプタを追加する。認証情報は state に保存しない設計にし、
   * ブラウザの安全な保存領域またはユーザー入力を都度使う。
   */
  function createApiAdapter(cfg) {
    return {
      id: 'api:' + cfg.id,
      name: cfg.name,
      kind: 'api',
      endpoint: cfg.endpoint,
      async fetch() {
        throw new Error('この金融機関のAPI連携は未実装です。CSVインポートをご利用ください。');
      },
      normalize(raw, fallbackAccountId) { return normalizeTx(raw, fallbackAccountId); },
    };
  }

  const registry = {
    csv: csvAdapter,
    manual: manualAdapter,
  };
  function list() { return Object.values(registry); }
  function get(id) { return registry[id] || null; }
  function register(adapter) { registry[adapter.id] = adapter; }

  const api = { list, get, register, createApiAdapter, normalizeTx };
  if (typeof window !== 'undefined') window.Providers = api;
  globalThis.Providers = api;
})();
