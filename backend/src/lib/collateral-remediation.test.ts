import { describe, expect, it } from "vitest";
import type { NormalizedFinding } from "./csv-ingest.js";
import { collateralMitigationEvidence, packageAdvisoryIdentity } from "./collateral-remediation.js";

function finding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    fingerprint: "f", externalId: "CVE-2025-12345", title: "advisory", severity: "High", cvssScore: null,
    cwe: null, component: "@scope/example_pkg", filePath: "apps/api/package-lock.json", findingType: "advisory",
    sourceStatus: null, dateFound: null, description: null, fixAvailable: null, sourceUrl: null, service: null,
    environment: null, cves: "CVE-2025-12345", affectedPackages: "@scope/example_pkg", currentVersions: "1.0.0",
    fixedVersions: "2.0.0", recommendations: null, ...overrides,
  };
}

describe("stack-agnostic package correlation", () => {
  it("normalizes ordinary scanner package identities", () => {
    expect(packageAdvisoryIdentity(finding())?.packageIdentity).toBe("@scope/example-pkg");
  });

  it("preserves package-url ecosystem and namespace", () => {
    expect(packageAdvisoryIdentity(finding({ affectedPackages: "pkg:maven/org.example/demo@1.0.0?type=jar" }))?.packageIdentity)
      .toBe("pkg:maven/org.example/demo");
  });

  it("accepts positive baseline evidence when the advisory disappears", () => {
    expect(collateralMitigationEvidence(finding(), [finding()], [])).not.toBeNull();
  });

  it("does not resolve from omission without matching baseline evidence", () => {
    expect(collateralMitigationEvidence(finding(), [], [])).toBeNull();
  });

  it("does not resolve when the advisory remains after the upgrade", () => {
    expect(collateralMitigationEvidence(finding(), [finding()], [finding({ currentVersions: "1.5.0" })])).toBeNull();
  });

  it("does not cross manifest contexts", () => {
    expect(collateralMitigationEvidence(finding(), [finding({ filePath: "apps/web/package-lock.json" })], [])).toBeNull();
  });

  it("does not correlate findings without package and advisory identity", () => {
    expect(collateralMitigationEvidence(finding({ affectedPackages: null, component: null, cves: null, externalId: "scanner-rule" }), [finding()], [])).toBeNull();
  });
});
