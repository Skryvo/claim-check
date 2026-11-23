import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createChecker, SearchError } from "../dist/index.js";
import { quotedFrom } from "../dist/judge.js";
import { answers, pages, root, scriptedModel } from "./helpers.mjs";

const recorded = async (name) => JSON.parse(await readFile(path.join(root, "test/fixtures/recorded", name), "utf8"));

test("a recorded live run replays to the same verdicts, lines, sources and quotes", async () => {
  const calls = await recorded("calls.json");
  const saved = await recorded("pages.json");
  const expected = await recorded("report.json");
  const judged = new Map(calls.filter((c) => c.step === "judge").map((c) => [c.user.split("\n")[0], c.reply]));
  // Only the judged passages were kept, so they may come back in another order: the recorded reply is pointed at the passage holding its quote.
  const model = scriptedModel((step, user) => {
    if (step === "extract") return calls.find((c) => c.step === "extract").reply;
    const reply = JSON.parse(judged.get(user.split("\n")[0]));
    const holder = user.split("PASSAGES:\n")[1].split(/\n\n(?=\[P\d+\] )/).find((p) => quotedFrom(reply.quote, p));
    return JSON.stringify({ ...reply, passage: holder ? /^\[(P\d+)\]/.exec(holder)[1] : reply.passage });
  });
  const fetchText = pages(Object.fromEntries(Object.entries(saved).map(([url, page]) => [url, { contentType: "text/plain", body: page.text }])));
  const text = await readFile(path.join(root, "examples/sample.md"), "utf8");

  const report = await createChecker({ model, fetchText }).checkText(text, { input: "examples/sample.md" });
  const shape = (r) => r.claims.map((c) => [c.verdict, c.line, c.kind, c.source?.url ?? null, c.source?.quote ?? null]);
  assert.deepEqual(shape(report), shape(expected));
  assert.deepEqual(report.counts, { supported: 2, contradicted: 1, no_source_found: 1, not_checkable: 1 });
  assert.equal(report.search, "cited");
});

const tower = "<html><head><title>Tower</title></head><body><nav>Menu</nav><p>The tower was built from 1887 to 1889 as the entrance to the fair, and it is still the tallest structure in the city today.</p></body></html>";

test("a claim citing nothing, in cited mode, says so, and no model call is spent judging it", async () => {
  const model = scriptedModel(answers([{ quote: "Sales grew 40% in 2024" }]));
  const report = await createChecker({ model, fetchText: pages({}) }).checkText("Sales grew 40% in 2024.");
  assert.equal(report.claims[0].verdict, "no_source_found");
  assert.equal(report.claims[0].why, "The text cites no address for it, and no web search is set.");
  assert.deepEqual(model.calls.map((c) => c.step), ["extract"]);
});

test("an unreadable cited page is named with its error", async () => {
  const model = scriptedModel(answers([{ quote: "The tower was built in 1889" }]));
  const report = await createChecker({ model, fetchText: pages({}) }).checkText("The tower was built in 1889 ([x](https://gone.example/page)).");
  assert.equal(report.claims[0].verdict, "no_source_found");
  assert.equal(report.claims[0].why, "No page could be read: gone.example (HTTP 404).");
  assert.deepEqual(report.claims[0].consulted, [{ url: "https://gone.example/page", via: "cited", read: false, error: "HTTP 404" }]);
});

test("a cited page is fetched once however many claims cite it, and the judge sees its passage", async () => {
  const claims = [{ quote: "The tower was built from 1887 to 1889" }, { quote: "It is the tallest structure in the city" }];
  const model = scriptedModel(
    answers(claims, (user) =>
      user.includes("1887 to 1889")
        ? { verdict: "supported", passage: "P1", quote: "built from 1887 to 1889", why: "The page gives those years." }
        : { verdict: "supported", passage: "P1", quote: "still the tallest structure in the city", why: "The page says so." },
    ),
  );
  const fetchText = pages({ "https://tower.example/": tower });
  const report = await createChecker({ model, fetchText }).checkText(
    "The tower was built from 1887 to 1889 ([page](https://tower.example/)). It is the tallest structure in the city ([page](https://tower.example/)).",
  );
  assert.deepEqual(report.claims.map((c) => c.verdict), ["supported", "supported"]);
  assert.equal(report.claims[0].source.title, "Tower");
  assert.deepEqual(fetchText.fetched, ["https://tower.example/"]);
  assert.ok(!model.calls[1].user.includes("Menu"), "navigation is not evidence");
});

test("a model that misquotes the page gets no source, whatever it says", async () => {
  const model = scriptedModel(
    answers([{ quote: "The tower was built in 1899" }], () => ({ verdict: "supported", passage: "P1", quote: "built in 1899", why: "Yes." })),
  );
  const report = await createChecker({ model, fetchText: pages({ "https://tower.example/": tower }) }).checkText(
    "The tower was built in 1899 (https://tower.example/).",
  );
  assert.equal(report.claims[0].verdict, "no_source_found");
  assert.equal(report.claims[0].source, null);
});

test("with a search provider, cited pages come first, then new results, never the input itself", async () => {
  const searched = [];
  const search = {
    name: "fake",
    async search(query, count) {
      searched.push([query, count]);
      return [
        { url: "https://tower.example/", title: "dup", snippet: "" },
        { url: "https://self.example/post", title: "self", snippet: "" },
        { url: "https://other.example/a", title: "a", snippet: "" },
      ];
    },
  };
  const model = scriptedModel(
    answers([{ quote: "The tower was built from 1887 to 1889", statement: "The Paris tower was built from 1887 to 1889." }], () => ({
      verdict: "supported",
      passage: "P1",
      quote: "built from 1887 to 1889",
    })),
  );
  const fetchText = pages({ "https://tower.example/": tower, "https://other.example/a": tower });
  const report = await createChecker({ model, search, fetchText }).checkText("The tower was built from 1887 to 1889 (https://tower.example).", {
    base: "https://self.example/post",
  });
  assert.deepEqual(searched, [["The Paris tower was built from 1887 to 1889.", 5]]);
  assert.deepEqual(report.claims[0].consulted.map((c) => [c.url, c.via]), [
    ["https://tower.example/", "cited"],
    ["https://other.example/a", "search"],
  ]);
  assert.equal(report.search, "fake");
});

test("a failed search is reported in the verdict's reason", async () => {
  const search = { name: "fake", search: async () => { throw new SearchError("fake search answered 429: slow down"); } };
  const model = scriptedModel(answers([{ quote: "Sales grew 40% in 2024" }]));
  const report = await createChecker({ model, search, fetchText: pages({}) }).checkText("Sales grew 40% in 2024.");
  assert.match(report.claims[0].why, /the search failed: fake search answered 429/);
});

test("not checkable claims are reported with why and never looked up", async () => {
  const model = scriptedModel(answers([{ quote: "Paris is the loveliest city", checkable: false, why: "opinion", kind: "superlative" }]));
  const fetchText = pages({});
  const report = await createChecker({ model, fetchText }).checkText("Paris is the loveliest city ([x](https://x.example)).");
  assert.equal(report.claims[0].verdict, "not_checkable");
  assert.equal(report.claims[0].why, "opinion");
  assert.deepEqual(fetchText.fetched, []);
});

test("a line filter keeps only the claims on those lines; claims the text does not contain are dropped", async () => {
  const model = scriptedModel(() =>
    JSON.stringify({ claims: [{ quote: "Revenue was $4 million" }, { quote: "Staff grew to 50" }, { quote: "The model invented this one entirely" }] }),
  );
  const report = await createChecker({ model, fetchText: pages({}) }).checkText("Revenue was $4 million.\n\nStaff grew to 50.\n", { lines: new Set([3]) });
  assert.deepEqual(report.claims.map((c) => [c.id, c.line, c.text]), [["c1", 3, "Staff grew to 50"]]);
});

test("check_claim takes the claim as written and only http(s) sources", async () => {
  const model = scriptedModel((step) =>
    step === "extract"
      ? JSON.stringify({ claims: [{ quote: "x", statement: "rewritten", kind: "date" }] })
      : JSON.stringify({ verdict: "contradicted", passage: "P1", quote: "built from 1887 to 1889", why: "The page gives 1889." }),
  );
  const fetchText = pages({ "https://tower.example/": tower });
  const report = await createChecker({ model, fetchText }).checkClaim("The tower was built  in 1899.", ["file:///etc/passwd", "https://tower.example/"]);
  assert.equal(report.input, "claim");
  assert.equal(report.claims[0].statement, "The tower was built in 1899.");
  assert.equal(report.claims[0].kind, "date");
  assert.equal(report.claims[0].verdict, "contradicted");
  assert.deepEqual(fetchText.fetched, ["https://tower.example/"]);
  assert.deepEqual(report.usage, { calls: 2, promptTokens: 20, completionTokens: 10, cost: null });
});

test("a claim the model finds nothing in is not checkable", async () => {
  const model = scriptedModel(() => JSON.stringify({ claims: [] }));
  const report = await createChecker({ model, fetchText: pages({}) }).checkClaim("Hello there");
  assert.equal(report.claims[0].verdict, "not_checkable");
});
