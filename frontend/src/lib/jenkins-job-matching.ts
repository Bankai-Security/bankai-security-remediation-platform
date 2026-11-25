export type JenkinsJobCandidate = { name: string; url: string; supportsPullRequests?: boolean; pullRequestNumber?: number; branchName?: string };

function sameJobUrl(leftUrl: string, rightUrl: string): boolean {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

export function isJobNestedUnder(parentUrl: string, candidateUrl: string): boolean {
  try {
    const parent = new URL(parentUrl);
    const candidate = new URL(candidateUrl);
    const parentPath = parent.pathname.replace(/\/+$/, "");
    const candidatePath = candidate.pathname.replace(/\/+$/, "");

    return parent.origin === candidate.origin
      && candidatePath.startsWith(`${parentPath}/`);
  } catch {
    return false;
  }
}

function pullRequestNumberFromJobUrl(jobUrl: string): number | undefined {
  try {
    const path = decodeURIComponent(new URL(jobUrl).pathname);
    const match = path.match(/(?:^|\/)job\/(?:pr|pull)[-_]?(\d+)(?:[-_/](?:head|merge))?(?:\/|$)/i);
    if (!match) return undefined;
    const number = Number(match[1]);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  } catch {
    return undefined;
  }
}

export function findPullRequestJob<T extends JenkinsJobCandidate>(jobs: T[], selectedUrl: string, expectedNames: Set<string>, pullRequestNumber?: number): T | undefined {
  const isExpectedPullRequest = (job: JenkinsJobCandidate) => job.supportsPullRequests
    && (pullRequestNumber != null ? job.pullRequestNumber === pullRequestNumber : false);
  const scope = resolveVerificationScope(jobs, selectedUrl);
  const identifiedPr = jobs.find((job) => isExpectedPullRequest(job) && isJobNestedUnder(scope, job.url));
  if (identifiedPr) return identifiedPr;

  const isExpectedName = (job: JenkinsJobCandidate) => expectedNames.has(job.name.toLowerCase());
  const isConventionalPullRequestName = (job: JenkinsJobCandidate) => pullRequestNumber != null
    && ( [`pr-${pullRequestNumber}`, `pr_${pullRequestNumber}`, `pr/${pullRequestNumber}`, `pull-${pullRequestNumber}`].includes(job.name.toLowerCase())
      || pullRequestNumberFromJobUrl(job.url) === pullRequestNumber );
  const selectedPrJob = jobs.find((job) => isExpectedName(job) && job.supportsPullRequests && sameJobUrl(job.url, selectedUrl));
  if (selectedPrJob) return selectedPrJob;

  return jobs.find((job) => isJobNestedUnder(scope, job.url) && (
    (job.supportsPullRequests && (isExpectedName(job) || (job.branchName != null && expectedNames.has(job.branchName.toLowerCase()))))
    || isConventionalPullRequestName(job)
  ));
}

// A saved selection may point to main or to a PR that Jenkins has since pruned.
// Resolve its immediate job parent, including URLs exposed through Jenkins views.
export function resolveVerificationScope(jobs: JenkinsJobCandidate[], selectedUrl: string): string {
  try {
    const parent = new URL(selectedUrl);
    const path = parent.pathname.replace(/\/+$/, "");
    const boundary = path.lastIndexOf("/job/");
    if (boundary < 0) return selectedUrl;
    parent.pathname = path.slice(0, boundary).replace(/\/view\/[^/]+$/, "") + "/";
    return jobs.find((job) => job.supportsPullRequests && sameJobUrl(job.url, parent.href))?.url ?? selectedUrl;
  } catch {
    return selectedUrl;
  }
}
