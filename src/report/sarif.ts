import { VERSION } from "../version.js";
import type { Report, Verdict } from "../types.js";
import { LABELS } from "./human.js";

const RULES: { id: string; name: string; verdict: Verdict; level: "error" | "warning" | "note"; text: string }[] = [
  { id: "contradicted", name: "Contradicted", verdict: "contradicted", level: "error", text: "A page states something that cannot be true together with the claim." },
  { id: "no-source-found", name: "NoSourceFound", verdict: "no_source_found", level: "warning", text: "No page read states the claim." },
  { id: "not-checkable", name: "NotCheckable", verdict: "not_checkable", level: "note", text: "The claim is opinion, advice, a prediction, private or too vague to test." },
];

/** SARIF 2.1.0 with one result per claim that is not supported; `uri` maps a report's input to the path a viewer should open. */
export function toSarif(reports: Report[], uri: (input: string) => string = (input) => input): object {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "claim-check",
            version: VERSION,
            informationUri: "https://github.com/Skryvo/claim-check",
            rules: RULES.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: `Claim ${LABELS[rule.verdict]}` },
              fullDescription: { text: rule.text },
              defaultConfiguration: { level: rule.level },
            })),
          },
        },
        results: reports.flatMap((report) =>
          report.claims
            .filter((claim) => claim.verdict !== "supported")
            .map((claim) => {
              const rule = RULES.find((r) => r.verdict === claim.verdict)!;
              const source = claim.source ? ` Source: ${claim.source.url} ("${claim.source.quote}").` : "";
              return {
                ruleId: rule.id,
                ruleIndex: RULES.indexOf(rule),
                level: rule.level,
                message: { text: `${claim.statement} ${claim.why}${source}` },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: uri(report.input) },
                      ...(claim.line === null ? {} : { region: { startLine: claim.line } }),
                    },
                  },
                ],
                partialFingerprints: { claim: `${claim.kind}:${claim.statement.toLowerCase().replace(/\W+/g, " ").trim()}` },
              };
            }),
        ),
      },
    ],
  };
}
