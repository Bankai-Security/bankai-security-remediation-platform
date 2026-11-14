export const requiredSmokeChecks = [
  'Bankai API reaches Redis and exposes queue health',
  'Quincy health and token rejection',
  'CloudFront serves the frontend configured for Bankai',
  'Cleanup isolated E2E resources',
];

export function verifySmokeEvidence(smoke, expected) {
  if (smoke.mode !== 'smoke' || !Array.isArray(smoke.results) ||
      smoke.results.some(result => result.error !== null) ||
      requiredSmokeChecks.some(name => smoke.results.filter(result => result.name === name).length !== 1)) {
    throw new Error('Smoke evidence must contain each required successful check exactly once');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!value || smoke.release?.[key] !== value) throw new Error(`Smoke release identity mismatch: ${key}`);
  }
}
