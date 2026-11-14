// Read-only metadata inventory. Never calls GetSecretValue, decrypt, delete or apply.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? `reports/readiness/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const stage = process.argv[3] ?? 'nonprod';
const expectedAccount = { nonprod: '926827998551', production: '643681121175' }[stage];
if (!expectedAccount) throw new Error('Inventory stage must be nonprod or production');
const stackName = `Bankai-${stage}-Foundation`;
const clusterName = `bankai-${stage}`;
mkdirSync(directory, { recursive: true });
const results = [];
function query(name, args, region = 'ap-south-1') {
  let run = spawnSync('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 45000 });
  // Some CLI paginator versions emit no JSON for an empty collection.
  // Retry one page to distinguish an empty result from an unusable response.
  if (run.status === 0 && !run.stdout.trim()) run = spawnSync('aws', [...args, '--no-paginate', '--region', region, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 45000 });
  const record = { name, args, region, timestamp: new Date().toISOString(), status: run.status === 0 ? 'PASS' : 'BLOCKED' };
  if (run.status === 0 && run.stdout.trim()) record.data = JSON.parse(run.stdout);
  else if (run.status === 0) { record.status = 'BLOCKED'; record.error = 'AWS CLI returned no JSON; do not infer an empty inventory'; }
  else record.error = (run.error?.message ?? run.stderr ?? 'Unknown AWS failure').trim();
  results.push(record);
  writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record.data;
}
const identity = query('identity', ['sts', 'get-caller-identity']);
if (identity?.Account !== expectedAccount) {
  console.error(identity ? 'Wrong account: refusing inventory' : 'AWS credentials unavailable; see identity.json');
  process.exitCode = 1;
} else {
  const stack = query('stack', ['cloudformation', 'describe-stacks', '--stack-name', stackName]);
  query('stack-resources', ['cloudformation', 'list-stack-resources', '--stack-name', stackName]);
  query('clusters', ['ecs', 'describe-clusters', '--clusters', clusterName, '--include', 'SETTINGS', 'STATISTICS']);
  const services = query('services', ['ecs', 'list-services', '--cluster', clusterName]);
  for (let i = 0; i < (services?.serviceArns.length ?? 0); i += 10) query(`service-details-${i}`, ['ecs', 'describe-services', '--cluster', clusterName, '--services', ...services.serviceArns.slice(i, i + 10)]);
  const groups = query('logs', ['logs', 'describe-log-groups']);
  for (const [i, group] of (groups?.logGroups ?? []).filter(g => /bankai|quincy/i.test(g.logGroupName)).entries()) {
    query(`subscriptions-${i}`, ['logs', 'describe-subscription-filters', '--log-group-name', group.logGroupName]);
  }
  const calls = [
    ['alarms', ['cloudwatch', 'describe-alarms']], ['dashboards', ['cloudwatch', 'list-dashboards']],
    ['sns', ['sns', 'list-subscriptions']], ['budgets', ['budgets', 'describe-budgets', '--account-id', identity.Account]],
    ['secrets-metadata', ['secretsmanager', 'list-secrets']], ['ecr', ['ecr', 'describe-repositories']],
    ['efs', ['efs', 'describe-file-systems']], ['redis', ['elasticache', 'describe-replication-groups']],
    ['redis-snapshots', ['elasticache', 'describe-snapshots']], ['backup-vaults', ['backup', 'list-backup-vaults']],
    ['backup-plans', ['backup', 'list-backup-plans']], ['certificates', ['acm', 'list-certificates']],
    ['zones', ['route53', 'list-hosted-zones']], ['trail', ['cloudtrail', 'describe-trails', '--include-shadow-trails']],
    ['load-balancers', ['elbv2', 'describe-load-balancers']], ['security-groups', ['ec2', 'describe-security-groups']],
    ['iam-roles', ['iam', 'list-roles']], ['regional-waf', ['wafv2', 'list-web-acls', '--scope', 'REGIONAL']],
  ];
  for (const [name, args] of calls) query(name, args);
  query('global-certificates', ['acm', 'list-certificates'], 'us-east-1');
  query('global-waf', ['wafv2', 'list-web-acls', '--scope', 'CLOUDFRONT'], 'us-east-1');
  query('distributions', ['cloudfront', 'list-distributions'], 'us-east-1');
  for (const code of ['ecs', 'fargate', 'ec2', 'ecr', 'elasticache']) query(`quotas-${code}`, ['service-quotas', 'list-service-quotas', '--service-code', code]);
  for (const item of stack?.Stacks?.[0]?.Outputs ?? []) {
    if (/BucketName$/.test(item.OutputKey)) for (const kind of ['versioning', 'encryption', 'lifecycle-configuration', 'public-access-block']) {
      query(`${item.OutputKey}-${kind}`, ['s3api', kind === 'public-access-block' ? 'get-public-access-block' : `get-bucket-${kind}`, '--bucket', item.OutputValue]);
    }
  }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ status: results.some(r => r.status === 'BLOCKED') ? 'PARTIAL' : 'COLLECTED_NOT_REVIEWED',
    timestamp: new Date().toISOString(), checks: results.map(({ name, status }) => ({ name, status })),
    note: 'Inventory does not prove readiness, absence of orphans, drift, restore or rollback success.' }, null, 2) + '\n', { flag: 'wx' });
  if (results.some(r => r.status === 'BLOCKED')) process.exitCode = 1;
}
