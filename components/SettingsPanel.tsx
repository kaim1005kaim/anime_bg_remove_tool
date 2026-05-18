"use client";

import type { CutoutOptions } from "@/lib/types";

interface Props {
  options: CutoutOptions;
  onChange: (o: CutoutOptions) => void;
  onReprocess: () => void;
  canReprocess: boolean;
  busy: boolean;
}

export default function SettingsPanel({
  options,
  onChange,
  onReprocess,
  canReprocess,
  busy,
}: Props) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
        {/* 白フチ ON/OFF */}
        <label className="flex cursor-pointer items-center gap-3 select-none">
          <span className="text-sm font-medium text-zinc-200">白フチ</span>
          <button
            type="button"
            role="switch"
            aria-checked={options.whiteFrame}
            onClick={() =>
              onChange({ ...options, whiteFrame: !options.whiteFrame })
            }
            className={`relative h-6 w-11 rounded-full transition-colors ${
              options.whiteFrame ? "bg-sky-500" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                options.whiteFrame ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>

        {/* フチの太さ */}
        <div
          className={`flex items-center gap-3 ${
            options.whiteFrame ? "" : "opacity-40"
          }`}
        >
          <span className="text-sm text-zinc-300">
            フチの太さ
            <span className="ml-1 tabular-nums text-zinc-500">
              {options.frameWidth}px
            </span>
          </span>
          <input
            type="range"
            min={2}
            max={48}
            step={1}
            value={options.frameWidth}
            disabled={!options.whiteFrame}
            onChange={(e) =>
              onChange({ ...options, frameWidth: Number(e.target.value) })
            }
            className="w-40 accent-sky-500"
          />
        </div>

        {/* 背景白の許容度 */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-300">
            背景の許容度
            <span className="ml-1 tabular-nums text-zinc-500">
              {options.tolerance}
            </span>
          </span>
          <input
            type="range"
            min={5}
            max={80}
            step={1}
            value={options.tolerance}
            onChange={(e) =>
              onChange({ ...options, tolerance: Number(e.target.value) })
            }
            className="w-40 accent-sky-500"
          />
        </div>

        <button
          type="button"
          onClick={onReprocess}
          disabled={!canReprocess || busy}
          className="ml-auto rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          現在の設定で再処理
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        許容度を上げると白に近い色まで透過します。線画に隙間がある画像で背景が残る場合は値を上げてください。
      </p>
    </div>
  );
}
