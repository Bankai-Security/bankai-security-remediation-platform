#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BankaiFoundationStack } from '../lib/bankai-foundation-stack';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage');
const region = app.node.tryGetContext('region') ?? 'ap-south-1';
const backendImageTag = app.node.tryGetContext('backendImageTag');
const quincyImageTag = app.node.tryGetContext('quincyImageTag');
const certificateArn = app.node.tryGetContext('certificateArn');
const frontendCertificateArn = app.node.tryGetContext('frontendCertificateArn');

if (stage !== 'nonprod' && stage !== 'production') {
  throw new Error('Pass a deployment stage with -c stage=nonprod or -c stage=production');
}

new BankaiFoundationStack(app, `Bankai-${stage}-Foundation`, {
  stage,
  backendImageTag,
  quincyImageTag,
  certificateArn,
  frontendCertificateArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: `Bankai ${stage} network, ECS cluster, container registries, and frontend storage`,
});
