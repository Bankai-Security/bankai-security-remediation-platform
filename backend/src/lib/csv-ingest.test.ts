import { describe, expect, it } from "vitest";
import { computeAiFingerprint, normalizeDate, normalizeSeverity, parseFindingsCsv, planIngest } from "./csv-ingest.js";

const policy = { Critical: 1, High: 5, Medium: 10, Low: 20 } as const;

describe("finding normalization and deduplication", () => {
  it("normalizes header aliases, severity aliases, dates, and stable external IDs", () => {
    const [finding] = parseFindingsCsv(Buffer.from(
      "Finding ID,Summary,Risk Level,CVSS,Found Date,Path,Team\n CVE-1 , SQL injection , severe ,9.8,2026-09-01,src/db.ts,payments\n",
    ));
    expect(finding).toMatchObject({
      fingerprint: "id:cve-1",
      externalId: "CVE-1",
      title: "SQL injection",
      severity: "Critical",
      cvssScore: 9.8,
      dateFound: "2026-09-01",
      filePath: "src/db.ts",
      service: "payments",
    });
  });

  it("derives severity from CVSS and rejects invalid dates safely", () => {
    expect(normalizeSeverity("unknown", 7.0)).toBe("High");
    expect(normalizeSeverity(undefined, null)).toBe("Medium");
    expect(normalizeDate("not-a-date")).toBeNull();
  });

  it("keeps the first duplicate fingerprint and reports missing findings without resolving them", () => {
    const rows = parseFindingsCsv(Buffer.from("id,title,severity\nA,first,high\nA,duplicate,critical\n"));
    const plan = planIngest(
      "project",
      "scan",
      [{ fingerprint: "id:old", severity: "Low", cvssScore: null, bucket: "In Progress" }],
      rows,
      new Date("2026-09-19T00:00:00Z"),
      policy,
    );
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0]?.title).toBe("first");
    expect(plan.notDetectedFingerprints).toEqual(["id:old"]);
    expect(plan.counts).toEqual({ newDelta: 1, changed: 0, inProgress: 0, notDetected: 1 });
  });

  it("uses a coarse line bucket for stable AI finding identity", () => {
    const first = computeAiFingerprint({ filePath: "src/db.ts", cwe: "CWE-89", lineStart: 21 });
    const shifted = computeAiFingerprint({ filePath: "SRC/DB.TS", cwe: "cwe-89", lineStart: 29 });
    expect(first).toBe(shifted);
  });

  it("reports missing findings as not detected without changing their status", () => {
    const plan = planIngest(
      "project",
      "scan",
      [{ fingerprint: "id:old", severity: "Low", cvssScore: null, bucket: "In Progress" }],
      [],
      new Date("2026-09-19T00:00:00Z"),
      policy,
      null,
    );

    expect(plan.notDetectedFingerprints).toEqual(["id:old"]);
    expect(plan.counts.notDetected).toBe(1);
  });

  it("reuses the active matching finding when temporary-path fingerprints drift", () => {
    const row = parseFindingsCsv(Buffer.from("id,title,severity\nstable,Vulnerability,high\n"))[0]!;
    const plan = planIngest("project", "scan", [
      { fingerprint: "resolved-old", externalId: "stable", findingType: "semgrep", filePath: "src/a.py", severity: "High", cvssScore: null, bucket: "Resolved" },
      { fingerprint: "legacy-id", externalId: "stable", findingType: "semgrep", filePath: "tmp/bankai-scan-old/repo/src/a.py", severity: "High", cvssScore: null, bucket: "In Progress" },
    ], [{ ...row, findingType: "semgrep", filePath: "src/a.py" }], new Date("2026-11-22T00:00:00Z"), policy);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0]?.fingerprint).toBe("legacy-id");
    expect(plan.upsertRows[0]?.bucket).toBe("In Progress");
    expect(plan.counts.newDelta).toBe(0);
    expect(plan.notDetectedFingerprints).toEqual([]);
  });

  it("does not conflate the same CVE in different components", () => {
    const parsed = parseFindingsCsv(Buffer.from("id,title,severity\nCVE-2025-0001,Vulnerability,high\n"))[0]!;
    const row = { ...parsed, cves: "CVE-2025-0001", component: "package-b" };
    const plan = planIngest("project", "scan", [
      { fingerprint: "other-package", externalId: "GHSA-x", component: "package-a", cves: "CVE-2025-0001", severity: "High", cvssScore: null, bucket: "In Progress" },
    ], [row], new Date("2026-11-22T00:00:00Z"), policy);
    expect(plan.upsertRows[0]?.fingerprint).toBe(row.fingerprint);
    expect(plan.upsertRows[0]?.bucket).toBe("New Delta");
  });
});
