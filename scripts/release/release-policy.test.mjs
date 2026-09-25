import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stackOutput } from './stack-output.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const review = fileURLToPath(new URL('./review-change-set.mjs', import.meta.url));
const manifest = fileURLToPath(new URL('./write-release-manifest.mjs', import.meta.url));
const validator = fileURLToPath(new URL('../ci/validate-release-jenkinsfile.mjs', import.meta.url));
const prepare = fileURLToPath(new URL('./prepare-runtime.mjs', import.meta.url));

function releaseFixture() {
  const account = '123456789012';
  const config = { account, region: 'ap-south-1', datadogSite: 'datadoghq.com' };
  const values = {
    BackendRepositoryUri: `${account}.dkr.ecr.ap-south-1.amazonaws.com/bankai/nonprod/backend`,
    QuincyRepositoryUri: `${account}.dkr.ecr.ap-south-1.amazonaws.com/bankai/nonprod/quincy`,
    JenkinsEcrPublishingRoleArnDD79E21B: `arn:aws:iam::${account}:role/bankai-nonprod-ecr-publishing`,
    JenkinsNonprodDeploymentRoleArn96BF7C8A: `arn:aws:iam::${account}:role/bankai-nonprod-deployment`,
    JenkinsCloudFormationDeploymentRoleArn8FB4218E: `arn:aws:iam::${account}:role/bankai-nonprod-cloudformation-deployment`,
    EcsClusterName: 'bankai-nonprod', ApiServiceName: 'bankai-nonprod-api',
    WorkerServiceName: 'bankai-nonprod-worker', QuincyServiceName: 'bankai-nonprod-quincy',
    FrontendBucketName: 'bankai-nonprod-frontend', FrontendDistributionId: 'DISTRIBUTION',
  };
  const stack = { StackName: 'Bankai-nonprod-Foundation', StackStatus: 'UPDATE_COMPLETE',
    Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  return { config, stack };
}

test('resolves deployed CDK-prefixed outputs and rejects missing, blank and ambiguous values', () => {
  const { stack } = releaseFixture();
  assert.match(stackOutput(stack, 'EcrPublishingRoleArn'), /role\/bankai-nonprod-ecr-publishing$/);
  assert.equal(stackOutput(stack, 'EcsClusterName'), 'bankai-nonprod');
  assert.throws(() => stackOutput(stack, 'Unknown'), /non-empty/);
  assert.throws(() => stackOutput({ Outputs: [{ OutputKey: 'Test', OutputValue: '' }] }, 'Test'), /non-empty/);
  stack.Outputs.push({ OutputKey: 'EcrPublishingRoleArn', OutputValue: 'conflicting-value' });
  assert.throws(() => stackOutput(stack, 'EcrPublishingRoleArn'), /found 2/);
});

test('preflight validates every output before appending a usable shell environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bankai-preflight-'));
  const configPath = join(dir, 'config.json');
  const stackPath = join(dir, 'stack.json');
  const runtimePath = join(dir, 'runtime.env');
  const { config, stack } = releaseFixture();
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(stackPath, JSON.stringify({ Stacks: [stack] }));
  writeFileSync(runtimePath, 'BANKAI_SHA=existing\n');
  execFileSync(process.execPath, [prepare, configPath, stackPath, runtimePath]);
  assert.match(readFileSync(runtimePath, 'utf8'), /PUBLISHING_ROLE_ARN=arn:aws:iam::123456789012:role\/bankai-nonprod-ecr-publishing\n/);
  assert.match(readFileSync(runtimePath, 'utf8'), /DATADOG_SITE=datadoghq.com\n/);
  const before = readFileSync(runtimePath, 'utf8');
  stack.Outputs = stack.Outputs.filter(output => !output.OutputKey.includes('EcrPublishingRoleArn'));
  writeFileSync(stackPath, JSON.stringify({ Stacks: [stack] }));
  assert.notEqual(spawnSync(process.execPath, [prepare, configPath, stackPath, runtimePath]).status, 0);
  assert.equal(readFileSync(runtimePath, 'utf8'), before);
});

for (const fault of ['wrong-account-role', 'wrong-repository', 'busy-stack', 'wrong-stack', 'invalid-datadog-site']) {
  test(`preflight refuses ${fault}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bankai-preflight-'));
    const { config, stack } = releaseFixture();
    if (fault === 'wrong-account-role') stack.Outputs.find(x => x.OutputKey.includes('EcrPublishingRoleArn')).OutputValue = 'arn:aws:iam::999999999999:role/bankai-nonprod-ecr-publishing';
    if (fault === 'wrong-repository') stack.Outputs.find(x => x.OutputKey === 'BackendRepositoryUri').OutputValue = 'other.example/production';
    if (fault === 'busy-stack') stack.StackStatus = 'UPDATE_IN_PROGRESS';
    if (fault === 'wrong-stack') stack.StackName = 'Bankai-production-Foundation';
    if (fault === 'invalid-datadog-site') config.datadogSite = 'US1';
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    writeFileSync(join(dir, 'stack.json'), JSON.stringify({ Stacks: [stack] }));
    assert.notEqual(spawnSync(process.execPath, [prepare, join(dir, 'config.json'), join(dir, 'stack.json'), join(dir, 'runtime.env')]).status, 0);
  });
}

test('permits ECS task-definition revisions but still rejects service and storage replacements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bankai-review-'));
  for (const [type, replacement, accepted] of [
    ['AWS::ECS::TaskDefinition', 'True', true],
    ['AWS::ECS::TaskDefinition', 'Conditional', true],
    ['AWS::ECS::Service', 'True', false],
    ['AWS::EFS::AccessPoint', 'True', false],
    ['AWS::S3::Bucket', 'Conditional', false],
  ]) {
    writeFileSync(join(dir, 'input.json'), JSON.stringify({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
      Changes: [{ ResourceChange: { Action: 'Modify', LogicalResourceId: 'Application', ResourceType: type, Replacement: replacement } }] }));
    const result = spawnSync(process.execPath, [review, join(dir, 'input.json'), join(dir, 'output.json')]);
    assert.equal(result.status === 0, accepted, `${type}/${replacement}`);
  }
});

test('approves additions and in-place modifications', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bankai-release-'));
  const input = join(directory, 'change-set.json');
  const output = join(directory, 'review.json');
  writeFileSync(input, JSON.stringify({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', ChangeSetId: 'cs-1', StackId: 'stack-1', Changes: [
    { ResourceChange: { Action: 'Add', LogicalResourceId: 'New', ResourceType: 'AWS::ECS::TaskDefinition' } },
    { ResourceChange: { Action: 'Modify', LogicalResourceId: 'Safe', ResourceType: 'AWS::ECS::Service', Replacement: 'False' } },
  ] }));
  execFileSync(process.execPath, [review, input, output]);
  assert.equal(JSON.parse(readFileSync(output)).decision, 'APPROVED');
});

test('rejects removals and conditional replacements', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bankai-release-'));
  const input = join(directory, 'change-set.json');
  const output = join(directory, 'review.json');
  writeFileSync(input, JSON.stringify({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', ChangeSetId: 'cs-2', StackId: 'stack-1', Changes: [
    { ResourceChange: { Action: 'Remove', LogicalResourceId: 'Data', ResourceType: 'AWS::S3::Bucket' } },
    { ResourceChange: { Action: 'Modify', LogicalResourceId: 'Network', ResourceType: 'AWS::EC2::VPC', Replacement: 'Conditional' } },
  ] }));
  const result = spawnSync(process.execPath, [review, input, output]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(output)).decision, 'REJECTED');
});

test('writes the required traceability manifest and artifact checksum', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bankai-release-'));
  const artifact = join(directory, 'frontend.tgz');
  const output = join(directory, 'manifest.json');
  writeFileSync(artifact, 'frontend');
  execFileSync(process.execPath, [manifest, output], { env: { ...process.env,
    BANKAI_SHA: 'a'.repeat(40), QUINCY_SHA: 'b'.repeat(40), BANKAI_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
    QUINCY_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`, FRONTEND_ARTIFACT: artifact, JENKINS_BUILD: 'build-7',
    CDK_SHA: 'a'.repeat(40), CHANGE_SET_ID: 'cs-7', AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'ap-south-1',
    RELEASE_TIMESTAMP: '2026-09-21T00:00:00Z',
  } });
  const value = JSON.parse(readFileSync(output));
  assert.equal(value.environment, 'nonprod');
  assert.match(value.frontend.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(value.cloudFormationChangeSetIds, ['cs-7']);
});

test('release Jenkinsfile passes its static policy', () => {
  execFileSync(process.execPath, [validator], { cwd: root });
});
