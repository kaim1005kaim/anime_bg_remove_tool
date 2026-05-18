import JSZip from "jszip";

/** Blob をファイルとしてダウンロードさせる */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 元のファイル名から拡張子を .png に変えた名前を返す */
export function toPngName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "") + ".png";
}

export interface ZipItem {
  name: string;
  blob: Blob;
}

/** 複数の PNG を ZIP にまとめてダウンロードする */
export async function downloadZip(
  items: ZipItem[],
  zipName = "cutouts.zip",
): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const item of items) {
    let name = toPngName(item.name);
    let n = name;
    let i = 1;
    while (used.has(n)) {
      n = name.replace(/\.png$/, `_${i++}.png`);
    }
    used.add(n);
    zip.file(n, item.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, zipName);
}
