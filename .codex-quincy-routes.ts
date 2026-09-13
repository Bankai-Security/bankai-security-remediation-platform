import { env } from './backend/src/env';
async function main() {
  if (!env.QUINCY_API_URL) { console.log('QUINCY_API_URL is not set'); return; }
  const base = env.QUINCY_API_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/openapi.json`);
  console.log(JSON.stringify({ url: `${base}/openapi.json`, status: res.status }, null, 2));
  if (!res.ok) return;
  const spec: any = await res.json();
  const paths = Object.keys(spec.paths ?? {}).filter((p) => p.includes('remediation') || p.includes('triage') || p.includes('workflow')).sort();
  console.log(JSON.stringify(paths, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
