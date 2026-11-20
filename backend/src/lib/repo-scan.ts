import type { SupabaseClient } from "@supabase/supabase-js";
import {
  excludeAlreadyTicketedFindings,
  planIngest,
  type ExistingFinding,
  type NormalizedFinding,
} from "./csv-ingest.js";
import { getBranchHeadSha, type GithubCredentials } from "./github.js";
import { scanRepository } from "./scanners.js";
import type { SlaPolicyDays } from "./sla.js";
import {
  closeTicketsForResolvedFindings,
  fetchAlreadyTicketedFingerprints,
  loadJiraCreds,
  updateTicketsForChangedFindings,
} from "./ticketing.js";

// The repo-scan pipeline: scan a pinned repository revision -> diff against
// existing findings -> upsert into `findings`, same as the CSV path.
// Findings just land in AI Triage for the user to review and manually
// select for ticket creation ("Mark for Jira") — no ticket/branch is
// auto-created here. Deliberately auth-context-agnostic (it takes a
// ready-made SupabaseClient) so it can run either inside an interactive
// HTTP request (M2, user-scoped client) or inside the BullMQ worker
// (M3/M4, service-role client) without duplicating this logic.
export interface RunRepoScanInput {
  supabase: SupabaseClient;
  projectId: string;
  scanId: string;
  github: { creds: GithubCredentials; defaultBranch: string };
  headSha?: string;
  slaPolicyDays: SlaPolicyDays;
  defaultService: string | null;
}

export interface RepoScanResult {
  commitSha: string;
  filesScanned: number;
  filesEligible: number;
  findingCount: number;
  scanners: import("./scanners.js").ScannerRun[];
  counts: { newDelta: number; changed: number; inProgress: number; resolved: number };
}

export async function runFullRepoScan(input: RunRepoScanInput): Promise<RepoScanResult> {
  const { supabase, projectId, scanId, github, slaPolicyDays, defaultService } = input;
  const commitSha = input.headSha ?? await getBranchHeadSha(github.creds, github.defaultBranch);
  const scan = await scanRepository(github.creds, commitSha);
  if (!scan.complete) {
    const failed = scan.scanners.filter((run) => run.status === "failed").map((run) => run.scanner).join(", ");
    await supabase.from("scans").update({ scanner_runs: scan.scanners, scan_complete: false }).eq("id", scanId);
    throw new Error(`Scanner coverage was incomplete (${failed}); findings were not reconciled.`);
  }
  const rows: NormalizedFinding[] = scan.findings;

  const { data: existingRaw, error: existingError } = await supabase
    .from("findings")
    .select("fingerprint, severity, cvss_score, bucket, file_path")
    .eq("project_id", projectId);
  if (existingError) throw new Error("Could not load this project's existing findings.");

  let existing: ExistingFinding[] = (existingRaw ?? []).map((f) => ({
    fingerprint: f.fingerprint,
    severity: f.severity,
    cvssScore: f.cvss_score,
    bucket: f.bucket,
    filePath: f.file_path,
  }));

  const rawPlan = planIngest(
    projectId,
    scanId,
    existing,
    rows,
    new Date(),
    slaPolicyDays,
    defaultService,
  );

  // Loaded once, reused below for change-propagation, resolved findings, and
  // the already-ticketed-in-Jira filter just below.
  const jiraCreds = await loadJiraCreds(supabase, projectId);

  // Skip the Jira API round-trip entirely when there's nothing it could
  // filter.
  const alreadyTicketedFingerprints =
    rawPlan.counts.newDelta > 0 ? await fetchAlreadyTicketedFingerprints(jiraCreds) : new Set<string>();
  const plan = excludeAlreadyTicketedFindings(rawPlan, alreadyTicketedFingerprints);

  if (plan.upsertRows.length > 0) {
    const { data: upsertedRows, error } = await supabase
      .from("findings")
      .upsert(plan.upsertRows, { onConflict: "project_id,fingerprint" })
      .select("id");
    if (error) throw new Error("Could not save findings from this scan.");
    await updateTicketsForChangedFindings(supabase, {
      projectId,
      findingIds: (upsertedRows ?? []).map((r) => r.id),
      jira: jiraCreds?.creds ?? null,
      slaPolicyDays,
    });
  }

  if (plan.resolvedFingerprints.length > 0) {
    const { data: resolvedRows, error } = await supabase
      .from("findings")
      .update({ bucket: "Resolved", rationale: "Not found in the latest AI scan — marked resolved." })
      .eq("project_id", projectId)
      .in("fingerprint", plan.resolvedFingerprints)
      .select("id");
    if (error) throw new Error("Could not update resolved findings.");

    await closeTicketsForResolvedFindings(supabase, {
      projectId,
      resolvedFindingIds: (resolvedRows ?? []).map((r) => r.id),
      jira: jiraCreds?.creds ?? null,
    });
  }

  return {
    commitSha,
    filesScanned: scan.filesScanned,
    filesEligible: scan.filesScanned,
    findingCount: rows.length,
    scanners: scan.scanners,
    counts: plan.counts,
  };
}
