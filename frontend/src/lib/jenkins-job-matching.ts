export type JenkinsJobCandidate = { name: string; url: string; supportsPullRequests?: boolean };

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

export function findPullRequestJob<T extends JenkinsJobCandidate>(jobs: T[], selectedUrl: string, expectedNames: Set<string>): T | undefined {
  const isExpectedName = (job: JenkinsJobCandidate) => expectedNames.has(job.name.toLowerCase());
  const selectedPrJob = jobs.find((job) => isExpectedName(job) && job.supportsPullRequests && sameJobUrl(job.url, selectedUrl));
  return selectedPrJob ?? jobs.find((job) => isExpectedName(job) && isJobNestedUnder(selectedUrl, job.url));
}
