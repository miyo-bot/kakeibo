/* classify.js - カテゴリ自動分類
 *
 * 優先順位:
 *   1. ユーザー定義ルール（state.rules）
 *   2. 過去取引（同じ店舗名の直近カテゴリ）
 *   3. 店舗辞書（組み込みキーワード）
 *   4. 高信頼度のローカル推定
 *   5. AI候補（外部AIは未接続。確定には利用しない）
 *   6. 未分類候補
 *
 * 外部APIが使えなくても 1〜3, 5 で基本分類が動く。
 */
(function () {
  'use strict';
  const S = () => globalThis.Store;
  let historyRevision = -1;
  let historyByMerchant = new Map();
  let recentCategoryFrequency = new Map();

  function historyIndex() {
    const st = S().state;
    if (historyRevision === S().revision) return historyByMerchant;
    const next = new Map();
    const recent = new Map();
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const recentFrom = cutoff.toISOString().slice(0, 10);
    for (const t of st.transactions) {
      if (t.type !== 'expense' && t.type !== 'income') continue;
      if (t.categoryId && t.date >= recentFrom) {
        const freqKey = t.type + '|' + t.categoryId;
        recent.set(freqKey, (recent.get(freqKey) || 0) + 1);
      }
      const merchantName = t.payee || t.memo || '';
      if (!t.categoryId || !merchantName) continue;
      const key = t.type + '|' + S().merchantKey(merchantName);
      if (!next.has(key)) next.set(key, new Map());
      const byCategory = next.get(key);
      const item = byCategory.get(t.categoryId) || { count: 0, latest: '' };
      item.count++;
      if (t.date > item.latest) item.latest = t.date;
      byCategory.set(t.categoryId, item);
    }
    historyByMerchant = next;
    recentCategoryFrequency = recent;
    historyRevision = S().revision;
    return historyByMerchant;
  }

  function dictMatches(text, type) {
    const found = new Map();
    for (const [kw, name] of DICT_NORM) {
      if (!kw || !text.includes(kw)) continue;
      const cat = S().catByName(name, type) || S().catByName(name);
      if (cat && cat.type === type && !found.has(cat.id)) {
        const confidence = Math.min(0.9, 0.62 + Math.min(kw.length, 6) * 0.045);
        found.set(cat.id, { categoryId: cat.id, source: 'dict', label: '店舗辞書', confidence, matchedKeyword: kw });
      }
    }
    return [...found.values()].sort((a, b) => b.confidence - a.confidence);
  }

  // 店舗辞書: キーワード(正規化後) → カテゴリ名
  // カテゴリ名は既定カテゴリに合わせる。存在しない場合は「その他」にフォールバック。
  const DICT = [
    // 食費（スーパー・コンビニ）
    ['セブンイレブン', '食費'], ['セブン', '食費'], ['ファミリーマート', '食費'], ['ファミマ', '食費'],
    ['ローソン', '食費'], ['ミニストップ', '食費'], ['デイリー', '食費'],
    ['イオン', '食費'], ['ライフ', '食費'], ['イトーヨーカドー', '食費'], ['ヨーカドー', '食費'],
    ['マルエツ', '食費'], ['ダイエー', '食費'], ['オーケー', '食費'], ['業務スーパー', '食費'],
    ['コストコ', '食費'], ['成城石井', '食費'], ['まいばすけっと', '食費'], ['サミット', '食費'],
    ['西友', '食費'], ['ベルク', '食費'], ['ヤオコー', '食費'], ['ピアゴ', '食費'],
    ['スーパー', '食費'], ['マルシェ', '食費'],
    // 外食
    ['マクドナルド', '外食'], ['モスバーガー', '外食'], ['ケンタッキー', '外食'],
    ['すき家', '外食'], ['吉野家', '外食'], ['松屋', '外食'], ['なか卯', '外食'],
    ['サイゼリヤ', '外食'], ['ガスト', '外食'], ['ジョナサン', '外食'], ['デニーズ', '外食'],
    ['バーミヤン', '外食'], ['ロイヤルホスト', '外食'], ['ココス', '外食'],
    ['スターバックス', '外食'], ['スタバ', '外食'], ['ドトール', '外食'], ['タリーズ', '外食'],
    ['コメダ', '外食'], ['ミスド', '外食'], ['ミスタードーナツ', '外食'],
    ['くら寿司', '外食'], ['スシロー', '外食'], ['はま寿司', '外食'], ['かっぱ寿司', '外食'],
    ['丸亀製麺', '外食'], ['はなまる', '外食'], ['一蘭', '外食'], ['日高屋', '外食'],
    ['餃子の王将', '外食'], ['王将', '外食'], ['大戸屋', '外食'], ['やよい軒', '外食'],
    ['びっくりドンキー', '外食'], ['サーティワン', '外食'], ['ミニストップ', '食費'],
    ['ドミノピザ', '外食'], ['ピザハット', '外食'], ['ピザーラ', '外食'],
    ['トンカツ', '外食'], ['ラーメン', '外食'], ['焼肉', '外食'], ['居酒屋', '外食'],
    ['カフェ', '外食'], ['レストラン', '外食'], ['ダイニング', '外食'],
    ['ウーバーイーツ', '外食'], ['ubereats', '外食'], ['出前館', '外食'], ['wolt', '外食'],
    // 日用品
    ['amazon', '日用品'], ['アマゾン', '日用品'], ['楽天市場', '日用品'], ['楽天', '日用品'],
    ['ヨドバシ', '日用品'], ['ビックカメラ', '日用品'], ['ヤマダ電機', '日用品'],
    ['ダイソー', '日用品'], ['セリア', '日用品'], ['キャンドゥ', '日用品'],
    ['ドンキホーテ', '日用品'], ['ドンキ', '日用品'], ['ホームセンター', '日用品'],
    ['カインズ', '日用品'], ['コーナン', '日用品'], ['ニトリ', '日用品'],
    ['イトーヨーカドー', '食費'],
    ['ウエルシア', '日用品'], ['マツモトキヨシ', '日用品'], ['マツキヨ', '日用品'],
    ['サンドラッグ', '日用品'], ['スギ薬局', '日用品'], ['ドラッグ', '日用品'], ['薬局', '日用品'],
    ['無印良品', '日用品'], ['無印', '日用品'],
    // 住居
    ['家賃', '住居'], ['管理会社', '住居'], ['管理費', '住居'], ['修繕積立', '住居'],
    ['住宅ローン', '住居'], ['賃貸', '住居'], ['レオパレス', '住居'], ['積水ハウス', '住居'],
    // 光熱・水道
    ['東京電力', '光熱・水道'], ['関西電力', '光熱・水道'], ['中部電力', '光熱・水道'],
    ['九州電力', '光熱・水道'], ['北海道電力', '光熱・水道'], ['東北電力', '光熱・水道'],
    ['四国電力', '光熱・水道'], ['中国電力', '光熱・水道'], ['北陸電力', '光熱・水道'], ['沖縄電力', '光熱・水道'],
    ['東京ガス', '光熱・水道'], ['大阪ガス', '光熱・水道'], ['東邦ガス', '光熱・水道'],
    ['水道局', '光熱・水道'], ['水道料金', '光熱・水道'], ['電力', '光熱・水道'], ['ガス', '光熱・水道'],
    ['でんき', '光熱・水道'], ['水道', '光熱・水道'], ['エネオス電気', '光熱・水道'],
    ['looop', '光熱・水道'], ['楽天でんき', '光熱・水道'], ['cdエナジー', '光熱・水道'],
    // 通信
    ['ドコモ', '通信'], ['nttドコモ', '通信'], ['au', '通信'], ['ソフトバンク', '通信'],
    ['softbank', '通信'], ['楽天モバイル', '通信'], ['uqモバイル', '通信'], ['uq', '通信'],
    ['ワイモバイル', '通信'], ['ymobile', '通信'], ['povo', '通信'], ['linemo', '通信'],
    ['ahamo', '通信'], ['mineo', '通信'], ['iijmio', '通信'], ['ビッグローブ', '通信'],
    ['nuro', '通信'], ['ocn', '通信'], ['biglobe', '通信'], ['so-net', '通信'],
    ['icloud', '通信'], ['googleone', '通信'], ['google one', '通信'],
    ['携帯', '通信'], ['インターネット', '通信'], ['プロバイダ', '通信'],
    // 交通
    ['jr東日本', '交通'], ['jr', '交通'], ['suica', '交通'], ['pasmo', '交通'],
    ['icoca', '交通'], ['nimoca', '交通'], ['kitaca', '交通'], ['manaca', '交通'],
    ['モバイルsuica', '交通'], ['チャージ', '交通'],
    ['東京メトロ', '交通'], ['メトロ', '交通'], ['都営', '交通'],
    ['東急', '交通'], ['小田急', '交通'], ['京急', '交通'], ['京王', '交通'],
    ['西武', '交通'], ['東武', '交通'], ['阪急', '交通'], ['阪神', '交通'], ['近鉄', '交通'],
    ['名鉄', '交通'], ['西鉄', '交通'],
    ['バス', '交通'], ['タクシー', '交通'], ['航空', '交通'], ['ana', '交通'], ['jal', '交通'],
    ['peach', '交通'], ['jetstar', '交通'], ['skymark', '交通'], ['spring', '交通'],
    ['高速', '交通'], ['etc', '交通'], ['nexco', '交通'],
    // 車
    ['eneos', '車'], ['エネオス', '車'], ['出光', '車'], ['apollostation', '車'],
    ['コスモ', '車'], ['ガソリン', '車'], ['給油', '車'], ['駐車場', '車'],
    ['タイムズ', '車'], ['三井のリパーク', '車'], ['リパーク', '車'],
    ['車検', '車'], ['オートバックス', '車'], ['イエローハット', '車'],
    // 医療
    ['病院', '医療'], ['クリニック', '医療'], ['医院', '医療'], ['歯科', '医療'], ['歯医者', '医療'],
    ['調剤', '医療'], ['処方', '医療'], ['眼科', '医療'], ['皮膚科', '医療'], ['内科', '医療'],
    // 娯楽
    ['netflix', '娯楽'], ['ネットフリックス', '娯楽'],
    ['amazonプライム', '娯楽'], ['prime video', '娯楽'], ['プライムビデオ', '娯楽'],
    ['spotify', '娯楽'], ['スポティファイ', '娯楽'],
    ['youtube', '娯楽'], ['youtubeプレミアム', '娯楽'],
    ['hulu', '娯楽'], ['フールー', '娯楽'], ['u-next', '娯楽'], ['unext', '娯楽'],
    ['dアニメ', '娯楽'], ['danime', '娯楽'], ['abema', '娯楽'], ['dazn', '娯楽'],
    ['disney', '娯楽'], ['ディズニー', '娯楽'],
    ['nintendo', '娯楽'], ['ニンテンドー', '娯楽'], ['playstation', '娯楽'], ['psn', '娯楽'],
    ['steam', '娯楽'], ['epic games', '娯楽'], ['xbox', '娯楽'],
    ['kindle', '娯楽'], ['キンドル', '娯楽'],
    ['映画', '娯楽'], ['tohoシネマズ', '娯楽'], ['イオンシネマ', '娯楽'], ['シネマ', '娯楽'],
    ['カラオケ', '娯楽'], ['ボウリング', '娯楽'], ['ゲーム', '娯楽'],
    ['ジム', '娯楽'], ['フィットネス', '娯楽'], ['ゴールドジム', '娯楽'], ['エニタイム', '娯楽'],
    ['チケット', '娯楽'], ['ライブ', '娯楽'], ['コンサート', '娯楽'],
    ['apple music', '娯楽'], ['applemusic', '娯楽'], ['apple.com/bill', '娯楽'],
    ['audible', '娯楽'], ['オーディブル', '娯楽'],
    // 衣服・美容
    ['ユニクロ', '衣服・美容'], ['uniqlo', '衣服・美容'], ['gu', '衣服・美容'],
    ['しまむら', '衣服・美容'], ['zara', '衣服・美容'], ['hm', '衣服・美容'],
    ['美容院', '衣服・美容'], ['美容室', '衣服・美容'], ['床屋', '衣服・美容'], ['理容', '衣服・美容'],
    ['化粧品', '衣服・美容'], ['コスメ', '衣服・美容'],
    // 教育
    ['書店', '教育'], ['紀伊國屋', '教育'], ['ジュンク堂', '教育'], ['丸善', '教育'],
    ['本', '教育'], ['書籍', '教育'], ['塾', '教育'], ['スクール', '教育'],
    ['udemy', '教育'], ['ユーデミー', '教育'], ['coursera', '教育'],
    // 交際
    ['プレゼント', '交際'], ['ギフト', '交際'], ['贈答', '交際'], ['ご祝儀', '交際'], ['香典', '交際'],
    // 事業（経費）
    ['アスクル', '消耗品費'], ['askul', '消耗品費'], ['ヨドバシ', '消耗品費'], ['yodobashi', '消耗品費'],
    ['ビックカメラ', '消耗品費'], ['biccamera', '消耗品費'], ['bic camera', '消耗品費'],
    ['コクヨ', '消耗品費'], ['kokuyo', '消耗品費'], ['文具', '消耗品費'], ['文房具', '消耗品費'],
    ['モノタロウ', '消耗品費'], ['monotaro', '消耗品費'], ['ホームセンター', '消耗品費'], ['カインズ', '消耗品費'],
    ['コワーキング', '地代家賃'], ['レンタルオフィス', '地代家賃'], ['シェアオフィス', '地代家賃'],
    ['wework', '地代家賃'], ['レゾナンス', '地代家賃'],
    ['出張', '旅費交通費'], ['宿泊', '旅費交通費'], ['ホテル', '旅費交通費'], ['新幹線', '旅費交通費'],
    ['楽天トラベル', '旅費交通費'], ['じゃらん', '旅費交通費'], ['ana', '旅費交通費'], ['jal', '旅費交通費'],
    ['google ads', '広告宣伝費'], ['google広告', '広告宣伝費'], ['meta広告', '広告宣伝費'],
    ['ヤフー広告', '広告宣伝費'], ['yahoo ads', '広告宣伝費'], ['チラシ', '広告宣伝費'], ['印刷', '広告宣伝費'],
    ['ランサーズ', '外注費'], ['lancers', '外注費'], ['クラウドワークス', '外注費'], ['crowdworks', '外注費'],
    ['ココナラ', '外注費'], ['coconala', '外注費'], ['外注', '外注費'],
    ['aws', '雑費（事業）'], ['amazon web services', '雑費（事業）'], ['google cloud', '雑費（事業）'],
    ['github', '雑費（事業）'], ['ドメイン', '雑費（事業）'], ['お名前.com', '雑費（事業）'], ['サーバー', '雑費（事業）'],
    ['slack', '雑費（事業）'], ['zoom', '雑費（事業）'], ['notion', '雑費（事業）'], ['adobe', '雑費（事業）'],
    // 収入
    ['給与', '給与'], ['給料', '給与'], ['賞与', '賞与'], ['ボーナス', '賞与'],
    ['売上', '事業収入'], ['報酬', '事業収入'], ['請求', '事業収入'],
    ['配当', '投資'], ['利息', '投資'], ['分配金', '投資'],
  ];
  // 長いキーワードを先に評価（「ファミリーマート」が「ファミマ」より先にマッチするよう正規化してソート）
  const DICT_NORM = DICT
    .map(([kw, cat]) => [normKw(kw), cat])
    .sort((a, b) => b[0].length - a[0].length);

  function normKw(s) {
    const S = globalThis.Store;
    return S ? S.normalizeText(s) : String(s || '').toLowerCase();
  }

  // メイン: 取引オブジェクト {payee, memo, type} → 推定カテゴリ
  // 戻り値: {categoryId, source: 'rule'|'history'|'dict'|'ai'|'fallback', label}
  function suggest(tx) {
    const st = S().state;
    const type = tx.type === 'income' ? 'income' : 'expense';
    const text = normKw((tx.payee || '') + ' ' + (tx.memo || ''));
    if (!text) return { categoryId: null, source: 'fallback', label: '未分類', confidence: 0 };

    // 1. 明示ルール。完全一致を優先し、次に優先順位と具体性で並べる。
    const merchantName = tx.payee || tx.memo || '';
    const merchantNorm = S().normalizeMerchantName(merchantName);
    const merchantKey = merchantName ? S().merchantKey(merchantName) : '';
    const rules = st.rules.filter(r => r.active !== false).slice().sort((a, b) =>
      (Number(b.priority) || 0) - (Number(a.priority) || 0) ||
      (b.matchMode === 'exact' ? 1 : 0) - (a.matchMode === 'exact' ? 1 : 0) ||
      (b.normalizedName || b.keyword || '').length - (a.normalizedName || a.keyword || '').length);
    for (const r of rules) {
      const ruleNorm = r.normalizedName || S().normalizeMerchantName(r.merchantName || r.keyword || '');
      const match = r.matchMode === 'partial'
        ? !!ruleNorm && (merchantNorm.includes(ruleNorm) || text.includes(normKw(ruleNorm)))
        : !!merchantKey && merchantKey === S().merchantKey(r.merchantName || r.keyword || '');
      if (!match) continue;
      const categoryId = r.subCategoryId || r.categoryId;
      const cat = S().catById(categoryId);
      if (cat && cat.type === type) return { categoryId: cat.id, source: 'rule', label: 'ルール', confidence: 0.99, ruleId: r.id };
    }

    // 2. 同じ店舗の過去分類。正規化キー別に遅延キャッシュし、大量取引でも入力のたびに全件走査しない。
    const history = merchantName ? historyIndex().get(type + '|' + merchantKey) : null;
    if (history && history.size) {
      const ranked = [...history.entries()].sort((a, b) =>
        (b[1].count - a[1].count) || b[1].latest.localeCompare(a[1].latest));
      const cat = S().catById(ranked[0][0]);
      // 同一店舗で異なる用途の履歴がある場合は候補に留め、自動確定しない。
      if (cat && cat.type === type) return { categoryId: cat.id, source: 'history', label: '過去の分類', confidence: history.size > 1 ? 0.7 : Math.min(0.97, 0.86 + ranked[0][1].count * 0.025) };
    }

    // 3. 店舗辞書
    const dictionary = dictMatches(text, type);
    if (dictionary.length) return dictionary[0];

    // 外部AIは未接続。候補表示は既存利用頻度から作り、分類を自動確定しない。
    return { categoryId: null, source: 'fallback', label: '未分類', confidence: 0 };
  }

  function candidates(tx, limit) {
    const type = tx.type === 'income' ? 'income' : 'expense';
    const found = new Map();
    const primary = suggest(tx);
    if (primary.categoryId) found.set(primary.categoryId, primary);
    const merchantName = tx.payee || tx.memo || '';
    const key = merchantName ? S().merchantKey(merchantName) : '';
    const history = key && historyIndex().get(type + '|' + key);
    if (history) {
      const total = [...history.values()].reduce((n, x) => n + x.count, 0);
      for (const [id, item] of [...history.entries()].sort((a, b) => b[1].count - a[1].count || b[1].latest.localeCompare(a[1].latest))) {
        const cat = S().catById(id);
        if (cat && cat.type === type && !found.has(id)) found.set(id, { categoryId: id, source: 'history', label: '過去の分類', confidence: Math.min(0.94, 0.65 + item.count / Math.max(1, total) * 0.29) });
      }
    }
    const text = normKw((tx.payee || '') + ' ' + (tx.memo || ''));
    for (const item of dictMatches(text, type)) if (!found.has(item.categoryId)) found.set(item.categoryId, item);
    if (found.size < (limit || 3)) {
      const freq = [...recentCategoryFrequency.entries()].filter(([key]) => key.startsWith(type + '|')).map(([key, count]) => [key.slice(type.length + 1), count]);
      for (const [id, count] of freq.sort((a, b) => b[1] - a[1])) {
        const cat = S().catById(id);
        if (cat && cat.type === type && !found.has(id)) found.set(id, { categoryId: id, source: 'frequency', label: 'よく使用', confidence: Math.min(0.58, 0.3 + count * 0.01) });
      }
    }
    return [...found.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit || 3)
      .map(item => ({ ...item, category: S().catById(item.categoryId) }));
  }

  function confidenceThreshold(tx) {
    const item = suggest(tx);
    return { ...item, auto: item.confidence >= 0.8 && item.source !== 'fallback' };
  }

  function fallbackCat(type) {
    const name = type === 'income' ? 'その他収入' : 'その他';
    const c = S().catByName(name, type);
    if (c) return c.id;
    const list = S().catsOf(type);
    return list.length ? list[list.length - 1].id : null;
  }

  // ユーザーがカテゴリを修正したときの学習
  // 「この店舗は今後このカテゴリにする」を保存
  function learn(tx, categoryId, options) {
    if (!tx.payee) return null;
    return S().learnRule(tx.payee, categoryId, options);
  }

  const api = { suggest, candidates, confidenceThreshold, learn, DICT };
  if (typeof window !== 'undefined') window.Classify = api;
  globalThis.Classify = api;
})();
