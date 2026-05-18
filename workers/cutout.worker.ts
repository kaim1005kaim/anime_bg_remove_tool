/**
 * 白背景の切り抜きエンジン (Web Worker)。
 *
 * AI バウンディングボックス(被写体範囲)がある場合:
 *  - ボックスの外側は無条件で透過 → UIボタン・文字・制作マーク等を除去。
 *  - 背景除去のフラッドフィルはボックスに進入しない
 *    → 被写体の白(布・肌など)が画像端に接していても消えない。
 *  - ボックス内部の白背景は、画像の内側に面したボックス辺から
 *    フラッドフィルして除去(被写体が接する画像端側の辺は種にしない)。
 * AI ボックスが無い/画像全体に近い場合は、画像4辺からの単純な
 * フラッドフィルにフォールバックする。
 *
 * 白フチは被写体マスクの距離変換で生成。
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
    const result = await processImage(bitmap, options, bbox);
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

async function processImage(
  bitmap: ImageBitmap,
  options: CutoutOptions,
  bbox: Bbox | null,
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
    // ボックス外は無条件で透過
    for (let i = 0; i < N; i++) {
      const x = i % w;
      const y = (i - x) / w;
      if (!inBox(x, y)) transparent[i] = 1;
    }
    // ボックス内: 画像内側に面したボックス辺から白背景をフラッドフィル
    const tryPush = (i: number): void => {
      if (transparent[i]) return;
      const x = i % w;
      const y = (i - x) / w;
      if (!inBox(x, y) || minChannel(i) < connectT) return;
      transparent[i] = 1;
      stack[sp++] = i;
    };
    // 画像端に近いボックス辺は「被写体が端に接している」とみなし種にしない
    // (被写体の白が端に接していても消さないため)。
    const marginX = Math.round(w * 0.04);
    const marginY = Math.round(h * 0.04);
    if (by0 > marginY) for (let x = bx0; x <= bx1; x++) tryPush(by0 * w + x);
    if (by1 < h - 1 - marginY) for (let x = bx0; x <= bx1; x++) tryPush(by1 * w + x);
    if (bx0 > marginX) for (let y = by0; y <= by1; y++) tryPush(y * w + bx0);
    if (bx1 < w - 1 - marginX) for (let y = by0; y <= by1; y++) tryPush(y * w + bx1);
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) tryPush(i - 1);
      if (x < w - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - w);
      if (y < h - 1) tryPush(i + w);
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
