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
  trigger_type: "manual" | "webhook" | null;
  commit_sha: string | null;
  base_commit_sha: string | null;
  branch: string | null;
  finding_count: number | null;
  created_at: string;
}

export const SCAN_SELECT =
  "id, filename, file_size_bytes, row_count, service_count, new_delta_count, changed_count, in_progress_count, resolved_count, status, error_message, source, trigger_type, commit_sha, base_commit_sha, branch, finding_count, created_at";

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
    resolvedCount: row.resolved_count,
    status: row.status,
    errorMessage: row.error_message,
    source: row.source,
    triggerType: row.trigger_type,
    commitSha: row.commit_sha,
    baseCommitSha: row.base_commit_sha,
    branch: row.branch,
    findingCount: row.finding_count,
    createdAt: row.created_at,
  };
}
