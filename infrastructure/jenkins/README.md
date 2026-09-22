# Jenkins configuration contract

`jenkins.yaml` is the authoritative controller configuration and `plugins.txt`
is the reviewed plugin lock. Secrets are resolved at runtime from AWS Secrets
Manager; never substitute them into these files or CloudFormation parameters.

Required tagged secrets:

- `jenkins-github-app-private-key`: untagged PKCS#8 GitHub App private key;
  JCasC uses it to create the `jenkins-github-app` vendor credential.
- `jenkins-datadog-api-key`: secret text consumed by the Datadog plugin.
- `jenkins-agent-ssh-key`: SSH private-key credential for an EC2 key pair
  installed on both agent launch templates.
- `jenkins-agent-host-private-key`: untagged Ed25519 SSH host private key whose
  public half is the configured `jenkinsAgentHostPublicKey`. Agents install it
  before `sshd` starts; Jenkins uses exact-key verification. Rotate both halves
  together and never use the non-verifying strategy.
- `bankai-e2e-user`: a Secrets Manager username/password credential for a
  dedicated non-production Supabase user. It must never be a human account.
- `bankai-e2e-github-token`: a narrowly scoped token for only the dedicated
  `bankai-e2e-vulnerable` repository.
- `jenkins-datadog-app-key`: a Datadog application key restricted to log
  search; paired with `jenkins-datadog-api-key` only in the trusted E2E job.

The controller has zero executors. Normal PR work uses the `linux` fleet with
only the PR validation instance role. The `trusted-docker` fleet is reserved
for the main-only non-production release job and may assume short-lived
publishing, verification, CloudFormation, and CDK bootstrap roles. The job is
triggered only after `bankai/main` succeeds; both repositories' gates are rerun
from exact SHAs. PR Jenkinsfiles must never select this label.

The committed zero controller-image digest is synthesis-only. Replace it with
the reviewed digest of `jenkins/jenkins:2.541.3-lts-jdk21` before deployment.

See `../../docs/delivery-platform/phase-7-nonprod-deployment.md` for activation
prerequisites, the release sequence, recovery, and the values that must replace
the committed placeholders before the first live run.

`bankai-nonprod-e2e` runs the full synthetic remediation nightly and is also
the pre-production gate. The release pipeline runs the smoke subset immediately
after every non-production deployment. See
`../../docs/delivery-platform/phase-8-integration-e2e.md`.
