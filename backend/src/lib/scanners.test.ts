import { describe, expect, it } from "vitest";
import { normalizeScannerFindings } from "./scanners.js";

describe("scanner finding identity", () => {
  it("normalizes temporary checkout paths and package casing for advisory identity", () => {
    const trivy = normalizeScannerFindings("trivy", { Results: [{ Target: "tmp/bankai-scan-one/repo/requirements.txt", Vulnerabilities: [{ VulnerabilityID: "GHSA-6q48-6c7w-9gw2", CVEIDs: [], PkgName: "certifi", Title: "emSign CA issue", Severity: "HIGH" }] }] }, "owner/repo", "a".repeat(40), "/tmp/bankai-scan-one/repo");
    const osv = normalizeScannerFindings("osv", { results: [{ source: { path: "requirements.txt" }, packages: [{ package: { name: "CERTIFI" }, vulnerabilities: [{ id: "GHSA-6q48-6c7w-9gw2", aliases: [], summary: "emSign CA issue" }] }] }] }, "owner/repo", "b".repeat(40), "/tmp/bankai-scan-two/repo");
    expect(trivy[0]?.filePath).toBe("requirements.txt");
    expect(osv[0]?.filePath).toBe("requirements.txt");
    expect(trivy[0]?.fingerprint).toBe(osv[0]?.fingerprint);
  });

  it("normalizes Semgrep findings emitted with temporary checkout prefixes", () => {
    const result = { results: [{ check_id: "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true", path: "tmp/bankai-scan-new/repo/src/commands.py", extra: { message: "shell=True", severity: "WARNING" }, start: { line: 12 } }] };
    const first = normalizeScannerFindings("semgrep", result, "owner/repo", "c".repeat(40), "/tmp/bankai-scan-new/repo");
    const second = normalizeScannerFindings("semgrep", { results: [{ ...result.results[0], path: "/tmp/bankai-scan-other/repo/src/commands.py" }] }, "owner/repo", "d".repeat(40), "/tmp/bankai-scan-other/repo");
    expect(first[0]?.filePath).toBe("src/commands.py");
    expect(second[0]?.filePath).toBe("src/commands.py");
    expect(first[0]?.fingerprint).toBe(second[0]?.fingerprint);
  });

  it("uses shared CVE aliases when advisory databases use different IDs", () => {
    const trivy = normalizeScannerFindings("trivy", { Results: [{ Target: "requirements.txt", Vulnerabilities: [{ VulnerabilityID: "CVE-2019-20477", CVEIDs: [], PkgName: "PyYAML", Title: "issue", Severity: "HIGH" }] }] }, "owner/repo", "a".repeat(40), "/repo");
    const osv = normalizeScannerFindings("osv", { results: [{ source: { path: "requirements.txt" }, packages: [{ package: { name: "pyyaml" }, vulnerabilities: [{ id: "GHSA-8q59-q68h-6hv4", aliases: ["CVE-2019-20477"], summary: "issue" }] }] }] }, "owner/repo", "b".repeat(40), "/repo");
    expect(trivy[0]?.fingerprint).toBe(osv[0]?.fingerprint);
  });
});
