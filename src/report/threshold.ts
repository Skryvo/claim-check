import type { Report, Verdict } from "../types.js";

export const FAIL_ON = {
  contradicted: ["contradicted"],
  unsourced: ["contradicted", "no_source_found"],
  never: [],
} as const satisfies Record<string, readonly Verdict[]>;
export type FailOn = keyof typeof FAIL_ON;

export function isFailOn(value: string): value is FailOn {
  return value in FAIL_ON;
}

export function failing(reports: Report[], failOn: FailOn): number {
  const verdicts: readonly Verdict[] = FAIL_ON[failOn];
  return reports.reduce((n, r) => n + r.claims.filter((c) => verdicts.includes(c.verdict)).length, 0);
}
