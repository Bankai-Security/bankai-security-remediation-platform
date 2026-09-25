import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function stackOutput(stack, key) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error('invalid stack output key');
  const matches = (stack.Outputs ?? []).filter(({ OutputKey }) =>
    OutputKey === key || new RegExp(`^Jenkins${key}[A-F0-9]{8}$`).test(OutputKey));
  if (matches.length !== 1 || !matches[0].OutputValue?.trim()) {
    throw new Error(`Expected one non-empty stack output ${key}; found ${matches.length}`);
  }
  return matches[0].OutputValue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, key] = process.argv.slice(2);
  const { Stacks } = JSON.parse(readFileSync(path, 'utf8'));
  if (Stacks?.length !== 1) throw new Error('Expected exactly one CloudFormation stack');
  process.stdout.write(stackOutput(Stacks[0], key));
}
