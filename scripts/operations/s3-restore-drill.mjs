import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Writes synthetic objects only, retaining every source version and restored copy.
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: s3-restore-drill.mjs OUTPUT_DIRECTORY');
const dir = resolve(output);
mkdirSync(dir, { recursive: false });
const aws = (...args) => JSON.parse(execFileSync('aws', [...args, '--profile', 'bankai-nonprod', '--region', 'ap-south-1', '--output', 'json'], { encoding: 'utf8' }));
if (aws('sts', 'get-caller-identity').Account !== '926827998551') throw new Error('Wrong account');
const bucket = 'bankai-nonprod-foundation-quincyjobbucket9fc20a0d-jry2dncfubch';
if (aws('s3api', 'get-bucket-versioning', '--bucket', bucket).Status !== 'Enabled') throw new Error('Versioning is required');
const key = `readiness-drills/${randomUUID()}/source.json`;
const first = resolve(dir, 'original.json');
const watermark = new Date().toISOString();
writeFileSync(first, JSON.stringify({ synthetic: true, watermark, value: 'known-good' }));
const v1 = aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', first);
if (!v1.VersionId || v1.VersionId === 'null') throw new Error('Missing version ID');
const second = resolve(dir, 'later.json');
writeFileSync(second, JSON.stringify({ synthetic: true, value: 'later-version' }));
const v2 = aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', second);
const started = new Date();
const restoredKey = key.replace('source.json', 'restored.json');
const copied = aws('s3api', 'copy-object', '--bucket', bucket, '--key', restoredKey, '--copy-source', `${bucket}/${key}?versionId=${encodeURIComponent(v1.VersionId)}`);
const restored = resolve(dir, 'restored.json');
aws('s3api', 'get-object', '--bucket', bucket, '--key', restoredKey, restored);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (sha(first) !== sha(restored)) throw new Error('Restored bytes differ');
const current = aws('s3api', 'head-object', '--bucket', bucket, '--key', key);
if (current.VersionId !== v2.VersionId) throw new Error('Source current version changed');
const ended = new Date();
const report = { status: 'PASS', scope: 'synthetic S3 version restore only', bucket, key, restoredKey,
  sourceVersion: v1.VersionId, preservedCurrentVersion: v2.VersionId, restoredVersion: copied.VersionId,
  watermark, startedAt: started.toISOString(), verifiedAt: ended.toISOString(),
  rtoSeconds: (ended - started) / 1000, syntheticRpoSeconds: (started - new Date(watermark)) / 1000,
  sha256: sha(restored), retained: true };
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
