import { describe, expect, it } from "vitest";
import { isJobNestedUnder } from "./jenkins-job-matching";

describe("isJobNestedUnder", () => {
  it("matches multibranch PR jobs nested through a Jenkins view", () => {
    expect(isJobNestedUnder(
      "http://localhost:8080/job/bankai-scan-fixtures/",
      "http://localhost:8080/job/bankai-scan-fixtures/view/change-requests/job/PR-4/",
    )).toBe(true);
  });

  it("matches direct branch jobs", () => {
    expect(isJobNestedUnder(
      "http://localhost:8080/job/bankai-scan-fixtures/",
      "http://localhost:8080/job/bankai-scan-fixtures/job/main/",
    )).toBe(true);
  });

  it("rejects jobs from a different Jenkins server or outside the parent path", () => {
    const parent = "http://localhost:8080/job/bankai-scan-fixtures/";
    expect(isJobNestedUnder(parent, "http://jenkins.example/job/bankai-scan-fixtures/job/PR-4/")).toBe(false);
    expect(isJobNestedUnder(parent, "http://localhost:8080/job/other/job/PR-4/")).toBe(false);
    expect(isJobNestedUnder(parent, "not a URL")).toBe(false);
  });
});
