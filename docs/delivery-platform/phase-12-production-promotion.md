# Phase 12 — Exact-artifact production promotion

> Updated evidence and current blockers: [validation record](phase-11-13-validation.md).
> The original checklist below includes historical pending items; consult that record
> for the successful October 21 nonproduction deployment, restores and drift audit.

Status: **PARTIAL** — source verification implemented; production promotion
execution remains BLOCKED by identity, configuration and artifact provenance.
No production change set or apply has occurred.

New nonprod releases write schema-v2 manifests with release ID, successful
post-smoke status, Bankai/Quincy Git SHAs and image digests, frontend hash,
nonprod infrastructure-template hash and smoke artifact hash. Jenkins retains
the complete bundle under release/ and reports/. The S3 manifest alone does not
contain every artifact; download the exact archived Jenkins bundle. A manifest
created before final Jenkins success is not sufficient: verify build SUCCESS
separately. Build #17's actual manifest has not been retrieved.

Run from the repository:

```text
node scripts/release/verify-promotion.mjs BUNDLE/release/release-manifest.json BUNDLE reports/promotion-source-plan.json
```

The verifier checks source account/region, nonzero digests, full SHAs, byte hashes,
template images and smoke results. It rejects legacy manifests; do not rewrite a
historical manifest to invent missing evidence. Missing historical checksums
require an independently attested record from the original archive or a new
successful nonprod release. Verification produces `VERIFIED_SOURCE_ONLY`, never
production authorization. No rebuild command exists in the verifier.

## Production procedure (operator-controlled; not yet automated end to end)

1. Select immutable Jenkins build + successful full nonprod E2E + scan reports.
   Record provenance, source manifest SHA-256, previous production manifest and
   frontend object versions. Recheck source verification in an isolated trusted
   workspace. Never execute scripts from an arbitrary uploaded artifact bundle.
2. Resolve frontend compatibility: current release compiles a nonprod API URL.
   It cannot be promoted unchanged to production safely. Introduce an approved
   environment-neutral runtime configuration/routing contract, test that exact
   artifact in nonprod, then select it. Rebuilding during promotion is forbidden.
3. Copy exact OCI manifests/layers to production ECR using an independently
   approved publishing role. Compare destination digests to source; stop on any
   architecture/index conversion. Preserve all previous release images.
4. Use the recorded CDK source/config and exact digests to synthesize a
   **production-specific** cloud assembly. Nonprod and production templates
   legitimately differ; verify source template hash and separately record the
   target template/assembly hash. No application/image/frontend rebuild.
5. Validate all production placeholders are replaced, account/region/secrets/
   certs/DNS/WAF metadata are correct, backup/restore and security gates pass.
   Prepare a named change set with `--method=prepare-change-set`, archive its ID,
   full property details, target template SHA and protected-resource comparison.
   Review prerequisites separately where necessary; no deletion/replacement of
   persistent resources, DNS or edge resources is permitted by this procedure.
6. Require an independent human approver in the production change system. The
   approval must bind exact change-set ARN, account, region, template hash,
   source manifest hash, image digests, frontend checksum, expiry and rollback
   plan. A free-text approver parameter or a generic Jenkins input alone is not
   an IAM boundary. The broker role must be unavailable to ordinary Jenkins jobs
   and grant short-lived access only for the approved change. Archive approver
   identity and timestamp from the trusted approval system.
7. Apply approved prerequisites, then ECS task definitions/services through the
   exact reviewed change set. Re-describe ID/status before execution; stop if
   it differs. Wait for stack completion and Quincy, API, worker stabilization.
   Use circuit breakers; never force a failed deployment through.
8. Publish the verified frontend bytes under a new release prefix and then the
   origin root without deleting prior versions/artifacts; invalidate CloudFront
   and wait. DNS/routing changes require a separately enumerated approval.
9. Run a dedicated production-safe smoke check (health, CORS, asset hashes,
   authentication boundary). **Do not run the nonprod full E2E harness against
   production.** Query only release-owned CloudWatch alarms; ALARM or unexplained
   INSUFFICIENT_DATA stops promotion. Wait across alarm evaluation windows.
10. Record release ID, source/target digests, template/frontend checksums,
    approval identity, start/end UTC, smoke checks, alarm states, change-set ID,
    CloudTrail event IDs/request references and final outcome in a retained
    versioned evidence bucket/Jenkins archive.

On any failure, stop further promotion and page the operator. Circuit breakers
cover service rollout, not frontend publication or data/schema changes. Use the
previous manifest with a newly reviewed rollback change set and prior frontend
versions; production rollback also requires explicit approval. No automatic
irreversible database migration is included. Time and prove the analogous
rollback in nonprod before approval.

The repository does not yet provide an executable production-apply Jenkins job:
independent credential brokering, frontend compatibility, real target policy,
saved plan and safe smoke/alarm checks are prerequisites. This is intentionally
reported as incomplete, not an operational promotion pipeline.
