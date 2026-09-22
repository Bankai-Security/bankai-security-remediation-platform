import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('../../Jenkinsfile', import.meta.url), 'utf8');
const requiredStages = [
  'Checkout and metadata', 'Install locked dependencies', 'Backend typecheck', 'Backend lint',
  'Backend unit tests', 'Backend component tests', 'Backend integration tests', 'Backend production build',
  'Frontend lint', 'Frontend unit and component tests', 'Frontend production build',
  'CDK formatting and compilation', 'CDK tests', 'CDK synthesis', 'Infrastructure security scan',
  'Bankai image build', 'API container health test', 'Worker container startup test',
  'Container vulnerability scan', 'Secret scan', 'SBOM generation', 'Publish reports',
];
for (const stage of requiredStages) {
  if (!pipeline.includes(`stage('${stage}')`)) throw new Error(`missing required stage: ${stage}`);
}
for (const forbidden of ['cdk deploy', 'aws cloudformation execute-change-set', "label 'trusted-docker'", 'withCredentials(']) {
  if (pipeline.includes(forbidden)) throw new Error(`forbidden PR pipeline capability: ${forbidden}`);
}
for (const required of ["label 'pr-container'", 'npm ci', 'junit ', 'archiveArtifacts',
  'allowEmptyArchive: false', 'skipDefaultCheckout(true)', 'disableConcurrentBuilds', 'timeout(time: 60']) {
  if (!pipeline.includes(required)) throw new Error(`missing pipeline control: ${required}`);
}
if (/\|\|\s*true|allowEmptyResults:\s*true|returnStatus:\s*true/.test(pipeline)) {
  throw new Error('pipeline contains a failure-masking construct');
}
console.log(`Bankai Jenkinsfile policy passed: ${requiredStages.length} required stages, no deploy/credential/failure-masking constructs.`);
