import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { BankaiFoundationStack } from '../lib/bankai-foundation-stack';
import type { EnvironmentConfig } from '../lib/environment-config';

const digest = `sha256:${'a'.repeat(64)}`;
const config: EnvironmentConfig = {
  stage: 'nonprod', account: '111111111111', region: 'ap-south-1', vpcCidr: '10.20.0.0/16', natGateways: 1,
  apiDomainName: 'api-nonprod.bankaisecurity.com', frontendDomainName: 'nonprod.bankaisecurity.com',
  hostedZoneId: 'Z1234567890', hostedZoneName: 'bankaisecurity.com',
  apiCertificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/api',
  frontendCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/frontend',
  frontendWebAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/test/00000000-0000-0000-0000-000000000003',
  backendImageDigest: digest, apiDesiredCount: 1, apiCpu: 512, apiMemoryMiB: 1024,
  workerDesiredCount: 1, workerCpu: 512, workerMemoryMiB: 1024, logRetentionDays: 14, ecrRetainedImageCount: 30,
  redisNodeType: 'cache.t4g.small', redisReplicaCount: 1, redisSnapshotRetentionDays: 1, costCenter: 'engineering-nonprod',
  jenkinsEnabled: false, jenkinsDomainName: 'jenkins.bankaisecurity.com',
  jenkinsCertificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/jenkins',
  jenkinsControllerImageDigest: digest, jenkinsControllerInstanceType: 'm7g.large',
  jenkinsGeneralAgentMax: 10, jenkinsPrivilegedAgentMax: 3, jenkinsPrContainerAgentMax: 4,
  jenkinsBackupRetentionDays: 35, jenkinsAgentKeyPairName: 'bankai-jenkins-agents',
  githubOrganization: 'bankai-security', githubAppId: '123456',
  jenkinsAgentHostPublicKey: `ssh-ed25519 ${'A'.repeat(43)}=`, bankaiRepository: 'bankai-security-remediation-platform',
  datadogSite: 'datadoghq.com', jenkinsTrustedRoleArn: 'arn:aws:iam::111111111111:role/bankai-agent',
};

describe('BankaiFoundationStack', () => {
  const app = new cdk.App();
  const stack = new BankaiFoundationStack(app, 'Bankai-nonprod-Foundation', {
    config, env: { account: config.account, region: config.region },
  });
  const template = Template.fromStack(stack);

  it('deploys only Bankai application services and the backend image repository', () => {
    template.resourceCountIs('AWS::ECS::Service', 2);
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'bankai/nonprod/backend',
    });
  });

  it('does not configure a Quincy runtime dependency', () => {
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).not.toMatch(/quincy|schrift/i);
  });
});
