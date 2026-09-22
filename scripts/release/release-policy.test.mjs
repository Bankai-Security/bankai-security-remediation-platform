import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const review = fileURLToPath(new URL('./review-change-set.mjs', import.meta.url));
const manifest = fileURLToPath(new URL('./write-release-manifest.mjs', import.meta.url));
const validator = fileURLToPath(new URL('../ci/validate-release-jenkinsfile.mjs', import.meta.url));

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
