import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { addedLines, annotations, input, summary } from "../dist/action/run.js";
import { answers, cleanEnv, modelServer, root, tempDir } from "./helpers.mjs";

const claim = (verdict, line, extra = {}) => ({
  id: "c1",
  text: "Sales rose 40%, then fell",
  statement: "Sales rose 40%.",
  kind: "statistic",
  line,
  verdict,
  why: "The page gives 4% (in 2024).",
  source: null,
  consulted: [],
  ...extra,
});
const report = (claims) => ({
  input: "x",
  model: "m",
  search: "cited",
  claims,
  counts: { supported: 0, contradicted: 0, no_source_found: 0, not_checkable: 0 },
  usage: { calls: 2, promptTokens: 10, completionTokens: 5, cost: null },
});

test("contradicted claims become errors and unsourced ones warnings, on their lines, escaped", () => {
  const lines = annotations(
    report([
      claim("contradicted", 3, { source: { url: "https://a.example/x", title: "", passage: "", quote: "rose 4%" } }),
      claim("no_source_found", 7),
      claim("supported", 9),
      claim("not_checkable", 11),
    ]),
    "docs/a,b.md",
  );
  assert.deepEqual(lines, [
    "::error file=docs/a%2Cb.md,line=3,title=Contradicted claim::Sales rose 40%25, then fell%0AThe page gives 4%25 (in 2024).%0ASource: https://a.example/x%0A\"rose 4%25\"",
    "::warning file=docs/a%2Cb.md,line=7,title=No source found::Sales rose 40%25, then fell%0AThe page gives 4%25 (in 2024).",
  ]);
});

test("the added lines of a pull request are read from its diff", () => {
  const patch = "@@ -1,3 +1,4 @@\n intro\n-old line\n+new line\n+another\n context\n@@ -20,2 +21,3 @@\n keep\n+added at 22\n \\ No newline at end of file";
  assert.deepEqual([...addedLines(patch)], [2, 3, 22]);
  assert.deepEqual([...addedLines("")], []);
});

test("inputs are read the way the runner passes them", () => {
  assert.equal(input("fail-on", { "INPUT_FAIL-ON": " unsourced " }), "unsourced");
  assert.equal(input("base-url", {}), "");
});

test("the job summary lists flagged claims first and folds the rest", () => {
  const text = summary([{ file: "docs/a.md", report: report([claim("contradicted", 3), claim("supported", 5)]) }]);
  assert.match(text, /^## Claim check/);
  assert.match(text, /### `docs\/a.md`/);
  assert.match(text, /\| 3 \| contradicted \| Sales rose 40%, then fell \|/);
  assert.match(text, /<details><summary>1 supported or not checkable<\/summary>/);
  assert.match(text, /Model `m`, 2 model calls, 15 tokens\./);
  assert.match(summary([]), /No Markdown files to check/);
});

test("the committed bundle is built from the current source", async () => {
  const built = await build({
    entryPoints: [path.join(root, "src/action/main.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    legalComments: "none",
    write: false,
    outfile: path.join(root, "action/index.js"),
  });
  assert.equal(built.outputFiles[0].text, await readFile(path.join(root, "action/index.js"), "utf8"), "run npm run build:action");
});

async function githubApi(files) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.includes("page=1") ? files : []));
  });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((resolve) => s.close(resolve)) };
}

test("on a pull request the bundled action checks changed Markdown lines, annotates, summarises and sets outputs", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "docs/post.md"), "# Post\n\nUnchanged: revenue was $4 million.\n\nNew: about 70% of buyers read reviews first.\n");
  await writeFile(path.join(dir, "event.json"), JSON.stringify({ pull_request: { number: 7 } }));
  await writeFile(path.join(dir, "summary.md"), "");
  await writeFile(path.join(dir, "output.txt"), "");
  const api = await githubApi([
    { filename: "docs/post.md", status: "modified", patch: "@@ -4,0 +5,1 @@\n+New: about 70% of buyers read reviews first." },
    { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@\n+x" },
    { filename: "docs/old.md", status: "removed" },
  ]);
  const model = await modelServer(answers([{ quote: "revenue was $4 million" }, { quote: "about 70% of buyers read reviews first" }]));

  const runAction = (failOn) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, "action/index.js")], {
        env: cleanEnv({
          GITHUB_EVENT_PATH: path.join(dir, "event.json"),
          GITHUB_REPOSITORY: "acme/site",
          GITHUB_API_URL: api.url,
          GITHUB_WORKSPACE: dir,
          GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
          GITHUB_OUTPUT: path.join(dir, "output.txt"),
          RUNNER_TEMP: dir,
          "INPUT_BASE-URL": model.baseUrl,
          INPUT_MODEL: "local-test",
          "INPUT_API-KEY": "k-secret",
          "INPUT_GITHUB-TOKEN": "gh-token",
          INPUT_FILES: "**/*.md",
          INPUT_LINES: "changed",
          "INPUT_FAIL-ON": failOn,
        }),
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
    });

  try {
    const passing = await runAction("contradicted");
    assert.equal(passing.code, 0, passing.stdout);
    assert.match(passing.stdout, /::add-mask::k-secret/);
    assert.match(passing.stdout, /::warning file=docs\/post.md,line=5,title=No source found::about 70%25 of buyers read reviews first%0AThe text cites no address for it/);
    assert.ok(!passing.stdout.includes("revenue was"), "claims on unchanged lines are not checked");
    assert.ok(!passing.stdout.includes("src/app.ts"));
    assert.equal(api.seen[0].auth, "Bearer gh-token");
    assert.match(api.seen[0].url, /^\/repos\/acme\/site\/pulls\/7\/files\?per_page=100&page=1$/);
    assert.match(await readFile(path.join(dir, "summary.md"), "utf8"), /\| 5 \| no source found \|/);
    assert.match(await readFile(path.join(dir, "output.txt"), "utf8"), /checked=1\ncontradicted=0\nunsourced=1\nreport=/);
    const saved = JSON.parse(await readFile(path.join(dir, "claim-check.json"), "utf8"));
    assert.equal(saved.reports[0].claims.length, 1);

    const failing = await runAction("unsourced");
    assert.equal(failing.code, 1);
    assert.match(failing.stdout, /::error::1 claim met fail-on: unsourced\./);
  } finally {
    await api.close();
    await model.close();
  }
});
