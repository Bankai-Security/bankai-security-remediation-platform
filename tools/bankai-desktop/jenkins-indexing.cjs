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
  const rateLimit = text.match(/(?:Jenkins-Imposed API Limiter|rate limit|quota)[^\r\n]*[\s\S]{0,240}?Sleeping for\s+([^\r\n.]+)/i);
  const finalResult = text.match(/Finished:\s*(SUCCESS|FAILURE|ABORTED|UNSTABLE)/i)?.[1]?.toUpperCase() || null;
  return {
    rateLimitDelay: rateLimit?.[1]?.trim().slice(0, 100) || null,
    result: finalResult,
  };
}

module.exports = { isCurrentIndexing, indexingFinished, summarizeIndexingLog };
