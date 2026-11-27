function timestampNumber(timestamp) {
  if (typeof timestamp === 'number') return timestamp;
  if (/^\d+$/.test(String(timestamp ?? ''))) return Number(timestamp);
  return Date.parse(timestamp || '');
}

function isCurrentIndexing(indexing, scan) {
  if (indexing?.building) return true;
  const timestamp = timestampNumber(indexing?.timestamp);
  const startedAt = timestampNumber(scan?.startedAt);
  const previousTimestamp = scan?.previousTimestamp == null ? null : timestampNumber(scan.previousTimestamp);
  return (Number.isFinite(timestamp) && Number.isFinite(startedAt) && timestamp >= startedAt)
    || (previousTimestamp !== null && Number.isFinite(timestamp) && Number.isFinite(previousTimestamp) && timestamp !== previousTimestamp);
}

function indexingFinished(status, isCurrent) {
  return Boolean(status?.supported && isCurrent && !status.building && status.result);
}

function summarizeIndexingLog(log) {
  const text = String(log || '').slice(-30000);
  // GitHub Branch Source and the Jenkins API limiter have used several log
  // formats over time. Match only a short window before "Sleeping for" so
  // unrelated quota messages elsewhere in the log cannot supply a delay.
  const rateLimit = text.match(/(?:jenkins[- ]imposed api limiter|api\s+rate\s+limit|rate[- ]limit(?:ed|ing)?|secondary rate limit|api quota|quota)[^\r\n]{0,240}(?:\r?\n[^\r\n]{0,240}){0,2}?sleeping for\s+([^\r\n.]+)/i);
  const finalResult = text.match(/Finished:\s*(SUCCESS|FAILURE|ABORTED|UNSTABLE)/i)?.[1]?.toUpperCase() || null;
  return {
    rateLimitDelay: rateLimit?.[1]?.trim().slice(0, 100) || null,
    result: finalResult,
  };
}

function rateLimitDelayMs(value) {
  const text = String(value || '');
  const units = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, min: 60_000, sec: 1_000 };
  let total = 0;
  for (const match of text.matchAll(/(\d+)\s*(day|hour|hr|min|sec)(?:s)?/gi)) {
    const unit = match[2].toLowerCase();
    const key = unit.startsWith('day') ? 'day' : unit.startsWith('hour') ? 'hour' : unit.startsWith('hr') ? 'hr' : unit.startsWith('min') ? 'min' : 'sec';
    total += Number(match[1]) * units[key];
  }
  return total;
}

module.exports = { isCurrentIndexing, indexingFinished, summarizeIndexingLog, rateLimitDelayMs };
