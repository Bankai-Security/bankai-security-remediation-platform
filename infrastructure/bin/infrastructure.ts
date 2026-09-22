#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BankaiFoundationStack } from '../lib/bankai-foundation-stack';
import { loadEnvironmentConfig } from '../lib/environment-config';

const app = new cdk.App();
const config = loadEnvironmentConfig(app.node);

new BankaiFoundationStack(app, `Bankai-${config.stage}-Foundation`, {
  config,
  env: {
    account: config.account,
    region: config.region,
  },
  terminationProtection: config.stage === 'production',
  description: `Bankai ${config.stage} AWS foundation and application services`,
});
