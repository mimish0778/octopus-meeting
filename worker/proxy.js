// プロキシの設定と、リクエストの検証に使う関数。
// Workers のエントリ（index.js）は default export しか持てないため、テストから使うものはここに置く

export const MODEL = "gemini-2.5-flash-lite";
export const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export const MAX_PROBLEM_LENGTH = 1000;

export const ALLOWED_ORIGINS = new Set([
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

export const GENERATION_CONFIG = {
  temperature: 1,
  maxOutputTokens: 2000,
  responseMimeType: "application/json",
};

export function isAllowedOrigin(origin) {
  return origin !== null && (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN.test(origin));
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

// Gemini に送るリクエスト本文。ブラウザから届いたものは悩みのテキストしか使わない
export function buildGeminiRequest(problem) {
  return {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: "user",
      parts: [{ text: `わたしの悩み・相談したいことはこれです：\n\n${problem}\n\nこの内容について、8本足それぞれの視点からアイデアをください。` }],
    }],
    generationConfig: GENERATION_CONFIG,
  };
}
