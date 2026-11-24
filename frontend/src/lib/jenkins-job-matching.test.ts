import { describe, expect, it } from "vitest";
import { findPullRequestJob, isJobNestedUnder } from "./jenkins-job-matching";

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

describe("findPullRequestJob", () => {
  const jobs = [
    { name: "bankai-scan-fixtures", url: "http://localhost:8080/job/bankai-scan-fixtures/", supportsPullRequests: true },
    { name: "PR-4", url: "http://localhost:8080/job/bankai-scan-fixtures/view/change-requests/job/PR-4/", supportsPullRequests: true },
    { name: "main", url: "http://localhost:8080/job/bankai-scan-fixtures/job/main/", supportsPullRequests: true },
  ];
  const expectedNames = new Set(["pr-4", "remediation/branch"]);

  it("uses the selected PR branch directly", () => {
    expect(findPullRequestJob(jobs, jobs[1].url, expectedNames)).toBe(jobs[1]);
  });

  it("finds the PR branch beneath the selected multibranch parent", () => {
    expect(findPullRequestJob(jobs, jobs[0].url, expectedNames)).toBe(jobs[1]);
  });

  it("resolves a selected main branch to its sibling PR", () => {
    expect(findPullRequestJob(jobs, jobs[2].url, expectedNames)).toBe(jobs[1]);
    expect(findPullRequestJob(jobs, jobs[0].url + "view/change-requests/job/PR-3/", expectedNames)).toBe(jobs[1]);
  });

  it("matches a PR by Jenkins branch metadata when its display name differs", () => {
    const metadataJobs = [
      { name: "bankai-scan-fixtures", url: "http://localhost:8080/job/bankai-scan-fixtures/", supportsPullRequests: true },
      { name: "github-pr-4", url: "http://localhost:8080/job/bankai-scan-fixtures/job/github-pr-4/", supportsPullRequests: true, pullRequestNumber: 4, branchName: "remediation/security-fix" },
    ];
    expect(findPullRequestJob(metadataJobs, metadataJobs[0].url, new Set(["remediation/security-fix"]), 4)).toBe(metadataJobs[1]);
    expect(findPullRequestJob(metadataJobs, metadataJobs[0].url, new Set(), 5)).toBeUndefined();
  });
});

