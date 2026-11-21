import { useEffect } from "react";
import { claimJenkinsPipeline, finishJenkinsPipeline, reportJenkinsPipelineProgress } from "../lib/api";

function desktopId(): string {
  const key = "bankai-pipeline-device-id";
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

export default function JenkinsPipelineAgent({ projectId }: { projectId: string }) {
  useEffect(() => {
    const desktop = window.bankaiDesktop;
    if (!desktop || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") return;
    let stopped = false;
    let working = false;
    let timer = 0;
    let activeRun: Awaited<ReturnType<typeof claimJenkinsPipeline>> | null = null;
    let activeRunJobUrl: string | null = null;
    const unsubscribe = desktop.onJenkinsJobProgress((progress) => {
      if (!activeRun?.runId || !activeRunJobUrl || progress.jobUrl !== activeRunJobUrl || progress.state !== "running" || !progress.buildUrl) return;
      void reportJenkinsPipelineProgress(projectId, activeRun.runId, { deviceId: desktopId(), buildUrl: progress.buildUrl, buildNumber: progress.number })
        .catch(() => undefined);
    });
    const poll = async () => {
      if (stopped || working || document.hidden || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") return;
      const selectedJob = localStorage.getItem(`bankai-jenkins-job:${projectId}`);
      if (!selectedJob) return;
      working = true;
      try {
        const connection = await desktop.getJenkinsConnection();
        if (!connection.connected) return;
        const run = await claimJenkinsPipeline(projectId, { deviceId: desktopId(), jobUrl: selectedJob });
        if (!run) return;
        activeRun = run;
        const expectedNames = new Set([`pr-${run.pullRequestNumber}`.toLowerCase(), `pr_${run.pullRequestNumber}`.toLowerCase(), run.branch.toLowerCase()]);
        const selected = new URL(selectedJob);
        let job: { name: string; url: string; color: string; supportsPullRequests?: boolean } | undefined;
        for (let attempt = 0; attempt < 18 && !job; attempt += 1) {
          if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") break;
          const jobs = await desktop.listJenkinsJobs();
          job = jobs.find((item) => expectedNames.has(item.name.toLowerCase()) && item.url.startsWith(`${selected.toString().replace(/\/$/, "")}/job/`));
          if (!job && attempt < 17) await new Promise((resolve) => window.setTimeout(resolve, 5_000));
        }
        if (stopped || localStorage.getItem(`bankai-jenkins-choice:${projectId}`) !== "enabled") {
          await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "cancelled", buildUrl: selectedJob });
          return;
        }
        if (!job) {
          await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state: "failed", buildUrl: selectedJob,
            commitSha: null, failureLog: "Jenkins setup: no matching PR branch job was found. Enable pull request branch discovery in the selected Jenkins multibranch job." });
          return;
        }
        activeRunJobUrl = job.url;
        const result = await desktop.runJenkinsJob(job.url);
        const state = result.state === "success" ? "passed" : result.state === "aborted" ? "cancelled" : "failed";
        const failureLog = state === "failed" && result.buildUrl ? await desktop.getJenkinsBuildLog(result.buildUrl).catch(() => "Jenkins build failed; console output could not be retrieved.") : undefined;
        await finishJenkinsPipeline(projectId, run.runId, { deviceId: desktopId(), state, buildUrl: result.buildUrl ?? job.url,
          buildNumber: result.number, commitSha: result.commitSha, failureLog });
      } catch {
        // A temporary network or Jenkins failure leaves the server side run in
        // progress; recovery marks stale claims for review instead of duplicating a build.
      } finally { activeRun = null; activeRunJobUrl = null; working = false; }
    };
    const schedule = () => { if (!stopped) timer = window.setTimeout(async () => { await poll(); schedule(); }, 12_000); };
    void poll().finally(schedule);
    return () => { stopped = true; window.clearTimeout(timer); unsubscribe(); };
  }, [projectId]);
  return null;
}
