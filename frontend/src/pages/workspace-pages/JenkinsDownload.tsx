import { useEffect, useState, type FormEvent } from 'react';
import { createJenkinsfilePullRequest, generateJenkinsfileProposal, getGithubConnection, inspectJenkinsfile, recordJenkinsAuditAction, updateJenkinsfilePullRequest, type JenkinsfileInspection, type JenkinsfileProposal, type JenkinsfilePullRequest } from '../../lib/api';
import jenkinsLogo from '../../assets/jenkins.svg';
import { useProject } from '../../lib/project-context';
import './JenkinsDownload.css';
import JenkinsDeploymentSetup from '../../components/JenkinsDeploymentSetup';
import { canEdit } from '../../lib/roles';

const downloadUrl = import.meta.env.VITE_BANKAI_DESKTOP_DOWNLOAD_URL;
type JenkinsJob = { name: string; url: string; color: string; supportsPullRequests?: boolean };
type JenkinsConnection = { connected: boolean; url?: string; username?: string };
type JenkinsJobProgress = { state: 'queued' | 'running' | 'success' | 'failure' | 'aborted'; buildUrl?: string; number?: number; timestamp?: number | null; durationMs?: number | null; commitSha?: string | null; targetUrl?: string | null; jobUrl?: string };
type JenkinsParameterDefinition = { name: string; type: string; description: string; defaultValue: string; choices: string[] };

export default function JenkinsDownload() {
  const { project } = useProject();
  const [desktopStatus] = useState<'web' | 'desktop'>(typeof window !== 'undefined' && Boolean(window.bankaiDesktop) ? 'desktop' : 'web');
  const desktopHref = downloadUrl || 'https://github.com/anubhavgpta/bankai-security-remediation-platform/releases/latest';
  const handoffUrl = new URL(desktopHref);
  if (project?.id) handoffUrl.searchParams.set('project', project.id);
  handoffUrl.searchParams.set('source', 'web-jenkins');
  const desktopDeepLink = project?.id ? `bankai://open?project=${encodeURIComponent(project.id)}` : 'bankai://open';

  return (
    <main className="ws-page ws-page--narrow jenkins-download-page">
      <div className="jenkins-download-card">
        <div className="jenkins-download-heading">
          <img src={jenkinsLogo} className="jenkins-download-mark jenkins-download-mark--large" alt="Jenkins" />
          <h1 className="jenkins-download-title">Run Jenkins from Bankai</h1>
        </div>
        {desktopStatus === 'desktop' ? <DesktopJenkinsOptions projectId={project?.id ?? ''} canManage={canEdit(project?.myRole)} /> : (
          <>
            <p className="jenkins-download-copy">Connect Jenkins, run builds, and follow deployment results from the Bankai desktop app. Your repository workspace will be ready when you open it there.</p>
            <div className="jenkins-download-actions">
              <a className="jenkins-download-cta" href={handoffUrl.toString()}>
                Download Bankai Desktop
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 13.5v2A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </a>
              <a className="jenkins-desktop-existing-link" href={desktopDeepLink}>Already installed? Open Bankai Desktop</a>
            </div>
            <p className="jenkins-download-note">Jenkins runs in the desktop app. Scanning, triage, remediation, and PR review remain available here.</p>
            <div className="jenkins-download-project">{project?.name ?? 'Current project'}<span className="jenkins-download-project-context">will be included when you continue</span></div>
          </>
        )}
      </div>
    </main>
  );
}

declare global {
  interface Window {
    bankaiDesktop?: {
      openJenkins: (url: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getJenkinsConnection: () => Promise<JenkinsConnection>;
      connectJenkins: (input: { url: string; username: string; apiToken: string }) => Promise<JenkinsConnection & { jobs: JenkinsJob[] }>;
      listJenkinsJobs: () => Promise<JenkinsJob[]>;
      disconnectJenkins: () => Promise<void>;
      runJenkinsJob: (url: string, parameters?: Record<string, string>) => Promise<JenkinsJobProgress>;
      resumeJenkinsJob: (jobUrl: string, buildUrl?: string | null) => Promise<JenkinsJobProgress>;
      getJenkinsJobParameters: (url: string) => Promise<{ supported: boolean; reason: string | null; parameters: JenkinsParameterDefinition[] }>;
      getJenkinsBuildLog: (url: string) => Promise<string>;
      cancelJenkinsJob: (url: string) => Promise<{ requested: boolean }>;
      onJenkinsJobProgress: (callback: (progress: JenkinsJobProgress) => void) => () => void;
      platform: string;
    };
  }
}

function DesktopJenkinsOptions({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const api = window.bankaiDesktop;
  const [connection, setConnection] = useState<JenkinsConnection>({ connected: false });
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [jobs, setJobs] = useState<JenkinsJob[]>([]);
  const [selectedJob, setSelectedJob] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<JenkinsJobProgress | null>(null);
  const [choice, setChoice] = useState<'unset' | 'enabled' | 'skipped'>(() => {
    try {
      const saved = localStorage.getItem(`bankai-jenkins-choice:${projectId}`);
      return saved === 'enabled' || saved === 'skipped' ? saved : 'unset';
    } catch { return 'unset'; }
  });

  useEffect(() => {
    if (!api || !canManage) return;
    let active = true;
    void api.getJenkinsConnection().then(async (saved) => {
      if (!active) return;
      setConnection(saved);
      if (saved.connected) {
        setUrl(saved.url || '');
        setUsername(saved.username || '');
        const discovered = await api.listJenkinsJobs();
        if (active) {
          setJobs(discovered);
          try {
            const savedJob = localStorage.getItem(`bankai-jenkins-job:${projectId}`) || '';
            setSelectedJob(discovered.some((job) => job.url === savedJob) ? savedJob : '');
          } catch { /* optional convenience */ }
        }
      }
    }).catch((reason) => { if (active) setError(errorMessage(reason)); });
    const unsubscribe = api.onJenkinsJobProgress((progress) => setRun(progress));
    return () => { active = false; unsubscribe(); };
  }, [api, projectId, canManage]);

  const saveChoice = (next: 'enabled' | 'skipped') => {
    setChoice(next);
    try { localStorage.setItem(`bankai-jenkins-choice:${projectId}`, next); } catch { /* optional preference */ }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!api) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.connectJenkins({ url, username, apiToken });
      void recordJenkinsAuditAction(projectId, 'connected').catch(() => undefined);
      setConnection(result); setJobs(result.jobs); setApiToken('');
      let savedJob = '';
      try { savedJob = localStorage.getItem(`bankai-jenkins-job:${projectId}`) || ''; } catch { /* optional convenience */ }
      setSelectedJob(result.jobs.some((job) => job.url === savedJob) ? savedJob : ''); setRun(null);
      setMessage(`Connected. Found ${result.jobs.length} Jenkins job${result.jobs.length === 1 ? '' : 's'}.`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const refreshJobs = async () => {
    if (!api) return;
    setBusy(true); setError(null);
    try { const discovered = await api.listJenkinsJobs(); setJobs(discovered); setMessage(`Found ${discovered.length} Jenkins job${discovered.length === 1 ? '' : 's'}.`); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      await api.disconnectJenkins();
      void recordJenkinsAuditAction(projectId, 'disconnected').catch(() => undefined);
      setConnection({ connected: false }); setJobs([]); setSelectedJob(''); setApiToken(''); setRun(null); setMessage('Jenkins disconnected.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const runJob = async () => {
    if (!api || !selectedJob) return;
    setBusy(true); setError(null); setMessage(null); setRun({ state: 'queued' });
    try {
      await recordJenkinsAuditAction(projectId, 'manual_build_started');
      const result = await api.runJenkinsJob(selectedJob);
      setRun(result);
    } catch (reason) { setRun(null); setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const chooseJob = (value: string) => {
    setSelectedJob(value);
    try { localStorage.setItem(`bankai-jenkins-job:${projectId}`, value); } catch { /* optional convenience */ }
    if (value) void recordJenkinsAuditAction(projectId, 'ci_job_selected').catch(() => undefined);
  };
  const openBuild = async () => {
    if (run?.buildUrl) await api?.openJenkins(run.buildUrl);
  };
  const openJenkinsDashboard = async () => {
    if (!connection.url) return;
    try { await api?.openJenkins(connection.url); setError(null); }
    catch (reason) { setError(errorMessage(reason)); }
  };

  if (!canManage) return <p className="jenkins-download-note" role="status">Your project role is view only. Ask a project editor to configure or run Jenkins for this repository.</p>;

  return (
    <>
      <p className="jenkins-download-copy">Choose whether Bankai should use Jenkins for this repository. Credentials stay on this computer.</p>
      <div className="jenkins-choice-group" role="group" aria-label="Jenkins preference">
        <button className={`jenkins-choice-card ${choice === 'enabled' ? 'jenkins-choice-card--selected' : ''}`} onClick={() => saveChoice('enabled')}><strong>Use Jenkins</strong><span>Connect, find a build job, and run it from Bankai.</span></button>
        <button className={`jenkins-choice-card ${choice === 'skipped' ? 'jenkins-choice-card--selected' : ''}`} onClick={() => saveChoice('skipped')}><strong>Skip Jenkins</strong><span>Keep using Bankai without Jenkins jobs.</span></button>
      </div>
      {choice === 'enabled' && (
        <>
        <p className="jenkins-download-note">Bankai Desktop checks for remediation PR builds while the app is open. Choose the Jenkins multibranch job for this repository below; PR branch discovery must be enabled for automatic verification and retries.</p>
        <section className="jenkins-browser-setup" aria-label="Jenkins setup">
          {!connection.connected ? <form onSubmit={(event) => void connect(event)}>
            <label htmlFor="jenkins-url">Jenkins address</label>
            <input id="jenkins-url" type="url" autoComplete="url" placeholder="https://jenkins.example.com" value={url} onChange={(event) => setUrl(event.target.value)} required />
            <label htmlFor="jenkins-username">Username</label>
            <input id="jenkins-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
            <label htmlFor="jenkins-token">API token</label>
            <input id="jenkins-token" type="password" autoComplete="new-password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} required />
            <p className="jenkins-download-note">Create an API token in Jenkins under your user settings. Bankai encrypts it in your computer’s secure credential store.</p>
            <button className="jenkins-download-cta" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect and find jobs'}</button>
          </form> : <>
            <div className="jenkins-connected-row"><div><strong>Connected to Jenkins</strong><span>{connection.url} · {connection.username}</span></div><div className="jenkins-connected-actions"><button className="jenkins-text-button" type="button" onClick={() => void openJenkinsDashboard()}>Open Jenkins</button><button className="jenkins-text-button" type="button" onClick={() => void disconnect()} disabled={busy}>Disconnect</button></div></div>
            <label htmlFor="jenkins-job">Build job</label>
            <select id="jenkins-job" value={selectedJob} onChange={(event) => chooseJob(event.target.value)} disabled={!jobs.length || busy}>
              <option value="">{jobs.length ? 'Choose a Jenkins job' : 'No jobs found on this Jenkins server'}</option>
              {jobs.map((job) => <option key={job.url} value={job.url}>{job.name}{job.supportsPullRequests ? ' · multibranch PR pipeline' : ''}</option>)}
            </select>
            <div className="jenkins-job-actions">
              <button className="jenkins-download-cta" type="button" onClick={() => void runJob()} disabled={!selectedJob || busy}>{busy ? 'Working…' : 'Run build'}</button>
              <button className="jenkins-text-button" type="button" onClick={() => void refreshJobs()} disabled={busy}>Refresh jobs</button>
            </div>
            {run && <div className={`jenkins-run-status jenkins-run-status--${run.state}`} role="status">
              <strong>{run.state === 'success' ? 'Build succeeded' : run.state === 'failure' ? 'Build failed' : run.state === 'aborted' ? 'Build was stopped' : run.state === 'running' ? 'Build is running' : 'Build is queued'}</strong>
              {run.number && <span> · #{run.number}</span>}
              {run.commitSha && <span> · commit {run.commitSha.slice(0, 10)}</span>}
              {run.durationMs && <span> · {(run.durationMs / 1000).toFixed(1)}s</span>}
              {run.timestamp && <span> · {new Date(run.timestamp).toLocaleString()}</span>}
              {run.buildUrl && <button type="button" className="jenkins-text-button" onClick={() => void openBuild()}>Open build in Bankai browser</button>}
            </div>}
          </>}
          {error && <p className="jenkins-browser-error" role="alert">{error}</p>}
          {message && <p className="jenkins-browser-status" role="status">{message}</p>}
        </section>
        <JenkinsDeploymentSetup projectId={projectId} jobs={jobs} />
        <JenkinsfileSetup projectId={projectId} />
        </>
      )}
      {choice === 'skipped' && <p className="jenkins-download-note" role="status">Jenkins is skipped for this repository. Other Bankai features remain available.</p>}
      {choice === 'unset' && <p className="jenkins-download-note">No Jenkins jobs will run until you choose Use Jenkins.</p>}
    </>
  );
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Check the connection and try again.'; }

function JenkinsfileSetup({ projectId }: { projectId: string }) {
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [inspection, setInspection] = useState<JenkinsfileInspection | null>(null);
  const [proposal, setProposal] = useState<JenkinsfileProposal | null>(null);
  const [createdPr, setCreatedPr] = useState<JenkinsfilePullRequest | null>(null);
  const [prBuildMessage, setPrBuildMessage] = useState<string | null>(null);
  const [prBuild, setPrBuild] = useState<JenkinsJobProgress | null>(null);
  const [prBuildChecking, setPrBuildChecking] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true); setError(null); setProposal(null); setCreatedPr(null);
    try {
      const github = await getGithubConnection(projectId);
      setGithubConnected(github.connected);
      if (github.connected) setInspection(await inspectJenkinsfile(projectId));
      else setInspection(null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, [projectId]);

  const generate = async () => {
    setBusy(true); setError(null); setCreatedPr(null);
    setPrBuildMessage(null); setPrBuild(null);
    try { setProposal(await generateJenkinsfileProposal(projectId)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    if (!proposal) return;
    setBusy(true); setError(null);
    try {
      setPrBuild(null);
      if (createdPr) {
        await updateJenkinsfilePullRequest(projectId, { prNumber: createdPr.pullRequest.number, branchName: createdPr.branchName, content: proposal.content });
        setPrBuildMessage('Jenkinsfile updated in the pull request. Checking Jenkins for a fresh run…');
        void runPullRequestBuild(createdPr);
      } else {
        const result = await createJenkinsfilePullRequest(projectId, { baseSha: proposal.baseSha, content: proposal.content, summary: proposal.summary, assumptions: proposal.assumptions });
        setCreatedPr(result);
        void runPullRequestBuild(result);
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const runPullRequestBuild = async (result: JenkinsfilePullRequest) => {
    const desktop = window.bankaiDesktop;
    if (!desktop) return;
    setPrBuildChecking(true);
    try {
      const connection = await desktop.getJenkinsConnection();
      if (!connection.connected) {
        setPrBuildMessage('Connect Jenkins and configure a multibranch pipeline to run this PR branch.');
        return;
      }
      const expectedNames = new Set([`pr-${result.pullRequest.number}`.toLowerCase(), result.branchName.toLowerCase()]);
      const headRef = result.pullRequest.headRef?.toLowerCase();
      if (headRef) expectedNames.add(headRef);
      setPrBuildMessage('Waiting for Jenkins to discover the new pull request branch…');
      for (let attempt = 0; attempt < 18; attempt += 1) {
        const jobs = await desktop.listJenkinsJobs();
        const prJob = jobs.find((job) => expectedNames.has(job.name.toLowerCase()));
        if (prJob) {
          setPrBuildMessage(`Starting Jenkins job ${prJob.name} for this pull request…`);
          const resultBuild = await desktop.runJenkinsJob(prJob.url);
          setPrBuild(resultBuild);
          setPrBuildMessage(resultBuild.state === 'success' ? 'The pull request build passed.' : resultBuild.state === 'failure' ? 'The pull request build failed. Review its Jenkins output and update the draft before merging.' : `The pull request build finished: ${resultBuild.state}.`);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
      }
      setPrBuildMessage('Jenkins did not expose a branch job for this PR. Configure GitHub branch discovery in the Jenkins multibranch job, then refresh Jenkins jobs.');
    } catch (reason) {
      setPrBuildMessage(`Could not run the pull request build: ${errorMessage(reason)}`);
    } finally {
      setPrBuildChecking(false);
    }
  };

  return (
    <section className="jenkinsfile-setup" aria-label="Jenkinsfile setup">
      <div className="jenkinsfile-setup-heading"><div><span className="jenkinsfile-setup-eyebrow">Repository setup</span><h2>Jenkinsfile</h2></div><button className="jenkins-text-button" type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
      {busy && !inspection && <p className="jenkins-download-note">Checking the repository’s default branch…</p>}
      {!busy && githubConnected === false && <p className="jenkins-download-note">Connect this project to GitHub before Bankai can inspect or propose a Jenkinsfile. <a href={`/workspace/${projectId}/settings`}>Open GitHub settings</a>.</p>}
      {inspection?.exists && !createdPr && !proposal && <>
        <p className="jenkins-browser-status" role="status">Found <code>{inspection.path}</code> on <code>{inspection.branch}</code>.</p>
        <p className="jenkins-download-note">This is the pipeline Jenkins will use for the repository branch. Review it here, then select the matching Jenkins job above.</p>
        <pre className="jenkinsfile-code-view">{inspection.content}</pre>
      </>}
      {inspection && !inspection.exists && !proposal && !createdPr && <>
        <p className="jenkins-download-note">No Jenkinsfile was found on <code>{inspection.branch}</code>. Bankai can inspect the manifests and existing CI files and prepare a draft for you to review.</p>
        <button className="jenkins-download-cta" type="button" onClick={() => void generate()} disabled={busy}>{busy ? 'Inspecting repository…' : 'Generate Jenkinsfile draft'}</button>
      </>}
      {proposal && <div className="jenkinsfile-proposal">
        <p className="jenkinsfile-proposal-summary">{proposal.summary}</p>
        {proposal.detectedCommands.length > 0 && <details className="jenkinsfile-detected-commands"><summary>Commands Bankai found in the repo</summary><ul>{proposal.detectedCommands.map((item) => <li key={`${item.stage}:${item.command}`}><code>{item.command}</code><span>{item.evidence}</span></li>)}</ul></details>}
        <label htmlFor="jenkinsfile-draft">Review and edit the complete Jenkinsfile</label>
        <textarea id="jenkinsfile-draft" spellCheck={false} value={proposal.content} onChange={(event) => setProposal({ ...proposal, content: event.target.value })} />
        {proposal.assumptions.length > 0 && <div className="jenkinsfile-assumptions"><strong>Assumptions to review</strong><ul>{proposal.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        <p className="jenkins-download-note">The draft uses commands found in repository manifests. It includes no deployment steps or credentials. Accepting creates a PR that adds only <code>Jenkinsfile</code>; Bankai will not merge it.</p>
        <div className="jenkins-job-actions"><button className="jenkins-download-cta" type="button" onClick={() => void accept()} disabled={busy}>{busy ? (createdPr ? 'Updating PR…' : 'Creating PR…') : (createdPr ? 'Update PR and rerun Jenkins' : 'Accept and create pull request')}</button>{!createdPr && <button className="jenkins-text-button" type="button" onClick={() => setProposal(null)} disabled={busy}>Discard draft</button>}</div>
      </div>}
      {createdPr && <div className="jenkinsfile-created-pr"><strong>Jenkinsfile pull request created</strong><span>Review the generated pipeline before merging.</span><a href={createdPr.pullRequest.url} target="_blank" rel="noreferrer">Open PR #{createdPr.pullRequest.number} on GitHub</a>{prBuildMessage && <span role="status">{prBuildMessage}</span>}{prBuildChecking && <span className="jenkins-pr-progress">Looking for the Jenkins PR branch…</span>}{prBuild?.buildUrl && <button className="jenkins-text-button" type="button" onClick={() => void window.bankaiDesktop?.openJenkins(prBuild.buildUrl!)}>Open PR build in Bankai browser</button>}{!prBuildChecking && <button className="jenkins-text-button" type="button" onClick={() => void runPullRequestBuild(createdPr)}>Check Jenkins PR job again</button>}</div>}
      {error && <p className="jenkins-browser-error" role="alert">{error}</p>}
      {!busy && githubConnected && !inspection && error && <button className="jenkins-text-button" type="button" onClick={() => void refresh()}>Try again</button>}
    </section>
  );
}
