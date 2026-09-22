import { readFileSync } from 'node:fs';

const [configPath, actualAccount, bankaiSha, quincySha] = process.argv.slice(2);
if (!configPath || !actualAccount || !bankaiSha || !quincySha) {
  throw new Error('usage: validate-nonprod-release.mjs CONFIG ACTUAL_ACCOUNT BANKAI_SHA QUINCY_SHA');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const failures = [];
const placeholderPatterns = [
  /^0+$/, /^1{12}$/, /^2{12}$/, /00000000-0000-0000-0000-00000000000[0-9]/,
  /^Z0+$/, /^sha256:0{64}$/, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=/,
];
for (const [key, value] of Object.entries(config)) {
  if (key === 'backendImageDigest' || key === 'quincyImageDigest') continue;
  if (typeof value === 'string' && placeholderPatterns.some((pattern) => pattern.test(value))) {
    failures.push(`${key} is still a placeholder`);
  }
}
if (config.account !== actualAccount) failures.push(`AWS account mismatch: config=${config.account}, caller=${actualAccount}`);
if (!/^\d{12}$/.test(actualAccount)) failures.push('caller AWS account is not a 12-digit ID');
if (!/^[0-9a-f]{40}$/.test(bankaiSha)) failures.push('Bankai revision must be a full Git SHA');
if (!/^[0-9a-f]{40}$/.test(quincySha)) failures.push('Quincy revision must be a full Git SHA');
if (config.jenkinsEnabled !== true) failures.push('non-production Jenkins must be enabled');

if (failures.length) throw new Error(`non-production release refused:\n- ${failures.join('\n- ')}`);
console.log(`Release target validated: account ${actualAccount}, region ${config.region}`);
