import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NativeObservabilityProps {
  stage: string;
  cluster: string;
  services: string[];
  apiLogGroup: string;
  workerLogGroup: string;
  loadBalancer: string;
  targetGroup: string;
  distribution: string;
  webAcl: string;
}

/** Additive monitoring: existing alarm identities remain untouched. */
export class NativeObservability extends Construct {
  constructor(scope: Construct, id: string, p: NativeObservabilityProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const email = new cdk.CfnParameter(stack, 'OperationsEmail', {
      type: 'String', default: '', allowedPattern: '^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      description: 'Alarm and budget recipient; requires SNS email confirmation.',
    });
    const amount = new cdk.CfnParameter(stack, 'MonthlyBudgetUsd', {
      type: 'Number', default: 0, minValue: 0,
      description: 'Monthly account COST budget in USD; zero leaves budget unconfigured.',
    });
    const hasEmail = new cdk.CfnCondition(stack, 'OperationsEmailConfigured', {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(email.valueAsString, '')),
    });
    const alertKey = new kms.Key(this, 'AlertKey', { enableKeyRotation: true, removalPolicy: cdk.RemovalPolicy.RETAIN });
    alertKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'cloudwatch', resource: 'alarm', resourceName: `bankai-${p.stage}-*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME }) } },
    }));
    const topic = new sns.Topic(this, 'Alerts', { topicName: `bankai-${p.stage}-operations`, masterKey: alertKey });
    topic.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const subscription = new sns.CfnSubscription(this, 'Email', {
      topicArn: topic.topicArn, protocol: 'email', endpoint: email.valueAsString,
    });
    subscription.cfnOptions.condition = hasEmail;
    const budget = new budgets.CfnBudget(this, 'AccountBudget', {
      budget: { budgetName: `bankai-${p.stage}-account-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: amount.valueAsNumber, unit: 'USD' } },
      notificationsWithSubscribers: ['ACTUAL', 'FORECASTED'].map(notificationType => ({
        notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold: notificationType === 'ACTUAL' ? 80 : 100, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: email.valueAsString }],
      })),
    });
    budget.cfnOptions.condition = new cdk.CfnCondition(stack, 'BudgetConfigured', {
      expression: cdk.Fn.conditionAnd(hasEmail, cdk.Fn.conditionNot(cdk.Fn.conditionEquals(amount.valueAsNumber, 0))),
    });
    const namespace = `Bankai/${p.stage}`;
    const metric = (ns: string, name: string, dimensionsMap: Record<string, string> = {}, statistic = 'Maximum', period = 60) =>
      new cw.Metric({ namespace: ns, metricName: name, dimensionsMap, statistic, period: cdk.Duration.seconds(period) });
    const widgets: cw.IWidget[] = [];
    const graph = (title: string, ...metrics: cw.IMetric[]) => widgets.push(new cw.GraphWidget({ title, left: metrics, width: 12 }));
    const alarm = (name: string, m: cw.IMetric, threshold: number, missing = cw.TreatMissingData.NOT_BREACHING) => {
      const a = new cw.Alarm(this, name, { alarmName: `bankai-${p.stage}-native-${name}`,
        alarmDescription: `Owner: Bankai Platform. Runbook: docs/runbooks/production-operations.md#${name}. Initial threshold requires nonprod baseline validation.`,
        metric: m, threshold, evaluationPeriods: 3, datapointsToAlarm: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: missing });
      a.addAlarmAction(new actions.SnsAction(topic));
      a.addOkAction(new actions.SnsAction(topic));
    };
    for (const [i, service] of p.services.entries()) {
      const d = { ClusterName: p.cluster, ServiceName: service };
      const desired = metric('ECS/ContainerInsights', 'DesiredTaskCount', d);
      const running = metric('ECS/ContainerInsights', 'RunningTaskCount', d, 'Minimum');
      graph(`ECS ${i}: desired / running / CPU / memory`, desired, running,
        metric('AWS/ECS', 'CPUUtilization', d), metric('AWS/ECS', 'MemoryUtilization', d));
      alarm(`ecs-${i}`, new cw.MathExpression({ expression: 'IF(desired>running,desired-running,0)', usingMetrics: { desired, running }, period: cdk.Duration.minutes(1) }), 1, cw.TreatMissingData.BREACHING);
    }
    const alb = { LoadBalancer: p.loadBalancer };
    const targetErrors = metric('AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', alb, 'Sum');
    const edgeErrors = metric('AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', alb, 'Sum');
    const latency = metric('AWS/ApplicationELB', 'TargetResponseTime', alb, 'p95');
    const unhealthy = metric('AWS/ApplicationELB', 'UnHealthyHostCount', { ...alb, TargetGroup: p.targetGroup });
    graph('ALB errors / latency / health', targetErrors, edgeErrors, latency, unhealthy);
    alarm('target-5xx', targetErrors, 5); alarm('alb-5xx', edgeErrors, 1);
    alarm('latency', latency, 2); alarm('unhealthy-targets', unhealthy, 1, cw.TreatMissingData.BREACHING);
    const filter = (name: string, group: string, pattern: string, value = '1', statistic = 'Sum') => {
      new logs.CfnMetricFilter(this, `${name}Filter`, { logGroupName: group, filterPattern: pattern,
        metricTransformations: [{ metricNamespace: namespace, metricName: name, metricValue: value }] });
      return metric(namespace, name, {}, statistic);
    };
    const requests = filter('ApiRequests', p.apiLogGroup, '{ $.msg = "request completed" }');
    const errors = filter('ApiErrors', p.apiLogGroup, '{ $.res.statusCode >= 500 }');
    graph('API JSON logs', requests, errors); alarm('api-errors', errors, 5);
    const apiTelemetry = new cw.Alarm(this, 'ApiTelemetryMissing', {
      alarmName: `bankai-${p.stage}-native-api-telemetry`,
      metric: metric('AWS/Logs', 'IncomingLogEvents', { LogGroupName: p.apiLogGroup }, 'Sum'),
      threshold: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 10, treatMissingData: cw.TreatMissingData.BREACHING,
    });
    apiTelemetry.addAlarmAction(new actions.SnsAction(topic)); apiTelemetry.addOkAction(new actions.SnsAction(topic));
    // Queue names are an allowlist, never extracted into unbounded dimensions.
    for (const queue of ['repo-scan', 'fix-pr']) {
      const pattern = `{ $.event = "queue.depth" && $.queue = "${queue}" }`;
      const depth = filter(`${queue}-depth`, p.workerLogGroup, pattern, '$.waiting', 'Maximum');
      const age = filter(`${queue}-age`, p.workerLogGroup, `{ $.event = "queue.depth" && $.queue = "${queue}" && $.oldestWaitingAgeMs >= 0 }`, '$.oldestWaitingAgeMs', 'Maximum');
      const heartbeat = filter(`${queue}-heartbeat`, p.workerLogGroup, pattern);
      graph(`Queue ${queue}`, depth, age);
      alarm(`${queue}-depth`, depth, 100); alarm(`${queue}-age`, age, 300000);
      const missing = new cw.Alarm(this, `${queue}Missing`, {
        alarmName: `bankai-${p.stage}-native-${queue}-telemetry`, metric: heartbeat,
        threshold: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 10, treatMissingData: cw.TreatMissingData.BREACHING,
      });
      missing.addAlarmAction(new actions.SnsAction(topic)); missing.addOkAction(new actions.SnsAction(topic));
    }
    for (const event of ['failed', 'stalled']) alarm(`jobs-${event}`, filter(`Jobs-${event}`, p.workerLogGroup, `{ $.event = "queue.job.${event}" }`), 1);
    alarm('redis-connectivity', filter('RedisErrors', p.workerLogGroup, '{ $.event = "queue.depth.error" }'), 1);
    graph('CloudFront (us-east-1)', new cw.Metric({ namespace: 'AWS/CloudFront', metricName: '5xxErrorRate',
      dimensionsMap: { DistributionId: p.distribution, Region: 'Global' }, region: 'us-east-1', statistic: 'Average' }));
    graph('WAF (us-east-1)', new cw.Metric({ namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: p.webAcl, Region: 'Global', Rule: 'ALL' }, region: 'us-east-1', statistic: 'Sum' }));
    new cw.Dashboard(this, 'Dashboard', { dashboardName: `bankai-${p.stage}-operations`, widgets: [widgets] });
    new cdk.CfnOutput(stack, 'OperationsTopicArn', { value: topic.topicArn });
  }
}
