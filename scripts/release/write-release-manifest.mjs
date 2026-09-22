import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('usage: write-release-manifest.mjs OUTPUT_JSON');
const required = [
  'BANKAI_SHA', 'QUINCY_SHA', 'BANKAI_IMAGE_DIGEST', 'QUINCY_IMAGE_DIGEST',
  'FRONTEND_ARTIFACT', 'JENKINS_BUILD', 'CDK_SHA', 'CHANGE_SET_ID',
  'AWS_ACCOUNT_ID', 'AWS_REGION', 'RELEASE_TIMESTAMP',
];
for (const key of required) if (!process.env[key]) throw new Error(`missing manifest field ${key}`);
const artifactBytes = readFileSync(process.env.FRONTEND_ARTIFACT);
const manifest = {
  schemaVersion: 1,
  environment: 'nonprod',
  account: process.env.AWS_ACCOUNT_ID,
  region: process.env.AWS_REGION,
  timestamp: process.env.RELEASE_TIMESTAMP,
  bankai: { gitSha: process.env.BANKAI_SHA, imageDigest: process.env.BANKAI_IMAGE_DIGEST },
  quincy: { gitSha: process.env.QUINCY_SHA, imageDigest: process.env.QUINCY_IMAGE_DIGEST },
  frontend: {
    artifact: process.env.FRONTEND_ARTIFACT,
    checksum: `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`,
  },
  jenkinsBuild: process.env.JENKINS_BUILD,
  cdkGitSha: process.env.CDK_SHA,
  cloudFormationChangeSetIds: [process.env.CHANGE_SET_ID],
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Release manifest written to ${outputPath}`);
