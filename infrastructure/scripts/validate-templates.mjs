import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const directories = process.argv.slice(2);
if (directories.length === 0) throw new Error('usage: validate-templates.mjs CDK_OUT_DIR...');

const secretPattern = /(sk_live_|ghp_|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY)/;
for (const directory of directories) {
  const templates = readdirSync(directory).filter((name) => name.endsWith('.template.json'));
  if (templates.length === 0) throw new Error(`No templates in ${directory}`);
  for (const name of templates) {
    const file = path.join(directory, name);
    const raw = readFileSync(file, 'utf8');
    const template = JSON.parse(raw);
    if (!template.Resources || !template.Outputs) throw new Error(`${file}: incomplete CloudFormation template`);
    if (secretPattern.test(raw)) throw new Error(`${file}: secret-shaped value found`);
    if (raw.includes(':latest')) throw new Error(`${file}: mutable latest image found`);
    for (const [outputName, output] of Object.entries(template.Outputs)) {
      if (/secret|password|token/i.test(outputName)) throw new Error(`${file}: sensitive output name ${outputName}`);
      if (secretPattern.test(JSON.stringify(output))) throw new Error(`${file}: sensitive output ${outputName}`);
    }
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const statement of statements) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes('*')) throw new Error(`${file}: wildcard IAM action in ${logicalId}`);
      }
    }
    console.log(`validated ${file}`);
  }
}
