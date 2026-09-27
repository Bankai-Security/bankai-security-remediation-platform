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
  reviewedConditionalUpdate: safeConditionalUpdate(change),
}));
function safeConditionalUpdate(change) {
  if (change.Action !== 'Modify' || change.Replacement !== 'Conditional' ||
      change.PolicyAction?.startsWith('Replace') ||
      !change.Details?.length || !change.Scope?.length ||
      change.Scope.some(attribute => attribute !== 'Properties')) return false;
  // CloudFormation reports these mutable properties as Conditional. Limit the
  // exception to static property updates on the existing release resources.
  // Never accept a name change, an actual replacement, or missing detail.
  let allowed;
  if (change.ResourceType === 'AWS::CDK::Metadata' && change.LogicalResourceId === 'CDKMetadata') {
    allowed = /^\/Properties\/Analytics$/;
  } else if (change.ResourceType === 'AWS::CodeBuild::Project' &&
      /^QuincyRemediationProject[A-F0-9]{8}$/.test(change.LogicalResourceId) &&
      change.PhysicalResourceId === 'bankai-nonprod-quincy-remediation') {
    return change.Details.every(({ Evaluation, ChangeSource, Target }) =>
      Evaluation === 'Static' && ChangeSource === 'DirectModification' &&
      Target?.Attribute === 'Properties' && ['Never', 'Conditionally'].includes(Target.RequiresRecreation) &&
      safeCodeBuildTarget(Target));
  } else return false;
  return change.Details.every(({ Evaluation, ChangeSource, Target }) =>
    Evaluation === 'Static' && ChangeSource === 'DirectModification' &&
    Target?.Attribute === 'Properties' && Target.AttributeChangeType === 'Modify' &&
    ['Never', 'Conditionally'].includes(Target.RequiresRecreation) &&
    allowed.test(Target.Path));
}
function safeCodeBuildTarget(target) {
  if (target.AttributeChangeType === 'Modify' &&
      /^\/Properties\/Environment\/(Image|Type|ComputeType|EnvironmentVariables\/\d+\/Value)$/.test(target.Path)) {
    return true;
  }
  if (target.AttributeChangeType === 'Add' &&
      /^\/Properties\/Environment\/EnvironmentVariables\/\d+$/.test(target.Path)) {
    try {
      const variable = JSON.parse(target.AfterValue);
      if (variable.Type !== 'PLAINTEXT') return false;
      const value = String(variable.Value);
      return (variable.Name === 'DD_ENV' && value === 'nonprod') ||
        (variable.Name === 'DD_SERVICE' && value === 'quincy-codebuild') ||
        (['DD_VERSION', 'GIT_SHA'].includes(variable.Name) && /^[0-9a-f]{40}$/.test(value)) ||
        (variable.Name === 'DEPLOYMENT_ID' && /^bankai-[0-9a-f]{12}-build-\d+$/.test(value)) ||
        (variable.Name === 'JENKINS_BUILD' && /^\d+$/.test(value));
    } catch {
      return false;
    }
  }
  if (target.AttributeChangeType === 'Modify' && target.Path === '/Properties/Source/BuildSpec' &&
      typeof target.BeforeValue === 'string' && typeof target.AfterValue === 'string') {
    const marker = ' -e GEMINI_API_KEY -e SANDBOX_BACKEND=docker';
    const replacement = ' -e GEMINI_API_KEY -e DD_ENV -e DD_SERVICE -e DD_VERSION -e GIT_SHA -e DEPLOYMENT_ID -e JENKINS_BUILD -e SANDBOX_BACKEND=docker';
    return target.BeforeValue.includes(marker) && target.AfterValue === target.BeforeValue.replace(marker, replacement);
  }
  return false;
}
// A new ECS task-definition revision is how an immutable image is released.
// Continue refusing replacement of services, storage, networking and all other
// resources; never turn off replacement review for the whole stack.
const unsafe = changes.filter((change) => change.action === 'Remove' ||
  !['Add', 'Modify'].includes(change.action) ||
  (change.replacement !== 'False' && !change.reviewedConditionalUpdate &&
    !(change.action === 'Modify' && change.resourceType === 'AWS::ECS::TaskDefinition')));
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
console.log(`Change set approved: ${changes.length} changes; ECS revisions and narrowly reviewed mutable-property updates only`);
