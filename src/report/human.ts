import type { ClaimResult, Report, Usage, Verdict } from "../types.js";

export const LABELS: Record<Verdict, string> = {
  supported: "supported",
  contradicted: "contradicted",
  no_source_found: "no source found",
  not_checkable: "not checkable",
};

const COLORS: Record<Verdict, string> = {
  supported: "32",
  contradicted: "31",
  no_source_found: "33",
  not_checkable: "2",
};

function paint(color: boolean, code: string, text: string): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summaryLine(report: Report): string {
  const parts = (Object.keys(LABELS) as Verdict[])
    .filter((v) => report.counts[v] > 0)
    .map((v) => `${report.counts[v]} ${LABELS[v]}`);
  const total = report.claims.length;
  return `${total} claim${total === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

export function usageLine(usage: Usage): string {
  const tokens = usage.promptTokens + usage.completionTokens;
  const cost = usage.cost === null ? "" : `, $${usage.cost.toFixed(4)} as reported by the endpoint`;
  return `${usage.calls} model call${usage.calls === 1 ? "" : "s"}, ${tokens.toLocaleString("en-US")} tokens${cost}`;
}

function claimBlock(claim: ClaimResult, color: boolean): string[] {
  const label = paint(color, COLORS[claim.verdict], LABELS[claim.verdict].padEnd(15));
  const where = claim.line === null ? "" : `line ${claim.line}  `;
  const lines = [`  ${label} ${where}${clip(claim.text, 110)}`];
  const indent = " ".repeat(18);
  if (claim.source) {
    lines.push(`${indent}${clip(claim.source.url, 110)}`);
    lines.push(`${indent}"${clip(claim.source.quote, 160)}"`);
  }
  lines.push(paint(color, "2", `${indent}${clip(claim.why, 200)}`));
  return lines;
}

export function totalUsage(reports: Report[]): Usage {
  return reports.reduce<Usage>(
    (sum, r) => ({
      calls: sum.calls + r.usage.calls,
      promptTokens: sum.promptTokens + r.usage.promptTokens,
      completionTokens: sum.completionTokens + r.usage.completionTokens,
      cost: r.usage.cost === null ? sum.cost : (sum.cost ?? 0) + r.usage.cost,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, cost: null },
  );
}

export function formatHuman(reports: Report[], color: boolean): string {
  const out: string[] = [];
  for (const report of reports) {
    out.push(paint(color, "1", `${report.input}  ${summaryLine(report)}`));
    for (const claim of report.claims) out.push(...claimBlock(claim, color), "");
    if (report.claims.length === 0) out.push("  No checkable claims found.", "");
  }
  const first = reports[0];
  if (first) {
    const usage = totalUsage(reports);
    const sources = first.search === "cited" ? "addresses the text cites" : `addresses the text cites, then ${first.search} search`;
    out.push(paint(color, "2", `Model ${first.model} (${usageLine(usage)}). Sources: ${sources}.`));
  }
  return out.join("\n");
}
