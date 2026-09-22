import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cdk = path.join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');

function synth(stage, output) {
  execFileSync(process.execPath, [cdk, 'synth', '-c', `stage=${stage}`, '--quiet', '--output', output], {
    cwd: root,
    stdio: 'pipe',
  });
  const template = readdirSync(output).find((name) => name.endsWith('.template.json'));
  if (!template) throw new Error(`No CloudFormation template synthesized for ${stage}`);
  const bytes = readFileSync(path.join(output, template));
  return createHash('sha256').update(bytes).digest('hex');
}

for (const stage of ['nonprod', 'production']) {
  const temporary = mkdtempSync(path.join(tmpdir(), `bankai-cdk-${stage}-`));
  try {
    const first = synth(stage, path.join(temporary, 'first'));
    const second = synth(stage, path.join(temporary, 'second'));
    if (first !== second) throw new Error(`${stage} synthesis is not deterministic: ${first} != ${second}`);
    console.log(`${stage} template sha256:${first}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
