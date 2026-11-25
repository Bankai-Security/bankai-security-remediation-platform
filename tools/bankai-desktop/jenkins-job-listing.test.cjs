const test = require('node:test');
const assert = require('node:assert/strict');
const { listJenkinsJobs } = require('./jenkins-job-listing.cjs');

test('descends into a multibranch pipeline and identifies its PR branch jobs', async () => {
  const responses = new Map([
    ['https://jenkins.example/ci', { jobs: [
      { name: 'bankai-owner-repo', url: 'https://jenkins.example/ci/job/bankai-owner-repo/', _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject' },
    ] }],
    ['https://jenkins.example/ci/job/bankai-owner-repo/', { jobs: [
      { name: 'PR-16', url: 'https://jenkins.example/ci/job/bankai-owner-repo/job/PR-16/', _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', properties: [
        { _class: 'jenkins.branch.BranchJobProperty', branch: { head: { _class: 'org.jenkinsci.plugins.github_branch_source.PullRequestSCMHead', number: 16, name: 'remediation/sql-injection' } } },
      ] },
    ] }],
  ]);
  const jobs = await listJenkinsJobs({ url: 'https://jenkins.example/ci' }, async (url) => responses.get(url));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].supportsPullRequests, true);
  assert.equal(jobs[1].supportsPullRequests, true);
  assert.equal(jobs[1].pullRequestNumber, 16);
  assert.equal(jobs[1].branchName, 'remediation/sql-injection');
});
