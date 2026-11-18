// たこ先生の Gemini API プロキシ（Cloudflare Workers）
//
// ブラウザから届いたリクエストをそのまま Gemini に流すと、誰でもこのプロキシを
// 無料の Gemini API として使えてしまう。そこで次のようにしている。
//
// - システムプロンプトと生成設定はこのファイルで固定し、ブラウザから送られたものは使わない
// - 受け付けるのは「悩み」のテキスト 1 つだけで、長さに上限を設ける
// - 送信元（Origin）を公開ページとローカルに限る（ブラウザ以外からの悪用は防げないため、
//   レート制限と組み合わせる）
// - RATE_LIMITER（Workers Rate Limiting）が設定されていれば、IP アドレスごとに回数を制限する
//
// 必要な設定: シークレット GEMINI_API_KEY（`npx wrangler secret put GEMINI_API_KEY`）

const MODEL = "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export const MAX_PROBLEM_LENGTH = 1000;

const ALLOWED_ORIGINS = new Set([
  "https://mimish0778.github.io",
  "null", // ローカルで index.html を直接開いた場合（file://）
]);
const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const SYSTEM_PROMPT = `あなたは「たこ先生」という、8本の足を持つ赤い自信満々なタコのキャラクターです。鉢巻きをして指し棒を持ち、相談相手の悩みに対して8本足それぞれが全く異なる視点・発想からアイデアを出してくれます。
口調は常に上から目線で、相手をちょっと馬鹿にしたような、自信満々な態度で話してください。語尾は「〜じゃん」「〜だし」などを多用してください。「そんなことも知らないの？」「当たり前じゃん」「え、それで悩んでたの？」みたいなニュアンスを含めつつ、でも実用的なアドバイスはちゃんと出してください。

ユーザーから日本語で悩みや課題が渡されます。それに対して、以下の8つの異なる視点に沿って、それぞれ短く具体的なアイデアを1つずつ出してください。

1. 逆転の発想（常識をひっくり返す）
2. 引き算の発想（やめる・減らす）
3. 他人の視点（全く違う立場の人ならどうするか）
4. 時間軸をずらす（過去や未来の視点）
5. 遊び心の発想（ゲームや遊びにする）
6. 環境を変える発想（場所・道具・仕組みを変える）
7. 小さな一歩（今すぐ5分でできる最小の行動）
8. 誰かに頼る発想（人や仕組みに任せる）

必ず以下のJSON形式のみで出力してください。前置きや説明、Markdownのコードブロック記号は一切つけないでください。

{
  "ideas": [
    { "title": "10〜18文字程度の短いキャッチタイトル", "body": "そのアイデアの説明。2〜3文程度、80〜140文字程度。上から目線で自信満々、ちょっと馬鹿にした口調で。語尾は「〜じゃん」「〜だし」などを使う。でも内容はちゃんと実用的にする。" },
    ... (合計8個、上記の順番で)
  ],
  "summary": "8つのアイデアを踏まえた、たこ先生からの一言まとめ。60〜100文字程度。上から目線で自信満々、「まあ、これくらい知っておいてよね」「わかった？じゃあやってみなよ」みたいなニュアンスで。"
}`;

const GENERATION_CONFIG = {
  temperature: 1,
  maxOutputTokens: 2000,
  responseMimeType: "application/json",
};

function isAllowedOrigin(origin) {
  return origin !== null && (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN.test(origin));
}

function json(body, status, origin) {
  const headers = { "Content-Type": "application/json" };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function error(message, status, origin) {
  return json({ error: { message } }, status, origin);
}

// 悩みのテキストを取り出す。新しい形式 { problem } と、
// これまでの index.html が送る generateContent 形式の両方を受け付ける
export function extractProblem(body) {
  if (body && typeof body.problem === "string") {
    return body.problem;
  }
  const contents = body && body.contents;
  if (Array.isArray(contents) && contents.length === 1) {
    const parts = contents[0] && contents[0].parts;
    if (Array.isArray(parts) && parts.length === 1 && typeof parts[0].text === "string") {
      // 「わたしの悩み・相談したいことはこれです：\n\n<悩み>\n\nこの内容について…」から悩みだけを取り出す
      const m = parts[0].text.match(/^わたしの悩み・相談したいことはこれです：\n\n([\s\S]*)\n\nこの内容について、8本足それぞれの視点からアイデアをください。$/);
      return m ? m[1] : null;
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }
    if (request.method !== "POST") return error("POST only", 405, origin);
    if (!isAllowedOrigin(origin)) return error("Origin not allowed", 403, origin);

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return error("Too many requests", 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return error("Invalid JSON", 400, origin);
    }
    const problem = extractProblem(body);
    if (problem === null || problem.trim() === "") return error("Invalid request", 400, origin);
    if (problem.length > MAX_PROBLEM_LENGTH) {
      return error(`Problem must be ${MAX_PROBLEM_LENGTH} characters or fewer`, 400, origin);
    }

    const upstream = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
          role: "user",
          parts: [{ text: `わたしの悩み・相談したいことはこれです：\n\n${problem}\n\nこの内容について、8本足それぞれの視点からアイデアをください。` }],
        }],
        generationConfig: GENERATION_CONFIG,
      }),
    });

    if (!upstream.ok) {
      // Gemini のエラー内容（キーの情報を含むことがある）はブラウザに返さない
      console.error("Gemini error", upstream.status, await upstream.text());
      const status = upstream.status === 429 ? 429 : 502;
      return error("Upstream error", status, origin);
    }
    return json(await upstream.json(), 200, origin);
  },
};
