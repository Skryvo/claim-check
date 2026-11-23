import { USER_AGENT } from "../version.js";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, count: number): Promise<SearchResult[]>;
}

export class SearchError extends Error {}

export const SEARCH_PROVIDERS = {
  brave: { env: "BRAVE_SEARCH_API_KEY", create: brave },
  serper: { env: "SERPER_API_KEY", create: serper },
  tavily: { env: "TAVILY_API_KEY", create: tavily },
} as const;
export type SearchName = keyof typeof SEARCH_PROVIDERS;

const TIMEOUT_MS = 20_000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function results(items: unknown, url: string, snippet: string): SearchResult[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item: Record<string, unknown>) => ({
      url: text(item?.[url]),
      title: text(item?.title),
      snippet: text(item?.[snippet]),
    }))
    .filter((r) => /^https?:\/\//.test(r.url));
}

export function parseBrave(body: unknown): SearchResult[] {
  return results((body as { web?: { results?: unknown } })?.web?.results, "url", "description");
}

export function parseSerper(body: unknown): SearchResult[] {
  return results((body as { organic?: unknown })?.organic, "link", "snippet");
}

export function parseTavily(body: unknown): SearchResult[] {
  return results((body as { results?: unknown })?.results, "url", "content");
}

async function call(name: string, fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new SearchError(`${name} search could not be reached: ${(error as Error).message}`);
  }
  const raw = await response.text();
  if (!response.ok) throw new SearchError(`${name} search answered ${response.status}: ${raw.slice(0, 200).trim()}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new SearchError(`${name} search did not answer with JSON`);
  }
}

export function brave(key: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "brave",
    async search(query, count) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query.slice(0, 400));
      url.searchParams.set("count", String(Math.min(count, 20)));
      const body = await call("Brave", fetchImpl, url.href, {
        headers: { accept: "application/json", "x-subscription-token": key, "user-agent": USER_AGENT },
      });
      return parseBrave(body).slice(0, count);
    },
  };
}

export function serper(key: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "serper",
    async search(query, count) {
      const body = await call("Serper", fetchImpl, "https://google.serper.dev/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "user-agent": USER_AGENT },
        body: JSON.stringify({ q: query.slice(0, 400), num: Math.min(count, 20) }),
      });
      return parseSerper(body).slice(0, count);
    },
  };
}

export function tavily(key: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "tavily",
    async search(query, count) {
      const body = await call("Tavily", fetchImpl, "https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": USER_AGENT },
        body: JSON.stringify({ query: query.slice(0, 400), max_results: Math.min(count, 20), search_depth: "basic" }),
      });
      return parseTavily(body).slice(0, count);
    },
  };
}
