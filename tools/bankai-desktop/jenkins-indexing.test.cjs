const test = require('node:test');
const assert = require('node:assert/strict');
const { isCurrentIndexing, indexingFinished, summarizeIndexingLog, rateLimitDelayMs } = require('./jenkins-indexing.cjs');

test('recognizes only the active or newly started Jenkins indexing run', () => {
  const startedAt = 1_800_000_000_000;
  const scan = { startedAt, previousTimestamp: startedAt - 10 };
  assert.equal(isCurrentIndexing({ building: true }, scan), true);
  assert.equal(isCurrentIndexing({ building: false, timestamp: startedAt + 1 }, scan), true);
  assert.equal(isCurrentIndexing({ building: false, timestamp: startedAt - 1 }, scan), true);
  assert.equal(isCurrentIndexing({ building: false, timestamp: startedAt - 10 }, scan), false);
});

test('accepts a result only after a supported current scan finishes', () => {
  assert.equal(indexingFinished({ supported: true, building: false, result: null }, true), false);
  assert.equal(indexingFinished({ supported: true, building: false, result: 'SUCCESS' }, true), true);
  assert.equal(indexingFinished({ supported: true, building: false, result: 'SUCCESS' }, false), false);
});

test('extracts a rate-limit delay and final result without returning raw logs', () => {
  const summary = summarizeIndexingLog('Jenkins-Imposed API Limiter: Current quota has 46 remaining. Sleeping for 7 min 9 sec.\nFinished: SUCCESS');
  assert.deepEqual(summary, { rateLimitDelay: '7 min 9 sec', result: 'SUCCESS' });
});

test('extracts delays from GitHub Branch Source rate-limit log formats', () => {
  assert.deepEqual(summarizeIndexingLog('GitHub API rate limit exceeded. Sleeping for 1 hr 12 min.\nFinished: SUCCESS'), {
    rateLimitDelay: '1 hr 12 min', result: 'SUCCESS',
  });
  assert.deepEqual(summarizeIndexingLog('Secondary rate limit reached\nRetry later\nSleeping for 45 sec.\nFinished: SUCCESS'), {
    rateLimitDelay: '45 sec', result: 'SUCCESS',
  });
});

test('parses Jenkins limiter sleep durations for discovery polling', () => {
  assert.equal(rateLimitDelayMs('7 min 9 sec'), 429_000);
  assert.equal(rateLimitDelayMs('1 hour 2 min'), 3_720_000);
  assert.equal(rateLimitDelayMs(null), 0);
});

test('parses the hour abbreviation used in GitHub rate-limit logs', () => {
  assert.equal(rateLimitDelayMs('1 hr 12 min'), 4_320_000);
});
