# Bankai AWS CDK foundation

This TypeScript CDK application is the sole infrastructure definition for
Bankai and Quincy. It synthesizes one environment stack while deliberately
preserving the original stack and construct paths to avoid accidental resource
replacement during the migration.

## Environment configuration

Defaults live in `config/nonprod.json` and `config/production.json`. Every
field can be overridden with CDK context, for example:

```powershell
npx cdk synth -c stage=nonprod `
  -c account=123456789012 `
  -c backendImageDigest=sha256:<64-hex-characters> `
  -c quincyImageDigest=sha256:<64-hex-characters> `
  -c apiCertificateArn=arn:aws:acm:ap-south-1:123456789012:certificate/<id> `
  -c frontendCertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/<id> `
  -c frontendWebAclArn=arn:aws:wafv2:us-east-1:123456789012:global/webacl/<name>/<id>
```

The committed account IDs, certificate IDs, WAF IDs, and all-zero digests are
synthesis placeholders. They are not deployment values. Jenkins must supply
real environment identifiers and ECR digests from a reviewed release manifest.
The application rejects tags and accepts only `sha256:<64 hex>` image inputs.

Production and non-production configurations cover account, region, network,
domains, certificates, WAF, image digests, desired counts, CPU/memory, NAT
count, Redis sizing/replicas/backups, ECR retention, log retention, and cost
allocation.

## Local validation

```powershell
npm ci
npm run build
npm test -- --runInBand
npm run test:determinism
npx cdk synth -c stage=nonprod --quiet
npx cdk synth -c stage=production --quiet
```

`scripts/validate-templates.mjs` checks synthesized templates for schema shape,
secret-shaped values, mutable images, sensitive outputs, and wildcard IAM
actions. `scripts/replacement-report.mjs` compares protected logical IDs with a
prior synthesis. Trivy scans use `.trivyignore`, which documents only the
intentional public-edge findings: the internet-facing Bankai ALB, its public
ALB/NAT subnets, and outbound security-group access needed for external APIs,
ECR, GitHub, and scanner/package endpoints. Application tasks themselves are
private and receive no public IP addresses.

## Deployment safety

Phase 7 implements deployment only in the trusted `bankai-nonprod-release`
Jenkins job. Do not run `cdk deploy` from a workstation. The job must:

1. validate real configuration and digest inputs;
2. synthesize once and retain the cloud assembly;
3. scan and review the exact templates;
4. create a CloudFormation change set from that assembly;
5. reject unexpected replacement or deletion;
6. execute only the reviewed change set.

Run `npm run validate:release` to test the release policy and manifest/change
set helpers. The job deliberately refuses placeholder configuration, an AWS
account mismatch, a missing existing foundation stack, a non-main checkout,
and any change set containing removal or replacement.

Production synthesis marks the stack for CloudFormation termination
protection. Before the first production deployment, independently confirm
termination protection in the change-management procedure and enable it on any
pre-existing production stack before updating.

The CloudFront OAC construct initially grants its KMS key to distributions in
the same account using a distribution-ID wildcard to avoid a CloudFormation
circular dependency. After the first controlled deployment, scope that key
condition to the created distribution ARN and retain the reviewed change set.

`cdk diff` and `aws cloudformation validate-template` require read-only AWS
credentials. They are mandatory in an AWS-connected review environment but are
not substitutes for reviewing replacements and deletions in the change set.

## Jenkins foundation

Phase 4 adds the non-production Jenkins controller, encrypted EFS/backup model,
ephemeral agent fleets, and cross-account role boundaries. See
`jenkins/README.md` for its credential contract and
`../docs/delivery-platform/phase-4-jenkins-foundation.md` for activation,
backup/restore, risks, and rollback. The committed controller digest and AWS
identifiers are placeholders; synthesis is not authorization to deploy them.
