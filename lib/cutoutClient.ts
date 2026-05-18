import type { CutoutOptions } from "./types";

export interface CutoutResult {
  blob: Blob;
  width: number;
  height: number;
}

interface PendingTask {
  resolve: (r: CutoutResult) => void;
  reject: (e: Error) => void;
}

let pool: Worker[] = [];
let roundRobin = 0;
let seq = 0;
const pending = new Map<string, PendingTask>();

function ensurePool(): void {
  if (pool.length > 0) return;
  const hw = navigator.hardwareConcurrency || 4;
  const count = Math.min(4, Math.max(2, hw - 1));
  for (let i = 0; i < count; i++) {
    const worker = new Worker(
      new URL("../workers/cutout.worker.ts", import.meta.url),
    );
    worker.onmessage = (e: MessageEvent) => {
      const { id, type } = e.data;
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      if (type === "done") {
        task.resolve({
          blob: e.data.blob,
          width: e.data.width,
          height: e.data.height,
        });
      } else {
        task.reject(new Error(e.data.message || "切り抜き処理に失敗しました"));
      }
    };
    pool.push(worker);
  }
}

/** 1枚の画像を切り抜く。Web Worker プールで並列処理される。 */
export async function runCutout(
  file: File,
  options: CutoutOptions,
): Promise<CutoutResult> {
  ensurePool();
  const bitmap = await createImageBitmap(file);
  const id = `cut-${++seq}`;
  const worker = pool[roundRobin++ % pool.length];
  return new Promise<CutoutResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, bitmap, options }, [bitmap]);
  });
}
