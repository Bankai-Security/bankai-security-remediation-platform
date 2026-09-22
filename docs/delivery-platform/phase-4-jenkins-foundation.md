# Phase 4 — Jenkins foundation

Status: source implementation complete and stopped for review on 2026-09-20.
No AWS infrastructure, Jenkins controller, GitHub App, webhook, or Datadog
configuration was changed outside this repository.

## Implementation

The existing identity-preserving CDK stack now contains a `JenkinsFoundation`
construct. Jenkins is hosted only in the non-production delivery account;
production receives cross-account deployment roles but no duplicate controller.

- The controller runs from a digest-pinned Jenkins LTS image on a one-instance
  private Auto Scaling Group. It has no public address and zero build executors.
- `$JENKINS_HOME` is an encrypted EFS access point retained independently of
  the controller. Root disks are encrypted and IMDSv2 is mandatory.
- HTTPS and GitHub webhooks enter through a dedicated ALB and regional ACM
  certificate. The ALB is the only public Jenkins resource.
- AWS Backup performs continuous/daily EFS backup into a KMS-encrypted vault
  with a 35-day vault lock. Controller replacement does not remove Jenkins home.
- JCasC defines bootstrap administration, matrix authorization, CSRF, plain-text
  markup, AWS Secrets Manager credentials, Datadog CI Visibility, GitHub
  multibranch discovery for Bankai and Quincy, and bounded build history.
- Seventeen plugins are pinned exactly in `infrastructure/jenkins/plugins.txt`.
  The Jenkins controller image is also required by digest.
- Credential values are not committed or placed in CloudFormation parameters.
  Jenkins discovers tagged Secrets Manager credentials through its instance
  role. JCasC constructs the GitHub App credential from `GITHUB_APP_ID` and the
  `jenkins-github-app-private-key` secret. Datadog uses
  `jenkins-datadog-api-key`; controller-to-agent SSH uses
  `jenkins-agent-ssh-key`.

## Agent and trust boundaries

Three private Auto Scaling Groups start at zero capacity and terminate an agent
after one build:

| Class | Jenkins labels | Host capability | AWS authority |
| --- | --- | --- | --- |
| General | `linux pr-validation` | Java/Git only | SSM access only; no publish, deployment, CloudFormation, or role assumption |
| PR container | `pr-container` | Docker daemon on a disposable host | Same credential-free PR role as general agents; no release-role assumption |
| Restricted | `trusted-docker` | Docker daemon | May assume scoped publishing/deployment roles; trusted jobs only |

Both accept SSH only from the controller security group, use encrypted ephemeral
disks, private addresses, IMDSv2, one executor, a ten-minute idle timeout, and a
maximum of one build per instance. The AMI installs a stable Ed25519 SSH host
key from `jenkins-agent-host-private-key`; JCasC verifies its configured public
key exactly. No first-use or non-verifying host-key strategy remains.

Separate short-lived roles exist for PR validation, ECR publishing,
non-production deployment, production deployment, and stage-specific
CloudFormation deployment. Only the trusted agent role can assume release
roles. Production roles trust the configured non-production trusted-agent ARN.
PR agents cannot assume any release role.

The Phase 5 Jenkinsfile runs only on the disposable `pr-container` fleet. Phase
6 must additionally enforce `changeRequest()` and trusted-branch conditions.
An untrusted pull request must never select `trusted-docker`, interpolate a
deployment credential, or invoke CDK deployment.

## GitHub and Datadog activation

Before deployment, create a least-privilege GitHub App with repository metadata
and contents read access, pull-request read access, commit-status/checks write
access, and webhook events for pull requests and pushes. Install it only on the
Bankai and Quincy repositories and store the credential as
`jenkins-github-app`.

Configure its webhook URL as
`https://jenkins.bankaisecurity.com/github-webhook/`. GitHub Branch Source will
discover both multibranch jobs and report build status. No PAT or long-lived AWS
access key is part of the design.

Store the Datadog API key as `jenkins-datadog-api-key`. JCasC enables agentless
CI Visibility and build-log forwarding for the configured Datadog site. A live
test must confirm the pipeline appears under the `bankai-jenkins` CI instance.

## Backup and restore procedure

Target: restore Jenkins configuration and history without restoring a controller
root disk. Validate this procedure in non-production before Phase 10.

1. Stop controller replacement/traffic and record the EFS filesystem, access
   point, backup recovery point, JCasC commit, plugin lock, and image digest.
2. Restore the selected AWS Backup recovery point into a new encrypted EFS
   filesystem in isolated subnets. Never overwrite the original filesystem.
3. Validate UID/GID 1000 ownership and job/config counts from an SSM-managed
   maintenance instance without exposing EFS publicly.
4. Review a CloudFormation change set pointing the Jenkins access point at the
   restored filesystem and reject unrelated replacements.
5. Start one controller with the exact prior image, plugin, and JCasC versions.
   Keep it out of ALB service until `/login`, JCasC, plugins, credential lookup,
   and job discovery are healthy.
6. Re-enable traffic, run harmless Bankai and Quincy validations, and confirm
   GitHub status plus Datadog telemetry.
7. Retain the old filesystem and recovery point through the acceptance window.
   Roll back by reverting the filesystem/access-point change set.

RPO is the latest continuous-backup recovery point. RTO remains unasserted until
the procedure is timed in AWS.

## Validation results

- `npm run build`: passed.
- `npm test -- --runInBand`: 14/14 CDK assertions passed.
- `npm run validate:jenkins`: passed; 17 exact plugin pins, two multibranch
  definitions, isolated fleet labels, and no plaintext secret patterns.
- Non-production synthesis: passed.
- Production synthesis: passed; it contains production deployment roles and no
  Jenkins controller/agent resources.
- `npm run test:determinism`: passed; non-production template SHA-256 is
  `188b420e9a5d98b08c440da31c0f11373dd4e2f4027a7e4ab41ebe302c1b64fc`
  and production is
  `a2fddf7cbb5297db76a88b369ab3862de0a5e2e982748c4644879421e1ed2764`.
- `validate-templates.mjs`: passed both final assemblies with no mutable image,
  secret-shaped value, sensitive output, or wildcard IAM action.
- Digest-pinned Trivy 0.74.0 configuration scan: zero unignored High/Critical
  findings in both final templates.
- Phase 3 protected-resource comparison: no removal or logical-ID replacement.
  Non-production adds only Jenkins EFS, ALB, and DNS among protected types;
  production adds no protected persistent or edge resource.
- `git diff --check`: passed; Git only emitted Windows LF/CRLF notices.

No live webhook, GitHub status, job discovery, agent SSH, Datadog intake, backup,
or restore was attempted because nothing was deployed and external credentials
were unavailable.

## Required inputs and unresolved risks

- Replace the zero image digest with the reviewed digest of
  `jenkins/jenkins:2.541.3-lts-jdk21`.
- Supply real accounts, certificate, DNS zone, GitHub App ID, EC2 agent key
  pair, matching Jenkins SSH credential, and matching agent host-key secret.
- Confirm GitHub organization/repository names and default branches. Quincy was
  previously observed locally on `master` while the target brief says `main`.
- Rotate and audit the bootstrap administrator until an approved identity
  provider replaces the local security realm.
- Rotate the stable agent host key through a reviewed configuration and secret
  update; a mismatched public/private key intentionally prevents agents joining.
- The controller needs outbound HTTPS for pinned plugins, GitHub, Datadog, and
  AWS APIs. Add VPC endpoints/egress controls after endpoint inventory review.
- AWS describe APIs require `Resource: *`; mutating Auto Scaling permissions are
  scoped to the three agent fleets.
- Phase 6 added Python 3.12 and its pip package to agent bootstrap so Quincy’s
  declared runtime and Linux lock can be used without mutating the base AMI.

## Rollback

Because Phase 4 made no external changes, revert only the Phase 4 construct,
configuration fields, JCasC/plugin files, tests, and this document. Re-run the
Phase 3 build, assertions, deterministic synth, and protected logical-ID report.
Do not execute a CloudFormation change set without separate authorization.

After a future deployment, retain EFS, the backup vault, and recovery points;
route the ALB away from a failed controller and restore the previous image,
JCasC, and plugin set. Never delete persistent Jenkins data during rollback.

## Review gate

Source implementation, including the Phase 5 prerequisite gaps, is complete.
Runtime exit criteria remain pending
deployment and integration verification:

- a GitHub PR triggers Jenkins and receives status/checks;
- Bankai and Quincy multibranch jobs are discovered;
- all three agent classes connect, run once, and terminate;
- Datadog receives CI telemetry;
- a PR build proves production credentials are inaccessible.

Do not deploy this foundation until the inputs, security model, and restore
procedure are reviewed. Phase 5 source validation may proceed without a live
Jenkins or Datadog installation; live webhook/status/telemetry checks cannot.
