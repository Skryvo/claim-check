// Runs samples/labelled.json through check_claim with your model, against only the addresses each item gives.
import { readFile } from "node:fs/promises";
import { ConfigError, VERDICTS, createChecker, modelFrom } from "../dist/index.js";

const { claims } = JSON.parse(await readFile(new URL("../samples/labelled.json", import.meta.url), "utf8"));

let model;
try {
  model = modelFrom({});
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const checker = createChecker({ model, search: null, maxClaims: 1 });
const results = [];
let next = 0;
async function worker() {
  while (next < claims.length) {
    const item = claims[next++];
    const report = await checker.checkClaim(item.claim, item.sources);
    const got = report.claims[0];
    results.push({ ...item, got: got.verdict, why: got.why });
    process.stderr.write(`${got.verdict === item.expected ? "match" : "MISS "}  ${item.id}\n`);
  }
}
await Promise.all([worker(), worker(), worker()]);

const short = { supported: "supported", contradicted: "contradicted", no_source_found: "no source", not_checkable: "not checkable" };
const width = 14;
const lines = [`${"expected \\ got".padEnd(width)}${VERDICTS.map((v) => short[v].padStart(width)).join("")}`];
for (const expected of VERDICTS) {
  const row = VERDICTS.map((got) => String(results.filter((r) => r.expected === expected && r.got === got).length).padStart(width));
  lines.push(`${short[expected].padEnd(width)}${row.join("")}`);
}
const matched = results.filter((r) => r.got === r.expected).length;
const usage = model.usage;
console.log(lines.join("\n"));
console.log(`\n${matched} of ${results.length} as labelled. Model ${model.name}; ${usage.calls} calls, ${usage.promptTokens + usage.completionTokens} tokens${usage.cost === null ? "" : `, $${usage.cost.toFixed(4)} reported`}.`);
for (const r of results.filter((r) => r.got !== r.expected).sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`\n${r.id}: expected ${short[r.expected]}, got ${short[r.got]}\n  ${r.claim}\n  ${r.why}`);
}
