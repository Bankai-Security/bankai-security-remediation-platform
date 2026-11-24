import { useEffect } from "react";
import { claimJenkinsPipeline, finishJenkinsPipeline, getGithubConnection, reportJenkinsDeployment, reportJenkinsPipelineProgress } from "../lib/api";
import { findPullRequestJob, resolveVerificationScope } from "../lib/jenkins-job-matching";

function desktopId(): string {
  const key = "bankai-pipeline-device-id";
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

function recoveryMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  if (/404|not found|deleted/i.test(message)) return "The selected Jenkins job was not found. Refresh the job list on the Bankai Jenkins page, choose an available job, then review this pull request.";
  if (/401|403|credential|permission|authentication/i.test(message)) return "Jenkins rejected the saved credentials or permissions. Reconnect on the Bankai Jenkins page, then check the Jenkins build before retrying.";
  if (/429|rate.?limit/i.test(message)) return "Jenkins is rate limiting requests. Wait briefly, refresh the Jenkins connection, and check the job before retrying.";
  if (/timeout|timed out|still running/i.test(message)) return "Bankai could not confirm whether the Jenkins build finished. Check Jenkins before retrying to avoid a duplicate build.";
  if (/unreach|connection|temporarily unavailable|HTTP 5\d\d/i.test(message)) return "Jenkins is unavailable. Check that it is running, reconnect on the Bankai Jenkins page, and confirm the build state before retrying.";
  const safeMessage = message.replace(/(authorization|api[_-]?token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 400);
  if (safeMessage) return `Jenkins: ${safeMessage}`;
  return "Bankai could not confirm the Jenkins result. Check the Jenkins job before retrying to avoid duplicate work.";
}

export default function JenkinsPipelineAgent({ projectId }: { projectId: string }) {
  useEffect(() => {
    const desktop = window.bankaiDesktop;
    if (!desktop) return;
    let stopped = false;
    let working = false;
    let timer = 0;
    let activeRun: Awaited<ReturnType<typeof claimJenkinsPipeline>> | null = null;
    let activeRunJobUrl: string | null = null;
    let activeDeploymentRunId: string | null = null;
    let activeDeploymentJobUrl: string | null = null;
    const terminalReports = new Set<string>();
    const unsubscribe = desktop.onJenkinsJobProgress((progress) => {
      if (!progress.buildUrl) return;
      if (activeRun?.runId && progress.jobUrl === activeRunJobUrl) {
        if (progress.state === "running") {
          void reportJenkinsPipelineProgress(projectId, activeRun.runId, { deviceId: desktopId(), jobUrl: progress.jobUrl, buildUrl: progress.buildUrl, buildNumber: progress.number }).catch(() => undefined);
        } else if (["success", "failure", "aborted"].includes(progress.state) && !terminalReports.has(activeRun.runId)) {
          const run = activeRun;
          const runId = run.runId;
          terminalReports.add(runId);
          const state = progress.state === "success" ? "passed" : progress.state === "aborted" ? "cancelled" : "failed";
          void (async () => {
            const failureLog = state === "failed" ? await desktop.getJenkinsBuildLog(progress.buildUrl!).catch(() => "Jenkins build failed; console output could not be retrieved.") : undefined;
            await finishJenkinsPipeline(projectId, runId, { deviceId: desktopId(), state, jobUrl: progress.jobUrl, buildUrl: progress.buildUrl!,
              buildNumber: progress.number, commitSha: progress.commitSha, failureLog });
          })().catch(() => { terminalReports.delete(runId); });
        }
      } else if (activeDeploymentRunId && progress.jobUrl === activeDeploymentJobUrl && progress.state === "running") {
        void reportJenkinsDeployment(projectId, activeDeploymentRunId, { deviceId: desktopId(), state: "running", buildUrl: progress.buildUrl, buildNumber: progress.number }).catch(() => undefined);
      }
    });
    const poll = async () => {
      if (stopped || working || document.hidden || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") return;
      const selectedJob = localStorage.getItem(`bankai-jenkins-job:${projectId}`);
      if (!selectedJob) return;
      working = true;
      try {
        const connection = await desktop.getJenkinsConnection();
        if (!connection.connected) return;
        const github = await getGithubConnection(projectId);
        if (!github.connected || !github.repo) return;
        const jobs = await desktop.listJenkinsJobs();
        const scope = resolveVerificationScope(jobs, selectedJob);
        const expectedPipelineName = `bankai-${github.repo.replace('/', '-')}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100);
        if (!jobs.some((job) => job.url === scope && job.name === expectedPipelineName && job.supportsPullRequests)) return;
        const run = await claimJenkinsPipeline(projectId, { deviceId: desktopId(), jobUrl: scope });
        if (!run) return;
        activeRun = run;
        let indexingSupported = false;
        let indexingResult: string | null = null;
        let indexingSummary: { rateLimitDelay: string | null; result: string | null } | null = null;
        // When a retry is resuming a persisted build, do not run multibranch
        // indexing first. Indexing can block on the same GitHub API limiter
        // and delay reconciliation of a result Jenkins already produced.
        if (!run.manualRetry && !run.buildUrl && desktop.scanJenkinsMultibranch) {
          const scan = await desktop.scanJenkinsMultibranch(scope);
          if (desktop.getJenkinsMultibranchIndexingStatus) {
            const indexingDeadline = Date.now() + 15 * 60_000;
            let sawActiveIndexing = false;
            while (!stopped && Date.now() < indexingDeadline) {
              const indexing = await desktop.getJenkinsMultibranchIndexingStatus(scope, scan);
              if (!indexing.supported) break;
              indexingSupported = true;
              const isThisScan = indexing.current || indexing.building;
              if (indexing.building) sawActiveIndexing = true;
              if (indexing.summary) indexingSummary = indexing.summary;
              if (isThisScan && !indexing.building && indexing.result) {
                indexingResult = indexing.result;
                break;
              }
              if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") break;
              await new Promise((resolve) => window.setTimeout(resolve, sawActiveIndexing ? 5_000 : 10_000));
            }
            if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") {
              await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "cancelled", buildUrl: selectedJob });
              return;
            }
            if (indexingSupported && !indexingResult) {
              if (!indexingSummary) indexingSummary = (await desktop.getJenkinsMultibranchIndexingStatus(scope, scan, true).catch(() => null))?.summary ?? null;
              const delay = indexingSummary?.rateLimitDelay;
              await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "needs_review",
                failureLog: delay
                  ? `Jenkins has not completed pull request discovery. Its GitHub API limiter delayed requests by ${delay}. Bankai waited 15 minutes and found no PR build. Check the indexing log in Jenkins; adding GitHub API credentials to the Jenkins GitHub Branch Source can prevent anonymous API throttling.`
                  : "Jenkins has not completed pull request discovery. Bankai waited 15 minutes without seeing this scan finish. Check the multibranch indexing log in Jenkins for source permissions, API throttling, or a missing pull request discovery trait, then retry verification." });
              return;
            }
            if (indexingResult && indexingResult !== "SUCCESS") {
              await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "needs_review",
                failureLog: `Jenkins branch discovery finished with ${indexingResult}. Bankai did not start a build. Review the indexing log and Jenkins source configuration, then retry verification.` });
              return;
            }
          }
        }
        const expectedNames = new Set([`pr-${run.pullRequestNumber}`.toLowerCase(), `pr_${run.pullRequestNumber}`.toLowerCase(), `pr/${run.pullRequestNumber}`.toLowerCase(), run.branch.toLowerCase()]);
        let job: { name: string; url: string; color: string; supportsPullRequests?: boolean; pullRequestNumber?: number; branchName?: string } | undefined;
        for (let attempt = 0; attempt < 18 && !job; attempt += 1) {
          if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") break;
          const jobs = await desktop.listJenkinsJobs();
          job = findPullRequestJob(jobs, scope, expectedNames, run.pullRequestNumber);
          if (!job && attempt < 17) await new Promise((resolve) => window.setTimeout(resolve, 5_000));
        }
        if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") {
          await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "cancelled", buildUrl: selectedJob });
          return;
        }
        if (!job) {
          await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "needs_review",
            failureLog: indexingSummary?.rateLimitDelay
              ? `Jenkins completed branch discovery, but did not expose a PR job for PR #${run.pullRequestNumber}. Its GitHub API limiter delayed requests by ${indexingSummary.rateLimitDelay}. Check the indexing log and Jenkins GitHub Branch Source credentials; Bankai did not start a build.`
              : `Jenkins completed branch discovery but did not expose a job for PR #${run.pullRequestNumber}. Bankai checked the selected multibranch job. Check its indexing log for GitHub API throttling or source configuration errors; Bankai did not start a build.` });
          return;
        }
        activeRunJobUrl = job.url;
        let existingBuild = run.buildUrl ? { url: run.buildUrl } : null;
        if (!run.manualRetry && !existingBuild && run.buildSearchSince && desktop.findRecentJenkinsBuild) {
          // Jenkins may build a newly discovered PR branch automatically. Give
          // that build a short window to appear before requesting another one.
          // A desktop app can have a newer preload than main process during an
          // in-place rollout; fall back when that process lacks this IPC route.
          for (let attempt = 0; attempt < 18 && !existingBuild; attempt += 1) {
            try {
              existingBuild = await desktop.findRecentJenkinsBuild(job.url, run.buildSearchSince);
            } catch (reason) {
              const message = reason instanceof Error ? reason.message : String(reason ?? "");
              if (/No handler registered for ['"]?bankai:jenkins-find-recent-build['"]?/i.test(message)) break;
              throw reason;
            }
            if (!existingBuild && attempt < 17) await new Promise((resolve) => window.setTimeout(resolve, 5_000));
          }
        }
        if (!run.manualRetry && !existingBuild && !run.buildUrl) {
          await finishJenkinsPipeline(projectId, run.runId, {
            deviceId: desktopId(),
            state: "needs_review",
            jobUrl: job.url,
            failureLog: `Waiting for Jenkins did not reveal a build for PR #${run.pullRequestNumber} at commit ${run.commitSha}. Bankai did not start a second build. Check the multibranch PR job in Jenkins and reconcile the exact commit before retrying.`,
          });
          return;
        }
        // Jenkins' native pull request trigger owns build creation. Bankai
        // only observes and reconciles an existing build, preventing a slow
        // webhook/build discovery from starting duplicate work.
        const result = run.manualRetry
          ? await desktop.runJenkinsJob(job.url)
          : await desktop.resumeJenkinsJob(job.url, existingBuild?.url ?? run.buildUrl);
        const state = result.state === "success" ? "passed" : result.state === "aborted" ? "cancelled" : "failed";
        const failureLog = state === "failed" && result.buildUrl ? await desktop.getJenkinsBuildLog(result.buildUrl).catch(() => "Jenkins build failed; console output could not be retrieved.") : undefined;
        terminalReports.add(run.runId);
        const completion = await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state, jobUrl: result.jobUrl ?? job.url, buildUrl: result.buildUrl ?? job.url,
          buildNumber: result.number, commitSha: result.commitSha, failureLog });
        activeRun = null;
        activeRunJobUrl = null;
        if (completion.ciStatus === "passed" && localStorage.getItem(`bankai-cd-enabled:${projectId}`) === "true") {
          const deploymentJobUrl = localStorage.getItem(`bankai-cd-job:${projectId}`);
          if (!deploymentJobUrl) return;
          activeDeploymentRunId = run.runId;
          activeDeploymentJobUrl = deploymentJobUrl;
          let deploymentTrackingStarted = false;
          try {
            const configuredJob = (await desktop.listJenkinsJobs()).find((item) => item.url === deploymentJobUrl && !item.supportsPullRequests);
            const jobParameters = await desktop.getJenkinsJobParameters(deploymentJobUrl);
            if (!configuredJob || !jobParameters.supported) {
              await reportJenkinsDeployment(projectId, run.runId, { deviceId: desktopId(), state: "needs_review", error: jobParameters.reason ?? "The selected Jenkins deployment job is no longer available." });
              return;
            }
            let values: Record<string, string> = {};
            try { values = JSON.parse(localStorage.getItem(`bankai-cd-parameters:${projectId}:${deploymentJobUrl}`) || "{}"); } catch { /* use Jenkins defaults */ }
            await reportJenkinsDeployment(projectId, run.runId, { deviceId: desktopId(), state: "running", jobUrl: deploymentJobUrl });
            deploymentTrackingStarted = true;
            try {
              const deployment = await desktop.runJenkinsJob(deploymentJobUrl, values);
              const deploymentState = deployment.state === "success" ? "passed" : deployment.state === "aborted" ? "cancelled" : "failed";
              await reportJenkinsDeployment(projectId, run.runId, { deviceId: desktopId(), state: deploymentState, buildUrl: deployment.buildUrl,
                buildNumber: deployment.number, targetUrl: deployment.targetUrl, error: deploymentState === "failed" ? "Jenkins deployment failed. Review its build output." : undefined });
            } catch (reason) {
              await reportJenkinsDeployment(projectId, run.runId, { deviceId: desktopId(), state: "needs_review",
                error: recoveryMessage(reason) });
            }
          } catch (reason) {
            if (!deploymentTrackingStarted) await reportJenkinsDeployment(projectId, run.runId, { deviceId: desktopId(), state: "needs_review",
              error: recoveryMessage(reason) }).catch(() => undefined);
          } finally { activeDeploymentRunId = null; activeDeploymentJobUrl = null; }
        }
      } catch (reason) {
        if (activeRun) {
          await finishJenkinsPipeline(projectId, activeRun.runId, { deviceId: desktopId(), state: "needs_review",
            jobUrl: activeRunJobUrl ?? undefined, buildUrl: activeRunJobUrl ?? activeRun.jobUrl, failureLog: recoveryMessage(reason) }).catch(() => undefined);
        }
        // If Bankai itself is offline, the server's stale-run sweep marks the
        // lease for review after 30 minutes and avoids launching another build.
      } finally { activeRun = null; activeRunJobUrl = null; activeDeploymentRunId = null; activeDeploymentJobUrl = null; working = false; }
    };
    const schedule = () => { if (!stopped) timer = window.setTimeout(async () => { await poll(); schedule(); }, 12_000); };
    void poll().finally(schedule);
    return () => { stopped = true; window.clearTimeout(timer); unsubscribe(); };
  }, [projectId]);
  return null;
}

