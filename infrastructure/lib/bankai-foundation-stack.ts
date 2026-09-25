import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from './environment-config';
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
    const quincyVersion = this.node.tryGetContext('quincyGitSha') ?? config.quincyImageDigest;
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
    const quincyDesiredCount = initialProvisioning ? 0 : config.quincyDesiredCount;
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
      emptyOnDelete: !production,
      removalPolicy: production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [{
        description: `Retain the newest ${config.ecrRetainedImageCount} images`,
        maxImageCount: config.ecrRetainedImageCount,
        rulePriority: 1,
      }],
    };
    const backendRepository = new ecr.Repository(this, 'BackendRepository', {
      ...repositoryProps,
      repositoryName: `bankai/${stage}/backend`,
    });
    const quincyRepository = new ecr.Repository(this, 'QuincyRepository', {
      ...repositoryProps,
      repositoryName: `bankai/${stage}/quincy`,
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
    const quincyApiToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      'QuincyApiToken',
      `bankai/${stage}/quincy-api-token`,
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

    const jobKey = new kms.Key(this, 'QuincyJobKey', {
      enableKeyRotation: true,
      removalPolicy: production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      description: `Bankai ${stage} Quincy job artifact encryption`,
    });
    const jobBucket = new s3.Bucket(this, 'QuincyJobBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: jobKey,
      enforceSSL: true,
      versioned: production,
      lifecycleRules: [{ expiration: cdk.Duration.days(production ? 7 : 1) }],
      autoDeleteObjects: !production,
      removalPolicy: production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const codeBuildSecurityGroup = new ec2.SecurityGroup(this, 'CodeBuildSecurityGroup', {
      vpc,
      description: 'Outbound-only Quincy remediation builds',
      allowAllOutbound: true,
    });
    const quincyImageUri = `${quincyRepository.repositoryUri}@${config.quincyImageDigest}`;
    const codeBuildProject = new codebuild.Project(this, 'QuincyRemediationProject', {
      projectName: `bankai-${stage}-quincy-remediation`,
      timeout: cdk.Duration.hours(1),
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [codeBuildSecurityGroup],
      environment: {
        buildImage: releaseArchitecture === 'arm64'
          ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0
          : codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        computeType: releaseArchitecture === 'arm64' ? codebuild.ComputeType.LARGE : codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          QUINCY_IMAGE_URI: { value: quincyImageUri },
          MODEL_PROVIDER: { value: 'openrouter' },
          OPENROUTER_API_KEY: {
            value: `${backendSecret.secretName}:OPENROUTER_API_KEY`,
            type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          GEMINI_API_KEY: {
            value: `${backendSecret.secretName}:GEMINI_API_KEY`,
            type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: [
            'mkdir -p "$CODEBUILD_SRC_DIR/job" "$CODEBUILD_SRC_DIR/tmp"',
            'aws s3 cp "s3://$QUINCY_JOB_BUCKET/$QUINCY_JOB_PREFIX/job.json" "$CODEBUILD_SRC_DIR/job/job.json"',
            `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.${this.urlSuffix}`,
            'docker pull "$QUINCY_IMAGE_URI"',
          ] },
          build: { commands: [
            'docker run --rm --user root -v /var/run/docker.sock:/var/run/docker.sock -v "$CODEBUILD_SRC_DIR:$CODEBUILD_SRC_DIR" -e TMPDIR="$CODEBUILD_SRC_DIR/tmp" -e MODEL_PROVIDER -e OPENROUTER_API_KEY -e GEMINI_API_KEY -e SANDBOX_BACKEND=docker -e JOB_EXECUTION_BACKEND=local "$QUINCY_IMAGE_URI" python -m quincy.api.codebuild_job_worker --input "$CODEBUILD_SRC_DIR/job/job.json" --result "$CODEBUILD_SRC_DIR/job/result.json"',
          ] },
          post_build: { commands: [
            'if [ -f "$CODEBUILD_SRC_DIR/job/result.json" ]; then aws s3 cp "$CODEBUILD_SRC_DIR/job/result.json" "s3://$QUINCY_JOB_BUCKET/$QUINCY_JOB_PREFIX/result.json"; fi',
          ] },
        },
      }),
    });
    codeBuildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [jobBucket.arnForObjects('jobs/*')],
    }));
    quincyRepository.grantPull(codeBuildProject);
    backendSecret.grantRead(codeBuildProject);

    const quincySecurityGroup = new ec2.SecurityGroup(this, 'QuincySecurityGroup', {
      vpc,
      description: 'Internal Quincy API service',
      allowAllOutbound: true,
    });
    quincySecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(8000), 'Bankai tasks to Quincy');
    const fileSystemSecurityGroup = new ec2.SecurityGroup(this, 'QuincyFileSystemSecurityGroup', {
      vpc,
      description: 'Quincy EFS mount targets',
      allowAllOutbound: false,
    });
    fileSystemSecurityGroup.addIngressRule(quincySecurityGroup, ec2.Port.tcp(2049), 'Quincy task to EFS');
    const fileSystem = new efs.FileSystem(this, 'QuincyFileSystem', {
      vpc,
      encrypted: true,
      allowAnonymousAccess: true,
      securityGroup: fileSystemSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const accessPoint = fileSystem.addAccessPoint('QuincyDataAccessPoint', {
      path: '/quincy-data',
      // Preserve the deployed nonprod access point and its existing data
      // ownership. Moving it to the hardened runtime UID needs a separate
      // data migration because these fields replace the access point.
      createAcl: {
        ownerGid: production ? '10001' : '1000',
        ownerUid: production ? '10001' : '1000',
        permissions: '750',
      },
      posixUser: {
        gid: production ? '10001' : '1000',
        uid: production ? '10001' : '1000',
      },
    });
    const quincyTask = new ecs.FargateTaskDefinition(this, 'QuincyTask', {
      runtimePlatform,
      cpu: config.quincyCpu,
      memoryLimitMiB: config.quincyMemoryMiB,
    });
    quincyTask.addVolume({
      name: 'quincy-data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
      },
    });
    const quincyContainer = quincyTask.addContainer('Quincy', {
      image: ecs.ContainerImage.fromEcrRepository(quincyRepository, config.quincyImageDigest),
      environment: {
        DD_ENV: stage,
        DD_SERVICE: 'quincy',
        DD_VERSION: quincyVersion,
        GIT_SHA: quincyVersion,
        DEPLOYMENT_ID: deploymentId,
        JENKINS_BUILD: jenkinsBuild,
        MODEL_PROVIDER: 'openrouter',
        JOB_EXECUTION_BACKEND: 'codebuild',
        SANDBOX_BACKEND: 'docker',
        CODEBUILD_PROJECT_NAME: codeBuildProject.projectName,
        CODEBUILD_REQUEST_BUCKET: jobBucket.bucketName,
        AWS_REGION: this.region,
      },
      secrets: {
        SERVICE_API_TOKEN: ecs.Secret.fromSecretsManager(quincyApiToken),
        OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(backendSecret, 'OPENROUTER_API_KEY'),
        GEMINI_API_KEY: ecs.Secret.fromSecretsManager(backendSecret, 'GEMINI_API_KEY'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'quincy', logRetention }),
      healthCheck: {
        command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8000/health\', timeout=3).read()"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
      stopTimeout: cdk.Duration.seconds(120),
    });
    quincyContainer.addPortMappings({ containerPort: 8000 });
    quincyContainer.addMountPoints({ containerPath: '/app/data', sourceVolume: 'quincy-data', readOnly: false });
    quincyTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [jobBucket.arnForObjects('jobs/*')],
    }));
    const fileSystemActions = ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'];
    quincyTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: fileSystemActions,
      resources: [fileSystem.fileSystemArn],
      conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn } },
    }));
    fileSystem.addToResourcePolicy(new iam.PolicyStatement({
      actions: fileSystemActions,
      resources: ['*'],
      principals: [quincyTask.taskRole],
      conditions: { Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' } },
    }));
    fileSystem.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['elasticfilesystem:Client*'],
      resources: ['*'],
      principals: [new iam.AnyPrincipal()],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));
    quincyTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
      resources: [codeBuildProject.projectArn],
    }));
    const quincyService = new ecs.FargateService(this, 'QuincyService', {
      cluster,
      serviceName: `bankai-${stage}-quincy`,
      taskDefinition: quincyTask,
      desiredCount: quincyDesiredCount,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [quincySecurityGroup],
      cloudMapOptions: { name: 'quincy' },
    });
    quincyService.node.addDependency(fileSystem.mountTargetsAvailable);
    quincyService.autoScaleTaskCount({ minCapacity: quincyDesiredCount, maxCapacity: production ? 6 : 2 })
      .scaleOnCpuUtilization('QuincyCpuScaling', { targetUtilizationPercent: 65 });
    const quincyApiUrl = `http://quincy.${stage}.bankai.local:8000`;

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
      QUINCY_API_URL: quincyApiUrl,
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
    secrets.QUINCY_API_TOKEN = ecs.Secret.fromSecretsManager(quincyApiToken);
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
    api.service.node.addDependency(quincyService);
    api.service.autoScaleTaskCount({ minCapacity: apiDesiredCount, maxCapacity: production ? 10 : 3 })
      .scaleOnCpuUtilization('ApiCpuScaling', { targetUtilizationPercent: 60 });

    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      runtimePlatform,
      cpu: config.workerCpu,
      memoryLimitMiB: config.workerMemoryMiB,
    });
    workerTask.addContainer('Worker', {
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
    api.service.node.addDependency(quincyService);
    workerService.node.addDependency(api.service);
    if (redisService) workerService.node.addDependency(redisService);
    workerService.node.addDependency(quincyService);
    workerService.autoScaleTaskCount({ minCapacity: workerDesiredCount, maxCapacity: 2 })
      .scaleOnCpuUtilization('WorkerCpuScaling', { targetUtilizationPercent: 70 });

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
    runningTaskAlarm('QuincyRunningTaskAlarm', 'quincy', quincyService, config.quincyDesiredCount);
    runningTaskAlarm('WorkerRunningTaskAlarm', 'worker', workerService, config.workerDesiredCount);
    if (redisService) runningTaskAlarm('RedisRunningTaskAlarm', 'redis', redisService, 1);
    new cloudwatch.Alarm(this, 'CodeBuildFailureAlarm', {
      alarmName: `bankai-${stage}-quincy-codebuild-failures`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CodeBuild', metricName: 'Builds',
        dimensionsMap: { ProjectName: codeBuildProject.projectName, BuildStatus: 'FAILED' },
        statistic: 'Sum', period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
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

    new JenkinsFoundation(this, 'Jenkins', {
      config,
      vpc,
      hostedZone,
      backendRepository,
      quincyRepository,
      quincySecurityGroup,
      frontendBucket,
    });

    cdk.Tags.of(this).add('Application', 'Bankai');
    cdk.Tags.of(this).add('Service', 'delivery-platform');
    cdk.Tags.of(this).add('Environment', stage);
    cdk.Tags.of(this).add('ManagedBy', 'AWS-CDK');
    cdk.Tags.of(this).add('CostCenter', config.costCenter);

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'BackendRepositoryUri', { value: backendRepository.repositoryUri });
    new cdk.CfnOutput(this, 'QuincyRepositoryUri', { value: quincyRepository.repositoryUri });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendDistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'FrontendDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'ApiLoadBalancerDnsName', { value: api.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ApiServiceName', { value: api.service.serviceName });
    new cdk.CfnOutput(this, 'WorkerServiceName', { value: workerService.serviceName });
    new cdk.CfnOutput(this, 'QuincyServiceName', { value: quincyService.serviceName });
    new cdk.CfnOutput(this, 'QuincyCodeBuildProjectName', { value: codeBuildProject.projectName });
    new cdk.CfnOutput(this, 'QuincyJobBucketName', { value: jobBucket.bucketName });
    new cdk.CfnOutput(this, 'BackendImageDigest', { value: config.backendImageDigest });
    new cdk.CfnOutput(this, 'QuincyImageDigest', { value: config.quincyImageDigest });
  }
}
