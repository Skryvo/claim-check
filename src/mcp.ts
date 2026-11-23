import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createChecker, type Checker } from "./check.js";
import { modelFrom, searchFrom } from "./config.js";
import { formatHuman } from "./report/human.js";
import { CLAIM_KINDS, VERDICTS, type Report } from "./types.js";
import { VERSION } from "./version.js";

const count = z.number().int();
const ReportSchema = z.object({
  input: z.string(),
  model: z.string(),
  search: z.string(),
  claims: z.array(
    z.object({
      id: z.string(),
      text: z.string().describe("The claim as the text words it."),
      statement: z.string().describe("The claim restated to stand alone."),
      kind: z.enum(CLAIM_KINDS),
      line: z.number().int().nullable().describe("Line in the input, when the claim came from a text."),
      verdict: z.enum(VERDICTS),
      why: z.string().describe("One sentence on how the verdict was reached."),
      source: z
        .object({ url: z.string(), title: z.string(), passage: z.string(), quote: z.string() })
        .nullable()
        .describe("For supported and contradicted: the page and the words from it that settle the claim."),
      consulted: z.array(
        z.object({ url: z.string(), via: z.enum(["cited", "search"]), read: z.boolean(), error: z.string().nullable() }),
      ),
    }),
  ),
  counts: z.object({ supported: count, contradicted: count, no_source_found: count, not_checkable: count }),
  usage: z.object({ calls: count, promptTokens: count, completionTokens: count, cost: z.number().nullable() }),
});

const VERDICT_NOTE =
  "Each claim gets a verdict: supported or contradicted (always with the source address and the exact passage quoted from a page that was fetched), no_source_found, or not_checkable (opinion, advice, prediction, private or vague), with one sentence on why. A model's own knowledge is never used as a source.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function answer(report: Report) {
  return { content: [{ type: "text" as const, text: formatHuman([report], false) }], structuredContent: report };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function createServer(makeChecker: (maxClaims: number) => Checker): McpServer {
  const server = new McpServer({ name: "claim-check", version: VERSION });
  const maxClaims = z.number().int().min(1).max(50).optional().describe("Most claims to check (default 20).");

  server.registerTool(
    "check_text",
    {
      title: "Check the claims in a text",
      description: `Finds the factual claims in a piece of text (statistics, dates, named facts, quotes, superlatives), looks for a source for each among the addresses the text cites (and a web search, when the server has one set), and reports per claim. ${VERDICT_NOTE} The text is sent to the model provider configured for this server.`,
      inputSchema: z.object({
        text: z.string().min(1).max(200_000).describe("Markdown or plain text. Links in it are the cited sources."),
        max_claims: maxClaims,
      }),
      outputSchema: ReportSchema,
      annotations: READ_ONLY,
    },
    async ({ text, max_claims }) => {
      try {
        return answer(await makeChecker(max_claims ?? 20).checkText(text));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_url",
    {
      title: "Check the claims on a web page",
      description: `Fetches a public web page and checks its factual claims against the pages it links to (and a web search, when the server has one set). ${VERDICT_NOTE} Private, local and loopback addresses are refused.`,
      inputSchema: z.object({
        url: z.url({ protocol: /^https?$/ }).describe("A public http(s) address."),
        max_claims: maxClaims,
      }),
      outputSchema: ReportSchema,
      annotations: READ_ONLY,
    },
    async ({ url, max_claims }) => {
      try {
        return answer(await makeChecker(max_claims ?? 20).checkUrl(url));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_claim",
    {
      title: "Check one claim",
      description: `Checks a single claim against the addresses given (and a web search, when the server has one set). Write the claim so it stands alone, with its names, figures and dates. ${VERDICT_NOTE}`,
      inputSchema: z.object({
        claim: z.string().min(3).max(2000).describe("One factual statement."),
        sources: z
          .array(z.url({ protocol: /^https?$/ }))
          .max(5)
          .optional()
          .describe("Public pages to check it against, best first."),
      }),
      outputSchema: ReportSchema,
      annotations: READ_ONLY,
    },
    async ({ claim, sources }) => {
      try {
        return answer(await makeChecker(1).checkClaim(claim, sources ?? []));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export function checkerFromEnvironment(maxClaims: number): Checker {
  return createChecker({ model: modelFrom({}), search: searchFrom({}), maxClaims });
}

export async function serveStdio(): Promise<void> {
  const server = createServer(checkerFromEnvironment);
  await server.connect(new StdioServerTransport());
}
