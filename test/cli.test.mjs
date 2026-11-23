import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { answers, cleanEnv, modelServer, root, tempDir } from "./helpers.mjs";

const cli = path.join(root, "dist/cli.js");

function run(args, { env = {}, stdin = null, cwd = root } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(stdin ?? "");
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const claims = [
  { quote: "About 70% of buyers read reviews first", kind: "statistic" },
  { quote: "Our coffee is the best in town", checkable: false, why: "opinion", kind: "superlative" },
];

async function withModel(fn) {
  const model = await modelServer(answers(claims));
  try {
    await fn({ CLAIM_CHECK_BASE_URL: model.baseUrl, CLAIM_CHECK_MODEL: "local-test", CLAIM_CHECK_API_KEY: "k-test" }, model);
  } finally {
    await model.close();
  }
}

const text = "# Notes\n\nAbout 70% of buyers read reviews first.\n\nOur coffee is the best in town.\n";

test("help and version answer everywhere without a model", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const args of [["--help"], ["-h"], ["help"], ["check", "--help"]]) {
    const r = await run(args);
    assert.equal(r.code, 0, args.join(" "));
    assert.match(r.stdout, /Usage\n  claim-check \[options\]/);
    assert.match(r.stdout, /Exit codes/);
  }
  for (const args of [["mcp", "--help"], ["help", "mcp"]]) {
    const r = await run(args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /check_text/);
  }
  assert.equal((await run(["--version"])).stdout.trim(), pkg.version);
});

test("without a model it exits 2 and says how to set one", async () => {
  const r = await run(["-"], { stdin: text });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No model is set/);
  assert.match(r.stderr, /CLAIM_CHECK_BASE_URL=https:\/\/openrouter.ai\/api\/v1/);
  assert.match(r.stderr, /localhost:11434/);
});

test("usage errors exit 2", async () => {
  await withModel(async (env) => {
    assert.equal((await run(["missing.md"], { env })).code, 2);
    assert.equal((await run(["-", "--fail-on", "sometimes"], { env, stdin: text })).code, 2);
    assert.equal((await run(["-", "--max-claims", "0"], { env, stdin: text })).code, 2);
    assert.equal((await run(["-", "--json", "--sarif"], { env, stdin: text })).code, 2);
    assert.equal((await run(["-", "--unknown"], { env, stdin: text })).code, 2);
    assert.equal((await run(["-", "--search", "brave"], { env, stdin: text })).code, 2, "a search provider without its key");
  });
});

test("the report reads well, sends the key and model, and exit codes follow --fail-on", async () => {
  await withModel(async (env, model) => {
    const r = await run(["-"], { env, stdin: text });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^stdin {2}2 claims: 1 no source found, 1 not checkable/);
    assert.match(r.stdout, /no source found line 3 {2}About 70% of buyers read reviews first/);
    assert.match(r.stdout, /not checkable {3}line 5 {2}Our coffee is the best in town/);
    assert.match(r.stdout, /Model local-test \(1 model call, 15 tokens\)\. Sources: addresses the text cites\./);
    assert.ok(!r.stdout.includes("\x1b["), "no colour when not a terminal");
    assert.equal(model.requests[0].headers.authorization, "Bearer k-test");
    assert.equal(model.requests[0].body.model, "local-test");
    assert.equal(model.requests[0].body.temperature, 0);

    assert.equal((await run(["-", "--fail-on", "unsourced"], { env, stdin: text })).code, 1);
    assert.equal((await run(["-", "--fail-on", "never"], { env, stdin: text })).code, 0);
  });
});

test("--json carries every field, and model options reach the request", async () => {
  await withModel(async (env, model) => {
    const r = await run(["-", "--json", "--model-options", '{"max_tokens": 900}'], { env, stdin: text });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.tool, "claim-check");
    const [report] = out.reports;
    assert.deepEqual(Object.keys(report), ["input", "model", "search", "claims", "counts", "usage"]);
    assert.deepEqual(Object.keys(report.claims[0]), ["id", "text", "statement", "kind", "line", "verdict", "why", "source", "consulted"]);
    assert.equal(model.requests.at(-1).body.max_tokens, 900);
    assert.equal((await run(["-", "--model-options", "nope"], { env, stdin: text })).code, 2);
  });
});

test("--sarif is SARIF 2.1.0 with a located result per claim that is not supported", async () => {
  await withModel(async (env) => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs/a.md"), text);
    const r = await run(["docs/*.md", "--sarif"], { env, cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const sarif = JSON.parse(r.stdout);
    assert.equal(sarif.version, "2.1.0");
    const [result] = sarif.runs[0].results.filter((x) => x.ruleId === "no-source-found");
    assert.equal(result.level, "warning");
    assert.deepEqual(result.locations[0].physicalLocation, { artifactLocation: { uri: "docs/a.md" }, region: { startLine: 3 } });
  });
});

test("a model endpoint that refuses ends with exit 3 and its message", async () => {
  const model = await modelServer(() => ({ status: 401, message: "bad key" }));
  const r = await run(["-"], { env: { CLAIM_CHECK_BASE_URL: model.baseUrl, CLAIM_CHECK_MODEL: "m" }, stdin: text });
  await model.close();
  assert.equal(r.code, 3);
  assert.match(r.stderr, /The model endpoint answered 401: .*bad key/);
});
