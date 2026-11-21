import { upsertJenkinsEvidenceComment } from "./github.js";
import { logger } from "./logger.js";
import { loadGithubCreds } from "./ticketing.js";
import { supabaseAdmin } from "./supabase.js";

const safeText = (value: unknown): string => String(value ?? "—")
  .replace(/[\\`*_{}\[\]()#+.!|<>]/g, "\\$&")
  .replace(/[\r\n]+/g, " ")
  .slice(0, 300);

function safeLink(label: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return `[${safeText(label)}](${url.toString().replace(/[()\\]/g, "\\$&")})`;
  } catch { return null; }
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function stateLabel(value: unknown): string {
  if (value === "passed") return "Passed";
  if (value === "failed") return "Failed";
  if (value === "cancelled") return "Cancelled";
  if (value === "needs_review") return "Needs review";
  if (value === "running") return "Running";
  if (value === "queued") return "Queued";
  return "Not configured";
}

/** Publish one short, secret-free evidence comment and keep it current across retries and CD updates. */
export async function publishJenkinsEvidence(projectId: string, ticketId: string): Promise<void> {
  try {
    const [{ data: ticket, error: ticketError }, github] = await Promise.all([
      supabaseAdmin.from("tickets")
        .select("key,title,severity,github_pr_number,github_pr_state,ci_status")
        .eq("id", ticketId).eq("project_id", projectId).maybeSingle(),
      loadGithubCreds(supabaseAdmin, projectId),
    ]);
    if (ticketError) throw ticketError;
    if (!ticket || !github || !ticket.github_pr_number || ticket.github_pr_state !== "open") return;

    const { data: runs, error: runsError } = await supabaseAdmin.from("pipeline_runs")
      .select("created_at,started_at,completed_at,commit_sha,conclusion,jenkins_build_url,html_url,jenkins_build_number,retry_count,deployment_status,deployment_job_url,deployment_build_url,deployment_build_number,deployment_target_url,deployment_started_at,deployment_completed_at")
      .eq("ticket_id", ticketId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(10);
    if (runsError) throw runsError;
    const latest = runs?.[0];
    if (!latest || !["passed", "failed", "cancelled", "needs_review"].includes(ticket.ci_status ?? "")) return;

    const ciStatus = stateLabel(ticket.ci_status);
    const deploymentStatus = stateLabel(latest.deployment_status);
    const ciLink = safeLink(latest.jenkins_build_number ? `Jenkins build #${latest.jenkins_build_number}` : "Jenkins build", latest.jenkins_build_url ?? latest.html_url);
    const deploymentLink = safeLink(latest.deployment_build_number ? `Deployment #${latest.deployment_build_number}` : "Deployment job", latest.deployment_build_url ?? latest.deployment_job_url);
    const targetLink = safeLink("Open deployment target", latest.deployment_target_url);
    const retryCount = Math.max(0, ...((runs ?? []).map((run) => Number.isInteger(run.retry_count) ? run.retry_count : 0)));
    const manualAction = ticket.ci_status !== "passed"
      ? "Review the Jenkins result and pull request changes before deciding what to do next."
      : latest.deployment_status === "running" || latest.deployment_status === "queued"
        ? "Wait for deployment to finish, then review the pull request."
        : latest.deployment_status === "failed" || latest.deployment_status === "needs_review"
          ? "Review the deployment result and pull request changes; resolve any issue before merging."
          : "Review the pull request diff and checks, then merge manually if satisfied.";

    const lines = [
      "## Bankai CI/CD evidence",
      "",
      `- **Ticket:** ${safeText(ticket.key)} · ${safeText(ticket.severity)} · ${safeText(ticket.title)}`,
      `- **Commit:** \`${safeText(latest.commit_sha)}\``,
      `- **Jenkins build:** ${ciStatus}${ciLink ? ` · ${ciLink}` : ""}`,
      `- **Build started:** ${formatDate(latest.started_at)}`,
      `- **Build completed:** ${formatDate(latest.completed_at)}`,
      `- **AI remediation retries:** ${retryCount}`,
      `- **Deployment:** ${deploymentStatus}${deploymentLink ? ` · ${deploymentLink}` : ""}${targetLink ? ` · ${targetLink}` : ""}`,
      `- **Deployment started:** ${formatDate(latest.deployment_started_at)}`,
      `- **Deployment completed:** ${formatDate(latest.deployment_completed_at)}`,
      "",
      `**Next step:** ${manualAction}`,
      "",
      "Bankai does not merge pull requests. Review and merge remain under your control.",
    ];
    await upsertJenkinsEvidenceComment(github.creds, ticket.github_pr_number, lines.join("\n"));
  } catch (error) {
    logger.warn({ err: error, projectId, ticketId }, "Could not publish Jenkins evidence to the pull request");
  }
}
