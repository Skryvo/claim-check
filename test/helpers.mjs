import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FetchError } from "../dist/index.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function stepOf(system) {
  return system.startsWith("You read a document") ? "extract" : "judge";
}

/** Extraction lists every given claim whose quote is in the chunk; judging defers to `judge(user)`. */
export function answers(claims, judge = () => ({ verdict: "not_addressed", passage: "", quote: "", why: "Not stated." })) {
  return (step, user) =>
    step === "extract"
      ? JSON.stringify({
          claims: claims
            .filter((c) => user.includes(c.quote))
            .map((c) => ({ statement: c.quote, kind: "statistic", checkable: true, why: "", ...c })),
        })
      : JSON.stringify(judge(user));
}

export function scriptedModel(answer) {
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0, cost: null };
  const calls = [];
  return {
    name: "test-model",
    usage,
    calls,
    async complete(system, user) {
      usage.calls++;
      usage.promptTokens += 10;
      usage.completionTokens += 5;
      const step = stepOf(system);
      calls.push({ step, user });
      return answer(step, user);
    },
  };
}

export async function modelServer(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, headers: req.headers, body });
      const system = body.messages[0].content;
      const user = body.messages[1].content;
      const reply = answer(stepOf(system), user, body);
      if (typeof reply === "object" && reply.status) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: reply.message } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function pages(map) {
  const fetched = [];
  const fetchText = async (url) => {
    fetched.push(url);
    if (!(url in map)) throw new FetchError("HTTP 404");
    const page = map[url];
    return typeof page === "string"
      ? { url, contentType: "text/html; charset=utf-8", body: page, truncated: false }
      : { url, contentType: page.contentType, body: page.body, truncated: false };
  };
  fetchText.fetched = fetched;
  return fetchText;
}

export function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "claim-check-"));
}

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAIM_CHECK_") || key.startsWith("INPUT_") || key.startsWith("GITHUB_") || key === "NO_COLOR") delete env[key];
  }
  for (const key of ["BRAVE_SEARCH_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"]) delete env[key];
  return { ...env, ...extra };
}
