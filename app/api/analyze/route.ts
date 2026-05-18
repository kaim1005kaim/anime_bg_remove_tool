import { GoogleGenAI, Type } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 30;

const PROMPT = `あなたは背景透過処理の前処理アシスタントです。これはアニメ・イラスト調の画像で、白背景の自動切り抜きを行います。
次を判定し、指定の JSON スキーマで返してください:
- box_2d: 主要な被写体(キャラクター等)を囲む最小の矩形。[ymin, xmin, ymax, xmax] の順で 0〜1000 に正規化した整数。
- background_clean: 背景が一様な白で自動切り抜きに適していれば true、そうでなければ false。
- note: 切り抜きで問題になりそうな点を日本語で1〜2文。例: 背景が完全な白でない / 被写体が画像端で見切れている / 被写体内部の白が背景と繋がって消える可能性。問題が無ければ「背景は白く良好です。」と返す。`;

interface GeminiResult {
  box_2d?: number[];
  background_clean?: boolean;
  note?: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;
  // キー未設定でもアプリを止めない: 解析をスキップした応答を返す
  if (!apiKey) {
    return Response.json({ bbox: null, backgroundOk: true, note: "" });
  }

  let image: string | undefined;
  try {
    const body = await request.json();
    image = body?.image;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof image !== "string" || !image.startsWith("data:")) {
    return Response.json({ error: "invalid_image" }, { status: 400 });
  }

  const comma = image.indexOf(",");
  const meta = image.slice(5, comma);
  const mimeType = meta.split(";")[0] || "image/jpeg";
  const base64 = image.slice(comma + 1);

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType, data: base64 } },
        { text: PROMPT },
      ],
      config: {
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            box_2d: {
              type: Type.ARRAY,
              items: { type: Type.NUMBER },
              minItems: "4",
              maxItems: "4",
            },
            background_clean: { type: Type.BOOLEAN },
            note: { type: Type.STRING },
          },
          required: ["box_2d", "background_clean", "note"],
        },
      },
    });

    const text = response.text;
    if (!text) {
      return Response.json({ bbox: null, backgroundOk: true, note: "" });
    }
    const parsed = JSON.parse(text) as GeminiResult;

    let bbox: { x: number; y: number; w: number; h: number } | null = null;
    const box = parsed.box_2d;
    if (Array.isArray(box) && box.length === 4) {
      const ymin = clamp01(box[0] / 1000);
      const xmin = clamp01(box[1] / 1000);
      const ymax = clamp01(box[2] / 1000);
      const xmax = clamp01(box[3] / 1000);
      bbox = {
        x: Math.min(xmin, xmax),
        y: Math.min(ymin, ymax),
        w: Math.abs(xmax - xmin),
        h: Math.abs(ymax - ymin),
      };
    }

    return Response.json({
      bbox,
      backgroundOk: parsed.background_clean !== false,
      note: typeof parsed.note === "string" ? parsed.note : "",
    });
  } catch (err) {
    console.error("[analyze] Gemini error:", err);
    // 解析失敗でも切り抜きは続行できるよう 200 でフォールバックを返す
    return Response.json({ bbox: null, backgroundOk: true, note: "" });
  }
}
