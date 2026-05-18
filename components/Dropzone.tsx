"use client";

import { useCallback, useRef, useState } from "react";

interface Props {
  onFiles: (files: File[]) => void;
}

export default function Dropzone({ onFiles }: Props) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const files = Array.from(list).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
        over
          ? "border-sky-400 bg-sky-400/10"
          : "border-zinc-700 bg-zinc-900/60 hover:border-zinc-500 hover:bg-zinc-900"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      <svg
        width="44"
        height="44"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={over ? "text-sky-400" : "text-zinc-400"}
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <div>
        <p className="text-base font-medium text-zinc-100">
          画像をドラッグ&ドロップ
        </p>
        <p className="mt-1 text-sm text-zinc-400">
          またはクリックして選択（複数枚まとめてOK・白背景のPNG/JPEG）
        </p>
      </div>
    </div>
  );
}
