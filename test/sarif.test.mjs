import assert from "node:assert/strict";
import { test } from "node:test";
import { failing, toSarif, VERSION } from "../dist/index.js";

const claim = (id, verdict, line, source = null) => ({
  id,
  text: `claim ${id}`,
  statement: `Claim ${id}.`,
  kind: "statistic",
  line,
  verdict,
  why: `Because ${id}.`,
  source,
  consulted: [],
});

const report = {
  input: "docs/post.md",
  model: "m",
  search: "cited",
  claims: [
    claim("c1", "supported", 2, { url: "https://a.example", title: "", passage: "p", quote: "q" }),
    claim("c2", "contradicted", 4, { url: "https://b.example", title: "", passage: "p", quote: "it was 1889" }),
    claim("c3", "no_source_found", 6),
    claim("c4", "not_checkable", null),
  ],
  counts: { supported: 1, contradicted: 1, no_source_found: 1, not_checkable: 1 },
  usage: { calls: 1, promptTokens: 1, completionTokens: 1, cost: null },
};

test("SARIF has the schema, the tool, three rules and one result per claim that is not supported", () => {
  const sarif = toSarif([report]);
  assert.equal(sarif.$schema, "https://json.schemastore.org/sarif-2.1.0.json");
  assert.equal(sarif.version, "2.1.0");
  const { driver } = sarif.runs[0].tool;
  assert.equal(driver.name, "claim-check");
  assert.equal(driver.version, VERSION);
  assert.deepEqual(driver.rules.map((r) => [r.id, r.defaultConfiguration.level]), [
    ["contradicted", "error"],
    ["no-source-found", "warning"],
    ["not-checkable", "note"],
  ]);
  const results = sarif.runs[0].results;
  assert.deepEqual(results.map((r) => [r.ruleId, r.ruleIndex, r.level]), [
    ["contradicted", 0, "error"],
    ["no-source-found", 1, "warning"],
    ["not-checkable", 2, "note"],
  ]);
  assert.equal(results[0].message.text, 'Claim c2. Because c2. Source: https://b.example ("it was 1889").');
  assert.deepEqual(results[0].locations[0].physicalLocation, { artifactLocation: { uri: "docs/post.md" }, region: { startLine: 4 } });
  assert.equal(results[2].locations[0].physicalLocation.region, undefined, "a claim without a line has no region");
  assert.ok(results[0].partialFingerprints.claim);
});

test("fail-on counts the claims at its level", () => {
  assert.equal(failing([report], "contradicted"), 1);
  assert.equal(failing([report], "unsourced"), 2);
  assert.equal(failing([report], "never"), 0);
});
