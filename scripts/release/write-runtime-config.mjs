import { readFileSync, writeFileSync } from 'node:fs';
const [configPath, output] = process.argv.slice(2);
if (!configPath || !output) throw new Error('usage: write-runtime-config.mjs ENVIRONMENT_JSON OUTPUT_JS');
const config = JSON.parse(readFileSync(configPath));
if (!/^[a-z0-9.-]+$/.test(config.apiDomainName ?? '') || !config.apiDomainName.includes('.')) throw new Error('Invalid API DNS name');
writeFileSync(output, `window.__BANKAI_CONFIG__ = ${JSON.stringify({ apiBaseUrl: `https://${config.apiDomainName}` })};\n`);
