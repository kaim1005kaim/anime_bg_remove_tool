export type JobStatus =
  | "queued"
  | "analyzing"
  | "processing"
  | "done"
  | "error";

export interface CutoutOptions {
  /** ステッカー風の白フチを付けるか */
  whiteFrame: boolean;
  /** 白フチの太さ (px, 元画像解像度) */
  frameWidth: number;
  /** 背景白の許容度 0-100 (高いほど広く透過) */
  tolerance: number;
}

export interface AiAnalysis {
  /** 被写体の正規化バウンディングボックス (0-1)。失敗時 null */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** 背景が一様な白で自動切り抜きに適しているか */
  backgroundOk: boolean;
  /** 日本語の所見 */
  note: string;
}

export interface Job {
  id: string;
  name: string;
  status: JobStatus;
  error?: string;
  /** 元画像 (セッション内のみ。復元したジョブでは undefined) */
  file?: File;
  /** 元画像表示用 URL */
  srcUrl: string;
  /** 結果 PNG の表示用 URL */
  resultUrl?: string;
  /** 結果 PNG の Blob (セッション内のみ) */
  resultBlob?: Blob;
  width?: number;
  height?: number;
  ai?: AiAnalysis;
  /** Supabase に保存済みなら true */
  persisted?: boolean;
  /** 復元元（Supabase）のジョブか */
  remote?: boolean;
}

export const DEFAULT_OPTIONS: CutoutOptions = {
  whiteFrame: true,
  frameWidth: 14,
  tolerance: 32,
};
