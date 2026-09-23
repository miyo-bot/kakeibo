/* js/ocr.js - レシートOCR取込
 * Tesseract.js を CDN から遅延ロードし、ブラウザ内で文字認識する。
 * 外部APIキー不要・画像は端末外に送信しない。
 * parse() は純粋関数なので Node のテストからも利用できる。
 */
(function () {
  'use strict';

  /* ---------- テキスト正規化 ---------- */
  function toHalf(s) {
    return String(s || '')
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }
  function normLine(s) {
    return toHalf(s)
      .replace(/[¥￥]/g, ' ')
      .replace(/,/g, '')
      .replace(/[‐‑–—―−ｰ]/g, '-')
      .replace(/[．。]/g, '.')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- 日付 ---------- */
  const ERA = { '令和': 2018, 'れいわ': 2018, 'レイワ': 2018, 'R': 2018, 'r': 2018,
                '平成': 1988, 'H': 1988, 'h': 1988,
                '昭和': 1925, 'S': 1925, 's': 1925 };

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function findDate(lines) {
    const cands = [];
    for (const raw of lines) {
      const l = normLine(raw);
      let m;
      // 令和7年9月15日 / R7.9.15 / 平成31-4-30
      m = l.match(/(令和|れいわ|レイワ|平成|昭和|[RrHhSs])\s*[.．\-/]?\s*(\d{1,2})\s*[年.\-/]\s*(\d{1,2})\s*月?\s*(\d{1,2})\s*日?/);
      if (m && ERA[m[1]] != null) {
        const iso = validDate(ERA[m[1]] + Number(m[2]), Number(m[3]), Number(m[4]));
        if (iso) { cands.push(iso); continue; }
      }
      // 2026/9/15 ・ 2026-09-15 ・ 2026年9月15日
      m = l.match(/(20\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*日?/);
      if (m) {
        const iso = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
        if (iso) { cands.push(iso); continue; }
      }
      // 26/9/15 （年2桁。30以下→2000年代、それ以外→1900年代）
      m = l.match(/(?<!\d)(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)/);
      if (m) {
        const yy = Number(m[1]);
        const iso = validDate(yy <= 30 ? 2000 + yy : 1900 + yy, Number(m[2]), Number(m[3]));
        if (iso) { cands.push(iso); continue; }
      }
      // 9月15日（年なし → 今年。未来なら前年）
      m = l.match(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (m) {
        const now = new Date();
        let y = now.getFullYear();
        let iso = validDate(y, Number(m[1]), Number(m[2]));
        if (iso && iso > todayStr()) iso = validDate(y - 1, Number(m[1]), Number(m[2]));
        if (iso) cands.push(iso);
      }
    }
    return cands.length ? cands[0] : null;
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------- 金額 ---------- */
  const TOTAL_KEYS = ['合計', '合 計', '総計', '総 計', 'TOTAL', 'Total', 'お会計', 'お買上', '御買上', '税込', '税 込', '小計', '小 計', '現計', 'クレジット', 'お支払'];
  const EXCLUDE_KEYS = ['お釣', 'おつり', '釣銭', 'お預', '預り', '預かり', 'ポイント', 'POINT', '残高', '値引', '割引', '内税', '消費税', '対象額', '対象', '点数', '個数', 'TEL', '電話', '担当', 'No.', 'レジ', '責'];

  function amountsIn(l) {
    const out = [];
    const re = /(\d{1,3}(?:\d{3})+|\d{3,})/g;
    let m;
    while ((m = re.exec(l))) {
      const v = Number(m[1]);
      if (v > 0 && v < 100000000) out.push(v);
    }
    return out;
  }
  function isDateLine(l) {
    return /[年月日]/.test(l) || /\d{2,4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}/.test(l);
  }
  function hasKey(l, keys) { return keys.some(k => l.indexOf(k) !== -1); }

  function findTotal(lines) {
    const hits = [];
    for (const raw of lines) {
      const l = normLine(raw);
      if (!hasKey(l, TOTAL_KEYS)) continue;
      if (hasKey(l, ['内税', '消費税', '対象額', '対象', '値引', '割引', '残高', 'お釣', 'おつり', '預り', 'お預', 'ポイント'])) continue;
      const nums = amountsIn(l.replace(/\d{1,2}\s*%/g, ''));
      for (const v of nums) hits.push(v);
    }
    if (hits.length) return Math.max.apply(null, hits);
    // 合計キーワードが読み取れなかった場合: 除外語を含まない行の最大金額
    let fallback = null;
    for (const raw of lines) {
      const l = normLine(raw);
      if (isDateLine(l) || hasKey(l, EXCLUDE_KEYS)) continue;
      if (/\d{4}[\s\-]?\d{4}/.test(l)) continue; // 電話番号
      for (const v of amountsIn(l)) {
        if (v >= 100 && (fallback == null || v > fallback)) fallback = v;
      }
    }
    return fallback;
  }

  /* ---------- 店舗名 ---------- */
  const SKIP_PAYEE = ['領収書', 'レシート', 'RECEIPT', '控え', '領収証', '明細', 'ご利用', '売上票'];
  // OCRが日本語の間に挿入するスペースを除去（例: "セブ ン - イ レブ ン" → "セブン-イレブン"）
  function cleanJp(s) {
    let prev;
    do { prev = s; s = s.replace(/([ぁ-んァ-ヶ一-龥])\s+([ぁ-んァ-ヶ一-龥])/g, '$1$2'); } while (s !== prev);
    return s.replace(/\s*-\s*/g, '-').trim();
  }
  function findPayee(lines) {
    for (const raw of lines) {
      let l = normLine(raw);
      if (!l) continue;
      if (isDateLine(l)) continue;
      if (/^\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{3,4}/.test(l)) continue; // 電話番号
      if (/^〒?\d{3}-?\d{4}/.test(l)) continue;                          // 郵便番号
      if (hasKey(l, SKIP_PAYEE)) continue;
      if (!/[ぁ-んァ-ヶ一-龥a-zA-Z]/.test(l)) continue;                   // 文字を含まない行は除外
      l = l.replace(/[\s\-_*.:：]+$/, '').replace(/^[#＃]+/, '').trim();
      if (l.length < 2) continue;
      return cleanJp(l).slice(0, 40);
    }
    return '';
  }

  /* ---------- 品目（メモ用） ---------- */
  function findItems(lines, total) {
    const items = [];
    for (const raw of lines) {
      const l = normLine(raw);
      if (!l || isDateLine(l)) continue;
      if (hasKey(l, TOTAL_KEYS) || hasKey(l, EXCLUDE_KEYS)) continue;
      const m = l.match(/^(.+?)\s+(\d{1,3}(?:\d{3})+|\d{2,})\s*[*＊]?$/);
      if (!m) continue;
      const name = cleanJp(m[1].replace(/^[*＊#＃\s]+/, '').trim());
      const price = Number(m[2]);
      if (name.length < 2 || !/[ぁ-んァ-ヶ一-龥a-zA-Z]/.test(name)) continue;
      if (total != null && price === total) continue;
      if (items.length < 3) items.push(name);
    }
    return items;
  }

  /* ---------- エントリ ---------- */
  function parse(text) {
    const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const amount = findTotal(lines);
    const date = findDate(lines);
    const payee = findPayee(lines);
    const items = findItems(lines, amount);
    return {
      date: date || null,
      amount: amount || null,
      payee: payee || '',
      memo: items.length ? items.join('・') : '',
    };
  }

  /* ---------- ブラウザ: Tesseract 読み込み + 認識 ----------
   * vendor/tesseract/ に同梱したローカルファイルを使う。
   * 外部CDN不要・オフライン動作・画像とデータは端末外に出ない。
   */
  const VENDOR = 'vendor/tesseract';
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Tesseract.js の読み込みに失敗しました'));
      document.head.appendChild(s);
    });
  }

  // 画像をグレースケール化＋リサイズして認識精度を上げる
  function preprocess(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 2200;
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, MAX / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h), p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
          const v = g < 140 ? Math.max(0, g - 30) : Math.min(255, g + 30);
          p[i] = p[i + 1] = p[i + 2] = v;
        }
        ctx.putImageData(d, 0, 0);
        URL.revokeObjectURL(url);
        resolve(cv);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  async function recognize(file, onProgress) {
    if (typeof window === 'undefined') throw new Error('ブラウザ環境でのみ利用できます');
    await loadScript(VENDOR + '/tesseract.min.js');
    onProgress && onProgress(0.05, 'OCRエンジンを準備中…');
    if (!workerPromise) {
      workerPromise = window.Tesseract.createWorker('jpn', 1, {
        workerPath: VENDOR + '/worker.min.js',
        corePath: VENDOR + '/tesseract-core-simd-lstm.wasm.js',
        langPath: VENDOR,
        gzip: false,
        logger: m => {
          if (m.status === 'recognizing text' && onProgress) {
            onProgress(0.1 + m.progress * 0.85, '文字を読み取り中… ' + Math.round(m.progress * 100) + '%');
          }
        },
      });
    }
    const worker = await workerPromise;
    const img = await preprocess(file);
    onProgress && onProgress(0.1, '文字を読み取り中…');
    const ret = await worker.recognize(img);
    onProgress && onProgress(1, '完了');
    return ret.data.text;
  }

  const api = { parse, recognize, normLine, findDate, findTotal, findPayee };
  if (typeof window !== 'undefined') window.OCR = api;
  globalThis.OCR = api;
})();
