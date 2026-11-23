import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedFrom, settle } from "../dist/judge.js";

const passages = [
  { id: "P1", url: "https://a.example/tower", title: "Tower", text: "The tower was built from 1887 to 1889 for the World’s Fair." },
  { id: "P2", url: "https://b.example/visits", title: "Visits", text: "About 6.9 million people visited it in 2015." },
];

test("a quote counts only when its words are in the passage, ignoring case, quote style and spacing", () => {
  assert.ok(quotedFrom("built from 1887 to 1889", passages[0].text));
  assert.ok(quotedFrom("THE TOWER WAS BUILT   from 1887", passages[0].text));
  assert.ok(quotedFrom("for the World's Fair", passages[0].text));
  assert.ok(quotedFrom("The tower was built ... for the World's Fair", passages[0].text));
  assert.ok(!quotedFrom("for the World's Fair ... The tower was built", passages[0].text), "parts must be in order");
  assert.ok(!quotedFrom("built from 1897 to 1899", passages[0].text));
  assert.ok(!quotedFrom("1889", passages[0].text), "too short to show anything");
});

test("supported and contradicted carry the passage and the quote", () => {
  const supported = settle({ verdict: "supported", passage: "P2", quote: "6.9 million people visited it in 2015", why: "It gives 6.9 million." }, passages);
  assert.equal(supported.verdict, "supported");
  assert.equal(supported.source.url, "https://b.example/visits");
  assert.equal(supported.source.passage, passages[1].text);
  assert.equal(supported.why, "It gives 6.9 million.");

  const contradicted = settle({ verdict: "contradicted", passage: "[P1]", quote: "built from 1887 to 1889" }, passages);
  assert.equal(contradicted.verdict, "contradicted");
  assert.equal(contradicted.source.quote, "built from 1887 to 1889");
});

test("a verdict whose quote is not in a fetched passage is reported without a source", () => {
  for (const reply of [
    { verdict: "supported", passage: "P1", quote: "The tower was completed in 1899", why: "It says so." },
    { verdict: "contradicted", passage: "P9", quote: "built from 1887 to 1889" },
    { verdict: "supported", passage: "P1", quote: "" },
  ]) {
    const judged = settle(reply, passages);
    assert.equal(judged.verdict, "no_source_found");
    assert.equal(judged.source, null);
    assert.match(judged.why, /quote is not in any page that was read/);
  }
});

test("not addressed, or anything else, is no source found with the model's reason", () => {
  assert.deepEqual(settle({ verdict: "not_addressed", why: "The pages are about the park." }, passages), {
    verdict: "no_source_found",
    why: "The pages are about the park.",
    source: null,
  });
  assert.equal(settle({ verdict: "probably" }, passages).verdict, "no_source_found");
});
