export const CLAIM_KINDS = ["statistic", "date", "named_fact", "quote", "superlative"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const VERDICTS = ["supported", "contradicted", "no_source_found", "not_checkable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Source {
  url: string;
  title: string;
  passage: string;
  quote: string;
}

export interface Consulted {
  url: string;
  via: "cited" | "search";
  read: boolean;
  error: string | null;
}

export interface ClaimResult {
  id: string;
  text: string;
  statement: string;
  kind: ClaimKind;
  line: number | null;
  verdict: Verdict;
  why: string;
  source: Source | null;
  consulted: Consulted[];
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cost: number | null;
}

export interface Report {
  input: string;
  model: string;
  search: string;
  claims: ClaimResult[];
  counts: Record<Verdict, number>;
  usage: Usage;
}
