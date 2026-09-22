import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('../../Jenkinsfile.release', import.meta.url), 'utf8');
const stages = [
  'Checkout exact revisions', 'Validate release target', 'Rerun Bankai quality gates',
  'Rerun Quincy quality gates', 'Build release assets once', 'Publish immutable images',
  'Synthesize exact release', 'Prepare and review change set', 'Execute reviewed change set',
  'Wait for services', 'Publish frontend', 'Smoke and integration checks',
  'Record release and Datadog event',
];
let previous = -1;
for (const stage of stages) {
  const index = pipeline.indexOf(`stage('${stage}')`);
  if (index < 0) throw new Error(`missing release stage: ${stage}`);
  if (index <= previous) throw new Error(`release stage out of order: ${stage}`);
  previous = index;
}
for (const required of ["label 'trusted-docker'", "BRANCH_NAME != 'main'", '--method=prepare-change-set',
  'review-change-set.mjs', 'execute-change-set', 'services-stable', 'create-invalidation',
  'write-release-manifest.mjs', 'archiveArtifacts', 'disableConcurrentBuilds']) {
  if (!pipeline.includes(required)) throw new Error(`missing release control: ${required}`);
}
for (const forbidden of [':latest', '--force-new-deployment', 'allowEmptyArchive: true', 'returnStatus: true', '|| true']) {
  if (pipeline.includes(forbidden)) throw new Error(`forbidden release construct: ${forbidden}`);
}
console.log(`Release Jenkinsfile policy passed: ${stages.length} ordered stages and fail-closed deployment controls.`);
