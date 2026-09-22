import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('../../Jenkinsfile.e2e', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../e2e/run.mjs', import.meta.url), 'utf8');
for (const required of ["label 'trusted-docker'", "cron('H H * * *')", "choices: ['full', 'smoke']",
  "stage('Non-production smoke')", "stage('Synthetic remediation workflow')", 'jenkins-datadog-app-key',
  'bankai-e2e-github-token', 'junit ', 'archiveArtifacts']) {
  if (!pipeline.includes(required)) throw new Error(`missing E2E pipeline control: ${required}`);
}
for (const required of ['Bankai API reaches Redis', 'Quincy health and token rejection',
  'CloudFront serves the frontend', 'Supabase-backed login', 'GitHub webhook rejects',
  'worker completes it', 'Seeded vulnerability', 'Quincy remediation', 'Datadog receives',
  'Cleanup isolated E2E resources']) {
  if (!runner.includes(required)) throw new Error(`missing E2E contract: ${required}`);
}
for (const forbidden of ['allowEmptyResults: true', 'allowEmptyArchive: true', '|| true', 'production.bankai']) {
  if (pipeline.includes(forbidden) || runner.includes(forbidden)) throw new Error(`forbidden E2E construct: ${forbidden}`);
}
console.log('E2E policy passed: post-deploy smoke, nightly/full workflow, failure contracts, telemetry, and cleanup are enforced.');
