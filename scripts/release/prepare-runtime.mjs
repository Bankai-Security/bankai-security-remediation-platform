import { appendFileSync, readFileSync } from 'node:fs';
import { stackOutput } from './stack-output.mjs';

const [configPath, stackPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('usage: prepare-runtime.mjs CONFIG STACK_JSON RUNTIME_ENV');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { Stacks } = JSON.parse(readFileSync(stackPath, 'utf8'));
if (Stacks?.length !== 1) throw new Error('Expected exactly one CloudFormation stack');
const stack = Stacks[0];
if (stack.StackName !== 'Bankai-nonprod-Foundation') throw new Error('Unexpected release stack');
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus)) {
  throw new Error(`Stack is not ready for a release: ${stack.StackStatus}`);
}
const values = {
  AWS_ACCOUNT_ID: config.account,
  AWS_REGION: config.region,
  STACK_NAME: stack.StackName,
  DATADOG_SITE: config.datadogSite,
  IMAGE_ARCHITECTURE: 'arm64',
  BACKEND_REPOSITORY: stackOutput(stack, 'BackendRepositoryUri'),
  QUINCY_REPOSITORY_URI: stackOutput(stack, 'QuincyRepositoryUri'),
  PUBLISHING_ROLE_ARN: stackOutput(stack, 'EcrPublishingRoleArn'),
  DEPLOYMENT_ROLE_ARN: stackOutput(stack, 'NonprodDeploymentRoleArn'),
  CLOUDFORMATION_ROLE_ARN: stackOutput(stack, 'CloudFormationDeploymentRoleArn'),
};
for (const [key, role] of Object.entries({
  PUBLISHING_ROLE_ARN: 'bankai-nonprod-ecr-publishing',
  DEPLOYMENT_ROLE_ARN: 'bankai-nonprod-deployment',
  CLOUDFORMATION_ROLE_ARN: 'bankai-nonprod-cloudformation-deployment',
})) {
  if (values[key] !== `arn:aws:iam::${config.account}:role/${role}`) throw new Error(`Unexpected ${key}`);
}
const registry = `${config.account}.dkr.ecr.${config.region}.amazonaws.com`;
if (values.BACKEND_REPOSITORY !== `${registry}/bankai/nonprod/backend` ||
    values.QUINCY_REPOSITORY_URI !== `${registry}/bankai/nonprod/quincy`) throw new Error('Unexpected ECR release repositories');
for (const key of ['EcsClusterName', 'ApiServiceName', 'WorkerServiceName', 'QuincyServiceName', 'FrontendBucketName', 'FrontendDistributionId']) {
  stackOutput(stack, key);
}
if (!['datadoghq.com', 'datadoghq.eu', 'us3.datadoghq.com', 'us5.datadoghq.com', 'ddog-gov.com', 'ap1.datadoghq.com', 'ap2.datadoghq.com'].includes(values.DATADOG_SITE)) {
  throw new Error('Invalid Datadog API site');
}
for (const [key, value] of Object.entries(values)) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:/.-]+$/.test(value)) throw new Error(`Unsafe runtime value ${key}`);
}
// Validate the whole contract before writing anything; shell printf previously
// masked failed output lookups and allowed empty role ARNs through preflight.
appendFileSync(outputPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
console.log('Validated release outputs, role ARNs, repositories, and observability site');
