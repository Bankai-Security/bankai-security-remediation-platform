export function waitingAgeMs(timestamp: number | undefined, now = Date.now()): number | null {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp > now) return null;
  return Math.max(0, now - timestamp);
}
