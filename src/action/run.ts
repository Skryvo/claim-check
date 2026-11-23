import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createChecker } from "../check.js";
import { modelFrom, searchFrom } from "../config.js";
import { expandGlob, globToRegExp } from "../glob.js";
import { LABELS, summaryLine, totalUsage, usageLine } from "../report/human.js";
import { failing, isFailOn, FAIL_ON } from "../report/threshold.js";
import type { ClaimResult, Report } from "../types.js";
import { USER_AGENT } from "../version.js";

export function input(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function annotations(report: Report, file: string): string[] {
  const out: string[] = [];
  for (const claim of report.claims) {
    if (claim.verdict !== "contradicted" && claim.verdict !== "no_source_found") continue;
    const level = claim.verdict === "contradicted" ? "error" : "warning";
    const title = claim.verdict === "contradicted" ? "Contradicted claim" : "No source found";
    const source = claim.source ? `\nSource: ${claim.source.url}\n"${claim.source.quote}"` : "";
    const where = claim.line === null ? "" : `,line=${claim.line}`;
    out.push(`::${level} file=${escapeProperty(file)}${where},title=${escapeProperty(title)}::${escapeData(`${claim.text}\n${claim.why}${source}`)}`);
  }
  return out;
}

/** The new-side line numbers a pull request adds, read from a file's unified diff. */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith("+")) added.add(line++);
    else if (row.startsWith(" ")) line++;
  }
  return added;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function row(claim: ClaimResult): string {
  const source = claim.source ? `[${new URL(claim.source.url).hostname.replace(/^www\./, "")}](${claim.source.url})` : "";
  return `| ${claim.line ?? ""} | ${LABELS[claim.verdict]} | ${cell(claim.text)} | ${cell(claim.why)} ${source} |`;
}

export function summary(reports: { file: string; report: Report }[]): string {
  const out = ["## Claim check", ""];
  if (reports.length === 0) {
    out.push("No Markdown files to check.");
    return `${out.join("\n")}\n`;
  }
  const table = "| Line | Verdict | Claim | Why |\n|---:|---|---|---|";
  for (const { file, report } of reports) {
    out.push(`### \`${file}\``, "", summaryLine(report), "");
    const flagged = report.claims.filter((c) => c.verdict === "contradicted" || c.verdict === "no_source_found");
    const rest = report.claims.filter((c) => !flagged.includes(c));
    if (flagged.length) out.push(table, ...flagged.map(row), "");
    if (rest.length) {
      out.push(`<details><summary>${rest.length} supported or not checkable</summary>`, "", table, ...rest.map(row), "", "</details>", "");
    }
  }
  const first = reports[0]!.report;
  const sources = first.search === "cited" ? "the addresses each file cites" : `cited addresses, then ${first.search} search`;
  out.push(`Model \`${first.model}\`, ${usageLine(totalUsage(reports.map((r) => r.report)))}. Sources: ${sources}.`);
  return `${out.join("\n")}\n`;
}

interface PullFile {
  filename: string;
  status: string;
  patch?: string;
}

export async function pullRequestFiles(api: string, repo: string, number: number, token: string, fetchImpl: typeof fetch = fetch): Promise<PullFile[]> {
  const files: PullFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const response = await fetchImpl(`${api}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`Listing the pull request's files failed: HTTP ${response.status}`);
    const batch = (await response.json()) as PullFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

async function targets(env: NodeJS.ProcessEnv, patterns: RegExp[], globs: string[], workspace: string, onlyChanged: boolean) {
  const eventPath = env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : {};
  const number: number | undefined = event.pull_request?.number;
  if (number) {
    const token = input("github-token", env);
    const files = await pullRequestFiles(env.GITHUB_API_URL ?? "https://api.github.com", env.GITHUB_REPOSITORY ?? "", number, token);
    return files
      .filter((f) => f.status !== "removed" && patterns.some((p) => p.test(f.filename)))
      .map((f) => ({ file: f.filename, lines: onlyChanged ? addedLines(f.patch ?? "") : null }));
  }
  const found = new Set<string>();
  for (const glob of globs) for (const file of await expandGlob(glob, workspace)) found.add(file);
  return [...found].sort().map((file) => ({ file, lines: null }));
}

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  for (const secret of [input("api-key", env), input("search-key", env)]) if (secret) out(`::add-mask::${secret}`);

  const failOn = input("fail-on", env) || "contradicted";
  if (!isFailOn(failOn)) throw new Error(`fail-on takes ${Object.keys(FAIL_ON).join(", ")}.`);
  const linesMode = input("lines", env) || "changed";
  if (linesMode !== "changed" && linesMode !== "all") throw new Error("lines takes changed or all.");
  const maxClaims = Number(input("max-claims", env) || 20);
  if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > 100) throw new Error("max-claims takes a whole number from 1 to 100.");
  const settings = {
    baseUrl: input("base-url", env) || undefined,
    model: input("model", env) || undefined,
    apiKey: input("api-key", env) || undefined,
    modelOptions: input("model-options", env) || undefined,
    search: input("search", env) || undefined,
    searchKey: input("search-key", env) || undefined,
  };
  const checker = createChecker({ model: modelFrom(settings, {}), search: searchFrom(settings, {}), maxClaims });

  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const globs = (input("files", env) || "**/*.md").split(/[\n,]/).map((g) => g.trim()).filter(Boolean);
  const patterns = globs.map(globToRegExp);
  const reports: { file: string; report: Report }[] = [];
  for (const { file, lines } of await targets(env, patterns, globs, workspace, linesMode === "changed")) {
    if (lines && lines.size === 0) continue;
    out(`Checking ${file}${lines ? ` (${lines.size} changed lines)` : ""}`);
    const text = await readFile(path.join(workspace, file), "utf8");
    const report = await checker.checkText(text, { input: file, lines });
    reports.push({ file, report });
    for (const command of annotations(report, file)) out(command);
  }

  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary(reports));
  const all = reports.map((r) => r.report);
  const reportPath = path.join(env.RUNNER_TEMP ?? workspace, "claim-check.json");
  await writeFile(reportPath, JSON.stringify({ tool: "claim-check", reports: all }, null, 2));
  if (env.GITHUB_OUTPUT) {
    const total = (verdict: keyof Report["counts"]) => all.reduce((n, r) => n + r.counts[verdict], 0);
    await appendFile(
      env.GITHUB_OUTPUT,
      `checked=${all.reduce((n, r) => n + r.claims.length, 0)}\ncontradicted=${total("contradicted")}\nunsourced=${total("no_source_found")}\nreport=${reportPath}\n`,
    );
  }
  const failed = failing(all, failOn);
  if (failed > 0) {
    out(`::error::${failed} claim${failed === 1 ? "" : "s"} met fail-on: ${failOn}.`);
    return 1;
  }
  return 0;
}
