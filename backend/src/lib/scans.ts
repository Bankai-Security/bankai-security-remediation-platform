// Shared by scan.controller.ts (CSV + polling), github.controller.ts (the
// manual scan trigger), and jobs/repo-scan.job.ts (the worker) — all three
// read/write the same `scans` row shape, just from different auth contexts.

export interface ScanRow {
  id: string;
  filename: string | null;
  file_size_bytes: number;
  row_count: number;
  service_count: number;
  new_delta_count: number;
  changed_count: number;
  in_progress_count: number;
  resolved_count: number;
  status: "Queued" | "Processing" | "Done" | "Failed";
  error_message: string | null;
  source: "csv" | "github_ai";
  trigger_type: "manual" | "webhook" | "initial" | null;
  scan_type?: "baseline" | "push" | "pull_request";
  pull_request_number?: number | null;
  base_commit_sha?: string | null;
  commit_sha: string | null;
  branch: string | null;
  finding_count: number | null;
  scanner_runs?: unknown[] | null;
  scan_complete?: boolean;
  created_at: string;
}

export const SCAN_SELECT =
  "id, filename, file_size_bytes, row_count, service_count, new_delta_count, changed_count, in_progress_count, resolved_count, status, error_message, source, trigger_type, scan_type, pull_request_number, base_commit_sha, commit_sha, branch, finding_count, scanner_runs, scan_complete, created_at";

export function toPublicScan(row: ScanRow) {
  return {
    id: row.id,
    filename: row.filename,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    serviceCount: row.service_count,
    newDeltaCount: row.new_delta_count,
    changedCount: row.changed_count,
    inProgressCount: row.in_progress_count,
    notDetectedCount: row.resolved_count,
    status: row.status,
    errorMessage: row.error_message,
    source: row.source,
    triggerType: row.trigger_type,
    scanType: row.scan_type ?? "baseline",
    pullRequestNumber: row.pull_request_number ?? null,
    baseCommitSha: row.base_commit_sha ?? null,
    commitSha: row.commit_sha,
    branch: row.branch,
    findingCount: row.finding_count,
    scannerRuns: row.scanner_runs ?? [],
    scanComplete: row.scan_complete ?? false,
    createdAt: row.created_at,
  };
}
