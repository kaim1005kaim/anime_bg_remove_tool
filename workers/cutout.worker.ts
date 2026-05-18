/**
 * 白背景の切り抜きエンジン (Web Worker)。
 *
 * 1. 画像の4辺から白っぽいピクセルを連結成分で塗りつぶし (フラッドフィル) し、
 *    被写体内部の白を保持したまま外側の白背景だけを透過にする。
 * 2. 境界を1pxフェザリングしてギザつきを除去。
 * 3. 白フチ有効時は被写体マスクを距離変換で膨張させ、ステッカー風の白縁を合成。
 * 4. 不透明領域にタイトにトリミングして PNG (透過) を返す。
 */
export {};

interface CutoutOptions {
  whiteFrame: boolean;
  frameWidth: number;
  tolerance: number;
}

interface InMsg {
  id: string;
  bitmap: ImageBitmap;
  options: CutoutOptions;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const { id, bitmap, options } = e.data;
  try {
    const result = await processImage(bitmap, options);
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

async function processImage(bitmap: ImageBitmap, options: CutoutOptions) {
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) throw new Error("2Dコンテキストを取得できませんでした");
  c.drawImage(bitmap, 0, 0);
  const img = c.getImageData(0, 0, w, h);
  const data = img.data;
  const N = w * h;

  // 許容度が高いほどしきい値が下がり、より広い範囲を「白背景」とみなす
  const connectT = Math.max(120, Math.round(255 - options.tolerance * 0.95));

  const minChannel = (i: number): number => {
    const o = i << 2;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const m = r < g ? r : g;
    return m < b ? m : b;
  };

  // --- フラッドフィル: 4辺から連結する白っぽいピクセルを外部としてマーク ---
  const exterior = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const tryPush = (i: number): void => {
    if (!exterior[i] && minChannel(i) >= connectT) {
      exterior[i] = 1;
      stack[sp++] = i;
    }
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

  // --- アルファ値: 1=不透明, 0=透過 ---
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) alpha[i] = exterior[i] ? 0 : 1;

  // --- 境界フェザリング: 外部に隣接する白っぽいピクセルを半透明化 ---
  const featherLow = Math.max(0, connectT - 50);
  const featherRange = 255 - featherLow || 1;
  for (let i = 0; i < N; i++) {
    if (exterior[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const onEdge =
      (x > 0 && exterior[i - 1] === 1) ||
      (x < w - 1 && exterior[i + 1] === 1) ||
      (y > 0 && exterior[i - w] === 1) ||
      (y < h - 1 && exterior[i + w] === 1);
    if (!onEdge) continue;
    const m = minChannel(i);
    if (m <= featherLow) continue;
    let wt = (m - featherLow) / featherRange;
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
    // 前方走査
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
    // 後方走査
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

  // --- 被写体を白フチの上に合成しつつ、不透明領域の範囲を測る ---
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
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
    // 白フチ (255,255,255) の上に被写体を source-over 合成
    const framePremul = 255 * fa * (1 - sa);
    data[o] = (data[o] * sa + framePremul) / outA;
    data[o + 1] = (data[o + 1] * sa + framePremul) / outA;
    data[o + 2] = (data[o + 2] * sa + framePremul) / outA;
    data[o + 3] = Math.round(outA * 255);
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  c.putImageData(img, 0, 0);

  // --- 不透明領域へタイトにトリミング ---
  if (maxX < 0) {
    const empty = new OffscreenCanvas(1, 1);
    const blob = await empty.convertToBlob({ type: "image/png" });
    return { blob, width: 1, height: 1 };
  }
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new OffscreenCanvas(cw, ch);
  const oc = out.getContext("2d");
  if (!oc) throw new Error("出力コンテキストを取得できませんでした");
  oc.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  const blob = await out.convertToBlob({ type: "image/png" });
  return { blob, width: cw, height: ch };
}
