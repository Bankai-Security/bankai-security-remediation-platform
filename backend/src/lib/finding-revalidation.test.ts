import { describe, expect, it } from "vitest";
import { findingStillPresent, type FindingRevalidationIdentity } from "./finding-revalidation.js";

const finding = (overrides: Partial<FindingRevalidationIdentity> = {}): FindingRevalidationIdentity => ({
  fingerprint: "stored-fingerprint",
  externalId: "B602",
  title: "subprocess call with shell=True identified",
  component: null,
  filePath: "src/commands.py",
  findingType: "bandit",
  description: "shell=True",
  ...overrides,
});

describe("current-branch finding revalidation", () => {
  it("matches code findings when scanner paths use different checkout roots", () => {
    expect(findingStillPresent(
      finding({ filePath: "/tmp/bankai-scan-old/repo/src/commands.py" }),
      [finding({ fingerprint: "fresh-fingerprint" })],
    )).toBe(true);
  });

  it("normalizes Windows workspace and file URI paths", () => {
    expect(findingStillPresent(
      finding({ filePath: "file:///C:/agent_workspaces/repo/src/commands.py" }),
      [finding({ fingerprint: "fresh-fingerprint", filePath: "C:\\agent_workspaces\\repo\\src\\commands.py" })],
    )).toBe(true);
  });

  it.each(["pip_audit", "npm-audit", "trivy", "osv"])("matches %s dependency findings through shared advisory aliases and package identity", (scanner) => {
    expect(findingStillPresent(
      finding({ externalId: "PYSEC-2020-176", title: "PyYAML advisory", component: "PyYAML", filePath: "requirements.txt", findingType: scanner, cves: "CVE-2019-20477" }),
      [finding({ externalId: "CVE-2019-20477", title: "PyYAML advisory", component: "pyyaml", filePath: "requirements-prod.txt", findingType: scanner.replace("_", "-"), cves: "GHSA-8q59-q68h-6hv4, CVE-2019-20477" })],
    )).toBe(true);
  });

  it("does not match a shared CVE against a different package", () => {
    expect(findingStillPresent(
      finding({ externalId: "PYSEC-2020-176", component: "PyYAML", findingType: "pip-audit", cves: "CVE-2019-20477" }),
      [finding({ fingerprint: "fresh-fingerprint", externalId: "CVE-2019-20477", component: "OtherPackage", findingType: "pip-audit", cves: "CVE-2019-20477" })],
    )).toBe(false);
  });

  it("keeps a missing dependency finding stale when package and advisory do not match", () => {
    expect(findingStillPresent(
      finding({ externalId: "PYSEC-2020-176", component: "PyYAML", affectedPackages: "PyYAML", findingType: "pip-audit", title: "PyYAML 5.1 through 5.1.2 has insufficient restrictions on deserialization" }),
      [finding({ fingerprint: "fresh-fingerprint", externalId: "PYSEC-9999-1", component: "PyYAML", findingType: "pip-audit", title: "A different PyYAML issue" })],
    )).toBe(false);
  });
});
