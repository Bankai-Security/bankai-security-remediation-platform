export function resolveApiOrigin(runtime: unknown, buildTime = ''): string {
  const value = runtime ?? buildTime;
  if (typeof value !== 'string') throw new Error('Invalid API origin configuration');
  if (value === '') return '';
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('API configuration must be an HTTPS origin or local development origin');
  }
  return url.origin;
}
