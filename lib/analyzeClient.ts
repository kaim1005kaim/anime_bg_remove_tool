import type { AiAnalysis } from "./types";

const FALLBACK: AiAnalysis = {
  bbox: null,
  backgroundOk: true,
  note: "",
};

/** 解析用に画像を縮小して JPEG data URL を作る (送信ペイロード削減) */
async function toAnalysisDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const maxDim = 768;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no ctx");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Gemini で被写体範囲と背景品質を解析する。
 * 失敗しても切り抜き処理を止めないよう、エラー時はフォールバックを返す。
 */
export async function analyzeImage(file: File): Promise<AiAnalysis> {
  try {
    const image = await toAnalysisDataUrl(file);
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) return FALLBACK;
    const json = (await res.json()) as Partial<AiAnalysis>;
    return {
      bbox: json.bbox ?? null,
      backgroundOk: json.backgroundOk ?? true,
      note: json.note ?? "",
    };
  } catch {
    return FALLBACK;
  }
}
