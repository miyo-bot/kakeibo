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
load('category-workbench.js');
load('insights.js');
load('nlq.js');
load('csv.js');
load('ocr.js');

const S = globalThis.Store;
const Classify = globalThis.Classify;
const CategoryWorkbench = globalThis.CategoryWorkbench;
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

await test('未分類取引はカテゴリ集計で安全に表示できる', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: '2026-09-12', type: 'expense', amount: 1234, categoryId: null, accountId: cash, payee: '未分類の店' });
  const row = S.byCategory('2026-09', 'expense').find(x => x.category.name === '未分類');
  assert.ok(row);
  assert.equal(row.total, 1234);
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
  S.addTx({ date: '2026-09-02', type: 'expense', amount: 700, categoryId: med, accountId: accId('cash'), memo: '摘要だけの店舗' });
  assert.equal(Classify.suggest({ memo: '摘要だけの店舗', type: 'expense' }).categoryId, med);
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

await test('v1→v4 マイグレーションで新フィールドが補完される', () => {
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
  assert.equal(S.state.version, 4);
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

await test('マイグレーション: v3→v4で分類データを補完し、v4内で削除したカテゴリは復活しない', () => {
  const v3 = S._defaultState();
  v3.version = 3;
  v3.merchantAliases = undefined;
  v3.categoryChanges = undefined;
  v3.settings.favoriteCategoryIds = undefined;
  S._setState(v3);
  assert.ok(Array.isArray(S.state.merchantAliases));
  assert.ok(Array.isArray(S.state.categoryChanges));
  assert.ok(Array.isArray(S.state.settings.favoriteCategoryIds));

  const st = S.state;
  st.categories = st.categories.filter(c => c.name !== '消耗品費');
  st.version = 4;
  S._setState(st);
  assert.equal(S.catByName('消耗品費', 'expense'), undefined, '同一バージョンでは復活しない');
});

await test('店舗正規化: Amazon表記ゆれと全角文字を同じグループにする', () => {
  fresh();
  const names = ['AMAZON.CO.JP', 'AMAZON CO JP', 'Amazon.co.jp', 'ＡＭＡＺＯＮ', 'AMAZON *MARKETPLACE'];
  assert.equal(new Set(names.map(S.merchantKey)).size, 1);
  assert.equal(S.merchantResolution(names[0]).canonicalName, 'Amazon');
  assert.notEqual(S.merchantKey('AMAZON WEB SERVICES'), S.merchantKey('Amazon.co.jp'));
});

await test('同一店舗を集計: 元表記・正規化名・件数・合計・最終日・過去カテゴリを保持', () => {
  fresh();
  const cash = accId('cash'), daily = catId('日用品'), baby = S.addCategory({ name: 'ベビー用品', type: 'expense', color: '#06b6d4', icon: '🍼' });
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 1200, categoryId: daily, accountId: cash, payee: 'AMAZON.CO.JP' });
  S.addTx({ date: '2026-09-03', type: 'expense', amount: 2200, categoryId: baby.id, accountId: cash, payee: 'ＡＭＡＺＯＮ' });
  S.addTx({ date: '2026-09-10', type: 'expense', amount: 300, categoryId: null, accountId: cash, payee: 'AMAZON *MARKETPLACE' });
  const group = CategoryWorkbench.groupTransactions({ type: 'expense' }).find(g => g.merchantKey === S.merchantKey('Amazon.co.jp'));
  assert.ok(group);
  assert.equal(group.count, 3);
  assert.equal(group.totalAmount, 3700);
  assert.equal(group.latestDate, '2026-09-10');
  assert.equal(group.normalizedName, 'amazon');
  assert.equal(group.originalNames.length, 3);
  assert.deepEqual(new Set(group.categorySummary.map(x => x.category.id)), new Set([daily, baby.id]));
});

await test('店舗エイリアス: 承認済み別表記を統合し、無効化すると分離する', () => {
  fresh();
  const left = S.merchantKey('MCDONALDS 12345');
  const right = S.merchantKey('マクドナルド熊本店');
  assert.notEqual(left, right); // 店舗番号・異なる言語表記は承認前にマージしない
  const cash = accId('cash');
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 800, categoryId: catId('外食'), accountId: cash, payee: 'MCDONALDS 12345' });
  S.addTx({ date: '2026-09-02', type: 'expense', amount: 900, categoryId: catId('外食'), accountId: cash, payee: 'MCDONALDS 45821' });
  S.addTx({ date: '2026-09-03', type: 'expense', amount: 700, categoryId: catId('外食'), accountId: cash, payee: 'マクドナルド熊本店' });
  const suggestions = CategoryWorkbench.similarMerchantPairs();
  assert.ok(suggestions.some(p => /MCDONALDS/.test(p.left.merchant + p.right.merchant) && /マクドナルド/.test(p.left.merchant + p.right.merchant)));
  S.addMerchantAlias({ aliasName: 'MCDONALDS 12345', canonicalName: 'マクドナルド' });
  S.addMerchantAlias({ aliasName: 'MCDONALDS 45821', canonicalName: 'マクドナルド' });
  S.addMerchantAlias({ aliasName: 'マクドナルド熊本店', canonicalName: 'マクドナルド' });
  assert.equal(S.merchantKey('MCDONALDS 12345'), S.merchantKey('マクドナルド熊本店'));
  S.addMerchantAlias({ aliasName: '旧店舗名', canonicalName: '店舗名A' });
  S.addMerchantAlias({ aliasName: '店舗名A', canonicalName: '店舗名B' });
  assert.equal(S.merchantKey('旧店舗名'), S.merchantKey('店舗名B'));
  assert.equal(S.merchantResolution('旧店舗名').canonicalName, '店舗名B');
  S.addMerchantAlias({ aliasName: 'AMZ*', canonicalName: 'Amazon', matchMode: 'partial' });
  assert.equal(S.merchantKey('AMZ*MARKETPLACE'), S.merchantKey('Amazon.co.jp'));
  const alias = S.state.merchantAliases.find(a => a.aliasName === 'AMZ*');
  S.updateMerchantAlias(alias.id, { active: false });
  assert.notEqual(S.merchantKey('AMZ*MARKETPLACE'), S.merchantKey('Amazon.co.jp'));
});

await test('候補優先順位: 明示ルール > 同一店舗履歴 > 店舗辞書、候補は最大3件', () => {
  fresh();
  const cash = accId('cash'), med = catId('医療'), food = catId('食費'), other = catId('その他');
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 500, categoryId: med, accountId: cash, payee: 'コストコ' });
  assert.equal(Classify.suggest({ payee: 'コストコ', type: 'expense' }).categoryId, med);
  S.learnRule('コストコ', food, { merchantName: 'コストコ', matchMode: 'exact', priority: 500 });
  const suggested = Classify.suggest({ payee: 'コストコ', type: 'expense' });
  assert.equal(suggested.categoryId, food);
  assert.equal(suggested.source, 'rule');
  assert.equal(suggested.confidence, 0.99);
  assert.ok(Classify.candidates({ payee: 'コストコ', type: 'expense' }).length <= 3);
  assert.equal(Classify.suggest({ payee: '無名の小さな店舗', type: 'expense' }).categoryId, null);
  assert.ok(S.catById(other));
});

await test('分類ルールは親カテゴリとサブカテゴリを分けて保存する', () => {
  fresh();
  const parentId = catId('車');
  const child = S.addCategory({ name: 'ガソリン', type: 'expense', parentId, color: '#f59e0b', icon: '⛽' });
  const rule = S.learnRule('ENEOS', child.id, { merchantName: 'ENEOS', matchMode: 'exact' });
  assert.equal(rule.categoryId, parentId);
  assert.equal(rule.subCategoryId, child.id);
  assert.equal(Classify.suggest({ payee: 'ENEOS', type: 'expense' }).categoryId, child.id);
});

await test('カテゴリ一括変更履歴とUndo: 全取引・由来・ルールを元に戻す', () => {
  fresh();
  const cash = accId('cash'), oldCat = catId('その他'), newCat = catId('日用品');
  const a = S.addTx({ date: '2026-09-01', type: 'expense', amount: 400, categoryId: oldCat, accountId: cash, payee: 'サンプル商店', categorySource: 'dict' });
  const b = S.addTx({ date: '2026-09-02', type: 'expense', amount: 600, categoryId: null, accountId: cash, payee: 'サンプル商店' });
  const before = S.bulkUpdate([a.id, b.id], { categoryId: newCat, categorySource: 'manual' }, { categoryId: newCat, action: 'test' });
  const batchId = before[0].categoryBatchId;
  assert.ok(batchId);
  assert.equal(S.state.categoryChanges.at(-1).changes.length, 2);
  S.learnRule('サンプル商店', newCat);
  const batch = S.state.categoryChanges.find(x => x.id === batchId);
  batch.learnedRules = [{ id: S.state.rules[0].id, previous: null }];
  S.save();
  S.restoreTxList(before);
  assert.equal(S.state.transactions.find(t => t.id === a.id).categoryId, oldCat);
  assert.equal(S.state.transactions.find(t => t.id === a.id).categorySource, 'dict');
  assert.equal(S.state.transactions.find(t => t.id === b.id).categoryId, null);
  assert.equal(S.state.rules.length, 0);
  assert.equal(S.state.categoryChanges.find(x => x.id === batchId).undone, true);
  assert.equal('categoryBatchId' in S.state.transactions.find(t => t.id === a.id), false);
});

await test('お気に入り・最近使用・90日頻度を永続設定から利用できる', () => {
  fresh();
  const cash = accId('cash'), food = catId('食費');
  S.toggleFavoriteCategory(food); S.recordRecentCategory(food);
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 100, categoryId: food, accountId: cash, payee: '八百屋' });
  assert.ok(S.state.settings.favoriteCategoryIds.includes(food));
  assert.equal(S.state.settings.recentCategoryIds[0], food);
  assert.equal(CategoryWorkbench.frequentlyUsed('expense', 90)[0].category.id, food);
});

await test('大量取引の店舗グループは同一データ版で集計をキャッシュする', () => {
  const st = S._defaultState();
  const cash = st.accounts[0].id, food = st.categories.find(c => c.name === '食費').id;
  st.transactions = Array.from({ length: 10000 }, (_, i) => ({
    id: 'perf-' + i, date: '2026-09-' + String((i % 28) + 1).padStart(2, '0'), type: 'expense', amount: 100 + i,
    categoryId: i % 4 ? food : null, categorySource: i % 4 ? 'manual' : 'unknown', accountId: cash,
    payee: i % 2 ? 'AMAZON.CO.JP' : 'ＡＭＡＺＯＮ', memo: '', tags: [], exclude: false,
  }));
  S._setState(st);
  const original = S.merchantResolution;
  let calls = 0;
  S.merchantResolution = name => { calls++; return original(name); };
  try {
    const first = CategoryWorkbench.groupTransactions({ type: 'expense' });
    const firstCalls = calls;
    const second = CategoryWorkbench.groupTransactions({ type: 'expense', status: 'unclassified' });
    assert.equal(first.length, 1);
    assert.equal(first[0].count, 10000);
    assert.equal(second[0].count, 2500);
    assert.equal(calls, firstCalls, '既存グループ索引を再利用する');
  } finally { S.merchantResolution = original; }
});

await test('CSVプレビューは状態を変更せず、確定時だけ新規マスタと取引を保存する', () => {
  fresh();
  const csv = '日付,種別,金額,カテゴリ,口座,店舗\n2026-09-01,支出,1200,新規分類,新規銀行,新規店\n';
  const before = S.exportJSON();
  const p = CSV.preview(csv);
  assert.equal(p.newCount, 1);
  assert.equal(S.exportJSON().replace(/"exportedAt": ".*?"/, ''), before.replace(/"exportedAt": ".*?"/, ''));
  assert.equal(S.catByName('新規分類', 'expense'), undefined);
  assert.equal(S.state.accounts.find(a => a.name === '新規銀行'), undefined);
  CSV.commit(p.txs, 'new.csv');
  assert.equal(S.state.transactions.length, 1);
  assert.equal(S.state.transactions[0].categoryId, S.catByName('新規分類', 'expense').id);
  assert.equal(S.state.transactions[0].accountId, S.state.accounts.find(a => a.name === '新規銀行').id);
});

await test('投資評価額は総資産に反映し、評価後の入金を二重計上しない', () => {
  fresh();
  const bank = accId('bank');
  S.updateAccount(bank, { initialBalance: 200000 });
  const inv = S.addAccount({ name: '証券', kind: 'invest', initialBalance: 0 });
  S.addTx({ date: '2026-09-01', type: 'transfer', amount: 100000, fromAccountId: bank, toAccountId: inv.id });
  S.setAssetSnapshot(inv.id, '2026-09-20', 120000);
  assert.equal(S.balanceByKind().invest, 120000);
  assert.equal(S.totalAssets(), 220000);
  S.addTx({ date: '2026-09-21', type: 'transfer', amount: 20000, fromAccountId: bank, toAccountId: inv.id });
  assert.equal(S.balanceByKind().invest, 140000);
  assert.equal(S.totalAssets(), 220000);
});

await test('取引が参照する口座は削除できず、総資産は変わらない', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: '2026-09-01', type: 'income', amount: 1000, accountId: cash });
  assert.throws(() => S.deleteAccount(cash), /取引/);
  assert.ok(S.accById(cash));
  assert.equal(S.totalAssets(), 1000);
});

await test('CSVの日付異常値を拒否し、エクスポートの振替を両口座付きで復元する', () => {
  fresh();
  assert.equal(CSV.normDate('2026-02-29'), null);
  assert.equal(CSV.normDate('2024-02-29'), '2024-02-29');
  const cash = accId('cash'), bank = accId('bank');
  S.addTx({ date: '2026-09-01', type: 'transfer', amount: 5000, fromAccountId: cash, toAccountId: bank });
  const csv = S.exportCSV();
  fresh();
  const p = CSV.preview(csv);
  assert.equal(p.newCount, 1);
  CSV.commit(p.txs, 'roundtrip.csv');
  assert.equal(S.state.transactions[0].type, 'transfer');
  assert.equal(S.state.transactions[0].fromAccountId, accId('cash'));
  assert.equal(S.state.transactions[0].toAccountId, accId('bank'));
  assert.equal(S.totalAssets(), 0);
});

await test('月末資産推移は取引のない月も繰り越し、評価損益を反映する', () => {
  fresh();
  const bank = accId('bank');
  S.updateAccount(bank, { initialBalance: 200000 });
  const inv = S.addAccount({ name: '証券', kind: 'invest', initialBalance: 0 });
  S.addTx({ date: '2026-07-01', type: 'transfer', amount: 100000, fromAccountId: bank, toAccountId: inv.id });
  S.setAssetSnapshot(inv.id, '2026-08-15', 115000);
  assert.equal(S.totalAssetsAt('2026-07-31'), 200000);
  assert.equal(S.totalAssetsAt('2026-08-31'), 215000);
  assert.equal(S.totalAssetsAt('2026-09-30'), 215000);
});

await test('CSV異常値は拒否し、確定前の不正な行でもマスタを変更しない', () => {
  fresh();
  assert.equal(CSV.normAmount('1.5'), null);
  assert.equal(CSV.normAmount('1,234.00'), 1234);
  assert.throws(() => CSV.parseCSV('a,b\n"broken'), /引用符/);
  const p = CSV.preview('日付,種別,金額,カテゴリ,口座,店舗\n2026-09-01,支出,100,新規分類,新規銀行,店\n');
  assert.throws(() => CSV.commit([...p.txs, { date: '2026-02-29', type: 'expense', amount: 1 }], 'bad.csv'), /正しくありません/);
  assert.equal(S.catByName('新規分類', 'expense'), undefined);
  assert.equal(S.state.transactions.length, 0);
});

await test('同じ店舗に異なる用途の履歴がある場合、CSV取込で自動分類しない', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: '2026-09-01', type: 'expense', amount: 1000, accountId: cash, categoryId: catId('食費'), payee: '多目的店' });
  S.addTx({ date: '2026-09-02', type: 'expense', amount: 2000, accountId: cash, categoryId: catId('日用品'), payee: '多目的店' });
  assert.ok(Classify.suggest({ type: 'expense', payee: '多目的店' }).confidence < 0.8);
  const p = CSV.preview('日付,種別,金額,口座,店舗\n2026-09-03,支出,3000,現金,多目的店\n');
  assert.equal(p.txs[0].categoryId, null);
});

await test('CSV→一括分類→月次集計・予算→個別修正→Undoの連携', () => {
  fresh();
  const cash = accId('cash'), food = catId('食費'), daily = catId('日用品');
  S.updateAccount(cash, { initialBalance: 10000 });
  S.setBudget(food, 3000);
  const csv = '日付,種別,金額,口座,店舗\n2026-09-10,支出,1000,現金,多目的商店\n2026-09-11,支出,2000,現金,多目的商店\n';
  const preview = CSV.preview(csv);
  assert.equal(preview.newCount, 2);
  CSV.commit(preview.txs, 'integration.csv');
  const ids = WIds();
  function WIds() { return CategoryWorkbench.groupTransactions({ type: 'expense' }).find(g => g.merchant === '多目的商店').transactionIds; }
  assert.equal(ids.length, 2);
  const before = S.bulkUpdate(ids, { categoryId: food, categorySource: 'manual' });
  assert.deepEqual(S.monthTotals('2026-09'), { expense: 3000, income: 0, diff: -3000 });
  assert.equal(Insights.budgetStatus('2026-09').find(x => x.category.id === food).spent, 3000);
  assert.equal(S.totalAssets(), 7000);
  S.updateTx(ids[0], { categoryId: daily });
  S.undoCategoryBatch(before[0].categoryBatchId);
  assert.equal(S.state.transactions.find(t => t.id === ids[0]).categoryId, daily);
  assert.equal(S.state.transactions.find(t => t.id === ids[1]).categoryId, null);
  assert.equal(S.monthTotals('2026-09').expense, 3000);
  assert.equal(S.totalAssets(), 7000);
});

await test('JSON復元は不正な金額と参照切れを拒否し、既存データを維持する', () => {
  fresh();
  const cash = accId('cash');
  S.addTx({ date: '2026-09-01', type: 'income', amount: 1234, accountId: cash });
  const original = JSON.parse(S.exportJSON());
  const corrupted = structuredClone(original);
  corrupted.data.transactions[0].amount = '1234';
  assert.throws(() => S.importJSON(JSON.stringify(corrupted)), /取引データ/);
  assert.equal(S.totalAssets(), 1234);
  const orphan = structuredClone(original);
  orphan.data.transactions[0].accountId = 'missing';
  assert.throws(() => S.importJSON(JSON.stringify(orphan)), /口座/);
  assert.equal(S.totalAssets(), 1234);
});

await test('IndexedDB書込失敗後の予備保存データを次回起動で優先する', async () => {
  const oldStorage = globalThis.localStorage, oldIdb = globalThis.indexedDB;
  const kv = new Map();
  let idbJson = JSON.stringify({ ...S._defaultState(), saveSequence: 1 });
  const newer = JSON.parse(idbJson);
  newer.saveSequence = 2;
  newer.accounts[0].initialBalance = 100;
  kv.set('kakeibo.v1', JSON.stringify(newer));
  let failWrites = false;
  globalThis.localStorage = { getItem: key => kv.get(key) || null, setItem: (key, value) => kv.set(key, value) };
  const db = { transaction() {
    const tx = { objectStore() { return {
      get() { const req = { result: idbJson }; queueMicrotask(() => req.onsuccess()); return req; },
      put(value) { queueMicrotask(() => { if (failWrites) tx.onerror(); else { idbJson = value; tx.oncomplete(); } }); },
    }; } };
    return tx;
  } };
  globalThis.indexedDB = { open() { const req = { result: db }; queueMicrotask(() => req.onsuccess()); return req; } };
  try {
    await S.init();
    assert.equal(S.totalAssets(), 100);
    assert.equal(JSON.parse(idbJson).saveSequence, 2);
    failWrites = true;
    S.updateAccount(S.state.accounts[0].id, { initialBalance: 200 });
    await S.flush();
    assert.equal(S.storageKind, 'localstorage');
    assert.equal(JSON.parse(kv.get('kakeibo.v1')).accounts[0].initialBalance, 200);
    await S.init();
    assert.equal(S.totalAssets(), 200);
  } finally {
    globalThis.localStorage = oldStorage;
    globalThis.indexedDB = oldIdb;
  }
});

await test('金額・日付・口座・種別の異常値は取引登録前に拒否する', () => {
  fresh();
  const cash = accId('cash'), bank = accId('bank');
  const base = { date: '2026-09-01', type: 'expense', amount: 100, accountId: cash };
  assert.throws(() => S.addTx({ ...base, amount: 0 }), /金額/);
  assert.throws(() => S.addTx({ ...base, amount: -100 }), /金額/);
  assert.throws(() => S.addTx({ ...base, amount: 1.5 }), /金額/);
  assert.throws(() => S.addTx({ ...base, amount: Number.MAX_SAFE_INTEGER + 1 }), /金額/);
  assert.throws(() => S.addTx({ ...base, date: '2026-02-29' }), /日付/);
  assert.throws(() => S.addTx({ ...base, accountId: 'unknown' }), /口座/);
  assert.throws(() => S.addTx({ ...base, categoryId: catId('給与', 'income') }), /カテゴリ/);
  assert.throws(() => S.addTx({ ...base, type: 'transfer', fromAccountId: bank, toAccountId: bank }), /振替/);
  assert.throws(() => S.addRecurring({ type: 'transfer', day: 1, amount: 100, accountId: bank, toAccountId: bank }), /定期取引/);
  assert.throws(() => S.setBudget(catId('食費'), 1.2), /予算/);
  assert.throws(() => S.addAccount({ name: '不正', kind: 'bank', initialBalance: 0.1 }), /初期残高/);
  assert.equal(S.state.transactions.length, 0);
});

await test('CSV確定時の口座不足エラーでもカテゴリを部分作成しない', () => {
  const st = S._defaultState();
  st.accounts = [];
  S._setState(st);
  const p = CSV.preview('日付,種別,金額,カテゴリ,店舗\n2026-09-01,支出,100,新規分類,店\n');
  assert.equal(p.newCount, 1);
  assert.throws(() => CSV.commit(p.txs, 'missing-account.csv'), /口座/);
  assert.equal(S.catByName('新規分類', 'expense'), undefined);
  assert.equal(S.state.transactions.length, 0);
});

await test('定期取引の一括削除は再生成せず、Undoで復元する', () => {
  fresh();
  const recurring = S.addRecurring({ type: 'expense', day: 5, amount: 1200, accountId: accId('cash'), categoryId: catId('食費'), startYm: '2026-09' });
  S.applyRecurring('2026-09');
  const occurrence = S.state.transactions.find(t => t.recurringId === recurring.id);
  const removed = S.deleteTxList([occurrence.id]);
  S.applyRecurring('2026-09');
  assert.equal(S.state.transactions.length, 0);
  S.addTxList(removed);
  assert.equal(S.state.transactions.length, 1);
  assert.equal(S.state.recurringSkipped.includes(recurring.id + ':2026-09'), false);
});

await test('複数タブ同期: 未編集タブは再読込、編集中タブは衝突、古い通知は無視', async () => {
  fresh();
  const base = S.state.saveSequence;
  S._setLastSavedSeq(base);

  // 未編集タブ: 新しい世代の通知で 'reload'
  assert.equal(S._onRemoteWrite(base + 1), 'reload');
  assert.equal(S.remoteConflict, null);

  // 編集中タブ（ローカル変更あり）: 'conflict'
  S.state.saveSequence = base + 1;            // ローカル変更を模擬
  S._setLastSavedSeq(base);                    // まだストレージには書いていない
  assert.equal(S._onRemoteWrite(base + 2), 'conflict');
  assert.ok(S.remoteConflict);
  assert.equal(S.remoteConflict.remoteSeq, base + 2);

  // 衝突中の追加通知は 'conflict' のまま（黙って上書きされない）
  assert.equal(S._onRemoteWrite(base + 9), 'conflict');

  // 'mine' で解決 → 衝突解除
  await S.resolveRemoteConflict('mine');
  assert.equal(S.remoteConflict, null);

  // 自分が書いた世代以降の古い通知は 'ignore'
  S._setLastSavedSeq(S.state.saveSequence);
  assert.equal(S._onRemoteWrite(S.state.saveSequence - 1), 'ignore');
});

console.log('\n✅ すべてのテストが完了しました');
