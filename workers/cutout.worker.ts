/**
 * 白背景の切り抜きエンジン (Web Worker)。
 *
 * 1. 白背景の除去: 画像4辺からのフラッドフィル。AI バウンディングボックス
 *    (被写体範囲)がある場合、フラッドフィルはボックスに進入しないため、
 *    被写体の白(布・肌など)が画像端に接していても消えない。ボックス内部の
 *    白背景は画像の内側に面したボックス辺から別途フラッドフィルして除去する。
 *    ボックスは保護のヒントであり、被写体がはみ出してもクリップしない。
 * 2. 連結成分フィルタ: AI 被写体ボックスを基準に、ボックス外に主に分布する
 *    成分(画像全体に広がる枠線・UIボタン・手書き文字・制作マーク等)を除去
 *    する。ボックス内に過半数の画素がある成分のみを採用する。
 * 3. 白フチ: 被写体マスクの距離変換で生成。
 *
 * 出力は元画像と同じ寸法(アスペクト比を完全維持・トリミングなし)。
 */
export {};

interface CutoutOptions {
  whiteFrame: boolean;
  frameWidth: number;
  tolerance: number;
}

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface InMsg {
  id: string;
  bitmap: ImageBitmap;
  options: CutoutOptions;
  bbox: Bbox | null;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const { id, bitmap, options, bbox } = e.data;
  try {
    const template = await getTemplateScaled(bitmap.width, bitmap.height);
    const result = await processImage(bitmap, options, bbox, template);
    bitmap.close();
    ctx.postMessage({
      id,
      type: "done",
      blob: result.blob,
      width: result.width,
      height: result.height,
    });
  } catch (err) {
    ctx.postMessage({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- 固定テンプレート(キープマスク)の読み込みとキャッシュ ---
// キープマスク(frame-keep.png)は2値: 白 = 残す描画エリア / それ以外(黒) = 削除(枠/余白)
interface TemplateMasks {
  keep: Uint8Array; // 1 = 残す(白), 0 = 削除(黒)
  w: number;
  h: number;
}
let keepCanvas: OffscreenCanvas | null = null;
let templateTried = false;
const scaledCache = new Map<string, TemplateMasks | null>();

async function fetchToCanvas(url: string): Promise<OffscreenCanvas | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const bmp = await createImageBitmap(await resp.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = c.getContext("2d");
    if (!cx) return null;
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  } catch {
    return null;
  }
}

async function loadTemplateAssets(): Promise<boolean> {
  if (templateTried) return keepCanvas !== null;
  templateTried = true;
  keepCanvas = await fetchToCanvas("/frame-keep.png");
  return keepCanvas !== null;
}

/** キープマスクを (w,h) にスケールして各画素の keep フラグを返す(キャッシュ付き) */
async function getTemplateScaled(
  w: number,
  h: number,
): Promise<TemplateMasks | null> {
  const ok = await loadTemplateAssets();
  if (!ok || !keepCanvas) return null;
  // アスペクト比が大きく違う画像はテンプレート対象外
  const arT = keepCanvas.width / keepCanvas.height;
  const arI = w / h;
  if (Math.abs(arT - arI) / arT > 0.04) return null;
  const key = `${w}x${h}`;
  if (scaledCache.has(key)) return scaledCache.get(key) ?? null;

  const d = new OffscreenCanvas(w, h);
  const dc = d.getContext("2d", { willReadFrequently: true });
  if (!dc) {
    scaledCache.set(key, null);
    return null;
  }
  dc.drawImage(keepCanvas, 0, 0, w, h);
  const md = dc.getImageData(0, 0, w, h).data;
  const N = w * h;
  const keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const o = i << 2;
    const r = md[o];
    const g = md[o + 1];
    const b = md[o + 2];
    const a = md[o + 3];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    // 白(明るく低彩度) = 残す。それ以外は削除。
    if (a >= 40 && mx - mn < 40 && mn > 190) keep[i] = 1;
  }
  const result: TemplateMasks = { keep, w, h };
  scaledCache.set(key, result);
  return result;
}

async function processImage(
  bitmap: ImageBitmap,
  options: CutoutOptions,
  bbox: Bbox | null,
  template: TemplateMasks | null,
) {
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) throw new Error("2Dコンテキストを取得できませんでした");
  c.drawImage(bitmap, 0, 0);
  const img = c.getImageData(0, 0, w, h);
  const data = img.data;
  const N = w * h;

  const connectT = Math.max(120, Math.round(255 - options.tolerance * 0.95));
  const minChannel = (i: number): number => {
    const o = i << 2;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const mn = r < g ? r : g;
    return mn < b ? mn : b;
  };

  // --- AI ボックスを画素座標へ。外側に少し余白を取る ---
  const pad = Math.round(Math.min(w, h) * 0.015);
  let bx0 = 0;
  let by0 = 0;
  let bx1 = w - 1;
  let by1 = h - 1;
  let hasBox = false;
  if (bbox) {
    bx0 = clamp(Math.floor(bbox.x * w) - pad, 0, w - 1);
    by0 = clamp(Math.floor(bbox.y * h) - pad, 0, h - 1);
    bx1 = clamp(Math.ceil((bbox.x + bbox.w) * w) + pad, 0, w - 1);
    by1 = clamp(Math.ceil((bbox.y + bbox.h) * h) + pad, 0, h - 1);
    // ボックスが画像のほぼ全域なら使わない(単純フラッドフィルへ)
    hasBox = (bx1 - bx0 + 1) * (by1 - by0 + 1) < N * 0.92 && bx1 > bx0 && by1 > by0;
  }
  const inBox = (x: number, y: number): boolean =>
    x >= bx0 && x <= bx1 && y >= by0 && y <= by1;

  // --- フラッドフィルで背景(透過対象)を判定 ---
  const transparent = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const colorRemoved = new Uint8Array(N);

  // --- 固定テンプレート(キープマスク)の減算 ---
  // マスクの白い部分(描画エリア)だけ残し、それ以外(枠/十字/ガイド/ボタン/ヘッダー/
  // 余白/コーナーマーク)は無条件で全削除する。肌色に依存せず被写体が何色でも対応。
  // その後は通常の背景フラッドフィルが白背景を抜く。
  let templateApplied = false;
  if (template && template.w === w && template.h === h) {
    const keep = template.keep;
    // ストーリーボード判定: 削除領域(マスク黒)に緑枠が十分あるか(非SB画像への誤適用防止)
    let delCount = 0;
    let greenInDel = 0;
    for (let i = 0; i < N; i++) {
      if (keep[i]) continue;
      delCount++;
      const o = i << 2;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (g >= r && g >= b && g - mn > 18) greenInDel++;
    }
    const isStoryboard = delCount > 0 && greenInDel > delCount * 0.04;

    if (isStoryboard) {
      for (let i = 0; i < N; i++) {
        if (!keep[i] && !transparent[i]) {
          transparent[i] = 1;
          colorRemoved[i] = 1;
        }
      }
      templateApplied = true;
    }
  }

  // --- テンプレートのアクセントカラー除去 ---
  // ストーリーボード等の枠・十字・ボタン・ヘッダー文字は同一の彩色(緑/赤/青等)で
  // 描かれ、画像の外周に thin な線として存在する。外周リングの彩色画素から色相
  // ヒストグラムのピークを学習し、その色相に一致する画素を全面(被写体に隣接/交差
  // する十字含む)から透過にする。
  // 誤除去防止: 一致画素が画像全体の thin な割合(=枠)のときだけ発動する。被写体が
  // 画像端まで色付きで大きく描かれている場合(例: 寝具の青)は一致割合が大きいため
  // 発動しない。被写体の鉛筆線(無彩色)も影響を受けない。被写体ボックスに依存しない
  // ため、被写体が枠に隣接していても枠を除去できる。
  // テンプレート減算がマスクのズレで取りこぼした枠も、ここで色相から補完除去する。
  {
    void templateApplied;
    const colorfulness = (o: number): number => {
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      return mx - mn;
    };
    // 色相 (0..360)。彩度が低い画素では意味を持たない。
    const hueOf = (o: number): number => {
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = mx - mn;
      if (d === 0) return 0;
      let hh: number;
      if (mx === r) hh = ((g - b) / d) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh *= 60;
      return hh < 0 ? hh + 360 : hh;
    };

    const LEARN_CF = 45; // 学習対象とみなす最小彩度
    // 外周リング(短辺の約10%)の彩色画素から 36 ビンの色相ヒストグラムを作る
    const ringT = Math.max(8, Math.round(Math.min(w, h) * 0.1));
    const BINS = 36;
    const hist = new Float64Array(BINS);
    const considerRing = (i: number): void => {
      const o = i << 2;
      if (data[o + 3] < 8) return;
      if (colorfulness(o) < LEARN_CF) return;
      const bin = Math.floor(hueOf(o) / (360 / BINS)) % BINS;
      hist[bin] += 1;
    };
    for (let y = 0; y < h; y++) {
      const edge = y < ringT || y >= h - ringT;
      if (edge) {
        for (let x = 0; x < w; x++) considerRing(y * w + x);
      } else {
        for (let x = 0; x < ringT; x++) considerRing(y * w + x);
        for (let x = w - ringT; x < w; x++) considerRing(y * w + x);
      }
    }
    // ピーク(隣接ビンも合算)を採用
    let peakBin = -1;
    let peakVal = 0;
    for (let b = 0; b < BINS; b++) {
      const v = hist[b] + hist[(b + 1) % BINS] + hist[(b + BINS - 1) % BINS];
      if (v > peakVal) {
        peakVal = v;
        peakBin = b;
      }
    }

    if (peakBin >= 0 && peakVal > 200) {
      const templH = (peakBin + 0.5) * (360 / BINS);
      const MATCH_CF = 24; // 除去対象の最小彩度(縁のアンチエイリアスを拾う)
      const HUE_TOL = 32; // 色相許容
      const colorMask = new Uint8Array(N);
      let matchCount = 0;
      for (let i = 0; i < N; i++) {
        const o = i << 2;
        if (data[o + 3] < 8) continue;
        if (colorfulness(o) < MATCH_CF) continue;
        let hh = Math.abs(hueOf(o) - templH) % 360;
        if (hh > 180) hh = 360 - hh;
        if (hh < HUE_TOL) {
          colorMask[i] = 1;
          matchCount++;
        }
      }
      // 一致画素が thin (画像の15%未満) のときだけ枠とみなして除去する。
      // 大きな色面(被写体)は除去しない。
      if (matchCount < N * 0.15) {
        for (let i = 0; i < N; i++) {
          if (!colorMask[i]) continue;
          colorRemoved[i] = 1;
          transparent[i] = 1;
          const x = i % w;
          const y = (i - x) / w;
          if (x > 0) {
            colorRemoved[i - 1] = 1;
            transparent[i - 1] = 1;
          }
          if (x < w - 1) {
            colorRemoved[i + 1] = 1;
            transparent[i + 1] = 1;
          }
          if (y > 0) {
            colorRemoved[i - w] = 1;
            transparent[i - w] = 1;
          }
          if (y < h - 1) {
            colorRemoved[i + w] = 1;
            transparent[i + w] = 1;
          }
        }
      }
    }
  }

  if (!hasBox) {
    // フォールバック: 画像4辺から白っぽい連結領域を透過に
    const tryPush = (i: number): void => {
      if (transparent[i] || minChannel(i) < connectT) return;
      transparent[i] = 1;
      stack[sp++] = i;
    };
    for (let x = 0; x < w; x++) {
      tryPush(x);
      tryPush((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      tryPush(y * w);
      tryPush(y * w + (w - 1));
    }
    // 除去された枠の内側に閉じ込められた白も背景として除去する
    for (let i = 0; i < N; i++) {
      if (!colorRemoved[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPush(i - 1);
      if (x < w - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - w);
      if (y < h - 1) tryPush(i + w);
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPush(i - 1);
      if (x < w - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - w);
      if (y < h - 1) tryPush(i + w);
    }
  } else {
    // パスA: 画像4辺から白背景をたどる。被写体ボックスには進入しない
    // (ボックス内の被写体の白が画像端に接していても消さないため)。
    // ※ボックス外でも非白(=被写体の一部やゴミ)は除去しない。被写体が
    //   ボックスからはみ出していてもクリップされず、ゴミは後段の連結成分
    //   フィルタで除去する。
    const tryPushA = (i: number): void => {
      if (transparent[i]) return;
      const x = i % w;
      const y = (i - x) / w;
      if (inBox(x, y) || minChannel(i) < connectT) return;
      transparent[i] = 1;
      stack[sp++] = i;
    };
    for (let x = 0; x < w; x++) {
      tryPushA(x);
      tryPushA((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      tryPushA(y * w);
      tryPushA(y * w + (w - 1));
    }
    // 除去された枠の内側(ボックス外)に閉じ込められた白も背景として除去する
    for (let i = 0; i < N; i++) {
      if (!colorRemoved[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPushA(i - 1);
      if (x < w - 1) tryPushA(i + 1);
      if (y > 0) tryPushA(i - w);
      if (y < h - 1) tryPushA(i + w);
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPushA(i - 1);
      if (x < w - 1) tryPushA(i + 1);
      if (y > 0) tryPushA(i - w);
      if (y < h - 1) tryPushA(i + w);
    }

    // パスB: ボックス内の白背景を、画像内側に面したボックス辺からたどる。
    // 画像端に近いボックス辺は「被写体が端に接している」とみなし種にしない。
    const tryPushB = (i: number): void => {
      if (transparent[i]) return;
      const x = i % w;
      const y = (i - x) / w;
      if (!inBox(x, y) || minChannel(i) < connectT) return;
      transparent[i] = 1;
      stack[sp++] = i;
    };
    const marginX = Math.round(w * 0.04);
    const marginY = Math.round(h * 0.04);
    if (by0 > marginY) for (let x = bx0; x <= bx1; x++) tryPushB(by0 * w + x);
    if (by1 < h - 1 - marginY) for (let x = bx0; x <= bx1; x++) tryPushB(by1 * w + x);
    if (bx0 > marginX) for (let y = by0; y <= by1; y++) tryPushB(y * w + bx0);
    if (bx1 < w - 1 - marginX) for (let y = by0; y <= by1; y++) tryPushB(y * w + bx1);
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPushB(i - 1);
      if (x < w - 1) tryPushB(i + 1);
      if (y > 0) tryPushB(i - w);
      if (y < h - 1) tryPushB(i + w);
    }
  }

  // --- 連結成分フィルタ ---
  // 主要被写体から切り離された塊(UI枠・ボタン・手書き文字・制作マーク等)を
  // 除去する。AI 被写体ボックスがある場合は「過半数の画素がボックス内」を
  // 採用基準にし、サイズだけでは判別できない画像全体に広がる枠線も除く。
  {
    const label = new Int32Array(N).fill(-1);
    const sizes: number[] = [];
    const inBoxCounts: number[] = [];
    let csp = 0;
    for (let s = 0; s < N; s++) {
      if (transparent[s] || label[s] !== -1) continue;
      const compId = sizes.length;
      let count = 0;
      let inBoxCount = 0;
      label[s] = compId;
      stack[csp++] = s;
      while (csp > 0) {
        const i = stack[--csp];
        count++;
        const x = i % w;
        const y = (i - x) / w;
        if (hasBox && x >= bx0 && x <= bx1 && y >= by0 && y <= by1) inBoxCount++;
        if (x > 0 && !transparent[i - 1] && label[i - 1] === -1) {
          label[i - 1] = compId;
          stack[csp++] = i - 1;
        }
        if (x < w - 1 && !transparent[i + 1] && label[i + 1] === -1) {
          label[i + 1] = compId;
          stack[csp++] = i + 1;
        }
        if (y > 0 && !transparent[i - w] && label[i - w] === -1) {
          label[i - w] = compId;
          stack[csp++] = i - w;
        }
        if (y < h - 1 && !transparent[i + w] && label[i + w] === -1) {
          label[i + w] = compId;
          stack[csp++] = i + w;
        }
      }
      sizes.push(count);
      inBoxCounts.push(inBoxCount);
    }

    if (sizes.length > 0) {
      const kept = new Uint8Array(sizes.length);
      let globalMax = 0;
      for (const sz of sizes) if (sz > globalMax) globalMax = sz;
      // 方針:
      //  - 最大成分の15%以上の大きな成分(=主要被写体, 複数可)は AI ボックスに
      //    関わらず常に保持する。AI ボックスが誤っても被写体を失わない。
      //  - 4〜15% の中程度の成分は、大半がボックス外なら除去(箱外の注釈/ゴミ)。
      //  - 4%未満の小さな成分は除去(ノイズ・細かいマーク)。
      for (let k = 0; k < sizes.length; k++) {
        const big = sizes[k] >= globalMax * 0.15;
        let keep = sizes[k] >= globalMax * 0.04;
        if (
          keep &&
          !big &&
          hasBox &&
          inBoxCounts[k] * 2 < sizes[k]
        ) {
          keep = false;
        }
        if (keep) kept[k] = 1;
      }
      for (let i = 0; i < N; i++) {
        const lb = label[i];
        if (lb >= 0 && !kept[lb]) transparent[i] = 1;
      }
    }
  }

  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) alpha[i] = transparent[i] ? 0 : 1;

  // --- 境界フェザリング: 透過に隣接する白っぽい画素を半透明化 ---
  const featherLow = Math.max(0, connectT - 50);
  const featherRange = 255 - featherLow || 1;
  for (let i = 0; i < N; i++) {
    if (transparent[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const onEdge =
      (x > 0 && transparent[i - 1] === 1) ||
      (x < w - 1 && transparent[i + 1] === 1) ||
      (y > 0 && transparent[i - w] === 1) ||
      (y < h - 1 && transparent[i + w] === 1);
    if (!onEdge) continue;
    const mn = minChannel(i);
    if (mn <= featherLow) continue;
    let wt = (mn - featherLow) / featherRange;
    if (wt > 1) wt = 1;
    alpha[i] = 1 - wt;
  }

  // --- 白フチ: 被写体マスクの距離変換で外側に白縁を作る ---
  let frame: Float32Array | null = null;
  if (options.whiteFrame && options.frameWidth > 0) {
    const INF = 1e9;
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) dist[i] = alpha[i] > 0.5 ? 0 : INF;
    const D1 = 1;
    const D2 = Math.SQRT2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x > 0 && dist[i - 1] + D1 < d) d = dist[i - 1] + D1;
        if (y > 0 && dist[i - w] + D1 < d) d = dist[i - w] + D1;
        if (x > 0 && y > 0 && dist[i - w - 1] + D2 < d) d = dist[i - w - 1] + D2;
        if (x < w - 1 && y > 0 && dist[i - w + 1] + D2 < d) d = dist[i - w + 1] + D2;
        dist[i] = d;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x < w - 1 && dist[i + 1] + D1 < d) d = dist[i + 1] + D1;
        if (y < h - 1 && dist[i + w] + D1 < d) d = dist[i + w] + D1;
        if (x < w - 1 && y < h - 1 && dist[i + w + 1] + D2 < d) d = dist[i + w + 1] + D2;
        if (x > 0 && y < h - 1 && dist[i + w - 1] + D2 < d) d = dist[i + w - 1] + D2;
        dist[i] = d;
      }
    }
    frame = new Float32Array(N);
    const fw = options.frameWidth;
    for (let i = 0; i < N; i++) {
      let cov = (fw - dist[i]) / 1.5 + 0.5;
      if (cov < 0) cov = 0;
      else if (cov > 1) cov = 1;
      frame[i] = cov;
    }
  }

  // --- 被写体を白フチの上に合成(元寸法のまま、トリミングなし) ---
  for (let i = 0; i < N; i++) {
    const sa = alpha[i];
    const fa = frame ? frame[i] : 0;
    const o = i << 2;
    const outA = sa + fa * (1 - sa);
    if (outA <= 0.0001) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
      continue;
    }
    const framePremul = 255 * fa * (1 - sa);
    data[o] = (data[o] * sa + framePremul) / outA;
    data[o + 1] = (data[o + 1] * sa + framePremul) / outA;
    data[o + 2] = (data[o + 2] * sa + framePremul) / outA;
    data[o + 3] = Math.round(outA * 255);
  }
  c.putImageData(img, 0, 0);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { blob, width: w, height: h };
}
