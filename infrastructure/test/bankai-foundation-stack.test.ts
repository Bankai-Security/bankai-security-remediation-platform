import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BankaiFoundationStack } from '../lib/bankai-foundation-stack';
import type { EnvironmentConfig } from '../lib/environment-config';

const digest = `sha256:${'a'.repeat(64)}`;
const base: Omit<EnvironmentConfig, 'stage' | 'account' | 'vpcCidr' | 'apiDomainName' | 'frontendDomainName' | 'costCenter'> = {
  region: 'ap-south-1', natGateways: 1, hostedZoneId: 'Z1234567890', hostedZoneName: 'bankaisecurity.com',
  apiCertificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/api',
  frontendCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/frontend',
  frontendWebAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/test/00000000-0000-0000-0000-000000000003',
  backendImageDigest: digest, quincyImageDigest: digest, apiDesiredCount: 1, apiCpu: 512, apiMemoryMiB: 1024,
  workerDesiredCount: 1, workerCpu: 512, workerMemoryMiB: 1024,
  quincyDesiredCount: 1, quincyCpu: 1024, quincyMemoryMiB: 2048,
  logRetentionDays: 14, ecrRetainedImageCount: 30,
  redisNodeType: 'cache.t4g.small', redisReplicaCount: 1, redisSnapshotRetentionDays: 1,
  jenkinsEnabled: true, jenkinsDomainName: 'jenkins.bankaisecurity.com',
  jenkinsCertificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/jenkins',
  jenkinsControllerImageDigest: digest, jenkinsControllerInstanceType: 'm7g.large',
  jenkinsGeneralAgentMax: 10, jenkinsPrivilegedAgentMax: 3, jenkinsBackupRetentionDays: 35,
  jenkinsPrContainerAgentMax: 4,
  jenkinsAgentKeyPairName: 'bankai-jenkins-agents',
  githubOrganization: 'bankai-security', bankaiRepository: 'bankai-security-remediation-platform',
  githubAppId: '123456', jenkinsAgentHostPublicKey: `ssh-ed25519 ${'A'.repeat(43)}=`,
  quincyRepository: 'quincy-security-engine', datadogSite: 'datadoghq.com',
  jenkinsTrustedRoleArn: 'arn:aws:iam::111111111111:role/bankai-nonprod-jenkins-trusted-agent',
};

function config(stage: 'nonprod' | 'production'): EnvironmentConfig {
  return {
    ...base, stage,
    account: stage === 'production' ? '222222222222' : '111111111111',
    vpcCidr: stage === 'production' ? '10.30.0.0/16' : '10.20.0.0/16',
    apiDomainName: stage === 'production' ? 'api.bankaisecurity.com' : 'api-nonprod.bankaisecurity.com',
    frontendDomainName: stage === 'production' ? 'app.bankaisecurity.com' : 'nonprod.bankaisecurity.com',
    costCenter: `engineering-${stage}`,
    apiDesiredCount: stage === 'production' ? 2 : 1,
    quincyDesiredCount: stage === 'production' ? 2 : 1,
    redisReplicaCount: stage === 'production' ? 2 : 1,
    redisSnapshotRetentionDays: stage === 'production' ? 7 : 1,
    logRetentionDays: stage === 'production' ? 90 : 14,
    jenkinsEnabled: stage === 'nonprod',
    jenkinsCertificateArn: `arn:aws:acm:ap-south-1:${stage === 'production' ? '222222222222' : '111111111111'}:certificate/jenkins`,
  };
}

function synth(stage: 'nonprod' | 'production', initialProvisioning = false): Template {
  const app = new cdk.App();
  app.node.setContext('@aws-cdk/aws-autoscaling:generateLaunchTemplateInsteadOfLaunchConfig', true);
  if (initialProvisioning) app.node.setContext('initialProvisioning', 'true');
  const cfg = config(stage);
  return Template.fromStack(new BankaiFoundationStack(app, `Bankai-${stage}-Foundation`, {
    config: cfg, env: { account: cfg.account, region: cfg.region },
  }));
}

describe('BankaiFoundationStack', () => {
  const nonprod = synth('nonprod');
  const production = synth('production');

  it('creates immutable, scan-on-push ECR repositories with stable logical IDs', () => {
    nonprod.resourceCountIs('AWS::ECR::Repository', 2);
    for (const repositoryName of ['bankai/nonprod/backend', 'bankai/nonprod/quincy']) {
      nonprod.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: repositoryName,
        ImageScanningConfiguration: { ScanOnPush: true },
        ImageTagMutability: 'IMMUTABLE',
      });
    }
    expect(nonprod.findResources('AWS::ECR::Repository')).toHaveProperty('BackendRepository9B711290');
    expect(nonprod.findResources('AWS::ECR::Repository')).toHaveProperty('QuincyRepositoryA34082CA');
  });

  it('keeps application tasks private and exposes only the Bankai ALB', () => {
    production.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    const services = Object.values(production.findResources('AWS::ECS::Service'));
    expect(services).toHaveLength(3);
    for (const service of services) {
      expect(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
      expect(service.Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({ Enable: true, Rollback: true });
    }
    production.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8000, ToPort: 8000, IpProtocol: 'tcp', SourceSecurityGroupId: Match.anyValue(),
    });
    production.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'routing.http.desync_mitigation_mode', Value: 'strictest' },
      ]),
    });
  });

  it('deploys the same immutable Bankai digest with distinct API and worker commands', () => {
    const definitions = JSON.stringify(nonprod.findResources('AWS::ECS::TaskDefinition'));
    expect(definitions).toContain(`@${digest}`);
    expect(definitions).toContain('dist/worker.js');
    expect(definitions).toContain('/healthz');
    expect(definitions).toContain('StopTimeout');
    expect(definitions).not.toContain(':latest');
  });

  it('tags API, worker, and Quincy tasks with distinct service and release metadata', () => {
    const tasks = Object.values(nonprod.findResources('AWS::ECS::TaskDefinition'));
    const containers = tasks.flatMap(task => task.Properties.ContainerDefinitions);
    for (const service of ['bankai-api', 'bankai-worker', 'quincy']) {
      const container = containers.find(item => item.Environment?.some((entry: { Name: string; Value: string }) => entry.Name === 'DD_SERVICE' && entry.Value === service));
      expect(container).toBeDefined();
      for (const name of ['DD_ENV', 'DD_VERSION', 'GIT_SHA', 'DEPLOYMENT_ID', 'JENKINS_BUILD']) {
        expect(container.Environment.some((entry: { Name: string }) => entry.Name === name)).toBe(true);
      }
    }
  });

  it('uses encrypted production ElastiCache and retains persistent resources', () => {
    production.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    production.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      AtRestEncryptionEnabled: true, TransitEncryptionEnabled: true,
      AutomaticFailoverEnabled: true, MultiAZEnabled: true, NumCacheClusters: 2, SnapshotRetentionLimit: 7,
    });
    const redis = Object.values(production.findResources('AWS::ElastiCache::ReplicationGroup'))[0];
    expect(redis.DeletionPolicy).toBe('Retain');
    expect(redis.UpdateReplacePolicy).toBe('Retain');
    const persistent = [
      ...Object.values(production.findResources('AWS::S3::Bucket')),
      ...Object.values(production.findResources('AWS::EFS::FileSystem')),
      ...Object.values(production.findResources('AWS::ECR::Repository')),
    ];
    for (const resource of persistent) expect(resource.DeletionPolicy).toBe('Retain');
  });

  it('keeps non-production Redis disposable while production has no Redis task', () => {
    nonprod.resourceCountIs('AWS::ECS::Service', 4);
    expect(JSON.stringify(nonprod.findResources('AWS::ECS::TaskDefinition'))).toContain('redis-server');
    production.resourceCountIs('AWS::ECS::Service', 3);
    expect(JSON.stringify(production.findResources('AWS::ECS::TaskDefinition'))).not.toContain('redis-server');
  });

  it('supports zero-capacity non-production application provisioning before ECR images exist', () => {
    const initial = synth('nonprod', true);
    for (const serviceName of ['bankai-nonprod-api', 'bankai-nonprod-worker', 'bankai-nonprod-quincy']) {
      initial.hasResourceProperties('AWS::ECS::Service', { ServiceName: serviceName, DesiredCount: 0 });
    }
    initial.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('encrypts Quincy storage and aligns the access point with the image UID', () => {
    production.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
    production.hasResourceProperties('AWS::EFS::AccessPoint', {
      PosixUser: { Gid: '10001', Uid: '10001' },
      RootDirectory: Match.objectLike({
        CreationInfo: Match.objectLike({ OwnerGid: '10001', OwnerUid: '10001', Permissions: '750' }),
      }),
    });
    const taskDefinitions = JSON.stringify(production.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDefinitions).toContain('ENABLED');
    expect(taskDefinitions).toContain('quincy-data');
  });

  it('uses digest-pinned Quincy in CodeBuild and limits data-plane permissions', () => {
    production.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ PrivilegedMode: true }), Source: Match.objectLike({ Type: 'NO_SOURCE' }),
    });
    const projects = JSON.stringify(production.findResources('AWS::CodeBuild::Project'));
    expect(projects).toContain(`@${digest}`);
    expect(projects).not.toContain(':latest');
    const policies = JSON.stringify(production.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('s3:GetObject');
    expect(policies).toContain('s3:PutObject');
    expect(policies).not.toContain('s3:ListBucket');
    expect(policies).not.toContain('elasticfilesystem:ClientRootAccess');
    expect(policies).not.toContain('"Action":"*"');
  });

  it('uses stage-specific settings and exposes non-sensitive Jenkins outputs', () => {
    const nonprodJson = JSON.stringify(nonprod.toJSON());
    const productionJson = JSON.stringify(production.toJSON());
    expect(nonprodJson).toContain('api-nonprod.bankaisecurity.com');
    expect(productionJson).toContain('api.bankaisecurity.com');
    expect(productionJson).toContain('app.bankaisecurity.com');
    expect(productionJson).not.toContain('api-nonprod.bankaisecurity.com');
    production.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    production.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'bankai-production-api', DesiredCount: 2 });
    production.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'bankai-production-quincy', DesiredCount: 2 });
    for (const output of [
      'BackendRepositoryUri', 'QuincyRepositoryUri', 'FrontendBucketName', 'FrontendDistributionId',
      'ApiServiceName', 'WorkerServiceName', 'QuincyServiceName', 'QuincyCodeBuildProjectName',
      'QuincyJobBucketName', 'BackendImageDigest', 'QuincyImageDigest',
    ]) expect(production.toJSON().Outputs).toHaveProperty(output);
  });

  it('uses customer-managed rotating keys and attaches the global CloudFront WAF', () => {
    production.resourceCountIs('AWS::KMS::Key', 2);
    production.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    production.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: Match.stringLikeRegexp('arn:aws:wafv2:us-east-1:.*:global/webacl/'),
      }),
    });
  });

  it('contains no plaintext secret-shaped configuration values', () => {
    const template = JSON.stringify(production.toJSON());
    expect(template).not.toMatch(/(sk_live_|ghp_|AKIA[0-9A-Z]{16}|BEGIN PRIVATE KEY)/);
    expect(template).not.toContain('OPENROUTER_API_KEY=');
    expect(template).toContain('SECRETS_MANAGER');
  });

  it('creates one private, persistent Jenkins controller and two zero-capacity agent fleets only in nonprod', () => {
    nonprod.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 4);
    production.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 0);
    nonprod.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '1', MaxSize: '1', DesiredCapacity: '1' });
    nonprod.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '0', MaxSize: '10', DesiredCapacity: '0' });
    nonprod.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '0', MaxSize: '3', DesiredCapacity: '0' });
    nonprod.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '0', MaxSize: '4', DesiredCapacity: '0' });
    nonprod.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
    nonprod.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({ MetadataOptions: Match.objectLike({ HttpTokens: 'required' }) }),
    });
  });

  it('encrypts Jenkins storage, retains backups, and exposes Jenkins only through TLS', () => {
    nonprod.hasResourceProperties('AWS::Backup::BackupVault', {
      LockConfiguration: Match.objectLike({ MinRetentionDays: 35 }),
    });
    nonprod.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443, Protocol: 'HTTPS', Certificates: Match.anyValue(),
    });
    nonprod.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 22, ToPort: 22, IpProtocol: 'tcp', SourceSecurityGroupId: Match.anyValue(),
    });
    const launchTemplates = JSON.stringify(nonprod.findResources('AWS::EC2::LaunchTemplate'));
    expect(launchTemplates).toContain('Encrypted');
    expect(launchTemplates).toContain(`jenkins/jenkins@${digest}`);
    expect(launchTemplates).not.toContain('jenkins/jenkins:latest');
  });

  it('keeps PR validation credentials separate from publishing and deployment roles', () => {
    const roles = JSON.stringify(nonprod.findResources('AWS::IAM::Role'));
    for (const name of ['bankai-nonprod-jenkins-pr-validation', 'bankai-nonprod-ecr-publishing',
      'bankai-nonprod-deployment', 'bankai-nonprod-cloudformation-deployment']) expect(roles).toContain(name);
    const policies = JSON.stringify(nonprod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('ecr:PutImage');
    expect(policies).toContain('cloudformation:CreateChangeSet');
    expect(policies).toContain('sts:AssumeRole');
    const prRole = Object.values(nonprod.findResources('AWS::IAM::Role'))
      .find((role) => role.Properties.RoleName === 'bankai-nonprod-jenkins-pr-validation');
    if (!prRole) throw new Error('PR validation role was not synthesized');
    expect(prRole.Properties.Policies).toBeUndefined();
    expect(JSON.stringify(prRole.Properties.ManagedPolicyArns)).toContain('AmazonSSMManagedInstanceCore');
    expect(JSON.stringify(prRole)).not.toMatch(/cloudformation|ecr:PutImage/);
  });

  it('creates production deployment roles without a production Jenkins controller', () => {
    const roles = JSON.stringify(production.findResources('AWS::IAM::Role'));
    expect(roles).toContain('bankai-production-deployment');
    expect(roles).toContain('bankai-production-cloudformation-deployment');
    expect(JSON.stringify(production.toJSON())).not.toContain('jenkins/jenkins@');
  });
});
