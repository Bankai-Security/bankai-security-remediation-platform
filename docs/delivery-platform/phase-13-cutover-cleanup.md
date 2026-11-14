# Phase 13 — Cutover and cleanup

> Updated evidence and current blockers: [validation record](phase-11-13-validation.md).
> The original checklist below includes historical pending items; consult that record
> for the successful October 21 nonproduction deployment, restores and drift audit.

Status: **PARTIAL** — ownership/checklist prepared; live audits and cutover BLOCKED.
No workflow, cloud resource, backup, audit log or release artifact was deleted.

Current repository owner: CloudFormation/CDK `Bankai-<stage>-Foundation`.
Terraform plans in Phase 0 are historical proposals; there is no proven
replacement owner. Keep CDK. Imported certificates, WAF ACLs, Secrets Manager
secrets and hosted zones remain externally owned until their operator is named.

| Step | Evidence required | Current result |
| --- | --- | --- |
| Jenkins authority | Build #17 archive, PR check context, failing-gate proof, branch rules, webhook delivery | User reports success; independently unverified |
| Duplicate CI | Compare GitHub deploy.yml jobs to required Jenkins checks | Only duplicate application workflow identified; remains enabled pending required-check proof |
| Preserved workflows | Inventory both repositories and generated customer bankai-verify.yml | No customer/security/audit workflow modified |
| Duplicate deployment | Jenkins schedules/upstream jobs, GitHub runs, AWS event rules | BLOCKED |
| Alarm/subscription overlap | Inventory alarm namespace/metric/dimensions/period/actions and every active task log-group subscription | BLOCKED; new native alarms intentionally coexist with old ones |
| Orphans | Compare physical stack IDs, tags, active task/image refs, DNS aliases/cert associations and dependency graph | BLOCKED; absence from one stack is not proof of orphan status |
| Ownership transfer | Replacement resource owner/import record for every logical and physical ID | None approved; CDK retained |
| Drift | Detect stack drift, wait, list resource drift; manually inspect unsupported resource types | BLOCKED |
| Final rollback | Previous/current manifest, protected resource map, DNS values, approver, timed drill | BLOCKED |

After authentication, run `scripts/operations/inventory.mjs` and preserve outputs.
Supplement it with DescribeTaskDefinition (record log-group names/digests only),
ECR list-images and lifecycle policies, DescribeCertificate, WAF GetWebACL,
Route53 record sets, role inline/attached policies, CloudTrail GetTrailStatus,
backup recovery points and EFS backup policy. Inventory is not an orphan detector.

Disable only `.github/workflows/deploy.yml` automatic push/PR triggers after
observing the real Jenkins required checks and proving deliberate failures block
merge. Retain manual dispatch if desired. Do not guess a status-context name.
Inspect Quincy independently; it is a separate repository and has not been
changed by this task. Do not disable generated customer verification workflows.

For every retirement candidate record physical ID, environment, owner, inbound
references, last activity, replacement ID, rollback path and retention window.
No absence-of-traffic heuristic authorizes deletion. Do not remove active ECR
digests, task definitions referenced by rollback manifests, DNS/certificates,
log groups, backups or audit evidence. Production resource deletion is prohibited.

Final ownership record must bind each resource to one owner (CDK/external), its
change authority and rollback artifact. Review drift and overlapping alarms
before marking COMPLETE. Existing alarm retirement requires validated native
ingestion, controlled alert/recovery and confirmed SNS notification delivery.
