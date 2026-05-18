"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dropzone from "@/components/Dropzone";
import SettingsPanel from "@/components/SettingsPanel";
import ImageCard from "@/components/ImageCard";
import {
  DEFAULT_OPTIONS,
  type Bbox,
  type CutoutOptions,
  type Job,
} from "@/lib/types";
import { runCutout } from "@/lib/cutoutClient";
import { analyzeImage } from "@/lib/analyzeClient";
import { downloadZip, triggerDownload, toPngName } from "@/lib/download";
import { BUCKET, getSupabase, publicUrl } from "@/lib/supabaseClient";
import {
  notificationPermission,
  requestNotificationPermission,
  sendNotification,
} from "@/lib/notify";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** items を最大 limit 並列で処理する */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (index < items.length) {
        await fn(items[index++]);
      }
    })(),
  );
  await Promise.all(lanes);
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [options, setOptions] = useState<CutoutOptions>(DEFAULT_OPTIONS);
  const [notifyState, setNotifyState] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setNotifyState(notificationPermission());
  }, []);

  const patch = useCallback((id: string, p: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }, []);

  // --- Supabase: 起動時に保存済みギャラリーを復元 ---
  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    void (async () => {
      const { data, error } = await sb
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(60);
      if (error || !data) return;
      const restored: Job[] = data.map((row) => ({
        id: row.id as string,
        name: (row.original_name as string) ?? "image.png",
        status: "done",
        srcUrl: publicUrl(
          (row.original_path as string) ?? (row.result_path as string),
        ),
        resultUrl: publicUrl(row.result_path as string),
        width: (row.width as number) ?? undefined,
        height: (row.height as number) ?? undefined,
        ai: {
          bbox: (row.ai_bbox as Bbox | null) ?? null,
          backgroundOk: (row.ai_background_ok as boolean) ?? true,
          note: (row.ai_note as string) ?? "",
        },
        persisted: true,
        remote: true,
      }));
      setJobs((prev) => {
        const seen = new Set(prev.map((j) => j.id));
        return [...prev, ...restored.filter((r) => !seen.has(r.id))];
      });
    })();
  }, []);

  // --- Supabase: 結果を永続化 ---
  const persist = useCallback(
    async (job: Job, blob: Blob, opts: CutoutOptions) => {
      const sb = getSupabase();
      if (!sb || !job.file) return;
      try {
        const resultPath = `${job.id}/result.png`;
        const ext = (job.file.name.match(/\.[^./\\]+$/)?.[0] ?? ".png").toLowerCase();
        const originalPath = `${job.id}/original${ext}`;
        await sb.storage
          .from(BUCKET)
          .upload(resultPath, blob, { contentType: "image/png", upsert: true });
        await sb.storage.from(BUCKET).upload(originalPath, job.file, {
          contentType: job.file.type || "image/png",
          upsert: true,
        });
        await sb.from("jobs").upsert({
          id: job.id,
          original_name: job.name,
          result_path: resultPath,
          original_path: originalPath,
          width: job.width ?? null,
          height: job.height ?? null,
          white_frame: opts.whiteFrame,
          frame_width: opts.frameWidth,
          tolerance: opts.tolerance,
          ai_bbox: job.ai?.bbox ?? null,
          ai_note: job.ai?.note ?? null,
          ai_background_ok: job.ai?.backgroundOk ?? null,
        });
        patch(job.id, { persisted: true });
      } catch (e) {
        console.warn("[persist] failed:", e);
      }
    },
    [patch],
  );

  // --- 1枚を解析 → 切り抜き ---
  const processJob = useCallback(
    async (job: Job, opts: CutoutOptions) => {
      if (!job.file) return;
      patch(job.id, { status: "analyzing" });
      const ai = await analyzeImage(job.file);
      patch(job.id, { ai, status: "processing" });
      try {
        const result = await runCutout(job.file, opts, ai.bbox);
        const resultUrl = URL.createObjectURL(result.blob);
        patch(job.id, {
          status: "done",
          resultBlob: result.blob,
          resultUrl,
          width: result.width,
          height: result.height,
        });
        void persist(
          {
            ...job,
            ai,
            width: result.width,
            height: result.height,
          },
          result.blob,
          opts,
        );
      } catch (e) {
        patch(job.id, { status: "error", error: errMessage(e) });
      }
    },
    [patch, persist],
  );

  // --- ファイル受け取り ---
  const handleFiles = useCallback(
    async (files: File[]) => {
      const opts = optionsRef.current;
      const newJobs: Job[] = await Promise.all(
        files.map(async (file) => {
          // サムネ枠を入力画像のアスペクト比に合わせるため寸法を先読み
          let width: number | undefined;
          let height: number | undefined;
          try {
            const bmp = await createImageBitmap(file);
            width = bmp.width;
            height = bmp.height;
            bmp.close();
          } catch {
            /* 寸法は任意 */
          }
          return {
            id: crypto.randomUUID(),
            name: file.name,
            status: "queued" as const,
            file,
            srcUrl: URL.createObjectURL(file),
            width,
            height,
          };
        }),
      );
      setJobs((prev) => [...newJobs, ...prev]);
      await runConcurrent(newJobs, 3, (j) => processJob(j, opts));
      sendNotification(
        "切り抜きが完了しました",
        `${newJobs.length}枚の画像を処理しました`,
      );
    },
    [processJob],
  );

  // --- 現在の設定で再処理 ---
  const reprocessAll = useCallback(async () => {
    const opts = optionsRef.current;
    const targets = jobs.filter(
      (j) => j.file && (j.status === "done" || j.status === "error"),
    );
    if (targets.length === 0) return;
    targets.forEach((j) => patch(j.id, { status: "processing" }));
    await runConcurrent(targets, 3, async (job) => {
      try {
        const result = await runCutout(job.file as File, opts, job.ai?.bbox ?? null);
        const resultUrl = URL.createObjectURL(result.blob);
        patch(job.id, {
          status: "done",
          resultBlob: result.blob,
          resultUrl,
          width: result.width,
          height: result.height,
          persisted: false,
        });
        void persist(
          { ...job, width: result.width, height: result.height },
          result.blob,
          opts,
        );
      } catch (e) {
        patch(job.id, { status: "error", error: errMessage(e) });
      }
    });
    sendNotification("再処理が完了しました", `${targets.length}枚を再処理しました`);
  }, [jobs, patch, persist]);

  const retryJob = useCallback(
    (job: Job) => {
      if (!job.file) return;
      void processJob(job, optionsRef.current);
    },
    [processJob],
  );

  // --- ダウンロード ---
  const resolveBlob = async (job: Job): Promise<Blob | null> => {
    if (job.resultBlob) return job.resultBlob;
    if (job.resultUrl) {
      try {
        return await fetch(job.resultUrl).then((r) => r.blob());
      } catch {
        return null;
      }
    }
    return null;
  };

  const downloadOne = useCallback(async (job: Job) => {
    const blob = await resolveBlob(job);
    if (blob) triggerDownload(blob, toPngName(job.name));
  }, []);

  const downloadAll = useCallback(async () => {
    const done = jobs.filter((j) => j.status === "done");
    const items: { name: string; blob: Blob }[] = [];
    for (const j of done) {
      const blob = await resolveBlob(j);
      if (blob) items.push({ name: j.name, blob });
    }
    if (items.length > 0) await downloadZip(items);
  }, [jobs]);

  // --- 削除 ---
  const removeJob = useCallback(async (job: Job) => {
    setJobs((prev) => prev.filter((j) => j.id !== job.id));
    if (job.srcUrl.startsWith("blob:")) URL.revokeObjectURL(job.srcUrl);
    if (job.resultUrl?.startsWith("blob:")) URL.revokeObjectURL(job.resultUrl);
    if (job.persisted || job.remote) {
      const sb = getSupabase();
      if (sb) {
        try {
          const { data } = await sb.storage.from(BUCKET).list(job.id);
          if (data && data.length > 0) {
            await sb.storage
              .from(BUCKET)
              .remove(data.map((f) => `${job.id}/${f.name}`));
          }
          await sb.from("jobs").delete().eq("id", job.id);
        } catch (e) {
          console.warn("[remove] failed:", e);
        }
      }
    }
  }, []);

  const clearAll = useCallback(() => {
    jobs.forEach((j) => {
      if (j.srcUrl.startsWith("blob:")) URL.revokeObjectURL(j.srcUrl);
      if (j.resultUrl?.startsWith("blob:")) URL.revokeObjectURL(j.resultUrl);
    });
    setJobs([]);
  }, [jobs]);

  const enableNotify = useCallback(async () => {
    const ok = await requestNotificationPermission();
    setNotifyState(notificationPermission());
    if (ok) {
      sendNotification("通知を有効化しました", "処理完了時にお知らせします");
    }
  }, []);

  // --- 集計 ---
  const stats = useMemo(() => {
    let done = 0;
    let working = 0;
    for (const j of jobs) {
      if (j.status === "done") done++;
      else if (j.status !== "error") working++;
    }
    return { done, working, total: jobs.length };
  }, [jobs]);

  const busy = stats.working > 0;
  const hasReprocessable = jobs.some(
    (j) => j.file && (j.status === "done" || j.status === "error"),
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
            アニメ画像 背景透過ツール
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            白背景のイラストをまとめて透過PNGに切り抜き。AI解析・白フチ・一括ダウンロード対応。
          </p>
        </div>
        <button
          type="button"
          onClick={enableNotify}
          disabled={
            notifyState === "granted" || notifyState === "unsupported"
          }
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
        >
          {notifyState === "granted"
            ? "🔔 通知ON"
            : notifyState === "denied"
              ? "🔕 通知ブロック中"
              : notifyState === "unsupported"
                ? "通知 非対応"
                : "🔔 デスクトップ通知を有効化"}
        </button>
      </header>

      <div className="space-y-5">
        <Dropzone onFiles={handleFiles} />

        <SettingsPanel
          options={options}
          onChange={setOptions}
          onReprocess={reprocessAll}
          canReprocess={hasReprocessable}
          busy={busy}
        />

        {jobs.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-5">
            <span className="text-sm text-zinc-400">
              完了 <span className="font-semibold text-zinc-100">{stats.done}</span>
              {" / "}
              全 {stats.total} 枚
              {busy && (
                <span className="ml-2 text-sky-400">処理中… {stats.working}</span>
              )}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={downloadAll}
                disabled={stats.done === 0}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                全てDL（ZIP・{stats.done}枚）
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                クリア
              </button>
            </div>
          </div>
        )}

        {jobs.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-600">
            まだ画像がありません。上のエリアから追加してください。
          </p>
        ) : (
          <div className="grid grid-cols-2 items-start gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {jobs.map((job) => (
              <ImageCard
                key={job.id}
                job={job}
                onDownload={downloadOne}
                onRemove={removeJob}
                onRetry={retryJob}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="mt-12 border-t border-zinc-800 pt-6 text-center text-xs text-zinc-600">
        切り抜きはブラウザ内で処理されます · AI解析: Gemini · 保存: Supabase
      </footer>
    </div>
  );
}
