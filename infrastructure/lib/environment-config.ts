import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Node } from 'constructs';

export type DeploymentStage = 'nonprod' | 'production';

export interface EnvironmentConfig {
  readonly stage: DeploymentStage;
  readonly account: string;
  readonly region: string;
  readonly vpcCidr: string;
  readonly natGateways: number;
  readonly apiDomainName: string;
  readonly frontendDomainName: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly apiCertificateArn: string;
  readonly frontendCertificateArn: string;
  readonly frontendWebAclArn: string;
  readonly backendImageDigest: string;
  readonly quincyImageDigest: string;
  readonly apiDesiredCount: number;
  readonly apiCpu: number;
  readonly apiMemoryMiB: number;
  readonly workerDesiredCount: number;
  readonly workerCpu: number;
  readonly workerMemoryMiB: number;
  readonly quincyDesiredCount: number;
  readonly quincyCpu: number;
  readonly quincyMemoryMiB: number;
  readonly logRetentionDays: number;
  readonly ecrRetainedImageCount: number;
  readonly redisNodeType: string;
  readonly redisReplicaCount: number;
  readonly redisSnapshotRetentionDays: number;
  readonly costCenter: string;
  readonly jenkinsEnabled: boolean;
  readonly jenkinsDomainName: string;
  readonly jenkinsCertificateArn: string;
  readonly jenkinsControllerImageDigest: string;
  readonly jenkinsControllerInstanceType: string;
  readonly jenkinsGeneralAgentMax: number;
  readonly jenkinsPrivilegedAgentMax: number;
  readonly jenkinsPrContainerAgentMax: number;
  readonly jenkinsBackupRetentionDays: number;
  readonly jenkinsAgentKeyPairName: string;
  readonly githubOrganization: string;
  readonly githubAppId: string;
  readonly jenkinsAgentHostPublicKey: string;
  readonly bankaiRepository: string;
  readonly quincyRepository: string;
  readonly datadogSite: string;
  readonly jenkinsTrustedRoleArn: string;
}

type FileConfig = Omit<EnvironmentConfig, 'stage'>;

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const accountPattern = /^\d{12}$/;

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
}

export function loadEnvironmentConfig(node: Node): EnvironmentConfig {
  const stage = node.tryGetContext('stage') as DeploymentStage | undefined;
  if (stage !== 'nonprod' && stage !== 'production') {
    throw new Error('Pass -c stage=nonprod or -c stage=production');
  }

  const path = resolve(__dirname, '..', 'config', `${stage}.json`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
  const override = <T>(key: keyof FileConfig): T => (node.tryGetContext(key) ?? file[key]) as T;
  const config: EnvironmentConfig = {
    stage,
    account: override<string>('account'),
    region: override<string>('region'),
    vpcCidr: override<string>('vpcCidr'),
    natGateways: override<number>('natGateways'),
    apiDomainName: override<string>('apiDomainName'),
    frontendDomainName: override<string>('frontendDomainName'),
    hostedZoneId: override<string>('hostedZoneId'),
    hostedZoneName: override<string>('hostedZoneName'),
    apiCertificateArn: override<string>('apiCertificateArn'),
    frontendCertificateArn: override<string>('frontendCertificateArn'),
    frontendWebAclArn: override<string>('frontendWebAclArn'),
    backendImageDigest: override<string>('backendImageDigest'),
    quincyImageDigest: override<string>('quincyImageDigest'),
    apiDesiredCount: override<number>('apiDesiredCount'),
    apiCpu: override<number>('apiCpu'),
    apiMemoryMiB: override<number>('apiMemoryMiB'),
    workerDesiredCount: override<number>('workerDesiredCount'),
    workerCpu: override<number>('workerCpu'),
    workerMemoryMiB: override<number>('workerMemoryMiB'),
    quincyDesiredCount: override<number>('quincyDesiredCount'),
    quincyCpu: override<number>('quincyCpu'),
    quincyMemoryMiB: override<number>('quincyMemoryMiB'),
    logRetentionDays: override<number>('logRetentionDays'),
    ecrRetainedImageCount: override<number>('ecrRetainedImageCount'),
    redisNodeType: override<string>('redisNodeType'),
    redisReplicaCount: override<number>('redisReplicaCount'),
    redisSnapshotRetentionDays: override<number>('redisSnapshotRetentionDays'),
    costCenter: override<string>('costCenter'),
    jenkinsEnabled: override<boolean>('jenkinsEnabled'),
    jenkinsDomainName: override<string>('jenkinsDomainName'),
    jenkinsCertificateArn: override<string>('jenkinsCertificateArn'),
    jenkinsControllerImageDigest: override<string>('jenkinsControllerImageDigest'),
    jenkinsControllerInstanceType: override<string>('jenkinsControllerInstanceType'),
    jenkinsGeneralAgentMax: override<number>('jenkinsGeneralAgentMax'),
    jenkinsPrivilegedAgentMax: override<number>('jenkinsPrivilegedAgentMax'),
    jenkinsPrContainerAgentMax: override<number>('jenkinsPrContainerAgentMax'),
    jenkinsBackupRetentionDays: override<number>('jenkinsBackupRetentionDays'),
    jenkinsAgentKeyPairName: override<string>('jenkinsAgentKeyPairName'),
    githubOrganization: override<string>('githubOrganization'),
    githubAppId: override<string>('githubAppId'),
    jenkinsAgentHostPublicKey: override<string>('jenkinsAgentHostPublicKey'),
    bankaiRepository: override<string>('bankaiRepository'),
    quincyRepository: override<string>('quincyRepository'),
    datadogSite: override<string>('datadogSite'),
    jenkinsTrustedRoleArn: override<string>('jenkinsTrustedRoleArn'),
  };

  if (!accountPattern.test(config.account)) throw new Error('account must be a 12-digit AWS account ID');
  if (!digestPattern.test(config.backendImageDigest) || !digestPattern.test(config.quincyImageDigest)) {
    throw new Error('backendImageDigest and quincyImageDigest must be sha256 digests, never tags');
  }
  for (const [name, value] of [
    ['natGateways', config.natGateways],
    ['apiDesiredCount', config.apiDesiredCount],
    ['apiCpu', config.apiCpu],
    ['apiMemoryMiB', config.apiMemoryMiB],
    ['workerDesiredCount', config.workerDesiredCount],
    ['workerCpu', config.workerCpu],
    ['workerMemoryMiB', config.workerMemoryMiB],
    ['quincyDesiredCount', config.quincyDesiredCount],
    ['quincyCpu', config.quincyCpu],
    ['quincyMemoryMiB', config.quincyMemoryMiB],
    ['logRetentionDays', config.logRetentionDays],
    ['ecrRetainedImageCount', config.ecrRetainedImageCount],
    ['redisReplicaCount', config.redisReplicaCount],
    ['redisSnapshotRetentionDays', config.redisSnapshotRetentionDays],
    ['jenkinsGeneralAgentMax', config.jenkinsGeneralAgentMax],
    ['jenkinsPrivilegedAgentMax', config.jenkinsPrivilegedAgentMax],
    ['jenkinsPrContainerAgentMax', config.jenkinsPrContainerAgentMax],
    ['jenkinsBackupRetentionDays', config.jenkinsBackupRetentionDays],
  ] as const) positiveInteger(value, name);
  if (!digestPattern.test(config.jenkinsControllerImageDigest)) {
    throw new Error('jenkinsControllerImageDigest must be a sha256 digest, never a tag');
  }
  if (!/^https:\/\/[^/]+$/.test(`https://${config.jenkinsDomainName}`)) throw new Error('jenkinsDomainName is invalid');
  if (!config.jenkinsCertificateArn.includes(`:${config.region}:`)) throw new Error('Jenkins certificate must be in the deployment region');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.githubOrganization)) throw new Error('githubOrganization is invalid');
  if (!/^\d+$/.test(config.githubAppId)) throw new Error('githubAppId must be numeric');
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(config.jenkinsAgentHostPublicKey)) {
    throw new Error('jenkinsAgentHostPublicKey must be an SSH Ed25519 public key without a comment');
  }
  if (!['datadoghq.com', 'datadoghq.eu', 'us3.datadoghq.com', 'us5.datadoghq.com', 'ddog-gov.com', 'ap1.datadoghq.com', 'ap2.datadoghq.com'].includes(config.datadogSite)) {
    throw new Error('datadogSite is not a supported Datadog site');
  }
  if (stage === 'production' && config.account === JSON.parse(readFileSync(resolve(__dirname, '..', 'config', 'nonprod.json'), 'utf8')).account) {
    throw new Error('production and non-production must not use the same AWS account');
  }
  if (!config.frontendCertificateArn.includes(':us-east-1:')) {
    throw new Error('CloudFront certificate must be in us-east-1');
  }
  if (!config.frontendWebAclArn.includes(':wafv2:us-east-1:') || !config.frontendWebAclArn.includes(':global/webacl/')) {
    throw new Error('CloudFront WAF ACL must be a global us-east-1 WAFv2 ARN');
  }
  return config;
}
