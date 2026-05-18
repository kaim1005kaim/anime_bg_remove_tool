"use client";

import type { Job, JobStatus } from "@/lib/types";

interface Props {
  job: Job;
  onDownload: (job: Job) => void;
  onRemove: (job: Job) => void;
  onRetry: (job: Job) => void;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "待機中",
  analyzing: "AI解析中",
  processing: "切り抜き中",
  done: "完了",
  error: "エラー",
};

export default function ImageCard({
  job,
  onDownload,
  onRemove,
  onRetry,
}: Props) {
  const isWorking =
    job.status === "queued" ||
    job.status === "analyzing" ||
    job.status === "processing";
  const isDone = job.status === "done";

  return (
    <div className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {/* プレビュー領域 */}
      <div className="relative aspect-square bg-checker">
        {isDone && job.resultUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={job.resultUrl}
              alt={job.name}
              className="absolute inset-0 h-full w-full object-contain"
            />
            {/* ホバーで原画と比較 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={job.srcUrl}
              alt={`${job.name} 原画`}
              className="absolute inset-0 h-full w-full bg-white object-contain opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
            <span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100">
              ホバー中: 原画
            </span>
          </>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={job.srcUrl}
              alt={job.name}
              className="absolute inset-0 h-full w-full bg-white object-contain"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/70">
              {isWorking && (
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
              )}
              <span
                className={`text-xs font-medium ${
                  job.status === "error" ? "text-rose-400" : "text-zinc-200"
                }`}
              >
                {STATUS_LABEL[job.status]}
              </span>
              {job.status === "error" && (
                <button
                  type="button"
                  onClick={() => onRetry(job)}
                  className="mt-1 rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-white"
                >
                  再試行
                </button>
              )}
            </div>
          </>
        )}

        {/* 削除ボタン */}
        <button
          type="button"
          onClick={() => onRemove(job)}
          aria-label="削除"
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-zinc-200 opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </button>
      </div>

      {/* 情報フッター */}
      <div className="space-y-2 p-3">
        <p className="truncate text-xs text-zinc-300" title={job.name}>
          {job.name}
        </p>

        {job.ai?.note && (
          <p
            className={`flex items-start gap-1 text-[11px] leading-snug ${
              job.ai.backgroundOk ? "text-zinc-500" : "text-amber-400"
            }`}
          >
            <span>{job.ai.backgroundOk ? "🔍" : "⚠️"}</span>
            <span className="line-clamp-2">{job.ai.note}</span>
          </p>
        )}

        {job.status === "error" && job.error && (
          <p className="text-[11px] text-rose-400">{job.error}</p>
        )}

        {isDone && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] tabular-nums text-zinc-500">
              {job.width}×{job.height}
            </span>
            <button
              type="button"
              onClick={() => onDownload(job)}
              className="rounded-md bg-sky-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-400"
            >
              PNG保存
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
