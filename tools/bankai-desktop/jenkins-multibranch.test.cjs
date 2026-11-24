const test = require('node:test');
const assert = require('node:assert/strict');
const { pipelineConfigXml, pipelineUrl, repositoryName } = require('./jenkins-multibranch.cjs');

test('names a multibranch job for the connected repository', () => {
  assert.deepEqual(repositoryName('anubhavgpta/bankai-test-jenkins'), {
    owner: 'anubhavgpta', repository: 'bankai-test-jenkins', name: 'bankai-anubhavgpta-bankai-test-jenkins',
  });
});

test('keeps Jenkins context paths in the generated job URL', () => {
  assert.equal(pipelineUrl('https://jenkins.example/ci/', 'bankai-owner-repo'), 'https://jenkins.example/ci/job/bankai-owner-repo/');
});

test('discovers pull requests at their head revision for exact commit verification', () => {
  const xml = pipelineConfigXml('owner', 'repo');
  assert.match(xml, /OriginPullRequestDiscoveryTrait><strategyId>2<\/strategyId>/);
  assert.match(xml, /<scriptPath>Jenkinsfile<\/scriptPath>/);
  assert.doesNotMatch(xml, /<owner\b/);
});

test('rejects repository names that could escape the expected owner/repo shape', () => {
  assert.throws(() => repositoryName('owner/repo/extra'));
  assert.throws(() => repositoryName('../repo'));
});
