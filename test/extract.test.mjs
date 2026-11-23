import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chunks, extractClaims, parseClaims } from "../dist/extract.js";
import { root, scriptedModel } from "./helpers.mjs";

test("a recorded extraction reply reads into claims with kinds and checkability", async () => {
  const calls = JSON.parse(await readFile(path.join(root, "test/fixtures/recorded/calls.json"), "utf8"));
  const claims = parseClaims(calls.find((c) => c.step === "extract").reply);
  assert.equal(claims.length, 5);
  assert.ok(claims.every((c) => c.quote && c.statement));
  assert.deepEqual(claims.map((c) => c.checkable), [true, true, true, true, false]);
  assert.ok(claims.some((c) => c.kind === "superlative"));
});

test("fenced JSON, unknown kinds and empty quotes are handled", () => {
  const reply = '```json\n{"claims": [{"quote": "Sales rose 4%", "kind": "number"}, {"quote": "", "kind": "date"}, {"quote": "Best café", "checkable": false, "why": "opinion"}]}\n```';
  assert.deepEqual(parseClaims(reply), [
    { quote: "Sales rose 4%", statement: "Sales rose 4%", kind: "named_fact", checkable: true, why: "" },
    { quote: "Best café", statement: "Best café", kind: "named_fact", checkable: false, why: "opinion" },
  ]);
  assert.throws(() => parseClaims("I could not find any claims."), /held no JSON/);
});

test("long text is sent in chunks, claims are kept once and the limit holds", async () => {
  const paragraph = (n) => `Paragraph ${n}: the plant produced ${n} tonnes. ${"Filler words here. ".repeat(60)}\n\n`;
  const text = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join("");
  assert.ok(chunks(text).length > 1);
  assert.equal(chunks(text).join(""), text, "chunks keep every character");

  const model = scriptedModel((_, user) => {
    const found = [...user.matchAll(/the plant produced (\d+) tonnes/g)].map((m) => ({ quote: m[0], statement: m[0], kind: "statistic" }));
    return JSON.stringify({ claims: [...found, { quote: "the plant produced 1 tonnes", statement: "the plant produced 1 tonnes" }] });
  });
  const claims = await extractClaims(model, text, 5);
  assert.equal(claims.length, 5);
  assert.equal(new Set(claims.map((c) => c.statement)).size, 5);
});
