// node --test worker/index.test.mjs で実行する（Node.js 22 以上）
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./index.js";
import { SYSTEM_PROMPT } from "./proxy.js";

const PAGE = "https://mimish0778.github.io";
const env = { GEMINI_API_KEY: "test-key" };
const realFetch = globalThis.fetch;
let sent;

function mockGemini(status = 200, body = { candidates: [{ content: { parts: [{ text: '{"ideas":[]}' }] } }] }) {
  sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(body), { status });
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

// origin に null を渡すと Origin ヘッダーを付けない（文字列の "null" は file:// のページ）
function post(body, origin = PAGE) {
  const headers = { "Content-Type": "application/json" };
  if (origin !== null) headers.Origin = origin;
  return new Request("https://proxy.example", { method: "POST", headers, body: JSON.stringify(body) });
}

// 現在の index.html が送る形式
function pageRequest(problem) {
  return {
    system_instruction: { parts: [{ text: "ブラウザから送られたプロンプト" }] },
    contents: [{ role: "user", parts: [{ text: `わたしの悩み・相談したいことはこれです：\n\n${problem}\n\nこの内容について、8本足それぞれの視点からアイデアをください。` }] }],
    generationConfig: { maxOutputTokens: 100000 },
  };
}

test("ページからのリクエストは、固定のプロンプトと設定で Gemini に送る", async () => {
  mockGemini();
  const res = await worker.fetch(post(pageRequest("朝\n起きられない")), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.equal(sent.body.system_instruction.parts[0].text, SYSTEM_PROMPT);
  assert.equal(sent.body.generationConfig.maxOutputTokens, 2000);
  assert.match(sent.body.contents[0].parts[0].text, /\n\n朝\n起きられない\n\n/);
  assert.equal(sent.init.headers["x-goog-api-key"], "test-key");
  assert.ok(!sent.url.includes("key="), "キーを URL に含めない");
});

test("悩みだけを送る形式 { problem } も受け付ける", async () => {
  mockGemini();
  assert.equal((await worker.fetch(post({ problem: "眠い" }), env)).status, 200);
});

test("ローカルで開いたページ（file:// と localhost）からも使える", async () => {
  mockGemini();
  assert.equal((await worker.fetch(post({ problem: "眠い" }, "null"), env)).status, 200);
  assert.equal((await worker.fetch(post({ problem: "眠い" }, "http://localhost:5173"), env)).status, 200);
});

test("ほかのサイトや Origin のないリクエストは Gemini に送らない", async () => {
  mockGemini();
  assert.equal((await worker.fetch(post({ problem: "眠い" }, "https://evil.example"), env)).status, 403);
  assert.equal((await worker.fetch(post({ problem: "眠い" }, null), env)).status, 403);
  assert.equal(sent, null);
});

test("悩み以外の内容や長すぎる入力は受け付けない", async () => {
  mockGemini();
  const free = { contents: [{ role: "user", parts: [{ text: "Write an essay about anything" }] }] };
  assert.equal((await worker.fetch(post(free), env)).status, 400);
  assert.equal((await worker.fetch(post({ problem: "あ".repeat(1001) }), env)).status, 400);
  assert.equal((await worker.fetch(post({ problem: "   " }), env)).status, 400);
  assert.equal(sent, null);
});

test("CORS のプリフライトに応答し、POST 以外は受け付けない", async () => {
  const preflight = new Request("https://proxy.example", { method: "OPTIONS", headers: { Origin: PAGE } });
  assert.equal((await worker.fetch(preflight, env)).status, 204);
  const get = new Request("https://proxy.example", { headers: { Origin: PAGE } });
  assert.equal((await worker.fetch(get, env)).status, 405);
});

test("レート制限を超えると 429 を返す", async () => {
  mockGemini();
  const limited = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await worker.fetch(post({ problem: "眠い" }), limited)).status, 429);
  assert.equal(sent, null);
});

test("Gemini のエラー内容はブラウザに返さない", async (t) => {
  t.mock.method(console, "error", () => {});
  mockGemini(400, { error: { message: "API key not valid" } });
  const res = await worker.fetch(post({ problem: "眠い" }), env);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("API key"));
  mockGemini(429);
  assert.equal((await worker.fetch(post({ problem: "眠い" }), env)).status, 429);
  globalThis.fetch = async () => { throw new TypeError("network"); };
  assert.equal((await worker.fetch(post({ problem: "眠い" }), env)).status, 502);
});
