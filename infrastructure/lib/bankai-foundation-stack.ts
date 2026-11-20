import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from './environment-config';
import { NativeObservability } from './native-observability';
import { JenkinsFoundation } from './jenkins-foundation';

export interface BankaiFoundationStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

function retentionFor(days: number): logs.RetentionDays {
  const values: Record<number, logs.RetentionDays> = {
    1: logs.RetentionDays.ONE_DAY,
    3: logs.RetentionDays.THREE_DAYS,
    5: logs.RetentionDays.FIVE_DAYS,
    7: logs.RetentionDays.ONE_WEEK,
    14: logs.RetentionDays.TWO_WEEKS,
    30: logs.RetentionDays.ONE_MONTH,
    60: logs.RetentionDays.TWO_MONTHS,
    90: logs.RetentionDays.THREE_MONTHS,
    120: logs.RetentionDays.FOUR_MONTHS,
    150: logs.RetentionDays.FIVE_MONTHS,
    180: logs.RetentionDays.SIX_MONTHS,
    365: logs.RetentionDays.ONE_YEAR,
  };
  const retention = values[days];
  if (!retention) throw new Error(`Unsupported CloudWatch log retention: ${days} days`);
  return retention;
}

export class BankaiFoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BankaiFoundationStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { stage } = config;
    const bankaiVersion = this.node.tryGetContext('bankaiGitSha') ?? config.backendImageDigest;
    const deploymentId = this.node.tryGetContext('deploymentId') ?? 'manual-synth';
    const jenkinsBuild = this.node.tryGetContext('jenkinsBuild') ?? 'manual-synth';
    const releaseArchitecture = this.node.tryGetContext('releaseArchitecture');
    if (releaseArchitecture !== undefined && !['arm64', 'amd64'].includes(releaseArchitecture)) {
      throw new Error('releaseArchitecture must be arm64 or amd64');
    }
    const runtimePlatform = releaseArchitecture === undefined ? undefined : {
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      cpuArchitecture: releaseArchitecture === 'arm64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
    };
    const production = stage === 'production';
    const initialProvisioning = this.node.tryGetContext('initialProvisioning') === 'true';
    if (initialProvisioning && production) {
      throw new Error('initialProvisioning is restricted to nonprod');
    }
    const apiDesiredCount = initialProvisioning ? 0 : config.apiDesiredCount;
    const workerDesiredCount = initialProvisioning ? 0 : config.workerDesiredCount;
    const logRetention = retentionFor(config.logRetentionDays);

    // This remains one stack to preserve the logical identity of resources
    // created by the original CDK foundation. Internal sections are separated
    // by concern without inserting Construct path components.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: config.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `bankai-${stage}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });
    cluster.addDefaultCloudMapNamespace({ name: `${stage}.bankai.local` });

    const repositoryProps: ecr.RepositoryProps = {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // No count-based expiry: ECS does not protect active/rollback digests from ECR lifecycle deletion.

    };
    const backendRepository = new ecr.Repository(this, 'BackendRepository', {
      ...repositoryProps,
      repositoryName: `bankai/${stage}/backend`,
    });

    const frontendKey = new kms.Key(this, 'FrontendKey', {
      enableKeyRotation: true,
      removalPolicy: production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      description: `Bankai ${stage} frontend artifact encryption`,
    });
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: frontendKey,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const frontendCertificate = acm.Certificate.fromCertificateArn(
      this,
      'FrontendCertificate',
      config.frontendCertificateArn,
    );
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      domainNames: [config.frontendDomainName],
      certificate: frontendCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      webAclId: config.frontendWebAclArn,
      defaultRootObject: 'index.html',
      additionalBehaviors: {
        'runtime-config.js': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(1) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(1) },
      ],
    });
    if (production) distribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });
    new route53.ARecord(this, 'FrontendAliasRecord', {
      zone: hostedZone,
      recordName: config.frontendDomainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    const backendSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'BackendSecret',
      `bankai/${stage}/backend`,
    );
    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: 'Bankai API and worker tasks',
      allowAllOutbound: true,
    });
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      // Preserve the deployed nonprod security-group identity; Description is
      // replacement-only in CloudFormation.
      description: production ? 'Bankai Redis access' : 'Bankai non-production Redis task',
      // The deployed nonprod Fargate Redis task needs outbound access for its
      // image pull and awslogs initialization. Preserve that behavior during
      // this migration; production uses ElastiCache instead of this task.
      allowAllOutbound: !production,
    });
    redisSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(6379), 'Bankai tasks to Redis');

    let redisUrl: string;
    let redisService: ecs.FargateService | undefined;
    if (production) {
      const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
        description: `Bankai ${stage} ElastiCache isolated subnets`,
        subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      });
      const replicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
        replicationGroupDescription: `Bankai ${stage} Redis`,
        engine: 'redis',
        engineVersion: '7.1',
        cacheNodeType: config.redisNodeType,
        cacheSubnetGroupName: subnetGroup.ref,
        securityGroupIds: [redisSecurityGroup.securityGroupId],
        numCacheClusters: config.redisReplicaCount,
        automaticFailoverEnabled: config.redisReplicaCount > 1,
        multiAzEnabled: config.redisReplicaCount > 1,
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        snapshotRetentionLimit: config.redisSnapshotRetentionDays,
        snapshotWindow: '18:00-19:00',
        preferredMaintenanceWindow: 'sun:19:00-sun:20:00',
      });
      replicationGroup.addResourceDependency(subnetGroup);
      replicationGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      redisUrl = cdk.Fn.join('', [
        'rediss://',
        replicationGroup.attrPrimaryEndPointAddress,
        ':',
        replicationGroup.attrPrimaryEndPointPort,
      ]);
      new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', {
        value: replicationGroup.attrPrimaryEndPointAddress,
        description: 'Non-sensitive ElastiCache endpoint used by deployment verification',
      });
    } else {
      const redisTask = new ecs.FargateTaskDefinition(this, 'RedisTask', {
        cpu: 256,
        memoryLimitMiB: 512,
      });
      const redisContainer = redisTask.addContainer('Redis', {
        image: ecs.ContainerImage.fromRegistry('redis:7.2.5-alpine'),
        command: ['redis-server', '--appendonly', 'yes'],
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'redis', logRetention }),
        healthCheck: {
          command: ['CMD-SHELL', 'redis-cli ping | grep PONG'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(10),
        },
        stopTimeout: cdk.Duration.seconds(30),
      });
      redisContainer.addPortMappings({ containerPort: 6379 });
      redisService = new ecs.FargateService(this, 'RedisService', {
        cluster,
        taskDefinition: redisTask,
        desiredCount: 1,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [redisSecurityGroup],
        cloudMapOptions: { name: 'redis' },
      });
      redisUrl = `redis://redis.${stage}.bankai.local:6379`;
    }

    const environment = {
      DD_ENV: stage,
      DD_VERSION: bankaiVersion,
      GIT_SHA: bankaiVersion,
      DEPLOYMENT_ID: deploymentId,
      JENKINS_BUILD: jenkinsBuild,

      NODE_ENV: 'production',
      APP_ENV: 'production',
      PORT: '4000',
      SUPABASE_ENV: 'production',
      BACKEND_PUBLIC_URL: `https://${config.apiDomainName}`,
      FRONTEND_ORIGIN: `https://${config.frontendDomainName}`,
      COOKIE_DOMAIN: `.${config.hostedZoneName}`,
      COOKIE_SAMESITE: 'lax',
      REDIS_URL: redisUrl,
      AI_PROVIDER: 'openrouter',
    };
    const secrets = Object.fromEntries([
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ARCJET_KEY',
      'TOKEN_ENC_KEY',
      'GEMINI_API_KEY',
      'GITHUB_OAUTH_CLIENT_ID',
      'GITHUB_OAUTH_CLIENT_SECRET',
      'OPENROUTER_API_KEY',
    ].map((key) => [key, ecs.Secret.fromSecretsManager(backendSecret, key)]));
    const backendImage = ecs.ContainerImage.fromEcrRepository(backendRepository, config.backendImageDigest);
    const apiCertificate = acm.Certificate.fromCertificateArn(this, 'ApiCertificate', config.apiCertificateArn);
    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      runtimePlatform,
      cluster,
      serviceName: `bankai-${stage}-api`,
      cpu: config.apiCpu,
      memoryLimitMiB: config.apiMemoryMiB,
      // The L3 pattern rejects zero even though ECS supports it. During the
      // first nonprod provisioning pass we override the synthesized service
      // below, before deployment, so no placeholder image is ever launched.
      desiredCount: initialProvisioning ? 1 : apiDesiredCount,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      publicLoadBalancer: true,
      assignPublicIp: false,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
      listenerPort: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate: apiCertificate,
      redirectHTTP: true,
      taskImageOptions: {
        image: backendImage,
        containerPort: 4000,
        environment: { ...environment, DD_SERVICE: 'bankai-api' },
        secrets,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logRetention }),
        // Preserve the original container/log-group logical identity during
        // the Phase 3-4 migration.
        containerName: 'web',
      },
    });
    const apiLoadBalancerResource = api.loadBalancer.node.defaultChild as elbv2.CfnLoadBalancer;
    if (initialProvisioning) {
      const apiServiceResource = api.service.node.defaultChild as ecs.CfnService;
      apiServiceResource.addPropertyOverride('DesiredCount', 0);
    }
    apiLoadBalancerResource.addPropertyOverride('LoadBalancerAttributes', [
      ...(production ? [{ Key: 'deletion_protection.enabled', Value: 'true' }] : []),
      { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      { Key: 'routing.http.desync_mitigation_mode', Value: 'strictest' },
    ]);
    const apiTaskResource = api.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    apiTaskResource.addPropertyOverride('ContainerDefinitions.0.HealthCheck', {
      Command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:4000/healthz\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
      Interval: 30,
      Timeout: 5,
      Retries: 3,
      StartPeriod: 30,
    });
    apiTaskResource.addPropertyOverride('ContainerDefinitions.0.StopTimeout', 60);
    api.targetGroup.configureHealthCheck({ path: '/healthz', healthyHttpCodes: '200' });
    if (redisService) api.service.node.addDependency(redisService);
    const apiScaling = api.service.autoScaleTaskCount({ minCapacity: apiDesiredCount, maxCapacity: production ? 10 : 3 });
    apiScaling.scaleOnCpuUtilization('ApiCpuScaling', { targetUtilizationPercent: 60 });
    apiScaling.scaleOnMemoryUtilization('ApiMemoryScaling', { targetUtilizationPercent: 75 });

    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      runtimePlatform,
      cpu: config.workerCpu,
      memoryLimitMiB: config.workerMemoryMiB,
    });
    const workerContainer = workerTask.addContainer('Worker', {
      image: backendImage,
      command: ['node', 'dist/worker.js'],
      environment: { ...environment, DD_SERVICE: 'bankai-worker' },
      secrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logRetention }),
      stopTimeout: cdk.Duration.seconds(120),
    });
    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      serviceName: `bankai-${stage}-worker`,
      taskDefinition: workerTask,
      desiredCount: workerDesiredCount,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
    });
    workerService.node.addDependency(api.service);
    if (redisService) workerService.node.addDependency(redisService);
    const workerScaling = workerService.autoScaleTaskCount({ minCapacity: workerDesiredCount, maxCapacity: 2 });
    workerScaling.scaleOnCpuUtilization('WorkerCpuScaling', { targetUtilizationPercent: 70 });
    workerScaling.scaleOnMemoryUtilization('WorkerMemoryScaling', { targetUtilizationPercent: 75 });

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: config.apiDomainName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(api.loadBalancer)),
    });

    const runningTaskAlarm = (id: string, name: string, service: ecs.FargateService, threshold: number) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: `bankai-${stage}-${name}-running-tasks`,
        alarmDescription: `${name} has fewer running tasks than its desired minimum.`,
        metric: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: service.serviceName },
          statistic: 'Minimum',
          period: cdk.Duration.minutes(5),
        }),
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    runningTaskAlarm('WorkerRunningTaskAlarm', 'worker', workerService, config.workerDesiredCount);
    if (redisService) runningTaskAlarm('RedisRunningTaskAlarm', 'redis', redisService, 1);
    new cloudwatch.Alarm(this, 'ApiUnhealthyTargetAlarm', {
      alarmName: `bankai-${stage}-api-unhealthy-targets`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB', metricName: 'UnHealthyHostCount',
        dimensionsMap: { LoadBalancer: api.loadBalancer.loadBalancerFullName, TargetGroup: api.targetGroup.targetGroupFullName },
        statistic: 'Maximum', period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `bankai-${stage}-alb-5xx`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_ELB_5XX_Count',
        dimensionsMap: { LoadBalancer: api.loadBalancer.loadBalancerFullName },
        statistic: 'Sum', period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Keep retired sidecar log-group construct paths so removing paid agents
    // cannot delete historical logs or silently change their ownership.
    for (const task of [api.taskDefinition, workerTask]) {
      const retiredAgent = new Construct(task, 'DatadogAgent');
      new logs.LogGroup(retiredAgent, 'LogGroup', {
        retention: logRetention, removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    new NativeObservability(this, 'NativeObservability', {
      stage, cluster: cluster.clusterName,
      services: [api.service.serviceName, workerService.serviceName, ...(redisService ? [redisService.serviceName] : [])],
      apiLogGroup: api.taskDefinition.defaultContainer!.logDriverConfig!.options!['awslogs-group'],
      workerLogGroup: workerContainer.logDriverConfig!.options!['awslogs-group'],
      loadBalancer: api.loadBalancer.loadBalancerFullName, targetGroup: api.targetGroup.targetGroupFullName,
      distribution: distribution.distributionId, webAcl: cdk.Fn.select(1, cdk.Fn.split('/', config.frontendWebAclArn)),
    });

    new JenkinsFoundation(this, 'Jenkins', {
      config,
      vpc,
      hostedZone,
      backendRepository,
      frontendBucket,
    });

    for (const resource of this.node.findAll()) {
      if (resource instanceof logs.CfnLogGroup || (production && resource instanceof route53.CfnRecordSet)) {
        resource.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    cdk.Tags.of(this).add('Application', 'Bankai');
    cdk.Tags.of(this).add('Service', 'delivery-platform');
    cdk.Tags.of(this).add('Environment', stage);
    cdk.Tags.of(this).add('ManagedBy', 'AWS-CDK');
    cdk.Tags.of(this).add('CostCenter', config.costCenter);

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'BackendRepositoryUri', { value: backendRepository.repositoryUri });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendDistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'FrontendDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'ApiLoadBalancerDnsName', { value: api.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ApiServiceName', { value: api.service.serviceName });
    new cdk.CfnOutput(this, 'WorkerServiceName', { value: workerService.serviceName });
    new cdk.CfnOutput(this, 'BackendImageDigest', { value: config.backendImageDigest });
  }
}
