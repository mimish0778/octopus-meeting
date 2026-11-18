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

import {
  GEMINI_URL,
  MAX_PROBLEM_LENGTH,
  buildGeminiRequest,
  extractProblem,
  isAllowedOrigin,
} from "./proxy.js";

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

    let upstream;
    try {
      upstream = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(buildGeminiRequest(problem)),
      });
    } catch (e) {
      console.error("Gemini request failed", e);
      return error("Upstream error", 502, origin);
    }

    if (!upstream.ok) {
      // Gemini のエラー内容（キーの情報を含むことがある）はブラウザに返さない
      console.error("Gemini error", upstream.status, await upstream.text());
      const status = upstream.status === 429 ? 429 : 502;
      return error("Upstream error", status, origin);
    }
    return json(await upstream.json(), 200, origin);
  },
};
