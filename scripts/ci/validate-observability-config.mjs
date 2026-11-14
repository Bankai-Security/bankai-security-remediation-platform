import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const pipeline = read('Jenkinsfile.observability');
const native = read('infrastructure/lib/native-observability.ts');
const foundation = read('infrastructure/lib/bankai-foundation-stack.ts');
const casc = read('infrastructure/jenkins/jenkins.yaml');
for (const forbidden of ['jenkins-datadog', 'configure-datadog', 'datadogGlobalConfiguration', 'addDatadogAgent', '--import dd-trace']) {
  if ([pipeline, foundation, casc].some(s => s.includes(forbidden))) throw new Error('Retired dependency: ' + forbidden);
}
for (const required of ['FailedBuilds', 'DesiredTaskCount', 'RunningTaskCount', 'StorageClass', 'FORECASTED', 'SnsAction', 'ci-pipeline', 'TreatMissingData.BREACHING']) {
  if (!native.includes(required)) throw new Error('Missing native monitoring contract: ' + required);
}
if (!pipeline.includes('inventory.mjs') || /execute-change-set|cdk deploy/.test(pipeline)) throw new Error('Inventory job must remain read-only');
console.log('AWS-native observability policy passed; live metric, email and alarm validation still required.');
