import { extractClaims, type Extracted } from "./extract.js";
import { publicFetcher, type FetchText } from "./fetch.js";
import { htmlToText, isHtml } from "./html.js";
import { judge, type Passage } from "./judge.js";
import { since, snapshot, type ChatModel } from "./model.js";
import { bestPassages } from "./passages.js";
import type { SearchProvider } from "./search/index.js";
import { citedFor, linesOf, locate, parseDocument, type Doc, type Span } from "./text.js";
import { VERDICTS, type ClaimResult, type Consulted, type Report, type Usage, type Verdict } from "./types.js";

export interface CheckOptions {
  model: ChatModel;
  search?: SearchProvider | null;
  fetchText?: FetchText;
  maxClaims?: number;
  concurrency?: number;
}

export interface TextOptions {
  input?: string;
  base?: string;
  lines?: ReadonlySet<number> | null;
}

export interface Checker {
  checkText(text: string, options?: TextOptions): Promise<Report>;
  checkUrl(url: string): Promise<Report>;
  checkClaim(claim: string, sources?: string[]): Promise<Report>;
}

interface Page {
  title: string;
  text: string;
}

const CITED_PAGES = 3;
const SEARCH_RESULTS = 5;
const SEARCH_PAGES = 3;
const PASSAGES_PER_PAGE = 5;
const PASSAGES = 10;

function sameAddress(a: string, b: string): boolean {
  const bare = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "");
  return bare(a) === bare(b);
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function countVerdicts(claims: ClaimResult[]): Record<Verdict, number> {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const claim of claims) counts[claim.verdict]++;
  return counts;
}

export function createChecker(options: CheckOptions): Checker {
  const { model } = options;
  const search = options.search ?? null;
  const fetchText = options.fetchText ?? publicFetcher();
  const maxClaims = options.maxClaims ?? 20;
  const concurrency = options.concurrency ?? 4;
  const pages = new Map<string, Promise<Page | string>>();

  function page(url: string): Promise<Page | string> {
    let pending = pages.get(url);
    if (!pending) {
      pending = fetchText(url).then(
        (fetched) => (isHtml(fetched.contentType, fetched.body) ? htmlToText(fetched.body, fetched.url, false) : { title: "", text: fetched.body }),
        (error: Error) => error.message,
      );
      pages.set(url, pending);
    }
    return pending;
  }

  async function verify(
    statement: string,
    cited: string[],
    exclude: string | null,
  ): Promise<Pick<ClaimResult, "verdict" | "why" | "source" | "consulted">> {
    const targets: { url: string; via: Consulted["via"] }[] = cited.slice(0, CITED_PAGES).map((url) => ({ url, via: "cited" }));
    let searchError: string | null = null;
    if (search) {
      try {
        let added = 0;
        for (const result of await search.search(statement, SEARCH_RESULTS)) {
          if (added >= SEARCH_PAGES) break;
          if (targets.some((t) => sameAddress(t.url, result.url))) continue;
          if (exclude && sameAddress(exclude, result.url)) continue;
          targets.push({ url: result.url, via: "search" });
          added++;
        }
      } catch (error) {
        searchError = (error as Error).message;
      }
    }

    const read = await Promise.all(targets.map((t) => page(t.url)));
    const consulted: Consulted[] = targets.map((t, i) => {
      const got = read[i]!;
      return { url: t.url, via: t.via, read: typeof got !== "string", error: typeof got === "string" ? got : null };
    });

    const passages: Passage[] = [];
    read.forEach((got, i) => {
      if (typeof got === "string") return;
      for (const text of bestPassages(statement, got.text, PASSAGES_PER_PAGE)) {
        if (passages.length < PASSAGES) {
          passages.push({ id: `P${passages.length + 1}`, url: targets[i]!.url, title: got.title, text });
        }
      }
    });

    if (passages.length === 0) {
      const failed = consulted.filter((c) => !c.read);
      let why: string;
      if (targets.length === 0) {
        why = searchError
          ? `The text cites no address for it, and the search failed: ${searchError}`
          : search
            ? "The text cites no address for it, and the search found no page."
            : "The text cites no address for it, and no web search is set.";
      } else if (failed.length === targets.length) {
        why = `No page could be read: ${failed.map((c) => `${host(c.url)} (${c.error})`).join("; ")}.`;
      } else {
        why = `The pages read do not mention it: ${consulted.filter((c) => c.read).map((c) => host(c.url)).join(", ")}.`;
      }
      return { verdict: "no_source_found", why, source: null, consulted };
    }

    const judged = await judge(model, statement, passages);
    return { ...judged, consulted };
  }

  async function run(
    input: string,
    claims: { extracted: Extracted; text: string; line: number | null; cited: string[] }[],
    exclude: string | null,
    before: Usage,
  ): Promise<Report> {
    const results = await mapLimit(claims, concurrency, async (claim, index): Promise<ClaimResult> => {
      const base = {
        id: `c${index + 1}`,
        text: claim.text,
        statement: claim.extracted.statement,
        kind: claim.extracted.kind,
        line: claim.line,
      };
      if (!claim.extracted.checkable) {
        return {
          ...base,
          verdict: "not_checkable",
          why: claim.extracted.why || "No public source could settle it.",
          source: null,
          consulted: [],
        };
      }
      return { ...base, ...(await verify(claim.extracted.statement, claim.cited, exclude)) };
    });
    return {
      input,
      model: model.name,
      search: search?.name ?? "cited",
      claims: results,
      counts: countVerdicts(results),
      usage: since(before, model.usage),
    };
  }

  async function checkDoc(doc: Doc, input: string, lines: ReadonlySet<number> | null, exclude: string | null): Promise<Report> {
    const before = snapshot(model.usage);
    const extracted = await extractClaims(model, doc.prose, maxClaims);
    const placed: { extracted: Extracted; span: Span }[] = [];
    for (const claim of extracted) {
      const span = locate(doc, claim.quote);
      if (!span) continue;
      if (lines && !linesOf(doc, span).some((line) => lines.has(line))) continue;
      placed.push({ extracted: claim, span });
    }
    return run(
      input,
      placed.map(({ extracted: claim, span }) => ({
        extracted: claim,
        text: doc.prose.slice(span.start, span.end).replace(/\s+/g, " ").trim(),
        line: linesOf(doc, span)[0]!,
        cited: citedFor(doc, span),
      })),
      exclude,
      before,
    );
  }

  return {
    checkText(text, textOptions = {}) {
      return checkDoc(parseDocument(text, textOptions.base), textOptions.input ?? "text", textOptions.lines ?? null, textOptions.base ?? null);
    },

    async checkUrl(url) {
      const fetched = await fetchText(url);
      const text = isHtml(fetched.contentType, fetched.body) ? htmlToText(fetched.body, fetched.url, true).text : fetched.body;
      return checkDoc(parseDocument(text, fetched.url), url, null, fetched.url);
    },

    async checkClaim(claim, sources = []) {
      const before = snapshot(model.usage);
      const [extracted] = await extractClaims(model, claim, 1);
      const statement = claim.replace(/\s+/g, " ").trim();
      return run(
        "claim",
        [
          {
            extracted: extracted
              ? { ...extracted, statement }
              : { quote: statement, statement, kind: "named_fact", checkable: false, why: "It states no fact a source could settle." },
            text: statement,
            line: null,
            cited: sources.filter((url) => /^https?:\/\//i.test(url)),
          },
        ],
        null,
        before,
      );
    },
  };
}
