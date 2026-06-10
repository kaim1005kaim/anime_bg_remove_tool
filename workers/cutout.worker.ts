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

  // --- テンプレートのアクセントカラー除去 ---
  // ストーリーボード等の枠・十字・ボタン・ヘッダー文字は同一の彩色(緑/青等)で
  // 描かれることが多い。AI 被写体ボックスの「外側」から主要な彩色の色相を学習し、
  // その色相に一致する画素を全面(ボックス内の十字含む)から透過にする。被写体の
  // 鉛筆線(無彩色)は影響を受けない。学習をボックス外に限定するため、被写体が
  // 画像端まで色付きで描かれていても(例: 寝具の青)誤って除去しない。
  // AI ボックスが無い/白背景のみの画像では発動しない。
  const colorRemoved = new Uint8Array(N);
  if (hasBox) {
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
    let hvx = 0;
    let hvy = 0;
    let learnCount = 0;
    // AI ボックスの外側のみから彩色を学習する
    for (let i = 0; i < N; i++) {
      const x = i % w;
      const y = (i - x) / w;
      if (inBox(x, y)) continue;
      const o = i << 2;
      if (data[o + 3] < 8) continue;
      if (colorfulness(o) < LEARN_CF) continue;
      const hh = (hueOf(o) * Math.PI) / 180;
      hvx += Math.cos(hh);
      hvy += Math.sin(hh);
      learnCount++;
    }

    // ボックス外に十分な量の一貫した彩色があれば、テンプレート色とみなし全面除去
    if (learnCount > N * 0.002 && learnCount > 200) {
      const templH = (((Math.atan2(hvy, hvx) * 180) / Math.PI) % 360 + 360) % 360;
      const MATCH_CF = 24; // 除去対象の最小彩度(縁のアンチエイリアスを拾う)
      const HUE_TOL = 32; // 色相許容
      const colorMask = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const o = i << 2;
        if (data[o + 3] < 8) continue;
        if (colorfulness(o) < MATCH_CF) continue;
        let hh = Math.abs(hueOf(o) - templH) % 360;
        if (hh > 180) hh = 360 - hh;
        if (hh < HUE_TOL) colorMask[i] = 1;
      }
      // アンチエイリアスの薄い縁取りを 1px 膨張して取り切る
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
      let appliedBoxRule = false;
      if (hasBox) {
        // 過半数の画素がボックス内にある成分のみを「被写体側」とみなす
        const inSubject: number[] = [];
        for (let k = 0; k < sizes.length; k++) {
          if (inBoxCounts[k] * 2 >= sizes[k]) inSubject.push(k);
        }
        if (inSubject.length > 0) {
          let maxIn = 0;
          for (const k of inSubject) if (sizes[k] > maxIn) maxIn = sizes[k];
          const thr = maxIn * 0.04;
          for (const k of inSubject) if (sizes[k] >= thr) kept[k] = 1;
          appliedBoxRule = true;
        }
      }
      if (!appliedBoxRule) {
        // フォールバック: 最大成分の4%以上を保持(AIなし or 被写体側成分なし)
        let maxSize = 0;
        for (const sz of sizes) if (sz > maxSize) maxSize = sz;
        const thr = maxSize * 0.04;
        for (let k = 0; k < sizes.length; k++) if (sizes[k] >= thr) kept[k] = 1;
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
