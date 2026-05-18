import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const BUCKET = "results";

let client: SupabaseClient | null = null;

/**
 * Supabase クライアントを返す。環境変数が未設定なら null を返し、
 * 呼び出し側はギャラリーの永続化をスキップする（セッション内のみ動作）。
 */
export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (!client) client = createClient(url, anonKey);
  return client;
}

export function publicUrl(path: string): string {
  return `${url}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** results バケットの全オブジェクトと jobs テーブルの全行を削除する */
export async function clearAllRemote(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data: folders } = await sb.storage
      .from(BUCKET)
      .list("", { limit: 1000 });
    for (const folder of folders ?? []) {
      const { data: files } = await sb.storage
        .from(BUCKET)
        .list(folder.name, { limit: 1000 });
      if (files && files.length > 0) {
        await sb.storage
          .from(BUCKET)
          .remove(files.map((f) => `${folder.name}/${f.name}`));
      }
    }
    await sb.from("jobs").delete().not("id", "is", null);
  } catch (e) {
    console.warn("[clearAllRemote] failed:", e);
  }
}
