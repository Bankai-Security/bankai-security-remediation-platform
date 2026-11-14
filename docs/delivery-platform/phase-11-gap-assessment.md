# Phase 11–13 gap assessment — 2026-10-19

Assessment recorded before implementation. User reports Jenkins release #17 and
Phase 9 deployment/E2E complete; this session has not independently verified them.
Historical Phase 0–10 documents contain superseded Datadog and Terraform plans.
Current authority is CDK and AWS-native observability; no Terraform migration.

## Evidence and boundaries

- `aws sts get-caller-identity --output json --no-cli-pager` returned
  `NoCredentials: Unable to locate credentials`. Live inventory, restore,
  rollback, drift, billing, quota and audit checks are BLOCKED.
- Git needed a per-command safe.directory override. Pre-existing edits to
  `backend/src/server.ts`, `backend/src/worker.ts` and untracked
  `e2e-fixture-repo/` are preserved.
- No AGENTS.md or instruction files were found in repository .agents/.codex.
- Production configuration contains account 222222222222, zero certificate/WAF
  identifiers, hosted-zone placeholder, zero digests and placeholder trust ARN.
  These are synthesis fixtures, never deployable production inputs.

## Gaps before implementation

| Area | Repository evidence | Required closure |
| --- | --- | --- |
| IAM | PR agents isolated; production roles trust nonprod agent directly; broad ECS UpdateService resource | Independent production approval/role gate, scoped IAM and live policy review; break-glass/MFA/CloudTrail evidence |
| Secrets/TLS | Secrets referenced by stage; external ACM/WAF/DNS references | Metadata-only live verification, rotation owners, real production config; internal Quincy HTTP remains an encryption-in-transit risk |
| Recovery | Production Redis snapshots and RETAIN; Jenkins backup vault; Quincy EFS backup not explicit | EFS backup policy, isolated EFS/S3/Redis/Supabase restore and measured RPO/RTO |
| Deletion | Production termination protection and retained persistent resources | Live protection verification; ECR count lifecycle can expire an active old release; imported DNS/certs/WAF/secrets need owner controls |
| Capacity | API 2–10, worker 1–2, Quincy 2–6 production; CPU scaling only | Memory scaling, measured load/connection limits, regional quotas; shared SQLite on EFS needs concurrency assessment |
| Observability | JSON logs/correlation/queue samples, existing CloudWatch alarms; active Datadog sidecars/JCasC | Native bounded metrics, dashboard, SNS/email, correct FailedBuilds metric, telemetry-loss alarms and live alarm/recovery proof |
| Cost | Log retention 14/90 days; NAT/Fargate/EFS | Budget amount/recipient, billing-based estimates and subscription audit; no default tracing |
| Security | Pinned scan helpers and tests exist | Fresh dependency/container/IaC/history/image scans and IAM/public exposure review |
| Promotion | Nonprod manifest has SHAs/images/frontend hash; frontend embeds nonprod API URL | Template hash and successful-release identity; environment-neutral frontend or separately validated identical artifact; saved production plan and independent approval |
| Cutover | GitHub deploy.yml still runs duplicate CI; Jenkins authority reported | Verify required Jenkins checks before disabling workflow; retain customer/security/audit workflows; live orphan/ownership/drift audit |

## Action separation

**Repository:** implement native definitions, safer retention/backup controls,
artifact verification and promotion preparation, tests, runbooks and checklists.

**Nonproduction AWS:** authorized by the request, but blocked by missing credentials.
After authenticated inventory, prepare a no-removal/no-replacement change set;
validate new alarms before retiring anything. Drills must use isolated targets.

**Production:** no apply, deletion, routing change or role change authorized.
Only local synthesis and a reviewable promotion procedure may be prepared now.

**Operator:** supply SSO/read-only profile, notification email/budget, real
production account/configuration, successful release evidence, independent
production approval principal and Supabase backup access. Never paste secrets.
