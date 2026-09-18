import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface BankaiFoundationStackProps extends cdk.StackProps {
  readonly stage: 'nonprod' | 'production';
  readonly backendImageTag?: string;
  readonly quincyImageTag?: string;
  readonly certificateArn?: string;
  readonly frontendCertificateArn?: string;
}

export class BankaiFoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BankaiFoundationStackProps) {
    super(scope, id, props);

    const { stage } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(stage === 'production' ? '10.30.0.0/16' : '10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `bankai-${stage}`,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
      enableFargateCapacityProviders: true,
    });

    const backendRepository = new ecr.Repository(this, 'BackendRepository', {
      repositoryName: `bankai/${stage}/backend`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: stage === 'nonprod',
      removalPolicy: stage === 'nonprod' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'Retain the newest 20 images', maxImageCount: 20, rulePriority: 1 }],
    });

    const quincyRepository = new ecr.Repository(this, 'QuincyRepository', {
      repositoryName: `bankai/${stage}/quincy`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: stage === 'nonprod',
      removalPolicy: stage === 'nonprod' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'Retain the newest 20 images', maxImageCount: 20, rulePriority: 1 }],
    });

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (props.frontendCertificateArn) {
      const frontendCertificate = acm.Certificate.fromCertificateArn(
        this,
        'FrontendCertificate',
        props.frontendCertificateArn,
      );
      const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
        domainNames: ['nonprod.bankaisecurity.com'],
        certificate: frontendCertificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
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

      new cdk.CfnOutput(this, 'FrontendDistributionDomainName', { value: distribution.distributionDomainName });
      new cdk.CfnOutput(this, 'FrontendDistributionId', { value: distribution.distributionId });
    }

    if (props.backendImageTag && props.certificateArn) {
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
        description: 'Bankai non-production Redis task',
        allowAllOutbound: true,
      });
      redisSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(6379), 'Bankai tasks to Redis');

      cluster.addDefaultCloudMapNamespace({ name: `${stage}.bankai.local` });

      const redisTask = new ecs.FargateTaskDefinition(this, 'RedisTask', {
        cpu: 256,
        memoryLimitMiB: 512,
      });
      const redisContainer = redisTask.addContainer('Redis', {
        image: ecs.ContainerImage.fromRegistry('redis:7-alpine'),
        command: ['redis-server', '--appendonly', 'yes'],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'redis',
          logRetention: logs.RetentionDays.ONE_WEEK,
        }),
        healthCheck: {
          command: ['CMD-SHELL', 'redis-cli ping | grep PONG'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(10),
        },
      });
      redisContainer.addPortMappings({ containerPort: 6379 });

      const redisService = new ecs.FargateService(this, 'RedisService', {
        cluster,
        taskDefinition: redisTask,
        desiredCount: 1,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        assignPublicIp: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [redisSecurityGroup],
        cloudMapOptions: { name: 'redis' },
      });

      let quincyService: ecs.FargateService | undefined;
      let quincyApiUrl: string | undefined;
      if (props.quincyImageTag) {
        const jobBucket = new s3.Bucket(this, 'QuincyJobBucket', {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
          autoDeleteObjects: stage === 'nonprod',
          removalPolicy: stage === 'nonprod' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });
        const quincyImageUri = `${quincyRepository.repositoryUri}:${props.quincyImageTag}`;
        const codeBuildProject = new codebuild.Project(this, 'QuincyRemediationProject', {
          projectName: `bankai-${stage}-quincy-remediation`,
          timeout: cdk.Duration.hours(1),
          environment: {
            buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
            privileged: true,
            computeType: codebuild.ComputeType.MEDIUM,
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
              pre_build: {
                commands: [
                  'mkdir -p "$CODEBUILD_SRC_DIR/job" "$CODEBUILD_SRC_DIR/tmp"',
                  'aws s3 cp "s3://$QUINCY_JOB_BUCKET/$QUINCY_JOB_PREFIX/job.json" "$CODEBUILD_SRC_DIR/job/job.json"',
                  `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.${this.urlSuffix}`,
                  'docker pull "$QUINCY_IMAGE_URI"',
                  'docker pull node:22-slim',
                  'docker tag node:22-slim quincy-sandbox-node:latest',
                ],
              },
              build: {
                commands: [
                  'docker run --rm --user root -v /var/run/docker.sock:/var/run/docker.sock -v "$CODEBUILD_SRC_DIR:$CODEBUILD_SRC_DIR" -e TMPDIR="$CODEBUILD_SRC_DIR/tmp" -e MODEL_PROVIDER -e OPENROUTER_API_KEY -e GEMINI_API_KEY -e SANDBOX_BACKEND=docker -e JOB_EXECUTION_BACKEND=local "$QUINCY_IMAGE_URI" python -m quincy.api.codebuild_job_worker --input "$CODEBUILD_SRC_DIR/job/job.json" --result "$CODEBUILD_SRC_DIR/job/result.json"',
                ],
              },
              post_build: {
                commands: [
                  'if [ -f "$CODEBUILD_SRC_DIR/job/result.json" ]; then aws s3 cp "$CODEBUILD_SRC_DIR/job/result.json" "s3://$QUINCY_JOB_BUCKET/$QUINCY_JOB_PREFIX/result.json"; fi',
                ],
              },
            },
          }),
        });
        jobBucket.grantReadWrite(codeBuildProject);
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
          securityGroup: fileSystemSecurityGroup,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
          removalPolicy: stage === 'nonprod' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });
        const accessPoint = fileSystem.addAccessPoint('QuincyDataAccessPoint', {
          path: '/quincy-data',
          createAcl: { ownerGid: '1000', ownerUid: '1000', permissions: '750' },
          posixUser: { gid: '1000', uid: '1000' },
        });
        const quincyTask = new ecs.FargateTaskDefinition(this, 'QuincyTask', {
          cpu: 1024,
          memoryLimitMiB: 2048,
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
          image: ecs.ContainerImage.fromEcrRepository(quincyRepository, props.quincyImageTag),
          environment: {
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
          logging: ecs.LogDrivers.awsLogs({
            streamPrefix: 'quincy',
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
          healthCheck: {
            command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8000/health\', timeout=3).read()"'],
            interval: cdk.Duration.seconds(30),
            timeout: cdk.Duration.seconds(5),
            retries: 3,
            startPeriod: cdk.Duration.seconds(30),
          },
        });
        quincyContainer.addPortMappings({ containerPort: 8000 });
        quincyContainer.addMountPoints({
          containerPath: '/app/data',
          sourceVolume: 'quincy-data',
          readOnly: false,
        });
        jobBucket.grantReadWrite(quincyTask.taskRole);
        fileSystem.grantReadWrite(quincyTask.taskRole);
        quincyTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
          resources: [codeBuildProject.projectArn],
        }));
        quincyService = new ecs.FargateService(this, 'QuincyService', {
          cluster,
          serviceName: `bankai-${stage}-quincy`,
          taskDefinition: quincyTask,
          desiredCount: 1,
          circuitBreaker: { rollback: true },
          minHealthyPercent: 100,
          assignPublicIp: true,
          vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
          securityGroups: [quincySecurityGroup],
          cloudMapOptions: { name: 'quincy' },
        });
        quincyService.node.addDependency(fileSystem.mountTargetsAvailable);
        quincyApiUrl = `http://quincy.${stage}.bankai.local:8000`;
      }

      const environment = {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        PORT: '4000',
        SUPABASE_ENV: 'production',
        BACKEND_PUBLIC_URL: 'https://api-nonprod.bankaisecurity.com',
        FRONTEND_ORIGIN: 'https://nonprod.bankaisecurity.com',
        COOKIE_DOMAIN: '.bankaisecurity.com',
        COOKIE_SAMESITE: 'lax',
        REDIS_URL: `redis://redis.${stage}.bankai.local:6379`,
        AI_PROVIDER: 'openrouter',
        ...(quincyApiUrl ? { QUINCY_API_URL: quincyApiUrl } : {}),
      };
      const secrets = Object.fromEntries(
        [
          'SUPABASE_URL',
          'SUPABASE_ANON_KEY',
          'SUPABASE_SERVICE_ROLE_KEY',
          'ARCJET_KEY',
          'TOKEN_ENC_KEY',
          'GEMINI_API_KEY',
          'GITHUB_OAUTH_CLIENT_ID',
          'GITHUB_OAUTH_CLIENT_SECRET',
          'OPENROUTER_API_KEY',
        ].map((key) => [key, ecs.Secret.fromSecretsManager(backendSecret, key)]),
      );
      if (quincyApiUrl) {
        secrets.QUINCY_API_TOKEN = ecs.Secret.fromSecretsManager(quincyApiToken);
      }
      const backendImage = ecs.ContainerImage.fromEcrRepository(backendRepository, props.backendImageTag);
      const certificate = acm.Certificate.fromCertificateArn(this, 'ApiCertificate', props.certificateArn);

      const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
        cluster,
        serviceName: `bankai-${stage}-api`,
        cpu: 512,
        memoryLimitMiB: 1024,
        desiredCount: 1,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        publicLoadBalancer: true,
        assignPublicIp: true,
        taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [appSecurityGroup],
        listenerPort: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificate,
        redirectHTTP: true,
        taskImageOptions: {
          image: backendImage,
          containerPort: 4000,
          environment,
          secrets,
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'api',
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
        },
      });
      api.targetGroup.configureHealthCheck({ path: '/healthz', healthyHttpCodes: '200' });
      api.service.node.addDependency(redisService);
      if (quincyService) api.service.node.addDependency(quincyService);

      const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
        cpu: 512,
        memoryLimitMiB: 1024,
      });
      workerTask.addContainer('Worker', {
        image: backendImage,
        command: ['node', 'dist/worker.js'],
        environment,
        secrets,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'worker',
          logRetention: logs.RetentionDays.ONE_WEEK,
        }),
      });
      const workerService = new ecs.FargateService(this, 'WorkerService', {
        cluster,
        serviceName: `bankai-${stage}-worker`,
        taskDefinition: workerTask,
        desiredCount: 1,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        assignPublicIp: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [appSecurityGroup],
      });
      workerService.node.addDependency(redisService);
      if (quincyService) workerService.node.addDependency(quincyService);

      new cdk.CfnOutput(this, 'ApiLoadBalancerDnsName', { value: api.loadBalancer.loadBalancerDnsName });
    } else if (props.backendImageTag || props.certificateArn) {
      throw new Error('backendImageTag and certificateArn must be provided together');
    }

    cdk.Tags.of(this).add('Application', 'Bankai');
    cdk.Tags.of(this).add('Environment', stage);
    cdk.Tags.of(this).add('ManagedBy', 'AWS-CDK');

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'BackendRepositoryUri', { value: backendRepository.repositoryUri });
    new cdk.CfnOutput(this, 'QuincyRepositoryUri', { value: quincyRepository.repositoryUri });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
  }
}
