import { upsertPullRequestScanEvidenceComment } from "./github.js";
import { logger } from "./logger.js";
import { loadGithubCreds } from "./ticketing.js";
import { supabaseAdmin } from "./supabase.js";

/** Keep one short, secret-free scan evidence comment current for a PR. */
export async function publishPullRequestScanEvidence(projectId: string, scanId: string): Promise<void> {
  try {
    const [{ data: scan, error }, github] = await Promise.all([
      supabaseAdmin.from("scans")
        .select("scan_type,pull_request_number,commit_sha,status,scan_complete,finding_count,scanner_runs,created_at")
        .eq("id", scanId).eq("project_id", projectId).maybeSingle(),
      loadGithubCreds(supabaseAdmin, projectId),
    ]);
    if (error) throw error;
    if (!scan || scan.scan_type !== "pull_request" || !scan.pull_request_number || !scan.commit_sha || !github) return;

    const passed = scan.status === "Done" && scan.scan_complete === true;
    const scannerRuns = Array.isArray(scan.scanner_runs) ? scan.scanner_runs as Array<{ scanner?: unknown; status?: unknown }> : [];
    const scannerSummary = scannerRuns
      .map((run) => `${String(run.scanner ?? "scanner")}: ${run.status === "complete" ? "complete" : "unavailable"}`)
      .slice(0, 8)
      .join(" · ");
    const commitUrl = `https://github.com/${github.creds.repo}/commit/${encodeURIComponent(scan.commit_sha)}`;
    const markdown = [
      "## Bankai pull request scan",
      "",
      `- **Pull request:** #${scan.pull_request_number}`,
      `- **Commit:** [${scan.commit_sha}](${commitUrl})`,
      `- **Scan:** ${passed ? "Passed" : scan.status === "Failed" ? "Needs review" : "Running"}`,
      `- **Findings observed:** ${Number.isInteger(scan.finding_count) ? scan.finding_count : "pending"} (PR findings are not added to baseline triage or ticketed)`,
      `- **Scanners:** ${scannerSummary || "Results pending"}`,
      "",
      "Review the pull request and its checks before merging. Bankai does not merge pull requests.",
    ].join("\n");
    await upsertPullRequestScanEvidenceComment(github.creds, scan.pull_request_number, markdown);
  } catch (error) {
    logger.warn({ err: error, projectId, scanId }, "Could not publish pull request scan evidence");
  }
}
