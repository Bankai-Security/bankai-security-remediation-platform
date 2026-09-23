import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from './environment-config';

export interface JenkinsFoundationProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly hostedZone: route53.IHostedZone;
  readonly backendRepository: ecr.IRepository;
  readonly quincyRepository: ecr.IRepository;
  readonly frontendBucket: s3.IBucket;
}

function assumptionRole(scope: Construct, id: string, roleName: string, principal: iam.IPrincipal): iam.Role {
  return new iam.Role(scope, id, {
    roleName,
    assumedBy: principal,
    maxSessionDuration: cdk.Duration.hours(1),
    description: `${roleName}; short-lived Jenkins role session only`,
  });
}

export class JenkinsFoundation extends Construct {
  constructor(scope: Construct, id: string, props: JenkinsFoundationProps) {
    super(scope, id);
    const { config } = props;
    const trustedPrincipal = new iam.ArnPrincipal(config.jenkinsTrustedRoleArn);
    const jenkinsDatadogSite = ({
      'datadoghq.com': 'US1',
      'us3.datadoghq.com': 'US3',
      'us5.datadoghq.com': 'US5',
      'ddog-gov.com': 'US1_FED',
      'datadoghq.eu': 'EU1',
      'ap1.datadoghq.com': 'AP1',
      'ap2.datadoghq.com': 'AP2',
    } as Record<string, string>)[config.datadogSite];

    // Production only receives cross-account roles. The controller and agents
    // live in the non-production delivery account and never duplicate here.
    if (!config.jenkinsEnabled) {
      const productionDeployment = assumptionRole(this, 'ProductionDeploymentRole', 'bankai-production-deployment', trustedPrincipal);
      productionDeployment.addToPolicy(new iam.PolicyStatement({
        actions: ['ecs:DescribeServices', 'ecs:DescribeTaskDefinition', 'ecs:UpdateService'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
      }));
      const cloudFormation = assumptionRole(this, 'CloudFormationDeploymentRole', 'bankai-production-cloudformation-deployment', trustedPrincipal);
      cloudFormation.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet'],
        resources: [`arn:${cdk.Aws.PARTITION}:cloudformation:${config.region}:${config.account}:stack/Bankai-production-*/*`],
      }));
      new cdk.CfnOutput(this, 'ProductionDeploymentRoleArn', { value: productionDeployment.roleArn });
      new cdk.CfnOutput(this, 'ProductionCloudFormationRoleArn', { value: cloudFormation.roleArn });
      return;
    }

    const controllerKey = new kms.Key(this, 'ControllerKey', {
      enableKeyRotation: true,
      description: 'Jenkins controller EFS, backup, and EBS encryption',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const controllerSecurityGroup = new ec2.SecurityGroup(this, 'ControllerSecurityGroup', {
      vpc: props.vpc, allowAllOutbound: true, description: 'Jenkins controller private ingress only',
    });
    const fileSystemSecurityGroup = new ec2.SecurityGroup(this, 'FileSystemSecurityGroup', {
      vpc: props.vpc, allowAllOutbound: false, description: 'Jenkins home EFS',
    });
    fileSystemSecurityGroup.addIngressRule(controllerSecurityGroup, ec2.Port.tcp(2049), 'Controller NFS mount');
    const home = new efs.FileSystem(this, 'ControllerHome', {
      vpc: props.vpc,
      encrypted: true,
      kmsKey: controllerKey,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroup: fileSystemSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    const accessPoint = home.addAccessPoint('ControllerAccessPoint', {
      path: '/jenkins-home', posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
    });

    const backupVault = new backup.BackupVault(this, 'BackupVault', {
      encryptionKey: controllerKey,
      lockConfiguration: { minRetention: cdk.Duration.days(config.jenkinsBackupRetentionDays) },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const backupPlan = new backup.BackupPlan(this, 'BackupPlan', { backupVault });
    backupPlan.addRule(new backup.BackupPlanRule({
      ruleName: 'DailyJenkinsHome', scheduleExpression: events.Schedule.cron({ minute: '0', hour: '20' }),
      deleteAfter: cdk.Duration.days(config.jenkinsBackupRetentionDays),
      enableContinuousBackup: true,
    }));
    backupPlan.addSelection('JenkinsHomeSelection', { resources: [backup.BackupResource.fromEfsFileSystem(home)] });

    const adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: 'jenkins-admin-password',
      description: 'Jenkins bootstrap administrator password; rotate after identity-provider integration',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });
    cdk.Tags.of(adminSecret).add('jenkins:credentials:type', 'string');

    const controllerRole = new iam.Role(this, 'ControllerRole', {
      roleName: 'bankai-nonprod-jenkins-controller',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    controllerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:ListSecrets'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
    }));
    controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:${cdk.Aws.PARTITION}:secretsmanager:${config.region}:${config.account}:secret:jenkins-*`],
    }));
    controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [home.fileSystemArn],
      conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn } },
    }));
    home.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: ['*'],
      principals: [controllerRole],
      conditions: {
        Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
      },
    }));

    const prValidationRole = new iam.Role(this, 'PrValidationRole', {
      roleName: 'bankai-nonprod-jenkins-pr-validation',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Untrusted PR validation agents; intentionally no deployment or production access',
    });
    prValidationRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    // CDK synthesis performs a read-only Availability Zone lookup when the
    // nonprod environment is synthesized on an ephemeral PR agent. Keep this
    // permission limited to the lookup API; PR agents still have no deploy or
    // publish permissions.
    prValidationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
    }));
    const trustedAgentRole = new iam.Role(this, 'TrustedAgentRole', {
      roleName: 'bankai-nonprod-jenkins-trusted-agent',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Trusted-branch Docker agent broker; assumes short-lived release roles',
    });
    trustedAgentRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    trustedAgentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:iam::${config.account}:role/cdk-hnb659fds-deploy-role-${config.account}-${config.region}`,
        `arn:${cdk.Aws.PARTITION}:iam::${config.account}:role/cdk-hnb659fds-file-publishing-role-${config.account}-${config.region}`,
        `arn:${cdk.Aws.PARTITION}:iam::${config.account}:role/cdk-hnb659fds-image-publishing-role-${config.account}-${config.region}`,
        `arn:${cdk.Aws.PARTITION}:iam::${config.account}:role/cdk-hnb659fds-lookup-role-${config.account}-${config.region}`,
      ],
    }));
    const agentHostKeyArn = `arn:${cdk.Aws.PARTITION}:secretsmanager:${config.region}:${config.account}:secret:jenkins-agent-host-private-key-*`;
    for (const agentRole of [prValidationRole, trustedAgentRole]) {
      agentRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [agentHostKeyArn] }));
    }

    const publishingRole = assumptionRole(this, 'EcrPublishingRole', 'bankai-nonprod-ecr-publishing', trustedAgentRole);
    props.backendRepository.grantPullPush(publishingRole);
    props.quincyRepository.grantPullPush(publishingRole);
    const nonprodDeploymentRole = assumptionRole(this, 'NonprodDeploymentRole', 'bankai-nonprod-deployment', trustedAgentRole);
    nonprodDeploymentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeServices', 'ecs:DescribeTaskDefinition', 'ecs:UpdateService'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
    }));
    props.frontendBucket.grantReadWrite(nonprodDeploymentRole);
    nonprodDeploymentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${config.account}:distribution/*`],
    }));
    const cloudFormationRole = assumptionRole(this, 'CloudFormationDeploymentRole', 'bankai-nonprod-cloudformation-deployment', trustedAgentRole);
    cloudFormationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:cloudformation:${config.region}:${config.account}:stack/Bankai-nonprod-*/*`,
        `arn:${cdk.Aws.PARTITION}:cloudformation:${config.region}:${config.account}:changeSet/bankai-nonprod-*/*`,
      ],
    }));
    for (const role of [publishingRole, nonprodDeploymentRole, cloudFormationRole]) {
      trustedAgentRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [role.roleArn] }));
    }

    const agentImage = ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 });
    const agentKeyPair = ec2.KeyPair.fromKeyPairName(this, 'AgentKeyPair', config.jenkinsAgentKeyPairName);
    const agentUserData = (docker: boolean, label: string) => {
      const data = ec2.UserData.forLinux();
      data.addCommands(
        'set -euo pipefail',
        'dnf install -y java-17-amazon-corretto-headless git jq openssh-server nodejs22 nodejs22-npm python3.12 python3.12-pip',
        "install -o root -g root -m 600 /dev/null /etc/ssh/ssh_host_ed25519_key",
        `aws secretsmanager get-secret-value --region ${config.region} --secret-id jenkins-agent-host-private-key --query SecretString --output text > /etc/ssh/ssh_host_ed25519_key`,
        'ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub',
        'chmod 600 /etc/ssh/ssh_host_ed25519_key',
        'chmod 644 /etc/ssh/ssh_host_ed25519_key.pub',
        'sshd -t',
        'systemctl restart sshd',
      );
      if (docker) data.addCommands(
        'dnf install -y docker',
        'systemctl enable --now docker',
        'usermod -aG docker ec2-user',
      );
      data.addCommands('install -d -o ec2-user -g ec2-user -m 750 /opt/jenkins-agent',
        `printf '%s' '${label}' > /etc/jenkins-agent-class`);
      return data;
    };
    const makeAgentFleet = (fleetId: string, role: iam.IRole, max: number, docker: boolean, label: string) => {
      const group = new autoscaling.AutoScalingGroup(this, fleetId, {
        vpc: props.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        machineImage: agentImage, instanceType: new ec2.InstanceType(docker ? 'c7g.large' : 'm7g.large'),
        keyPair: agentKeyPair,
        minCapacity: 0, desiredCapacity: 0, maxCapacity: max, role, userData: agentUserData(docker, label),
        requireImdsv2: true, healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: cdk.Duration.minutes(10) }),
        blockDevices: [{ deviceName: '/dev/xvda', volume: autoscaling.BlockDeviceVolume.ebs(80, {
          encrypted: true, volumeType: autoscaling.EbsDeviceVolumeType.GP3, deleteOnTermination: true,
        }) }],
      });
      cdk.Tags.of(group).add('JenkinsAgentClass', label);
      cdk.Tags.of(group).add('Ephemeral', 'true');
      return group;
    };
    const generalFleet = makeAgentFleet('GeneralAgentFleet', prValidationRole, config.jenkinsGeneralAgentMax, false, 'linux');
    const prContainerFleet = makeAgentFleet('PrContainerAgentFleet', prValidationRole, config.jenkinsPrContainerAgentMax, true, 'pr-container');
    const privilegedFleet = makeAgentFleet('PrivilegedAgentFleet', trustedAgentRole, config.jenkinsPrivilegedAgentMax, true, 'trusted-docker');
    const agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSecurityGroup', {
      vpc: props.vpc, allowAllOutbound: true, description: 'Ephemeral Jenkins agents; controller SSH only',
    });
    agentSecurityGroup.addIngressRule(controllerSecurityGroup, ec2.Port.tcp(22), 'Controller to ephemeral agents');
    generalFleet.addSecurityGroup(agentSecurityGroup);
    prContainerFleet.addSecurityGroup(agentSecurityGroup);
    privilegedFleet.addSecurityGroup(agentSecurityGroup);
    controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:UpdateAutoScalingGroup', 'autoscaling:SetInstanceProtection', 'autoscaling:TerminateInstanceInAutoScalingGroup'],
      resources: [generalFleet.autoScalingGroupArn, prContainerFleet.autoScalingGroupArn, privilegedFleet.autoScalingGroupArn],
    }));
    controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeWarmPool', 'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus', 'ec2:DescribeRegions', 'ec2:DescribeInstanceTypes'], resources: ['*'],
    }));

    const casc = readFileSync(resolve(__dirname, '..', 'jenkins', 'jenkins.yaml'), 'utf8')
      .replaceAll('__AGENT_HOST_PUBLIC_KEY__', config.jenkinsAgentHostPublicKey);
    const plugins = readFileSync(resolve(__dirname, '..', 'jenkins', 'plugins.txt'), 'utf8');
    const controllerUserData = ec2.UserData.forLinux();
    controllerUserData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker amazon-efs-utils',
      'systemctl enable --now docker',
      'install -d -m 750 /mnt/jenkins',
      `mount -t efs -o tls,iam,accesspoint=${accessPoint.accessPointId} ${home.fileSystemId}:/ /mnt/jenkins`,
      "grep -q '/mnt/jenkins' /etc/fstab || echo '${home.fileSystemId}:/ /mnt/jenkins efs _netdev,tls,iam,accesspoint=${accessPoint.accessPointId} 0 0' >> /etc/fstab",
      'install -d -o 1000 -g 1000 -m 750 /mnt/jenkins/casc /mnt/jenkins/plugins',
      `echo '${Buffer.from(casc).toString('base64')}' | base64 -d > /mnt/jenkins/casc/jenkins.yaml`,
      `echo '${Buffer.from(plugins).toString('base64')}' | base64 -d > /mnt/jenkins/plugins.txt`,
      `docker run --rm -v /mnt/jenkins:/var/jenkins_home jenkins/jenkins@${config.jenkinsControllerImageDigest} jenkins-plugin-cli --plugin-file /var/jenkins_home/plugins.txt --plugin-download-directory /var/jenkins_home/plugins`,
      'chown -R 1000:1000 /mnt/jenkins',
      `docker run -d --name jenkins --restart unless-stopped -p 8080:8080 -v /mnt/jenkins:/var/jenkins_home ` +
        `-e CASC_JENKINS_CONFIG=/var/jenkins_home/casc/jenkins.yaml -e AWS_REGION=${config.region} ` +
        `-e JENKINS_URL=https://${config.jenkinsDomainName}/ -e DATADOG_SITE=${jenkinsDatadogSite} ` +
        `-e GITHUB_ORGANIZATION=${config.githubOrganization} -e GITHUB_APP_ID=${config.githubAppId} ` +
        `-e BANKAI_REPOSITORY=${config.bankaiRepository} ` +
        `-e QUINCY_REPOSITORY=${config.quincyRepository} -e GENERAL_AGENT_FLEET=${generalFleet.autoScalingGroupName} ` +
        `-e PR_CONTAINER_AGENT_FLEET=${prContainerFleet.autoScalingGroupName} ` +
        `-e PRIVILEGED_AGENT_FLEET=${privilegedFleet.autoScalingGroupName} -e GENERAL_AGENT_MAX=${config.jenkinsGeneralAgentMax} ` +
        `-e PR_CONTAINER_AGENT_MAX=${config.jenkinsPrContainerAgentMax} ` +
        `-e PRIVILEGED_AGENT_MAX=${config.jenkinsPrivilegedAgentMax} jenkins/jenkins@${config.jenkinsControllerImageDigest}`,
    );
    const controller = new autoscaling.AutoScalingGroup(this, 'Controller', {
      vpc: props.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      machineImage: agentImage, instanceType: new ec2.InstanceType(config.jenkinsControllerInstanceType),
      minCapacity: 1, desiredCapacity: 1, maxCapacity: 1, role: controllerRole, userData: controllerUserData,
      securityGroup: controllerSecurityGroup, requireImdsv2: true,
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({ additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB], gracePeriod: cdk.Duration.minutes(15) }),
      blockDevices: [{ deviceName: '/dev/xvda', volume: autoscaling.BlockDeviceVolume.ebs(30, {
        encrypted: true, volumeType: autoscaling.EbsDeviceVolumeType.GP3,
      }) }],
    });
    controller.node.addDependency(home.mountTargetsAvailable);

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc, allowAllOutbound: false, description: 'Public HTTPS to Jenkins only',
    });
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Jenkins HTTPS and GitHub webhooks');
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTPS redirect');
    controllerSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(8080), 'ALB health and web traffic');
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc, internetFacing: true, securityGroup: loadBalancerSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, dropInvalidHeaderFields: true,
    });
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', config.jenkinsCertificateArn);
    const listener = loadBalancer.addListener('HttpsListener', { port: 443, certificates: [certificate], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS });
    listener.addTargets('ControllerTarget', { port: 8080, targets: [controller],
      healthCheck: { path: '/login', healthyHttpCodes: '200-399', interval: cdk.Duration.seconds(30) } });
    loadBalancer.addRedirect({ sourcePort: 80, sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      targetPort: 443, targetProtocol: elbv2.ApplicationProtocol.HTTPS });
    new route53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone, recordName: config.jenkinsDomainName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
    });

    new cdk.CfnOutput(this, 'Url', { value: `https://${config.jenkinsDomainName}` });
    new cdk.CfnOutput(this, 'GeneralAgentFleetName', { value: generalFleet.autoScalingGroupName });
    new cdk.CfnOutput(this, 'PrContainerAgentFleetName', { value: prContainerFleet.autoScalingGroupName });
    new cdk.CfnOutput(this, 'PrivilegedAgentFleetName', { value: privilegedFleet.autoScalingGroupName });
    new cdk.CfnOutput(this, 'PrValidationRoleArn', { value: prValidationRole.roleArn });
    new cdk.CfnOutput(this, 'EcrPublishingRoleArn', { value: publishingRole.roleArn });
    new cdk.CfnOutput(this, 'NonprodDeploymentRoleArn', { value: nonprodDeploymentRole.roleArn });
    new cdk.CfnOutput(this, 'CloudFormationDeploymentRoleArn', { value: cloudFormationRole.roleArn });
    new cdk.CfnOutput(this, 'BackupVaultName', { value: backupVault.backupVaultName });
  }
}
