import assert from "node:assert/strict";
import { test } from "node:test";
import { citedFor, lineOf, locate, parseDocument } from "../dist/text.js";

function citedForQuote(doc, quote) {
  const span = locate(doc, quote);
  assert.ok(span, `quote not found: ${quote}`);
  return citedFor(doc, span);
}

test("every way Markdown cites an address is kept for the sentence it is in", () => {
  const doc = parseDocument(
    [
      "Inline: the bridge opened in 1932 ([source](https://a.example/bridge)).",
      "",
      "Reference: the tunnel is 9 km long [per the survey][survey].",
      "",
      "Footnote: the dam holds 40 million cubic metres.[^dam]",
      "",
      "Bare: the canal carried 3,000 ships in 1914 https://c.example/canal.",
      "",
      "Angle: the tower has 72 floors <https://d.example/tower>.",
      "",
      'HTML: the port moved 5 million tonnes <a href="https://e.example/port">in 2020</a>.',
      "",
      "[survey]: https://b.example/survey \"Survey\"",
      "[^dam]: Water board, https://f.example/dam",
    ].join("\n"),
  );
  assert.deepEqual(citedForQuote(doc, "the bridge opened in 1932"), ["https://a.example/bridge"]);
  assert.deepEqual(citedForQuote(doc, "the tunnel is 9 km long"), ["https://b.example/survey"]);
  assert.deepEqual(citedForQuote(doc, "the dam holds 40 million cubic metres"), ["https://f.example/dam"]);
  assert.deepEqual(citedForQuote(doc, "the canal carried 3,000 ships in 1914"), ["https://c.example/canal"]);
  assert.deepEqual(citedForQuote(doc, "the tower has 72 floors"), ["https://d.example/tower"]);
  assert.deepEqual(citedForQuote(doc, "the port moved 5 million tonnes in 2020"), ["https://e.example/port"]);
  assert.ok(!doc.prose.includes("https://"), "addresses are not part of the prose a model quotes");
});

test("the claim's own sentence comes before the rest of its paragraph, and other paragraphs are left out", () => {
  const doc = parseDocument(
    "The mill opened in 1890 ([one](https://one.example)). It closed in 1960 ([two](https://two.example)).\n\nA later paragraph ([three](https://three.example)).",
  );
  assert.deepEqual(citedForQuote(doc, "It closed in 1960"), ["https://two.example/", "https://one.example/"]);
  assert.ok(!citedForQuote(doc, "The mill opened in 1890").includes("https://three.example/"));
});

test("front matter and code keep their lines, so line numbers match the file", () => {
  const doc = parseDocument(["---", "title: x", "---", "", "```", "const share = '45%';", "```", "", "Sales rose 45% in 2023."].join("\n"));
  assert.ok(!doc.prose.includes("const share"));
  assert.ok(!doc.prose.includes("title:"));
  assert.equal(lineOf(doc, locate(doc, "Sales rose 45% in 2023").start), 9);
});

test("a quote is found despite curly quotes, dashes, emphasis and line wrapping", () => {
  const doc = parseDocument("The **report** says “growth” was 4–5%\nin the second quarter.");
  const span = locate(doc, 'The report says "growth" was 4-5% in the second quarter.');
  assert.ok(span);
  assert.equal(lineOf(doc, span.start), 1);
});

test("a quote that is not in the text, nor close to any sentence, is not placed", () => {
  const doc = parseDocument("The museum opened in 1901.");
  assert.equal(locate(doc, "The aquarium holds 2,000 species of fish"), null);
  assert.ok(locate(doc, "the museum first opened in 1901"), "a near copy of one sentence is placed on it");
});

test("relative links resolve only when the page's own address is known", () => {
  assert.deepEqual(parseDocument("See [the data](/stats).").links, []);
  assert.equal(parseDocument("See [the data](/stats).", "https://site.example/blog/post").links[0].url, "https://site.example/stats");
});
