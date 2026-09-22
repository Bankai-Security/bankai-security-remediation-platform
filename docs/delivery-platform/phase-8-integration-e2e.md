# Phase 8 — Integration and end-to-end validation

Status: source implementation complete on 2026-09-21. Live validation is
blocked by the placeholder non-production configuration and the absence of a
confirmed synthetic GitHub repository/E2E credential set. No cloud, GitHub,
Supabase, Jenkins, or Datadog resource was mutated during implementation.

## Test layers

`e2e/run.mjs --mode smoke` is the mandatory post-deployment gate. From a
trusted VPC agent it verifies:

- Bankai `/healthz`, Redis `PONG`, and all BullMQ queue health payloads;
- frontend-origin CORS, proving CloudFront-hosted code may call Bankai;
- private Quincy `/health` and rejection of an invalid bearer token;
- the CloudFront boot document and its versioned JavaScript/CSS assets;
- the compiled frontend artifact contains the non-production Bankai API host;
- JUnit/JSON evidence and a successful no-op cleanup record.

`e2e/run.mjs --mode full` reruns smoke and then executes the synthetic workflow:

1. authenticate a dedicated user through Bankai/Supabase;
2. create a uniquely owned project labeled by the E2E run ID;
3. connect only the `bankai-e2e-vulnerable` repository;
4. verify an invalid GitHub webhook signature is rejected;
5. enqueue a repository scan and wait for worker completion;
6. require the seeded `BANKAI-E2E-001` finding;
7. promote it to a ticket and require remediation to be queued;
8. wait for Quincy/CodeBuild to produce a PR and Bankai verification to pass;
9. require the ticket to reach `In Review` or `Done`;
10. query Datadog for the E2E correlation ID and prove the invalid-token
    sentinel was not indexed;
11. delete the Bankai project, registered webhook, and remediation branch.

The real workflow exercises API-to-Redis enqueueing, worker consumption,
Bankai-to-Quincy authentication and response contracts, Quincy CodeBuild
invocation and its S3 request/result path, GitHub PR creation, security
verification, Supabase persistence, and final state reconciliation. Existing
Bankai/Quincy deterministic tests cover Quincy network failure/timeout fallback,
response validation, CodeBuild request/result behavior, sandbox timeout, and
token handling without fault-injecting the shared non-production services.

## Jenkins execution

- `Jenkinsfile.release` runs smoke after every non-production deployment.
- `bankai-nonprod-e2e` runs `Jenkinsfile.e2e`; its default `full` mode is
  scheduled nightly.
- The same job in `full` mode is the mandatory pre-production gate.
- All executions use the single-use `trusted-docker` fleet. PR jobs cannot
  obtain the E2E, GitHub, Datadog, or deployment credentials.
- Any skipped/missing JUnit output, failed check, telemetry gap, or cleanup
  error fails the job.

## Activation checklist

Before enabling the schedule:

1. Complete Phase 7 activation and confirm the agent resolves
   `quincy.nonprod.bankai.local` inside the VPC.
2. Create a private `<githubOrganization>/bankai-e2e-vulnerable` repository.
   Its default branch must contain the vulnerable source corresponding to
   `e2e/fixtures/seeded-vulnerability.csv`, a scanner rule producing
   `BANKAI-E2E-001`, and the real `bankai-verify.yml` commands.
3. Create a dedicated confirmed Supabase E2E user with no production access.
4. Store `bankai-e2e-user`, `bankai-e2e-github-token`, and
   `jenkins-datadog-app-key` as Jenkins-discoverable Secrets Manager
   credentials. Restrict the GitHub token to that single repository and the
   Datadog application key to log search.
5. Ensure the Datadog log pipeline retains `x-bankai-e2e-run-id` correlation
   but redacts authorization, cookies, tokens, and secret-shaped fields.
6. Run `npm run validate:e2e` from `infrastructure/`, then invoke the Jenkins
   job once manually in `full` mode and confirm the project, webhook, branch,
   and any temporary CodeBuild/S3 job objects are gone.

## Recovery

The harness owns only projects named `Bankai E2E <run-id>` and remediation
branches associated with that project. Normal cleanup calls Bankai's owner-only
project deletion endpoint, which also removes its GitHub webhook and remediation
branch. If a Jenkins agent is interrupted, use the run ID in the archived
`reports/e2e/result.json` to locate the E2E project, delete it through Bankai,
close any synthetic PR, and remove only `jobs/` objects correlated to that run.
Never bulk-delete a repository, bucket, or shared non-production database.

## Implementation validation

- E2E static policy and offline smoke harness: 2/2 passed, including explicit
  refusal of production-looking targets.
- Bankai Quincy timeout/unavailability and response-contract tests: 12 passed.
- Bankai API integration tests: 2 passed.
- Jenkins JCasC, Phase 7 release policy, TypeScript compilation, CDK formatting,
  and 14 CDK assertions passed.
- Deterministic synthesis passed for non-production and production.
- The four Redis/Testcontainers component cases could not start locally because
  Docker Desktop's Linux daemon was not running. The suite failed closed and
  reported all four as skipped; it remains a required Jenkins gate on an agent
  with Docker and must pass before live Phase 8 activation.
