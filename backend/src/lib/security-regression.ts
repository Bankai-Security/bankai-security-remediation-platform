import type { NormalizedFinding } from "./csv-ingest.js";

export function securityRegression(baseline: NormalizedFinding[], current: NormalizedFinding[], target: { externalId: string | null; filePath: string | null; cwe?: string | null; lineStart?: number | null; lineEnd?: number | null }): string | null {
  const known = new Set(baseline.map((f) => f.fingerprint));
  const cwes = new Set(target.cwe?.match(/CWE-\d+/g) ?? []);
  const correlated = new Set(!target.externalId && target.lineStart ? baseline.filter((finding) =>
    finding.filePath === target.filePath && finding.lineStart != null && finding.lineEnd != null &&
    finding.lineStart <= (target.lineEnd ?? target.lineStart!) && finding.lineEnd >= target.lineStart! &&
    (finding.cwe?.match(/CWE-\d+/g) ?? []).some((cwe) => cwes.has(cwe)),
  ).map((finding) => finding.fingerprint) : []);
  const problems = current.filter((f) =>
    !known.has(f.fingerprint) || correlated.has(f.fingerprint) || (target.externalId && f.externalId === target.externalId && f.filePath === target.filePath),
  );
  if (!problems.length) return null;
  return "Quincy rejected this commit: the target remains or new vulnerabilities were introduced. " + problems.map((f) =>
    `${f.title} in ${f.filePath}; affected package ${f.affectedPackages ?? f.component ?? "unknown"}; fixed versions ${f.fixedVersions ?? "consult registry"}`,
  ).join("\n") + "\nPreserve the security fix while resolving CI failures. Upgrade compatible parent dependencies; never downgrade to an affected version just to make installation pass.";
}
