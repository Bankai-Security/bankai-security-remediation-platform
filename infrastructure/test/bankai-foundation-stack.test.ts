import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BankaiFoundationStack } from '../lib/bankai-foundation-stack';

describe('BankaiFoundationStack', () => {
  const app = new cdk.App();
  const stack = new BankaiFoundationStack(app, 'TestStack', { stage: 'nonprod' });
  const template = Template.fromStack(stack);

  it('creates a two-AZ VPC without NAT gateways', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  it('creates immutable scanning repositories for Bankai and Quincy', () => {
    template.resourceCountIs('AWS::ECR::Repository', 2);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'bankai/nonprod/backend',
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: 'IMMUTABLE',
    });
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'bankai/nonprod/quincy',
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: 'IMMUTABLE',
    });
  });

  it('keeps the frontend bucket private and encrypted', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('runs Quincy jobs in privileged CodeBuild without exposing the Quincy service publicly', () => {
    const runtimeStack = new BankaiFoundationStack(new cdk.App(), 'RuntimeTestStack', {
      stage: 'nonprod',
      backendImageTag: 'backend-test',
      quincyImageTag: 'quincy-test',
      certificateArn: 'arn:aws:acm:ap-south-1:111111111111:certificate/test',
    });
    const runtimeTemplate = Template.fromStack(runtimeStack);

    runtimeTemplate.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ PrivilegedMode: true }),
      Source: Match.objectLike({ Type: 'NO_SOURCE' }),
    });

    const projects = runtimeTemplate.findResources('AWS::CodeBuild::Project');
    const buildSpec = JSON.stringify(Object.values(projects)[0]?.Properties?.Source?.BuildSpec);
    expect(buildSpec).toContain('docker pull node:22-slim');
    expect(buildSpec).toContain('docker tag node:22-slim quincy-sandbox-node:latest');
    runtimeTemplate.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'bankai-nonprod-quincy',
      DesiredCount: 1,
    });
    runtimeTemplate.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8000,
      ToPort: 8000,
      IpProtocol: 'tcp',
    });
    runtimeTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'elasticfilesystem:ClientMount',
              'elasticfilesystem:ClientWrite',
            ]),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
    runtimeTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    runtimeTemplate.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: Match.arrayWith([Match.objectLike({ Name: 'containerInsights', Value: 'enabled' })]),
    });
    runtimeTemplate.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    for (const alarmName of [
      'bankai-nonprod-api-unhealthy-targets',
      'bankai-nonprod-quincy-running-tasks',
      'bankai-nonprod-worker-running-tasks',
      'bankai-nonprod-redis-running-tasks',
      'bankai-nonprod-quincy-codebuild-failures',
      'bankai-nonprod-alb-5xx',
    ]) {
      runtimeTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: alarmName });
    }
  });
});
