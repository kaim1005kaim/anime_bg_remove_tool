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
