# Delivery Platform Phase 0 — Discovery and Architecture Record

Status: **Draft for review — no implementation authorized**
Date: 2026-09-19
Repositories reviewed:

- Bankai: `bankai-security-remediation-platform` at `c5460ae` on `main`
- Quincy: `quincy-security-engine` at `4c09c8e` on `master`

This record covers discovery only. It does not authorize a Terraform apply,
deployment, production change, CDK removal, or creation of cloud resources.

## 1. Executive summary

Bankai already has the main runtime seams needed by the target platform: a
React/Vite static frontend, an Express API, a separate BullMQ worker command,
four Redis-backed queues, a health endpoint, a multi-stage non-root backend
image, Supabase-backed persistence/authentication, and a Quincy client. Quincy
is a FastAPI service with a broad unit/integration suite, a non-root image, a
public health endpoint, persistent local state, Docker sandboxing, and existing
CodeBuild/S3 adapters.

The current delivery platform is not production-complete. GitHub Actions runs
partial CI, Bankai has no frontend tests, neither repository has Jenkins or
Terraform, deployment is a placeholder, reports are not exported in a
Jenkins-readable form, and there is no Datadog configuration. The CDK stack is
an architectural prototype and currently owns or models the AWS resources
listed in section 7. It must remain frozen but available as a rollback/reference
path until Terraform ownership is proven.

The highest-risk migration areas are:

1. Establishing actual AWS inventory before deciding imports or recreation.
2. Avoiding dual ownership between CDK and Terraform.
3. Replacing the CDK Redis Fargate task with ElastiCache without losing queued
   work or changing BullMQ behavior.
4. Preserving Quincy's EFS/SQLite state, or deliberately migrating it to a
   supported durable database, before replacing compute.
5. Removing public IPs from application tasks while preserving required egress.
6. Promoting exact image digests and frontend artifacts instead of rebuilding.
7. Reconciling the older AWS migration draft with the requested platform: that
   draft proposes CDK, GitHub Actions, Cognito, and Aurora; this program requires
   Terraform and Jenkins and does not yet authorize replacing Supabase.

## 2. Repository and working-tree state

No `AGENTS.md` file exists in either repository. Bankai contains one local
Claude launch configuration; Quincy contains no local agent instructions.

Both working trees were clean at discovery time. Git required a per-command
`safe.directory` override because the read-only sandbox user is not the Windows
repository owner; no global Git configuration was changed.

| Repository | Default-looking local branch | Current CI | Locking | Infrastructure |
| --- | --- | --- | --- | --- |
| Bankai | `main` | `.github/workflows/deploy.yml` | npm lockfiles for backend, frontend, infrastructure | AWS CDK TypeScript stack |
| Quincy | `master` (workflow watches pushes to `main`) | `.github/workflows/ci.yml` | no Python lockfile; lower bounds in `pyproject.toml` | no IaC |

The Quincy branch/workflow mismatch is a release risk: pushes to the checked-out
`master` branch do not match the workflow's `push.branches: [main]` trigger.

## 3. Application inventory

### 3.1 Bankai

| Area | Current implementation | Delivery implication |
| --- | --- | --- |
| Frontend | React 19, Vite 8, TypeScript; `frontend/`; build emits static `dist/` | Build once, archive by content identifier, publish to versioned private S3, serve through CloudFront |
| API | Node 22, Express 5, TypeScript; `backend/src/server.ts`; `/healthz` checks Redis | Run as an ECS/Fargate service behind an ALB |
| Worker | `backend/src/worker.ts`; same compiled package/image, different command | Run as a separate ECS/Fargate service using `node dist/worker.js` |
| Queues | BullMQ queues for repository scan, fix PR, pipeline, and fix retry | ElastiCache reachability, retry/idempotency, draining, depth/age telemetry, and failover tests are required |
| Persistence/auth | Supabase database, RLS migrations, authentication, service-role access | Remains an external dependency unless a separate data/identity migration is explicitly approved |
| Integrations | GitHub, Jira, Arcjet, OpenRouter/Gemini, Quincy | Stub in tests; store runtime secrets in Secrets Manager |
| Customer CI feature | Bankai generates/dispatches customer-repository `.github/workflows/bankai-verify.yml` | Must remain separate from Bankai's own Jenkins pipeline |
| Database schema | 32 ordered Supabase migrations plus SQL hierarchy assertions | Not Terraform-owned application data; migration execution policy must be defined before deployment automation |

Bankai's root `docker-compose.yml` starts API, Redis, and nginx frontend, but not
the separate worker or Quincy. It is a local convenience topology, not a
production reference.

### 3.2 Quincy

| Area | Current implementation | Delivery implication |
| --- | --- | --- |
| Service | Python 3.12, FastAPI/Uvicorn; public `/health`; optional bearer auth | Run as an internal ECS/Fargate service; keep health unauthenticated |
| Job execution | In-process queue by default; `JOB_EXECUTION_BACKEND=codebuild` adapter exists | Production API should dispatch bounded isolated jobs to CodeBuild |
| Sandbox | Docker by default; CodeBuild sandbox adapter also exists | Docker-backed CI needs a restricted privileged agent; production isolation needs least-privilege CodeBuild/S3 |
| State | SQLite/Postgres job repository option; multiple persistent cache/index/KB paths under `/app/data` | EFS is currently modeled; durability and concurrency semantics must be reviewed before confirming EFS |
| Scanners | Semgrep, Bandit, Gitleaks, Trivy, OSV, npm audit, pip audit; optional CodeQL | Pin scanner images/digests and make network/cache behavior deterministic in CI |
| Observability | Structured logging option and Prometheus metrics; local Prometheus/Grafana compose | Adapt logs/traces/metrics to Datadog; local stack is not the target production owner |

Quincy's container installs Docker CLI/daemon packages, Git, curl, all service
dependencies, scanner dependencies, and PostgreSQL support in a single runtime
stage. It runs as non-root by default, but local compose overrides it to root and
mounts the Docker socket. This is a material hardening item for Phase 2.

## 4. Configuration inventory

Only names and classifications are recorded; no secret values were read or
copied.

### Bankai runtime configuration

- Secrets: `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ARCJET_KEY`,
  `TOKEN_ENC_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
  `GITHUB_OAUTH_CLIENT_SECRET`, `QUINCY_API_TOKEN`.
- Sensitive/identity-adjacent configuration: `SUPABASE_URL`,
  `GITHUB_OAUTH_CLIENT_ID`, `QUINCY_API_URL`, `BACKEND_PUBLIC_URL`.
- Ordinary configuration: environment labels, ports, origins/cookie policy,
  provider/model selection, timeouts, scan/context limits, fallback policy, and
  `REDIS_URL`.
- Frontend build configuration: `VITE_API_BASE_URL`. Any `VITE_*` value is
  public by design and must never contain a secret.

`TOKEN_ENC_KEY` is a critical continuity secret: losing or changing it without
a data re-encryption procedure can make stored integration credentials
unreadable.

### Quincy runtime configuration

- Model/API secrets: Anthropic, OpenAI, OpenRouter, and Gemini keys.
- Service secrets: `SERVICE_API_TOKEN`, `CALLBACK_AUTH_TOKEN`, and
  `ATTESTATION_SIGNING_KEY_HEX`.
- Database-sensitive configuration: `POSTGRES_DSN`.
- Generated AWS configuration: CodeBuild project, S3 request bucket, region,
  execution backend, and polling/timeout settings.
- Ordinary configuration: models/router candidates, retry/cost policies,
  sandbox limits, scanner configuration, persistent paths, logging, and test
  command.

The checked-in `.env.example` omits the CodeBuild variables that exist in
`Settings`; Phase 1 or 2 documentation should make the full production schema
explicit. `LOG_FORMAT` appears twice in Quincy's example file.

## 5. Existing delivery and container behavior

### GitHub Actions

- Bankai's workflow runs frontend build and backend install, typecheck, tests,
  and build. It does not run either lint command, frontend tests (none exist),
  CDK tests, container builds, security scans, SBOM generation, Terraform, or
  deployment. Its deployment section is commented out.
- Quincy's workflow installs an unlocked editable environment, runs Ruff,
  mypy, and all pytest tests. It relies on the hosted runner's Docker and native
  Semgrep. It does not build/health-test/scan the service image or publish test
  reports/SBOMs.
- Neither workflow defines concurrency controls, artifact retention, explicit
  least-privilege permissions, immutable action SHAs, or Jenkins status/report
  integration.

GitHub Actions should remain active during the migration as a safety net. It
must not be disabled until Jenkins is approved as the required CI/CD authority.

### Containers

- Bankai backend: multi-stage Node Alpine build; production-only dependencies;
  non-root `bankai` user; API is the default command. The same image can run the
  worker with a command override. No Dockerfile `HEALTHCHECK` is present, though
  ECS checks `/healthz` in CDK.
- Bankai frontend: deterministic lockfile install and Vite build, served from
  nginx as root/default nginx user. AWS target is static S3/CloudFront, so this
  image is not the intended production frontend runtime.
- Quincy: non-root `quincy` user and `/health` health check; single-stage image
  contains compilers/tools/scanners and Docker packages. Base images are tags,
  not pinned digests.
- Local images and scanner defaults use mutable `latest` tags. These are not
  acceptable deployment identifiers and must be separated from immutable
  release image references.

## 6. Railway and hardcoded non-production assumptions

| Location | Assumption | Required disposition |
| --- | --- | --- |
| `deploy/nginx.conf` | Railway IPv6 DNS resolver `[fd12::10]` and `backend.railway.internal:4000` | Do not reuse on AWS; S3/CloudFront frontend should use a configured API origin/path |
| root `.env.example` | Empty production API base assumes nginx proxies relative `/api` | Define the CloudFront/ALB routing contract before frontend build promotion |
| CDK stack | Frontend `nonprod.bankaisecurity.com`, API `api-nonprod.bankaisecurity.com`, cookie `.bankaisecurity.com` are hardcoded for all stages | Make environment inputs; production must never inherit non-production hostnames |
| CDK stack | VPC CIDRs `10.20.0.0/16` and `10.30.0.0/16`, region default `ap-south-1` | Confirm against organization/network inventory |
| CDK stack | All ECS services receive public IPs because there are no NAT gateways | Replace with reviewed private-subnet/egress design; avoid accidental outage/cost surprise |
| CDK stack | Redis is an unpinned `redis:7-alpine` Fargate task with no durable volume | Replace with ElastiCache and explicitly drain/migrate queued work |
| CDK stack | Quincy and Bankai desired count is one; one-week log retention | Parameterize by environment and reliability/retention requirements |
| Quincy | Sandbox/scanner images default to mutable `latest` tags | Pin release/runtime digests and maintain a controlled update process |
| Quincy local compose | Service runs as root with host Docker socket | Local/integration-only; never carry this trust boundary into the API task |
| GitHub workflow | Quincy push trigger watches `main`, local branch is `master` | Decide canonical branch before Jenkins multibranch setup |

## 7. CDK-to-Terraform migration matrix

“Import” below is a provisional preference, not evidence that the resource
exists. AWS account inventory and `cdk list/synth` plus CloudFormation stack
resource enumeration are required before final decisions.

| Current resource | Current owner | Target Terraform module | Provisional action | Replacement risk | Rollback approach |
| --- | --- | --- | --- | --- | --- |
| CloudFormation/CDK stack and bootstrap assets | CDK/CloudFormation | `state-migration` documentation only | Retain/freeze, then retire after ownership acceptance | High if deleted early | Preserve stack/template and CDK commit; do not deploy both owners |
| VPC, IGW, route tables, 2 public + 2 isolated subnets, default-SG restriction | CDK | `networking` | Import if deployed and CIDRs fit target | High: replacement disconnects every service | Keep CDK stack frozen; import/test one address at a time; saved plan must show no replacement |
| ECS cluster with Container Insights/Fargate providers | CDK | `ecs-cluster` | Import | Medium: service recreation/telemetry gap | Retain old cluster/services until target services stabilize |
| Bankai and Quincy ECR repositories | CDK | `ecr` | Import | High: image/digest loss and broken rollback | Retain repositories/images; export digest inventory; deletion protection/lifecycle review |
| Private versioned frontend S3 bucket | CDK | `frontend` | Import | High: artifact/history loss | Retain bucket and versions; inventory objects; preserve previous release prefix |
| CloudFront distribution + OAC/bucket policy | CDK | `frontend` | Import if hostname/cert is valid; otherwise parallel replacement | High: cache/DNS/frontend outage | Preserve old distribution and DNS target until smoke tests pass |
| Imported frontend ACM certificate | External/manual or separate stack | `dns-certificates` data/reference | Reference, or import only if ownership is explicitly transferred | High: TLS outage | Do not replace certificate during app migration |
| Backend and Quincy Secrets Manager secrets | External resources referenced by CDK | `secrets` references | Reference existing secrets; do not import secret values into state | Critical: credential loss/exposure | Record ARNs/versions only; retain previous secret versions and access policy |
| App, Redis, Quincy, and EFS security groups/rules | CDK | `security-groups` | Import with parent services, then tighten | Medium: traffic interruption or excess access | Capture current rules; staged rule changes with connectivity tests |
| Cloud Map private namespace and `redis`/`quincy` services | CDK/ECS | `service-discovery` | Import Quincy namespace/service if retained; retire Redis record after cutover | Medium: internal DNS failure | Maintain old records until consumers use verified target endpoints |
| Redis task definition/service/log group | CDK | `elasticache` (replacement), `logging` | Recreate as ElastiCache; do not import as target | Critical: lost/double-processed BullMQ jobs | Stop producers, drain/record queues, validate idempotency, preserve old service for bounded rollback |
| Quincy job S3 bucket + lifecycle/policy | CDK | `quincy-codebuild` | Import | High: in-flight job loss | Pause dispatch, drain jobs, retain bucket, validate prefix-scoped access |
| Quincy CodeBuild project/role/policies/logs | CDK | `quincy-codebuild` | Import where practical | High: remediation outage or privilege regression | Retain project definition/image digest; can route API back to prior project |
| Quincy EFS, mount targets, access point, policy | CDK | `quincy-storage` | Import pending storage decision | Critical: loss/corruption of SQLite, caches, indexes, KB | Snapshot/backup and quiesce writers; retain filesystem; test restore |
| Quincy task/execution roles, task definition, service/log group | CDK | `quincy-service` | Import stable resources or create parallel service; task revisions become Terraform-owned | High: API/state/job interruption | Keep prior task definition and service deployment metadata |
| Bankai API ALB, listeners, target group, service, roles, task definition, log group | CDK | `bankai-api` | Import stable ALB/service where feasible | Critical: API outage/webhook and OAuth callback failure | Retain prior task definition/digest; ECS deployment circuit breaker; DNS rollback |
| Imported API ACM certificate | External/manual or separate stack | `dns-certificates` data/reference | Reference unless explicit ownership transfer | High: TLS outage | Keep certificate and listener unchanged during compute cutover |
| Bankai worker service, roles, task definition, log group | CDK | `bankai-worker` | Import service or create parallel at zero desired count | Critical: duplicate or lost jobs/PRs | Drain queues, stop one consumer set before starting another, retain prior task revision |
| Six CloudWatch alarms | CDK | `logging-alarms` and `observability` | Import or recreate after Datadog mapping; avoid duplicate paging | Medium: monitoring gap/noise | Keep old alarms active until new monitors are proven, then retire deliberately |
| Stack outputs | CDK | root/module outputs | Recreate as Terraform outputs consumed by Jenkins | Low, but pipeline coupling | Version output contract and keep prior manifest available |
| Tags (`Application`, `Environment`, `ManagedBy`) | CDK | provider/default tags | Recreate with `ManagedBy=Terraform` only after ownership transfer | Low; cost/allocation drift | Audit tags before/after import |

### Persistent/import candidates

Highest priority for inventory and likely import: ECR repositories, frontend S3
bucket, Quincy job bucket, EFS/files/access point, Secrets Manager references,
CloudFront distribution/OAC, certificates, VPC/subnets, and any stable ALB/DNS
resources. ECS task definition revisions and short-lived compute can normally be
recreated, but services must be migrated without duplicate workers. Redis is
explicitly a service replacement, not a state-preserving Terraform import.

## 8. Test inventory and gaps

### Bankai current coverage

- 15 backend test files, with 124 total test/describe blocks across backend and
  infrastructure searches.
- Existing backend tests cover collateral remediation, dependency and Gemini
  fix behavior, invitations, Jira, log parsing, OpenRouter, pipeline verdicts,
  Quincy response/workflow handling, repository context, security regression,
  ticket status/ticketing, team loading, and role resolution.
- One CDK assertion suite covers the basic VPC, immutable ECR, private frontend
  bucket, CodeBuild privilege, Quincy isolation/IAM/EFS policy, cluster insights,
  and six alarms.
- One SQL assertion file exercises organization/team hierarchy behavior.
- Frontend has no test runner, DOM/component testing dependency, test script,
  or test files.

Bankai gaps relative to Phase 1: systematic schema/request validation;
controller authorization decisions and denial cases; finding normalization and
deduplication; SLA boundary calculations; queue job IDs, retries, concurrency,
stall/failure behavior with real isolated Redis; encryption round trips and
failure modes; API component tests with controlled Supabase/GitHub/Jira/Quincy
boundaries; webhook signatures/replay/idempotency; container startup/health;
frontend forms, validation, state variants, redirects, roles, status rendering,
API errors, and accessibility. Infrastructure tests do not cover the intended
Terraform security properties because Terraform does not exist yet.

### Quincy current coverage

- 74 unit test files (including package `__init__.py`) and 7 integration files
  (including package `__init__.py`); 685 discovered `test_*` functions by static
  search.
- Covered areas include API/app factory/auth, schemas, scanners and correlation,
  caching, remediation loop/policy/safety, validation/red-team/net-negative,
  job worker/state, model adapters/router, CodeBuild runner, persistence,
  callback/GitHub integrations, indexing/comprehension, redaction, attestations,
  and metrics.
- Integration tests exercise seeded vulnerable TypeScript, Python, Go, and Java
  applications, sandbox isolation, and an explicitly live KB ingestion path.

Quincy gaps/risks relative to the target: a clearly separated offline unit suite
versus Docker/live-network markers; deterministic locked dependencies; JUnit and
coverage report commands; complete CodeBuild request/result cleanup and timeout
component coverage across both job and sandbox adapters; container startup as
the packaged image; service-token rejection/health exemption as a named gate;
concurrent cache/state behavior; ECS/EFS/Postgres failure behavior; and pinned
scanner/runtime images. The live KB ingestion test must never run as an
unreviewed PR network dependency.

### Proposed repeatable suite contract for Phase 1

These commands are proposed, not yet implemented or certified:

| Suite | Intended command/interface |
| --- | --- |
| Bankai backend unit | `npm test -- --reporter=junit --outputFile=...` after reporter compatibility is confirmed |
| Bankai backend component | Separate Vitest project/script with controlled stubs and Testcontainers Redis |
| Bankai frontend unit/component | Vitest + Testing Library + jsdom, JUnit output |
| Bankai infrastructure | Terraform fmt/validate/test plus policy/security scanner reports |
| Quincy unit | `pytest tests/unit` with JUnit XML and coverage XML |
| Quincy component | Dedicated marker/path with mocked model/AWS boundaries |
| Quincy Docker integration | `pytest -m integration` only on restricted Docker agents, excluding explicitly live network tests unless scheduled |
| Container health | Build by commit SHA, start with ephemeral config, poll health, capture logs, remove container |

## 9. Proposed target architecture

```text
GitHub (Bankai + Quincy)
  -> Jenkins multibranch PR validation
     -> unit/component/integration/container/IaC/security gates
  -> main build (once)
     -> ECR images addressed by digest
     -> immutable frontend artifact + release manifest
     -> automatic non-production deployment
        -> Terraform saved plan/apply
        -> ECS/Fargate: Bankai API, Bankai worker, Quincy API
        -> CodeBuild: isolated Quincy remediation executions
        -> ElastiCache: BullMQ Redis
        -> S3 + CloudFront: frontend
        -> post-deployment integration/E2E
     -> manual production approval
        -> promote the same digests and frontend artifact
        -> exact reviewed saved Terraform plan
        -> smoke tests or rollback to previous manifest

Runtime configuration/secrets -> AWS Secrets Manager and generated Terraform outputs
AWS/Jenkins/application telemetry -> Datadog with environment/service/version/deployment tags
Supabase/GitHub/Jira/model providers -> external managed dependencies unless separately migrated
```

Recommended environment boundary: separate production and non-production AWS
accounts, separate Terraform root/state/credentials, separate secrets/data/
queues/services, and distinct Datadog `env` tags. Shared, Jenkins, and
observability infrastructure should also have independent state roots so an
application deployment cannot accidentally replace foundational resources.

Jenkins is the only deployment orchestrator. Terraform owns infrastructure;
Jenkins supplies reviewed artifact inputs and applies saved plans. Datadog
observes and alerts but does not deploy. Customer `bankai-verify.yml` workflows
remain a Bankai product feature and are not replaced by Jenkins.

## 10. Decisions and information required before implementation

1. Confirm whether Supabase database/authentication remain external. The older
   draft proposes Aurora/Cognito migration, which is materially outside the
   current delivery-platform scope and needs its own approved program.
2. Provide read-only AWS inventory or exported CloudFormation/CDK stack
   resources for non-production. Without it, import/recreate choices remain
   provisional.
3. Confirm AWS account layout, account IDs/role names, primary region, DNS
   provider/hosted-zone ownership, and ACM certificate ownership. `ap-south-1`
   is only the current code default.
4. Decide the canonical Quincy default branch (`main` or `master`).
5. Confirm Jenkins hosting model, availability/backup targets, and whether its
   controller already exists.
6. Confirm whether Quincy's EFS-backed SQLite/cache/KB state is authoritative,
   rebuildable, or should move to PostgreSQL/object storage.
7. Define BullMQ queue drain and acceptable remediation interruption window for
   the Redis-to-ElastiCache cutover.
8. Confirm domain/API routing: one CloudFront distribution with `/api/*` to ALB
   versus separate frontend/API domains. This affects CORS, cookies, OAuth, and
   webhooks.
9. Define production availability, RPO/RTO, audit/log retention, and AWS/Datadog
   cost ceilings.
10. Confirm Datadog organization/region, desired sites, log retention, alert
    destinations, and SLO ownership. Do not supply credentials in source or chat.
11. Identify whether any current production/non-production resources were
    created outside the CDK stack and who owns them.
12. Approve the migration rule: no CDK update after freeze, and no Terraform
    resource declaration until its import/recreate disposition and rollback are
    reviewed.

## 11. Pull-request-sized implementation plan

Each item ends with its own review gate; no later phase starts automatically.

1. **Phase 1A — Test harnesses and reporting:** add deterministic scripts,
   frontend test tooling, JUnit/coverage outputs, and offline/unit markers.
2. **Phase 1B — Bankai high-value unit tests:** validation, authz, findings/SLA,
   ticket/pipeline/retry rules, Quincy parsing, queue/encryption security.
3. **Phase 1C — Component tests:** Bankai controlled boundaries + real isolated
   Redis; Quincy mocked model/AWS; packaged container health.
4. **Phase 2A — Bankai image/static artifact hardening:** shared API/worker image,
   health, non-root/runtime dependencies, deterministic frontend artifact.
5. **Phase 2B — Quincy image/scanner hardening:** split runtime/build concerns,
   pin images, verify non-root/health, SBOM/vulnerability/secret gates.
6. **Phase 3A — Terraform bootstrap and state design:** pinned versions,
   encrypted remote-state/locking design, provider/default tags, roots for
   shared/nonprod/prod/Jenkins/observability; validate only, no apply.
7. **Phase 3B — Network/registry/frontend modules:** tests and a non-production
   plan informed by the approved import matrix.
8. **Phase 3C — compute/data modules:** ECS services, ElastiCache, Quincy
   CodeBuild/EFS decision, IAM/secrets/logging; tests and reviewed plan only.
9. **Phase 3D — Datadog IaC:** AWS integration, dashboards, monitors, SLOs,
   budgets and runbook links; plan only.
10. **Phase 4 — Controlled non-production ownership migration:** inventory,
    backups, imports, saved plan review, explicit apply authorization, validation,
    stable follow-up plan, rollback; CDK retained.
11. **Phase 5 — Jenkins foundation:** configuration as code, pinned plugins,
    GitHub multibranch/webhooks, isolated agents/roles, backups, CI Visibility.
12. **Phase 6 — Bankai Jenkins PR CI:** all required quality/security/container/
    Terraform plan gates; no deployment.
13. **Phase 7 — Quincy Jenkins PR CI:** locked Python checks, unit/component and
    restricted Docker integration, image health/scans/SBOM; no deployment.
14. **Phase 8 — Immutable non-production release:** build once, push/capture
    digests, archive frontend, release manifest, saved plan/apply, ordered rollout,
    health/integration gates, Datadog event.
15. **Phase 9 — Cross-service E2E:** synthetic vulnerable repository, cleanup,
    failure cases, nightly/pre-promotion execution, telemetry correlation.
16. **Phase 10 — Runtime observability:** structured logs/traces/metrics,
    dashboards/monitors/SLOs and explicit volume/cardinality controls.
17. **Phase 11 — Production readiness:** accounts/IAM/backups/restore, deletion
    protection, scaling, budgets, security review, runbooks and rollback drill.
18. **Phase 12 — Exact-artifact production promotion:** selected release
    manifest, digest/artifact verification, saved plan, explicit approval,
    ordered deploy, smoke test/event/audit record, rollback on failure.
19. **Phase 13 — Cutover/cleanup:** make Jenkins authoritative, disable only
    duplicate application CI/deploy, preserve customer verification workflows,
    remove CDK only after ownership proof, drift/orphan/duplicate-monitor audit.

## 12. Phase 0 validation and exit assessment

- [x] Both repositories, local instructions, source layout, workflows,
  manifests, tests, Dockerfiles, environment examples, and infrastructure were
  inspected.
- [x] Git state was inspected without changing global configuration; both
  working trees were clean before this document was added.
- [x] Existing CDK resource families were mapped to proposed Terraform modules.
- [x] Persistent/import candidates, hardcoded values, and Railway assumptions
  were identified.
- [x] Existing coverage and high-value test gaps were inventoried.
- [x] Target architecture and a phased implementation plan were documented.
- [x] No application, container, workflow, infrastructure code, cloud resource,
  or secret was changed.
- [ ] Owner decisions in section 10 are reviewed/answered.
- [ ] Phase 0 is approved before Phase 1 begins.

No application test suite was run in Phase 0 because no executable code was
changed and this phase's validation is documentary/static. Test execution and
report-contract changes belong to Phase 1. No Terraform command exists to run,
and no CDK synth/deploy, AWS API call, or network request was performed.

## 13. Rollback for this phase

Phase 0 changes only this document. Rollback is deletion or reversion of
`docs/delivery-platform/phase-0-discovery-and-architecture.md`; it has no runtime
or infrastructure effect.
