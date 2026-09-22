import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, summaryPath] = process.argv.slice(2);
if (!inputPath || !summaryPath) throw new Error('usage: review-change-set.mjs INPUT_JSON SUMMARY_JSON');
const changeSet = JSON.parse(readFileSync(inputPath, 'utf8'));
if (changeSet.Status !== 'CREATE_COMPLETE' || changeSet.ExecutionStatus !== 'AVAILABLE') {
  throw new Error(`change set is not executable: ${changeSet.Status}/${changeSet.ExecutionStatus}`);
}
const changes = (changeSet.Changes ?? []).map(({ ResourceChange: change }) => ({
  action: change.Action,
  logicalResourceId: change.LogicalResourceId,
  physicalResourceId: change.PhysicalResourceId ?? null,
  resourceType: change.ResourceType,
  replacement: change.Replacement ?? 'False',
}));
const unsafe = changes.filter((change) => change.action === 'Remove' || change.replacement !== 'False');
writeFileSync(summaryPath, `${JSON.stringify({
  changeSetId: changeSet.ChangeSetId,
  stackId: changeSet.StackId,
  reviewedAt: new Date().toISOString(),
  changes,
  decision: unsafe.length ? 'REJECTED' : 'APPROVED',
}, null, 2)}\n`, { mode: 0o600 });
if (unsafe.length) {
  throw new Error(`change set rejected: ${unsafe.map((item) => `${item.logicalResourceId}:${item.action}/${item.replacement}`).join(', ')}`);
}
console.log(`Change set approved: ${changes.length} additions/non-replacing modifications, zero removals or replacements`);
