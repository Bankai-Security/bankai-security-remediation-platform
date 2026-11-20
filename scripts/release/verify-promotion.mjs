import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySmokeEvidence } from './verify-smoke-evidence.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = /^sha256:(?!0{64}$)[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
export function verifyPromotion(manifest, readArtifact) {
  if (manifest.schemaVersion !== 2 || manifest.environment !== 'nonprod' || manifest.status !== 'SUCCESS') throw new Error('A successful schema-v2 nonprod release is required; legacy manifests cannot be promoted');
  if (!/^[a-zA-Z0-9-]+$/.test(manifest.releaseId ?? '')) throw new Error('Missing or invalid release ID');
  if (manifest.account !== '926827998551' || manifest.region !== 'ap-south-1') throw new Error('Unexpected source account/region');
  if (manifest.frontend?.configuration !== 'runtime-v1') throw new Error('Frontend must support separately deployed runtime configuration');
  if (!sha.test(manifest.bankai?.gitSha) || !digest.test(manifest.bankai?.imageDigest)) throw new Error('Invalid Bankai identity');
  if (!sha.test(manifest.cdkGitSha) || manifest.cdkGitSha !== manifest.bankai.gitSha) throw new Error('Infrastructure source differs from release');
  for (const key of ['frontend', 'infrastructure', 'smoke']) {
    const item = manifest[key];
    if (!item || !digest.test(item.checksum) || hash(readArtifact(item.artifact)) !== item.checksum) throw new Error(`${key} artifact checksum mismatch`);
  }
  const template = JSON.parse(readArtifact(manifest.infrastructure.artifact));
  const tasks = Object.entries(template.Resources ?? {}).filter(([, r]) => r.Type === 'AWS::ECS::TaskDefinition');
  for (const [logicalPrefix, containerName] of [
    ['ApiServiceTaskDef', 'web'],
    ['WorkerTask', 'Worker'],
  ]) {
    const matching = tasks.filter(([id]) => new RegExp(`^${logicalPrefix}[A-F0-9]{8}$`).test(id));
    const containers = matching.flatMap(([, task]) => task.Properties?.ContainerDefinitions ?? [])
      .filter(container => container.Name === containerName);
    const expected = `${manifest.account}.dkr.ecr.${manifest.region}.amazonaws.com/bankai/nonprod/backend@${manifest.bankai.imageDigest}`;
    if (matching.length !== 1 || containers.length !== 1 || containers[0].Image !== expected) {
      throw new Error(`${logicalPrefix} does not use the exact verified Bankai image`);
    }
  }
  const smoke = JSON.parse(readArtifact(manifest.smoke.artifact));
  verifySmokeEvidence(smoke, { deploymentId: manifest.releaseId, gitSha: manifest.bankai.gitSha,
    jenkinsBuild: manifest.jenkinsBuild });
  return { schemaVersion: 1, releaseId: manifest.releaseId, manifestChecksum: hash(Buffer.from(JSON.stringify(manifest))),
    bankai: manifest.bankai, frontend: manifest.frontend,
    infrastructure: manifest.infrastructure, status: 'VERIFIED_SOURCE_ONLY',
    productionApplyAuthorized: false,
    outstanding: ['Verify Jenkins build SUCCESS and immutable artifact provenance independently',
      'Verify full nonprod E2E and security gates for this release',
      'Verify frontend API origin compatibility without rebuilding',
      'Copy images by digest to production ECR and verify destination digests',
      'Prepare and review a production-specific template and CloudFormation change set',
      'Record independent human approval of exact plan/checksums before production apply'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, bundleRoot, output] = process.argv.slice(2);
  if (!manifestPath || !bundleRoot || !output) throw new Error('usage: verify-promotion.mjs MANIFEST BUNDLE_ROOT OUTPUT');
  const root = realpathSync(resolve(bundleRoot));
  const readArtifact = name => {
    if (typeof name !== 'string' || isAbsolute(name)) throw new Error('Artifact must have a relative bundle path');
    const full = realpathSync(resolve(root, name)); const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes bundle');
    return readFileSync(full);
  };
  const result = verifyPromotion(JSON.parse(readFileSync(manifestPath)), readArtifact);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Source artifacts verified. Production authorization and target plan are still required.');
}
