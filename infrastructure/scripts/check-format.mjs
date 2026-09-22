import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const roots = ['bin', 'config', 'lib', 'scripts', 'test'];
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(candidate);
    else if (/\.(ts|mjs|json)$/.test(entry.name)) files.push(candidate);
  }
}
for (const root of roots) collect(root);
const failures = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (/\t/.test(text)) failures.push(`${file}: tab indentation`);
  if (/[ \t]+$/m.test(text)) failures.push(`${file}: trailing whitespace`);
  if (!text.endsWith('\n')) failures.push(`${file}: missing final newline`);
}
if (failures.length) throw new Error(failures.join('\n'));
console.log(`Infrastructure formatting policy passed for ${files.length} source files.`);
