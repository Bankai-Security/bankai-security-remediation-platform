import { useEffect, useState } from "react";
import { recordJenkinsAuditAction } from "../lib/api";

type JenkinsJob = { name: string; url: string; color: string; supportsPullRequests?: boolean };
type JenkinsParameter = { name: string; type: string; description: string; defaultValue: string; choices: string[] };
type JenkinsParametersResult = { supported: boolean; reason: string | null; parameters: JenkinsParameter[] };

export default function JenkinsDeploymentSetup({ projectId, jobs }: { projectId: string; jobs: JenkinsJob[] }) {
  const [enabled, setEnabled] = useState(false);
  const [jobUrl, setJobUrl] = useState("");
  const [definitions, setDefinitions] = useState<JenkinsParametersResult | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deployableJobs = jobs.filter((job) => !job.supportsPullRequests);

  const inspectJob = async (url: string) => {
    const api = window.bankaiDesktop;
    if (!api || !url) { setDefinitions(null); setValues({}); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.getJenkinsJobParameters(url);
      setDefinitions(result);
      const key = `bankai-cd-parameters:${projectId}:${url}`;
      let saved: Record<string, string> = {};
      try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* discard malformed local preference */ }
      const defaults = Object.fromEntries(result.parameters.map((item) => [item.name, item.defaultValue]));
      setValues({ ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([name, value]) => result.parameters.some((p) => p.name === name) && typeof value === "string")) });
    } catch (reason) {
      setDefinitions(null); setError(reason instanceof Error ? reason.message : "Could not inspect the deployment job.");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    setEnabled(localStorage.getItem(`bankai-cd-enabled:${projectId}`) === "true");
    const saved = localStorage.getItem(`bankai-cd-job:${projectId}`) || "";
    if (deployableJobs.some((job) => job.url === saved)) {
      setJobUrl(saved);
      void inspectJob(saved);
    }
  // Job discovery is refreshed on page open; the selected job value is loaded once for this project.
  }, [projectId, jobs]);

  const setChoice = (next: boolean) => {
    setEnabled(next);
    localStorage.setItem(`bankai-cd-enabled:${projectId}`, String(next));
    void recordJenkinsAuditAction(projectId, next ? "cd_enabled" : "cd_disabled").catch(() => undefined);
  };
  const selectJob = (url: string) => {
    setJobUrl(url); setDefinitions(null); setValues({});
    localStorage.setItem(`bankai-cd-job:${projectId}`, url);
    if (url) void recordJenkinsAuditAction(projectId, "cd_job_selected").catch(() => undefined);
    void inspectJob(url);
  };
  const updateParameter = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    if (jobUrl) localStorage.setItem(`bankai-cd-parameters:${projectId}:${jobUrl}`, JSON.stringify(next));
  };

  return (
    <section className="jenkinsfile-setup jenkins-deployment-setup" aria-label="Optional Jenkins deployment">
      <div className="jenkinsfile-setup-heading"><div><span className="jenkinsfile-setup-eyebrow">Optional CD</span><h2>Deployment job</h2></div></div>
      <p className="jenkins-download-note">Choose an existing Jenkins job. That job defines the environment and deployment destination. Bankai starts it only after the remediation PR build passes. Keep Bankai Desktop open.</p>
      <label className="jenkins-deployment-enable"><input type="checkbox" checked={enabled} onChange={(event) => setChoice(event.target.checked)} /> Enable automatic deployment after passing checks</label>
      {enabled && <>
        <label htmlFor="jenkins-deployment-job">Deployment job</label>
        <select id="jenkins-deployment-job" value={jobUrl} onChange={(event) => selectJob(event.target.value)} disabled={!deployableJobs.length || busy}>
          <option value="">{deployableJobs.length ? "Choose an existing Jenkins job" : "No deployment jobs found"}</option>
          {deployableJobs.map((job) => <option key={job.url} value={job.url}>{job.name}</option>)}
        </select>
        {busy && <p className="jenkins-download-note">Checking the job’s parameters…</p>}
        {definitions?.supported && definitions.parameters.length === 0 && <p className="jenkins-download-note">No parameters are required. The deployment destination and credentials remain configured in Jenkins.</p>}
        {definitions?.supported && definitions.parameters.map((parameter) => (
          <div className="jenkins-deployment-parameter" key={parameter.name}>
            <label htmlFor={`jenkins-cd-param-${parameter.name}`}>{parameter.name}{parameter.defaultValue ? <span> · default: {parameter.defaultValue}</span> : null}</label>
            {parameter.description && <span className="jenkins-deployment-param-help">{parameter.description}</span>}
            {parameter.choices.length > 0 ? (
              <select id={`jenkins-cd-param-${parameter.name}`} value={values[parameter.name] ?? ""} onChange={(event) => updateParameter(parameter.name, event.target.value)}>
                {!values[parameter.name] && <option value="">Choose a value</option>}
                {parameter.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            ) : <input id={`jenkins-cd-param-${parameter.name}`} value={values[parameter.name] ?? ""} onChange={(event) => updateParameter(parameter.name, event.target.value)} maxLength={2000} />}
          </div>
        ))}
        {definitions && !definitions.supported && <p className="jenkins-browser-error" role="alert">{definitions.reason}</p>}
        {error && <p className="jenkins-browser-error" role="alert">{error}</p>}
        {enabled && !jobUrl && <p className="jenkins-download-note">CD is not configured yet. Select a deployment job to enable it.</p>}
        {enabled && jobUrl && definitions?.supported && <p className="jenkins-download-note">Parameter values are saved on this computer only. Do not enter secrets here; store deployment credentials in Jenkins.</p>}
      </>}
    </section>
  );
}
