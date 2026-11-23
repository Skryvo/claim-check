#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createChecker } from "./check.js";
import { ConfigError, modelFrom, searchFrom, type Settings } from "./config.js";
import { expandGlob, hasMagic } from "./glob.js";
import { serveStdio } from "./mcp.js";
import { formatHuman } from "./report/human.js";
import { toSarif } from "./report/sarif.js";
import { failing, FAIL_ON, isFailOn } from "./report/threshold.js";
import type { Report } from "./types.js";
import { VERSION } from "./version.js";

const HELP = `claim-check ${VERSION}: find the factual claims in a text, look for a source for each, and report
which are supported, contradicted, unsourced or not checkable.

Usage
  claim-check [options] <file | glob | url | ->...
  claim-check mcp            run as an MCP server over stdio (claim-check mcp --help)

Inputs
  Markdown or text files, quoted globs ("docs/**/*.md"), public http(s) pages, or "-" for stdin.
  With no input and piped stdin, stdin is read.

Output
  --json                  the reports as JSON
  --sarif                 SARIF 2.1.0, for code scanning
  --no-color              plain text (also when NO_COLOR is set or output is not a terminal)

Checking
  --search <mode>         cited (default): only the addresses the text cites
                          brave | serper | tavily: those first, then a web search
  --max-claims <n>        claims per input, 1 to 100 (default 20)
  --fail-on <level>       exit 1 when a claim is: contradicted (default), unsourced
                          (contradicted or no source found), or never

Model (flags win over the environment)
  --base-url <url>        CLAIM_CHECK_BASE_URL     chat completions endpoint
  --model <id>            CLAIM_CHECK_MODEL        model id at that endpoint
  --api-key <key>         CLAIM_CHECK_API_KEY      prefer the variable: flags show in process lists
  --model-options <json>  CLAIM_CHECK_MODEL_OPTIONS  extra request fields, e.g. '{"max_tokens":4000}'
  --search-key <key>      BRAVE_SEARCH_API_KEY, SERPER_API_KEY or TAVILY_API_KEY

Exit codes
  0  checked; nothing met --fail-on
  1  at least one claim met --fail-on
  2  usage or configuration error
  3  the check could not finish (model, search or input error)

  -h, --help              this help
  -v, --version           the version`;

const MCP_HELP = `claim-check mcp: an MCP server over stdio with three tools:

  check_text    find and check the claims in a piece of text
  check_url     fetch a public page and check its claims
  check_claim   check one claim, against addresses you give or a web search

It reads the same environment as the command line: CLAIM_CHECK_BASE_URL, CLAIM_CHECK_MODEL,
CLAIM_CHECK_API_KEY, CLAIM_CHECK_MODEL_OPTIONS, CLAIM_CHECK_SEARCH and the search key.

A client configuration:
  {"mcpServers": {"claim-check": {"command": "npx", "args": ["-y", "@skryvo/claim-check", "mcp"],
    "env": {"CLAIM_CHECK_BASE_URL": "...", "CLAIM_CHECK_MODEL": "...", "CLAIM_CHECK_API_KEY": "..."}}}}`;

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type Input = { kind: "file"; path: string } | { kind: "url"; url: string } | { kind: "stdin" };

async function resolveInputs(args: string[]): Promise<Input[]> {
  if (args.length === 0) {
    if (process.stdin.isTTY) throw new UsageError("Give a file, glob, URL or - for stdin. See claim-check --help.");
    return [{ kind: "stdin" }];
  }
  const inputs: Input[] = [];
  for (const arg of args) {
    if (arg === "-") inputs.push({ kind: "stdin" });
    else if (/^https?:\/\//i.test(arg)) inputs.push({ kind: "url", url: arg });
    else if (hasMagic(arg)) {
      const found = await expandGlob(arg, process.cwd());
      if (found.length === 0) throw new UsageError(`No files match ${arg}`);
      inputs.push(...found.map((path) => ({ kind: "file" as const, path })));
    } else {
      const info = await stat(arg).catch(() => null);
      if (!info?.isFile()) throw new UsageError(`No such file: ${arg}`);
      inputs.push({ kind: "file", path: arg });
    }
  }
  return inputs;
}

async function check(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      sarif: { type: "boolean" },
      "no-color": { type: "boolean" },
      search: { type: "string" },
      "max-claims": { type: "string" },
      "fail-on": { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      "model-options": { type: "string" },
      "search-key": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.json && values.sarif) throw new UsageError("Choose one of --json and --sarif.");
  const failOn = values["fail-on"] ?? "contradicted";
  if (!isFailOn(failOn)) throw new UsageError(`--fail-on takes ${Object.keys(FAIL_ON).join(", ")}.`);
  const maxClaims = Number(values["max-claims"] ?? 20);
  if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > 100) {
    throw new UsageError("--max-claims takes a whole number from 1 to 100.");
  }

  const settings: Settings = {
    baseUrl: values["base-url"],
    model: values.model,
    apiKey: values["api-key"],
    modelOptions: values["model-options"],
    search: values.search,
    searchKey: values["search-key"],
  };
  const inputs = await resolveInputs(positionals);
  const checker = createChecker({ model: modelFrom(settings), search: searchFrom(settings), maxClaims });

  const reports: Report[] = [];
  const progress = process.stderr.isTTY && !values.json && !values.sarif;
  for (const input of inputs) {
    const name = input.kind === "file" ? input.path : input.kind === "url" ? input.url : "stdin";
    if (progress) process.stderr.write(`Checking ${name}…\n`);
    if (input.kind === "url") reports.push(await checker.checkUrl(input.url));
    else {
      const text = input.kind === "file" ? await readFile(input.path, "utf8") : await readStdin();
      reports.push(await checker.checkText(text, { input: name }));
    }
  }

  if (values.json) process.stdout.write(`${JSON.stringify({ tool: "claim-check", version: VERSION, reports }, null, 2)}\n`);
  else if (values.sarif) process.stdout.write(`${JSON.stringify(toSarif(reports), null, 2)}\n`);
  else {
    const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
    process.stdout.write(`${formatHuman(reports, color)}\n`);
  }
  return failing(reports, failOn) > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "mcp") {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${MCP_HELP}\n`);
      return 0;
    }
    if (argv.length > 1) throw new UsageError(`claim-check mcp takes no arguments. See claim-check mcp --help.`);
    await serveStdio();
    return -1;
  }
  if (argv[0] === "help") {
    process.stdout.write(`${argv[1] === "mcp" ? MCP_HELP : HELP}\n`);
    return 0;
  }
  return check(argv[0] === "check" ? argv.slice(1) : argv);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: Error) => {
    const code = (error as { code?: string }).code ?? "";
    const usage = error instanceof UsageError || error instanceof ConfigError || code.startsWith("ERR_PARSE_ARGS");
    process.stderr.write(`claim-check: ${error.message}\n`);
    process.exitCode = usage ? 2 : 3;
  },
);
