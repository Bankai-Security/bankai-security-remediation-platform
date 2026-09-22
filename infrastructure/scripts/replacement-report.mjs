import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [baselineDir, currentDir, reportPath] = process.argv.slice(2);
if (!baselineDir || !currentDir || !reportPath) {
  throw new Error('usage: replacement-report.mjs BASELINE_CDK_OUT CURRENT_CDK_OUT REPORT_JSON');
}
const protectedTypes = new Set([
  'AWS::ECR::Repository', 'AWS::S3::Bucket', 'AWS::EFS::FileSystem',
  'AWS::ElastiCache::ReplicationGroup', 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::CloudFront::Distribution', 'AWS::ECS::Service', 'AWS::Route53::RecordSet',
]);

function load(directory) {
  const name = readdirSync(directory).find((entry) => entry.endsWith('.template.json'));
  if (!name) throw new Error(`No template in ${directory}`);
  return JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
}

const baseline = load(baselineDir);
const current = load(currentDir);
const protectedResources = (template) => Object.entries(template.Resources)
  .filter(([, resource]) => protectedTypes.has(resource.Type))
  .map(([logicalId, resource]) => ({ logicalId, type: resource.Type }));
const before = protectedResources(baseline);
const after = protectedResources(current);
const afterIds = new Set(after.map(({ logicalId }) => logicalId));
const beforeIds = new Set(before.map(({ logicalId }) => logicalId));
const report = {
  removedOrReplaced: before.filter(({ logicalId }) => !afterIds.has(logicalId)),
  added: after.filter(({ logicalId }) => !beforeIds.has(logicalId)),
  preserved: before.filter(({ logicalId }) => afterIds.has(logicalId)),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (report.removedOrReplaced.length > 0) process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
