import { readFileSync } from 'node:fs';

const plugins = readFileSync(new URL('../jenkins/plugins.txt', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean);
const casc = readFileSync(new URL('../jenkins/jenkins.yaml', import.meta.url), 'utf8');

const required = ['configuration-as-code', 'github-branch-source', 'job-dsl', 'ec2-fleet',
  'aws-secrets-manager-credentials-provider', 'credentials-binding', 'datadog'];
for (const id of required) {
  if (!plugins.some((line) => line.startsWith(`${id}:`))) throw new Error(`missing pinned plugin: ${id}`);
}
for (const line of plugins) {
  if (!/^[a-z0-9-]+:[A-Za-z0-9_.-]+$/.test(line)) throw new Error(`plugin is not exactly pinned: ${line}`);
}
for (const text of ['numExecutors: 0', "scanCredentialsId('jenkins-github-app')",
  'enableCiVisibility: true', "multibranchPipelineJob('bankai')", "multibranchPipelineJob('quincy')",
  "pipelineJob('bankai-nonprod-release')", "upstream('bankai/main', 'SUCCESS')", "scriptPath('Jenkinsfile.release')",
  "pipelineJob('bankai-nonprod-e2e')", "scriptPath('Jenkinsfile.e2e')"]) {
  if (!casc.includes(text)) throw new Error(`missing JCasC control: ${text}`);
}
for (const text of ['labelString: "linux pr-validation"', 'labelString: "pr-container"', 'labelString: "trusted-docker"',
  'maxTotalUses: 1', 'privateIpUsed: true', 'manuallyProvidedKeyVerificationStrategy',
  'id: "jenkins-github-app"', 'privateKey: "${jenkins-github-app-private-key}"']) {
  if (!casc.includes(text)) throw new Error(`missing agent isolation control: ${text}`);
}
if (/(AKIA[0-9A-Z]{16}|ghp_|ddapi[_-]?key\s*:\s*[^$])/i.test(casc)) throw new Error('possible plaintext credential in JCasC');
console.log(`Jenkins configuration valid: ${plugins.length} pinned plugins, 2 multibranch jobs, release and E2E jobs, no plaintext secret patterns.`);
