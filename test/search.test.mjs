import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { brave, serper, tavily, SearchError } from "../dist/index.js";
import { parseBrave, parseSerper, parseTavily } from "../dist/search/index.js";
import { root } from "./helpers.mjs";

const fixture = async (name) => JSON.parse(await readFile(path.join(root, "test/fixtures/search", name), "utf8"));

function recordingFetch(body, status = 200) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url: String(url), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, seen };
}

test("each provider's answer reads into address, title and snippet, skipping entries without an http address", async () => {
  assert.deepEqual(parseBrave(await fixture("brave.json")), [
    { url: "https://history.example/harbour-bridge", title: "Harbour bridge history", snippet: "The harbour bridge opened to traffic in the spring of 1932 after eight years of work." },
    { url: "https://visit.example/bridge", title: "Visiting the bridge", snippet: "Opening hours and tickets." },
  ]);
  assert.deepEqual(parseSerper(await fixture("serper.json")).map((r) => r.url), ["https://history.example/harbour-bridge", "https://engineering.example/arch"]);
  assert.deepEqual(parseTavily(await fixture("tavily.json")).map((r) => [r.url, r.snippet.slice(0, 20)]), [
    ["https://archive.example/harbour-bridge", "Harbour bridge, a st"],
  ]);
  assert.deepEqual(parseBrave({}), []);
  assert.deepEqual(parseSerper({ organic: "nope" }), []);
});

test("Brave is called with the query, count and subscription token", async () => {
  const { impl, seen } = recordingFetch(await fixture("brave.json"));
  const results = await brave("k-brave", impl).search("When did the harbour bridge open?", 3);
  assert.equal(results.length, 2);
  const url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(url.searchParams.get("q"), "When did the harbour bridge open?");
  assert.equal(url.searchParams.get("count"), "3");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].headers["x-subscription-token"], "k-brave");
});

test("Serper and Tavily are posted JSON with their own key headers", async () => {
  const s = recordingFetch(await fixture("serper.json"));
  assert.equal((await serper("k-serper", s.impl).search("harbour bridge opened", 1)).length, 1);
  assert.equal(s.seen[0].url, "https://google.serper.dev/search");
  assert.equal(s.seen[0].headers["x-api-key"], "k-serper");
  assert.deepEqual(s.seen[0].body, { q: "harbour bridge opened", num: 1 });

  const t = recordingFetch(await fixture("tavily.json"));
  await tavily("k-tavily", t.impl).search("harbour bridge opened", 5);
  assert.equal(t.seen[0].url, "https://api.tavily.com/search");
  assert.equal(t.seen[0].headers.authorization, "Bearer k-tavily");
  assert.deepEqual(t.seen[0].body, { query: "harbour bridge opened", max_results: 5, search_depth: "basic" });
});

test("a refusal from the provider is a SearchError naming it and the status", async () => {
  const { impl } = recordingFetch({ message: "quota" }, 429);
  await assert.rejects(serper("k", impl).search("q", 3), (error) => error instanceof SearchError && /Serper search answered 429/.test(error.message));
});
