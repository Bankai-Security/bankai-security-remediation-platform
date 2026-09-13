import { expect, it } from "vitest";
import type { NormalizedFinding } from "./csv-ingest.js";
import { securityRegression } from "./security-regression.js";
const target = { fingerprint: "starlette", externalId: "CVE-2025-54121", filePath: "backend/requirements.txt", title: "Starlette CVE" } as NormalizedFinding;
const unrelated = { ...target, fingerprint: "old", externalId: "other" };
it("rejects a CI repair that reintroduces the target CVE", () => {
  expect(securityRegression([target, unrelated], [target, unrelated], target)).toContain("target remains");
});
it("allows existing unrelated findings but rejects new vulnerabilities", () => {
  expect(securityRegression([target, unrelated], [unrelated], target)).toBeNull();
  expect(securityRegression([target], [unrelated], target)).toContain("new vulnerabilities");
});

it("rejects reintroduced scanner evidence for an imported ticket without a scanner rule ID", () => {
  const scannerFinding = { ...target, externalId: "bandit:B602", cwe: "CWE-78", filePath: "report.py", lineStart: 26, lineEnd: 26 };
  const imported = { externalId: null, filePath: "report.py", cwe: "CWE-78", lineStart: 26, lineEnd: 26 };
  expect(securityRegression([scannerFinding], [scannerFinding], imported)).toContain("target remains");
  expect(securityRegression([scannerFinding], [], imported)).toBeNull();
  expect(securityRegression([scannerFinding], [scannerFinding], { ...imported, lineStart: 3, lineEnd: 3 })).toBeNull();
});
