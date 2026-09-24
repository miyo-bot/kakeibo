/* tests/run.mjs - Node で動くユニットテスト
 * 使い方: node tests/run.mjs
 * js/*.js はブラウザ向け IIFE だが globalThis に公開するためそのまま読み込める。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = dirname(fileURLToPath(import.meta.url));
const load = f => eval(readFileSync(join(dir, '..', 'js', f), 'utf8'));
load('store.js');
load('classify.js');
load('insights.js');
load('nlq.js');
load('csv.js');
load('ocr.js');

const S = globalThis.Store;
const Classify = globalThis.Classify;
const Insights = globalThis.Insights;
const NLQ = globalThis.NLQ;
const CSV = globalThis.KakeiboCSV;
const OCR = globalThis.OCR;

function fresh() {
  S._setState(S._defaultState());
  return S.state;
}
function catId(name, type) {
  const c = S.catByName(name, type || 'expense');
  return c ? c.id : null;
}
function accId(kind) {
  const a = S.state.accounts.find(a => a.kind === kind);
  return a ? a.id : null;
}

await test('収支計算: 支出・収入・振替・除外が正しく集計される', () => {
  const st = fresh();
  const cash = accId('cash'), bank = accId('bank');
  S.addTx({ date: '2026-09-01', type: 'income', amount: 300000, categoryId: catId('給与', 'income'), accountId: bank });
  S.addTx({ date: '2026-09-02', type: 'expense', amount: 5000, categoryId: catId('食費'), accountId: cash });
  S.addTx({ date: '2026-09-03', type: 'transfer', amount: 20000, fromAccountId: bank, toAccountId: cash });
  S.addTx({ date: '2026-09-04', type: 'expense', amount: 9999, categoryId: catId('その他'), accountId: cash, exclude: true });
  const t = S.monthTotals('2026-09');
  assert.equal(t.income, 300000);
  assert.equal(t.expense, 5000);          // 除外・振替は計上されない
  assert.equal(t.diff, 295000);
});

await test('振替は収支に二重計上されず口座間で移動する', () => {
  const st = fresh();
  const cash = accId('cash'), bank = accId('bank');
  S.addTx({ date: '2026-09-01', type: 'income', amount: 100000, categoryId: catId('給与', 'income'), accountId: bank });
  S.addTx({ date: '2026-09-02', type: 'transfer', amount: 30000, fromAccountId: bank, toAccountId: cash });
  assert.equal(S.accountBalance(bank), 70000);
  assert.equal(S.accountBalance(cash), 30000);
  const t = S.monthTotals('2026-09');
  assert.equal(t.expense, 0);
  assert.equal(t.income, 100000);
});

await test('口座残高の一括計算が個別計算と一致する', () => {
  fresh();
  const cash = accId('cash'), bank = accId('bank'), credit = accId('credit');
  S.addTx({ date: '2026-09-01', type: 'income', amount: 200000, categoryId: catId('給与', 'income'), accountId: bank });
  S.addTx({ date: '2026-09-05', type: 'expense', amount: 8000, categoryId: catId('食費'), accountId: credit });
  const map = S.accountBalances();
  assert.equal(map.get(bank), 200000);
  assert.equal(map.get(cash), 0);
  assert.equal(map.get(credit), -8000);   // クレカは負債としてマイナス
  assert.equal(S.cardDebt(), 8000);
  assert.equal(S.totalAssets(), 192000);
});

await test('固定費の自動反映は冪等で、削除した月はスキップされる', () => {
  fresh();
  const bank = accId('bank');
  const r = S.addRecurring({ type: 'expense', amount: 1490, categoryId: catId('娯楽'), accountId: bank, day: 3, memo: 'Netflix', payee: 'Netflix', startYm: '2026-07' });
  S.applyRecurring('2026-08');
  S.applyRecurring('2026-08');           // 2回呼んでも1件だけ
  const aug = S.txInMonth('2026-08').filter(t => t.recurringId === r.id);
  assert.equal(aug.length, 1);
  S.deleteTx(aug[0].id);                  // 手動削除 → スキップ登録
  S.applyRecurring('2026-08');
  assert.equal(S.txInMonth('2026-08').filter(t => t.recurringId === r.id).length, 0);
});

await test('カテゴリ自動分類: 辞書・履歴・ルールの優先順位', () => {
  fresh();
  // 辞書
  assert.equal(Classify.suggest({ payee: 'ENEOS', type: 'expense' }).categoryId, catId('車'));
  assert.equal(Classify.suggest({ payee: 'セブン-イレブン', type: 'expense' }).categoryId, catId('食費'));
  assert.equal(Classify.suggest({ payee: 'Netflix', type: 'expense' }).categoryId, catId('娯楽'));
  // 履歴（辞書にない店舗）
  const med = catId('医療');
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 1000, categoryId: med, accountId: accId('cash'), payee: '○○薬局' });
  assert.equal(Classify.suggest({ payee: '○○薬局', type: 'expense' }).categoryId, med);
  // ルールは履歴より優先
  const other = catId('その他');
  S.learnRule('○○薬局', other);
  assert.equal(Classify.suggest({ payee: '○○薬局', type: 'expense' }).categoryId, other);
});

await test('CSV: パース・日付/金額判定・重複スキップ・取り消し', () => {
  fresh();
  const csv = '日付,種別,金額,カテゴリ,口座,店舗,メモ\n'
    + '2026/9/1,支出,1500,食費,現金,セブン-イレブン,昼食\n'
    + '2026-09-02,支出,"2,300",日用品,現金,Amazon,消耗品\n';
  const p1 = CSV.preview(csv, null, {});
  assert.equal(p1.newCount, 2);
  const r1 = CSV.commit(p1.txs, 'test.csv');
  assert.equal(r1.count, 2);
  assert.equal(S.state.transactions.length, 2);
  // 同じCSVを再度 → 全部重複
  const p2 = CSV.preview(csv, null, {});
  assert.equal(p2.newCount, 0);
  assert.equal(p2.dupCount, 2);
  // 取り消し
  const n = S.undoImport(r1.batchId);
  assert.equal(n, 2);
  assert.equal(S.state.transactions.length, 0);
});

await test('CSV: マイナス金額は支出、計算対象0/振替1はスキップ（MF形式）', () => {
  fresh();
  const mf = '計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,振替\n'
    + '1,2026/09/01,スーパー,-1200,○○銀行,食費,食料品,0\n'
    + '0,2026/09/02,利息,10,○○銀行,その他,,0\n'
    + '1,2026/09/03,口座振替,-50000,○○銀行,その他,,1\n';
  const p = CSV.preview(mf, null, {});
  assert.equal(p.newCount, 1);           // 計算対象0と振替1はスキップ
  assert.equal(p.txs[0].type, 'expense');
  assert.equal(p.txs[0].amount, 1200);
});

await test('一括更新とUndo', () => {
  fresh();
  const a = S.addTx({ date: '2026-09-01', type: 'expense', amount: 100, categoryId: catId('食費'), accountId: accId('cash'), payee: 'Amazon' });
  const b = S.addTx({ date: '2026-09-02', type: 'expense', amount: 200, categoryId: catId('食費'), accountId: accId('cash'), payee: 'Amazon' });
  const target = catId('日用品');
  const before = S.bulkUpdate([a.id, b.id], { categoryId: target });
  assert.equal(S.state.transactions.find(t => t.id === a.id).categoryId, target);
  S.restoreTxList(before);
  assert.equal(S.state.transactions.find(t => t.id === a.id).categoryId, catId('食費'));
});

await test('予算ステータス: 消化率・1日あたり・月末予測', () => {
  fresh();
  const food = catId('食費');
  S.setBudget(food, 30000);
  const ym = S.nowYmStr();
  S.addTx({ date: ym + '-01', type: 'expense', amount: 15000, categoryId: food, accountId: accId('cash') });
  const rows = Insights.budgetStatus(ym);
  const r = rows.find(x => x.category.id === food);
  assert.ok(r);
  assert.equal(r.spent, 15000);
  assert.equal(r.budget, 30000);
  assert.ok(r.forecast >= 15000);
  assert.ok(r.perDay >= 0);
});

await test('固定費検出: 3ヶ月連続の安定支出を検出し値上げを検知', () => {
  fresh();
  const cash = accId('cash');
  for (const [ym, amt] of [['2026-06', 980], ['2026-07', 980], ['2026-08', 1490]]) {
    S.addTx({ date: ym + '-03', type: 'expense', amount: amt, categoryId: catId('娯楽'), accountId: cash, payee: 'Netflix' });
  }
  const subs = Insights.detectSubscriptions();
  const nf = subs.find(s => s.label === 'Netflix');
  assert.ok(nf, 'Netflix が検出される');
  assert.equal(nf.months, 3);
  assert.equal(nf.priceUp, true);
});

await test('将来残高予測: 確定は定期収支を含み、予測は変動費を引く', () => {
  fresh();
  const bank = accId('bank');
  S.addTx({ date: S.nowYmStr() + '-01', type: 'income', amount: 300000, categoryId: catId('給与', 'income'), accountId: bank });
  S.addRecurring({ type: 'expense', amount: 80000, categoryId: catId('住居'), accountId: bank, day: 28, memo: '家賃', payee: '家賃', startYm: '2020-01' });
  const fc = Insights.forecastBalances([30]);
  assert.ok(fc.horizons[30].confirmedTotal <= S.totalAssets());
  assert.ok(fc.horizons[30].projectedTotal <= fc.horizons[30].confirmedTotal);
});

await test('投資損益: 評価額 - 投入額', () => {
  fresh();
  const inv = S.addAccount({ name: '証券', kind: 'invest', initialBalance: 0 });
  const bank = accId('bank');
  S.addTx({ date: '2026-09-01', type: 'transfer', amount: 100000, fromAccountId: bank, toAccountId: inv.id });
  S.setAssetSnapshot(inv.id, '2026-09-20', 112000);
  const p = S.investPerf(inv.id);
  assert.equal(p.invested, 100000);
  assert.equal(p.market, 112000);
  assert.equal(p.pnl, 12000);
});

await test('自然言語検索: 店舗・カテゴリ・固定費・トップ', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: S.nowYmStr() + '-01', type: 'expense', amount: 1200, categoryId: catId('日用品'), accountId: cash, payee: 'Amazon' });
  S.addTx({ date: S.nowYmStr() + '-02', type: 'expense', amount: 800, categoryId: catId('日用品'), accountId: cash, payee: 'Amazon' });
  const r1 = NLQ.ask('今月Amazonでいくら使った？');
  assert.match(r1.answer, /2,000|2000/);
  const r2 = NLQ.ask('今月の食費はいくら？');
  assert.match(r2.answer, /食費/);
  const r3 = NLQ.ask('一番お金を使っているカテゴリは？');
  assert.match(r3.answer, /日用品/);
});

await test('v1→v2 マイグレーションで新フィールドが補完される', () => {
  const old = {
    version: 1,
    transactions: [{ id: 'x', date: '2026-01-01', type: 'expense', amount: 100, categoryId: null, accountId: null }],
    categories: [{ id: 'c1', name: '食費', color: '#fff', icon: '', type: 'expense' }],
    accounts: [{ id: 'a1', name: '現金', kind: 'cash', initialBalance: 0 }],
    budgets: {}, recurring: [], recurringSkipped: [],
    settings: { theme: 'light' },
  };
  S._setState(old);
  const t = S.state.transactions[0];
  assert.equal(t.payee, '');
  assert.deepEqual(t.tags, []);
  assert.equal(t.exclude, false);
  assert.equal(S.state.version, 3);
});

await test('検索: 複合フィルタ（期間・金額・タグ・除外）', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: '2026-08-01', type: 'expense', amount: 500, categoryId: catId('食費'), accountId: cash, payee: 'A', tags: ['仕事'] });
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 5000, categoryId: catId('食費'), accountId: cash, payee: 'B', exclude: true });
  S.addTx({ date: '2026-09-10', type: 'expense', amount: 2000, categoryId: catId('外食'), accountId: cash, payee: 'C' });
  assert.equal(S.search({ dateFrom: '2026-09-01' }).length, 2);
  assert.equal(S.search({ minAmount: 1000 }).length, 2);
  assert.equal(S.search({ tag: '仕事' }).length, 1);
  assert.equal(S.search({ exclude: 'only' }).length, 1);
  assert.equal(S.search({ exclude: 'hide' }).length, 2);
});

await test('OCR: コンビニレシートから日付・合計・店舗・品目を抽出', () => {
  const r = OCR.parse('セブン-イレブン 東京店\n2026年9月10日\nおにぎり 120\nお茶 150\n合計 270\nお預り 500\nお釣り 230');
  assert.equal(r.date, '2026-09-10');
  assert.equal(r.amount, 270);
  assert.equal(r.payee, 'セブン-イレブン東京店');
  assert.ok(r.memo.includes('おにぎり'));
});

await test('OCR: 和暦・カンマ金額・お釣り除外', () => {
  const r = OCR.parse('ENEOS SS 新宿\n令和7年9月20日\nレギュラー 165\n合計 ¥5,032\nお預かり 10,000\nお釣り 4,968');
  assert.equal(r.date, '2025-09-20'); // 令和7年
  assert.equal(r.amount, 5032);       // お預かり・お釣りは除外
  assert.equal(r.payee, 'ENEOS SS 新宿'); // 英字間の空白は保持
});

await test('OCR: 合計キーワードなしでも最大金額を推定', () => {
  const r = OCR.parse('マルエツ 渋谷店\n牛乳 298\nパン 158\n卵 328');
  assert.equal(r.amount, 328);
  assert.equal(r.payee, 'マルエツ渋谷店'); // OCR空白は日本語間では除去
});

await test('OCR: 読み取り不能でも例外を投げずnullを返す', () => {
  const r = OCR.parse('あいうえお\nかきくけこ');
  assert.equal(r.amount, null);
  assert.equal(r.date, null);
});

await test('CSV: エポスカード形式（タイトル行+年月日日付+SJIS想定）を検出', () => {
  fresh();
  const text = '月別ご利用明細　テスト　様　株式会社エポスカード,,,,,,,\n'
    + '種別（ショッピング、キャッシング、その他）,ご利用年月日,ご利用場所,ご利用内容,ご利用金額（キャッシングでは元金になります）,支払区分,お支払開始月,備考\n'
    + 'ショッピング,2026年1月1日,ニンテンドーＥショップ,－,306,1回払い,2026年2月,\n'
    + 'ショッピング,2026年1月2日,ハロ－デイ,－,558,1回払い,2026年2月,\n'
    + 'ショッピング合計,,,,864,,,\n'
    + '※１　注釈行,,,,,,,';
  const res = CSV.preview(text);
  assert.equal(res.headerRow, 1);
  assert.equal(res.newCount, 2);
  assert.equal(res.errors.length, 0); // 合計行・注釈行はスキップ
  assert.equal(res.txs[0].date, '2026-01-01');
  assert.equal(res.txs[0].payee, 'ニンテンドーＥショップ');
  const game = S.catByName('娯楽', 'expense');
  assert.equal(res.txs[0].categoryId, game.id); // 辞書で自動分類
});

await test('マイグレーション: v2→v3で事業用カテゴリが追加され、同一バージョンでは削除が復活しない', () => {
  // v2相当のデータを用意（事業カテゴリなし）
  const v2 = S._defaultState();
  v2.version = 2;
  v2.categories = v2.categories.filter(c => !/費|事業収入/.test(c.name));
  S._setState(v2);
  assert.ok(S.catByName('消耗品費', 'expense'), '消耗品費が追加される');
  assert.ok(S.catByName('旅費交通費', 'expense'));
  assert.ok(S.catByName('事業収入', 'income'));

  // v3で削除したカテゴリは復活しない
  const st = S.state;
  st.categories = st.categories.filter(c => c.name !== '消耗品費');
  st.version = 3;
  S._setState(st);
  assert.equal(S.catByName('消耗品費', 'expense'), undefined, '同一バージョンでは復活しない');
});

console.log('\n✅ すべてのテストが完了しました');
