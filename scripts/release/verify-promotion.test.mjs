import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPromotion } from './verify-promotion.mjs';
import { requiredSmokeChecks } from './verify-smoke-evidence.mjs';
const hash = x => `sha256:${createHash('sha256').update(x).digest('hex')}`;
function fixture() {
  const image = `sha256:${'a'.repeat(64)}`;
  const files = { frontend: Buffer.from('immutable frontend'), infrastructure: Buffer.from(JSON.stringify({ Resources: {
    ...Object.fromEntries([['ApiServiceTaskDef1234ABCD', 'web'], ['WorkerTask1234ABCD', 'Worker']].map(([id, Name]) => [id, { Type: 'AWS::ECS::TaskDefinition', Properties: { ContainerDefinitions: [{ Name, Image: `926827998551.dkr.ecr.ap-south-1.amazonaws.com/bankai/nonprod/backend@${image}` }] } }])),
  } })), smoke: Buffer.from(JSON.stringify({ mode: 'smoke', release: { deploymentId: 'bankai-test', gitSha: 'b'.repeat(40), jenkinsBuild: 'build-7' }, results: requiredSmokeChecks.map(name => ({ name, error: null })) })) };
  const manifest = { schemaVersion: 2, releaseId: 'bankai-test', status: 'SUCCESS', environment: 'nonprod',
    account: '926827998551', region: 'ap-south-1', cdkGitSha: 'b'.repeat(40), jenkinsBuild: 'build-7',
    bankai: { gitSha: 'b'.repeat(40), imageDigest: image },
    ...Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, { artifact: key, checksum: hash(bytes) }])) };
  manifest.frontend.configuration = 'runtime-v1';
  return { manifest, files, read: name => files[name] };
}

for (const fault of ['wrong-worker-image', 'wrong-registry', 'digest-only-in-sidecar']) {
  test(`rejects checksum-valid template with ${fault}`, () => {
    const f = fixture(); const template = JSON.parse(f.files.infrastructure);
    const containers = template.Resources.WorkerTask1234ABCD.Properties.ContainerDefinitions;
    if (fault === 'digest-only-in-sidecar') containers.push({ Name: 'sidecar', Image: containers[0].Image });
    containers[0].Image = fault === 'wrong-registry' ? containers[0].Image.replace('926827998551', '111111111111') : `unexpected@sha256:${'e'.repeat(64)}`;
    f.files.infrastructure = Buffer.from(JSON.stringify(template));
    f.manifest.infrastructure.checksum = hash(f.files.infrastructure);
    assert.throws(() => verifyPromotion(f.manifest, f.read));
  });
}

for (const fault of ['different-release', 'duplicate-check', 'missing-check', 'missing-outcome']) {
  test(`rejects checksum-valid smoke evidence with ${fault}`, () => {
    const f = fixture(); const smoke = JSON.parse(f.files.smoke);
    if (fault === 'different-release') smoke.release.deploymentId = 'another-release';
    if (fault === 'duplicate-check') smoke.results.push(smoke.results[0]);
    if (fault === 'missing-check') smoke.results.shift();
    if (fault === 'missing-outcome') delete smoke.results[0].error;
    f.files.smoke = Buffer.from(JSON.stringify(smoke));
    f.manifest.smoke.checksum = hash(f.files.smoke);
    assert.throws(() => verifyPromotion(f.manifest, f.read));
  });
}
test('verified artifact bundle never authorizes production apply', () => {
  const f = fixture(); assert.equal(verifyPromotion(f.manifest, f.read).productionApplyAuthorized, false);
});
for (const fault of ['legacy', 'failed', 'wrong-account', 'zero-digest', 'wrong-sha', 'tampered-frontend', 'tampered-template', 'failed-smoke']) {
  test(`rejects ${fault}`, () => {
    const f = fixture();
    if (fault === 'legacy') f.manifest.schemaVersion = 1;
    if (fault === 'failed') f.manifest.status = 'FAILURE';
    if (fault === 'wrong-account') f.manifest.account = '222222222222';
    if (fault === 'zero-digest') f.manifest.bankai.imageDigest = `sha256:${'0'.repeat(64)}`;
    if (fault === 'wrong-sha') f.manifest.cdkGitSha = 'd'.repeat(40);
    if (fault === 'tampered-frontend') f.files.frontend = Buffer.from('changed');
    if (fault === 'tampered-template') f.files.infrastructure = Buffer.from('{}');
    if (fault === 'failed-smoke') { f.files.smoke = Buffer.from('{"mode":"smoke","results":[{"error":"failed"}]}'); f.manifest.smoke.checksum = hash(f.files.smoke); }
    assert.throws(() => verifyPromotion(f.manifest, f.read));
  });
}
