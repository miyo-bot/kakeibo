/* Synthetic, in-memory benchmark. No browser storage or personal data is read. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const dir = dirname(fileURLToPath(import.meta.url));
for (const name of ['store.js', 'classify.js', 'category-workbench.js', 'csv.js']) {
  eval(readFileSync(join(dir, '..', 'js', name), 'utf8'));
}
const S = globalThis.Store;
const W = globalThis.CategoryWorkbench;
const CSV = globalThis.KakeiboCSV;
const measure = (name, fn) => {
  const start = performance.now();
  const value = fn();
  return { [name + 'Ms']: Math.round((performance.now() - start) * 10) / 10, value };
};

for (const count of [1000, 10000, 100000]) {
  const st = S._defaultState();
  const accountId = st.accounts[0].id;
  const categoryId = st.categories[0].id;
  st.transactions = Array.from({ length: count }, (_, i) => ({
    id: 'perf-' + i,
    date: '2026-' + String(1 + (i % 9)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'),
    type: 'expense', amount: 100 + (i % 1000), accountId, categoryId,
    payee: 'テスト店舗' + (i % 20), memo: '', tags: [], exclude: false,
  }));
  S._setState(st);
  const index = measure('index', () => S.accountBalances());
  const dashboard = measure('dashboard', () => ({ month: S.monthTotals('2026-09'), assets: S.totalAssets(), categories: S.byCategory('2026-09', 'expense') }));
  const search = measure('search', () => S.search({ q: 'テスト店舗1', dateFrom: '2026-01-01' }));
  const groups = measure('groups', () => W.groupTransactions({ type: 'expense' }));
  const trend = measure('trend12', () => Array.from({ length: 12 }, (_, i) => S.totalAssetsAt('2026-' + String(i + 1).padStart(2, '0') + '-31')));
  const ids = st.transactions.slice(0, 1000).map(t => t.id);
  const bulk = measure('bulk1000', () => S.bulkUpdate(ids, { exclude: true }));
  const row = {
    count,
    indexMs: index.indexMs, dashboardMs: dashboard.dashboardMs, searchMs: search.searchMs,
    groupsMs: groups.groupsMs, trend12Ms: trend.trend12Ms, bulk1000Ms: bulk.bulk1000Ms,
    searchMatches: search.value.length, groups: groups.value.length,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  S._setState(S._defaultState());
  const csv = '日付,種別,金額,口座,店舗\n' + Array.from({ length: count }, (_, i) =>
    '2026-09-' + String(1 + (i % 28)).padStart(2, '0') + ',支出,' + (100 + i) + ',現金,CSV店舗' + i + '\n').join('');
  const preview = measure('csvPreview', () => CSV.preview(csv));
  const commit = measure('csvCommit', () => CSV.commit(preview.value.txs, 'perf.csv'));
  row.csvPreviewMs = preview.csvPreviewMs;
  row.csvCommitMs = commit.csvCommitMs;
  row.csvCommitted = commit.value.count;
  row.peakRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(JSON.stringify(row));
}
