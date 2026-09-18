import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedFinding } from "./csv-ingest.js";
import { recordActivity } from "./activity.js";
import { logger } from "./logger.js";
import { transitionIssue } from "./jira.js";
import type { JiraCredentials } from "./jira.js";

export interface PackageAdvisoryIdentity {
  packageIdentity: string;
  advisoryIds: string[];
  version: string | null;
  filePath: string | null;
}

function firstListValue(value: string | null | undefined): string | null {
  const first = value?.replace(/^\s*\[|\]\s*$/g, "").split(/[,\n]/).map((part) => part.trim().replace(/^["']|["']$/g, "")).find(Boolean);
  return first ?? null;
}

function canonicalPackage(value: string | null | undefined): string | null {
  const first = firstListValue(value);
  if (!first) return null;
  // Preserve Package URL namespace/ecosystem when supplied. For ordinary
  // scanner package names, apply the cross-ecosystem normalization shared by
  // the major advisory databases; file context prevents workspace collisions.
  if (first.toLowerCase().startsWith("pkg:")) {
    const withoutQualifiers = first.toLowerCase().split(/[?#]/, 1)[0] ?? "";
    return withoutQualifiers.replace(/@[^/]+$/, "") || null;
  }
  return first.toLowerCase().replace(/[-_.]+/g, "-");
}

function advisoryIds(...values: Array<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    for (const id of value?.match(/(?:CVE-\d{4}-\d{4,}|GHSA-[A-Za-z0-9-]+|OSV-[A-Za-z0-9.-]+)/gi) ?? []) ids.add(id.toUpperCase());
  }
  return [...ids];
}

export function packageAdvisoryIdentity(finding: Pick<NormalizedFinding, "affectedPackages" | "component" | "cves" | "externalId" | "currentVersions" | "filePath">): PackageAdvisoryIdentity | null {
  const packageIdentity = canonicalPackage(finding.affectedPackages ?? finding.component);
  const ids = advisoryIds(finding.cves, finding.externalId);
  if (!packageIdentity || ids.length === 0) return null;
  return { packageIdentity, advisoryIds: ids, version: firstListValue(finding.currentVersions), filePath: finding.filePath };
}

function sameContext(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

export function collateralMitigationEvidence(
  finding: Pick<NormalizedFinding, "affectedPackages" | "component" | "cves" | "externalId" | "currentVersions" | "filePath">,
  baseline: NormalizedFinding[],
  current: NormalizedFinding[],
): PackageAdvisoryIdentity | null {
  const candidate = packageAdvisoryIdentity(finding);
  if (!candidate) return null;
  const matches = (item: NormalizedFinding) => {
    const identity = packageAdvisoryIdentity(item);
    return !!identity && identity.packageIdentity === candidate.packageIdentity && sameContext(identity.filePath, candidate.filePath) && identity.advisoryIds.some((id) => candidate.advisoryIds.includes(id));
  };
  // Positive baseline evidence plus absence from the complete post-change scan
  // is required. A database row or manifest version comparison alone is never
  // treated as proof.
  return baseline.some(matches) && !current.some(matches) ? candidate : null;
}

interface StoredFinding {
  id: string;
  external_id: string | null;
  component: string | null;
  file_path: string | null;
  cves: string | null;
  affected_packages: string | null;
  current_versions: string | null;
  bucket: string;
  title: string;
  tickets: { id: string; status: string; jira_issue_key: string | null } | Array<{ id: string; status: string; jira_issue_key: string | null }> | null;
}

function storedAsNormalized(row: StoredFinding): NormalizedFinding {
  return {
    fingerprint: "", externalId: row.external_id, title: row.title, severity: "Medium", cvssScore: null, cwe: null,
    component: row.component, filePath: row.file_path, findingType: null, sourceStatus: null, dateFound: null,
    description: null, fixAvailable: null, sourceUrl: null, service: null, environment: null, cves: row.cves,
    affectedPackages: row.affected_packages, currentVersions: row.current_versions, fixedVersions: null, recommendations: null,
  };
}

export async function reconcileCollateralPackageMitigations(supabase: SupabaseClient, input: { projectId: string; sourceTicketId: string; loadJira?: () => Promise<JiraCredentials | null> }): Promise<number> {
  const { data: source, error: sourceError } = await supabase.from("tickets")
    .select("id, key, github_pr_number, github_pr_state, ci_status, security_verified_commit_sha")
    .eq("id", input.sourceTicketId).eq("project_id", input.projectId).maybeSingle();
  if (sourceError || !source || source.github_pr_state !== "merged" || source.ci_status !== "passed" || source.github_pr_number == null || !source.security_verified_commit_sha) return 0;

  const { data: verification, error: verificationError } = await supabase.from("remediation_security_verifications")
    .select("id, commit_sha, baseline_findings, current_findings")
    .eq("ticket_id", input.sourceTicketId).eq("project_id", input.projectId)
    .eq("commit_sha", source.security_verified_commit_sha)
    .order("verified_at", { ascending: false }).limit(1).maybeSingle();
  if (verificationError || !verification) return 0;

  const baseline = verification.baseline_findings as NormalizedFinding[];
  const current = verification.current_findings as NormalizedFinding[];
  const { data: rows, error } = await supabase.from("findings")
    .select("id, external_id, title, component, file_path, cves, affected_packages, current_versions, bucket, tickets(id, status, jira_issue_key)")
    .eq("project_id", input.projectId).neq("bucket", "Resolved");
  if (error) {
    logger.error({ err: error, ...input }, "Could not load findings for collateral package reconciliation");
    return 0;
  }

  let resolved = 0;
  let jira: JiraCredentials | null | undefined;
  for (const row of (rows ?? []) as unknown as StoredFinding[]) {
    const ticket = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
    if (!ticket || ticket.id === input.sourceTicketId || ticket.status === "Done") continue;
    const evidence = collateralMitigationEvidence(storedAsNormalized(row), baseline, current);
    if (!evidence) continue;

    const { data: eventId, error: resolutionError } = await supabase.rpc("apply_collateral_package_resolution", {
      p_project_id: input.projectId, p_finding_id: row.id, p_ticket_id: ticket.id,
      p_resolution_type: "collateral_package_upgrade", p_source_ticket_id: source.id,
      p_source_pr_number: source.github_pr_number, p_source_commit_sha: verification.commit_sha,
      p_verification_id: verification.id, p_package_identity: evidence.packageIdentity,
      p_advisory_id: evidence.advisoryIds[0], p_previous_version: evidence.version,
      p_rationale: `Verified absent after ${evidence.packageIdentity} remediation in ${source.key} / PR #${source.github_pr_number}.`,
    });
    if (resolutionError || !eventId) continue;
    resolved++;
    if (ticket.jira_issue_key && input.loadJira) {
      jira ??= await input.loadJira();
      if (jira) await transitionIssue(jira, ticket.jira_issue_key, "Done");
    }
    await recordActivity(supabase, { projectId: input.projectId, actorId: null, actorLabel: "Bankai Security", eventType: "ticket", summary: "automatically resolved a related package CVIT through", linkLabel: source.key, linkTo: "tickets", meta: `${row.title} · ${evidence.packageIdentity} · PR #${source.github_pr_number}` });
  }
  return resolved;
}

export async function reopenReappearedCollateralMitigations(supabase: SupabaseClient, input: { projectId: string; findingIds: string[]; jira: JiraCredentials | null }): Promise<number> {
  if (input.findingIds.length === 0) return 0;
  const { data, error } = await supabase.from("tickets")
    .select("id, key, title, jira_issue_key, finding_id")
    .eq("project_id", input.projectId).eq("status", "Done")
    .not("collateral_resolution_event_id", "is", null).in("finding_id", input.findingIds);
  if (error) {
    logger.error({ err: error, projectId: input.projectId }, "Could not inspect reappeared collateral mitigations");
    return 0;
  }
  let reopened = 0;
  for (const ticket of data ?? []) {
    const { error: updateError } = await supabase.from("tickets")
      .update({ status: "In Progress", collateral_resolution_event_id: null })
      .eq("id", ticket.id).eq("project_id", input.projectId);
    if (updateError) continue;
    reopened++;
    if (input.jira && ticket.jira_issue_key) await transitionIssue(input.jira, ticket.jira_issue_key, "In Progress");
    await recordActivity(supabase, { projectId: input.projectId, actorId: null, actorLabel: "Bankai Security", eventType: "ticket", summary: "reopened after a package vulnerability reappeared in", linkLabel: ticket.key, linkTo: "tickets", meta: ticket.title });
  }
  return reopened;
}
