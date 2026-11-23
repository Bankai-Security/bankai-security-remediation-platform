import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createJenkinsfilePullRequest, generateJenkinsfileProposal, getGithubConnection, getVerificationSettings, inspectJenkinsfile, recordJenkinsAuditAction, setVerificationProvider, updateJenkinsfilePullRequest, type JenkinsfileInspection, type JenkinsfileProposal, type JenkinsfilePullRequest } from '../../lib/api';
import jenkinsLogo from '../../assets/jenkins.svg';
import { useProject } from '../../lib/project-context';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import './JenkinsDownload.css';
import JenkinsDeploymentSetup from '../../components/JenkinsDeploymentSetup';
import { canEdit } from '../../lib/roles';

const downloadUrl = import.meta.env.VITE_BANKAI_DESKTOP_DOWNLOAD_URL;
type JenkinsJob = { name: string; url: string; color: string; supportsPullRequests?: boolean };
type JenkinsConnection = { connected: boolean; url?: string; username?: string };
type JenkinsJobProgress = { state: 'queued' | 'running' | 'success' | 'failure' | 'aborted'; buildUrl?: string; number?: number; timestamp?: number | null; durationMs?: number | null; commitSha?: string | null; targetUrl?: string | null; jobUrl?: string };
type JenkinsParameterDefinition = { name: string; type: string; description: string; defaultValue: string; choices: string[] };
type JenkinsBrowserBounds = { x: number; y: number; width: number; height: number };

function jenkinsBrowserBounds(expanded: boolean): JenkinsBrowserBounds {
  const width = expanded ? Math.max(420, window.innerWidth - 320) : Math.min(900, Math.max(480, Math.round(window.innerWidth * .46)));
  return { x: Math.max(0, window.innerWidth - width), y: 64, width, height: Math.max(240, window.innerHeight - 64) };
}

export default function JenkinsDownload() {
  const { project } = useProject();
  const [desktopStatus] = useState<'web' | 'desktop'>(typeof window !== 'undefined' && Boolean(window.bankaiDesktop) ? 'desktop' : 'web');
  const desktopHref = downloadUrl || 'https://github.com/anubhavgpta/bankai-security-remediation-platform/releases/latest';
  const handoffUrl = new URL(desktopHref);
  if (project?.id) handoffUrl.searchParams.set('project', project.id);
  handoffUrl.searchParams.set('source', 'web-jenkins');
  const desktopDeepLink = project?.id ? `bankai://open?project=${encodeURIComponent(project.id)}` : 'bankai://open';

  return (
      <main className="ws-page jenkins-download-page">
      <WorkspaceBreadcrumb current="Jenkins" />
      <div className="ws-divider" />
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
      openJenkins: (url: string, bounds: JenkinsBrowserBounds) => Promise<{ open: boolean; url: string }>;
      setJenkinsBrowserBounds: (bounds: JenkinsBrowserBounds) => Promise<{ open: boolean }>;
      closeJenkinsBrowser: () => Promise<{ closed: boolean }>;
      onJenkinsBrowserNavigation: (callback: (url: string) => void) => () => void;
      openExternal: (url: string) => Promise<void>;
      getJenkinsConnection: () => Promise<JenkinsConnection>;
      connectJenkins: (input: { url: string; username: string; apiToken: string; repo: string }) => Promise<JenkinsConnection & { jobs: JenkinsJob[]; pipeline: { name: string; url: string; created: boolean } }>;
      listJenkinsJobs: () => Promise<JenkinsJob[]>;
      disconnectJenkins: () => Promise<void>;
      runJenkinsJob: (url: string, parameters?: Record<string, string>) => Promise<JenkinsJobProgress>;
      resumeJenkinsJob: (jobUrl: string, buildUrl?: string | null) => Promise<JenkinsJobProgress>;
      findRecentJenkinsBuild: (jobUrl: string, since?: string | null) => Promise<{ url: string; timestamp: number } | null>;
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
  const [selectedJobSupportsPr, setSelectedJobSupportsPr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<JenkinsJobProgress | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [browserUrl, setBrowserUrl] = useState('');
  const [choice, setChoice] = useState<'unset' | 'enabled' | 'skipped'>(() => {
    try {
      const saved = localStorage.getItem(`bankai-jenkins-choice:${projectId}`);
      return saved === 'enabled' || saved === 'skipped' ? saved : 'unset';
    } catch { return 'unset'; }
  });

  useEffect(() => {
    if (!api) return;
    let active = true;
    void getVerificationSettings(projectId).then((settings) => {
      if (!active) return;
      if (settings.verification_provider === 'jenkins') {
        setChoice('enabled');
        try { localStorage.setItem(`bankai-jenkins-choice:${projectId}`, 'enabled'); } catch { /* optional preference */ }
      } else {
        setChoice('unset');
        try { localStorage.removeItem(`bankai-jenkins-choice:${projectId}`); } catch { /* optional preference */ }
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, projectId, canManage]);

  useEffect(() => {
    if (!api || !browserOpen) return;
    const updateBounds = () => { void api.setJenkinsBrowserBounds(jenkinsBrowserBounds(browserExpanded)).catch(() => undefined); };
    window.addEventListener('resize', updateBounds);
    updateBounds();
    return () => window.removeEventListener('resize', updateBounds);
  }, [api, browserOpen, browserExpanded]);

  useEffect(() => {
    if (!api) return;
    return api.onJenkinsBrowserNavigation((nextUrl) => setBrowserUrl(nextUrl));
  }, [api]);

  useEffect(() => () => { void api?.closeJenkinsBrowser().catch(() => undefined); }, [api]);

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
            setSelectedJobSupportsPr(Boolean(discovered.find((job) => job.url === savedJob)?.supportsPullRequests));
            try {
              if (discovered.find((job) => job.url === savedJob)?.supportsPullRequests) localStorage.setItem(`bankai-jenkins-pr-job:${projectId}`, savedJob);
              else localStorage.removeItem(`bankai-jenkins-pr-job:${projectId}`);
            } catch { /* optional readiness hint */ }
          } catch { /* optional convenience */ }
        }
      }
    }).catch((reason) => { if (active) setError(errorMessage(reason)); });
    const unsubscribe = api.onJenkinsJobProgress((progress) => setRun(progress));
    return () => { active = false; unsubscribe(); };
  }, [api, projectId, canManage]);

  const saveChoice = async (next: 'enabled' | 'skipped') => {
    setBusy(true); setError(null); setMessage(null);
    try {
      await setVerificationProvider(projectId, next === 'enabled' ? 'jenkins' : 'none');
      setChoice(next);
      try { localStorage.setItem(`bankai-jenkins-choice:${projectId}`, next); } catch { /* optional preference */ }
      setMessage(next === 'enabled' ? 'Jenkins selected for pull request verification.' : 'Jenkins skipped for this project.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!api) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const github = await getGithubConnection(projectId);
      if (!github.connected || !github.repo) throw new Error('Connect a GitHub repository in project settings before connecting Jenkins.');
      const result = await api.connectJenkins({ url, username, apiToken, repo: github.repo });
      void recordJenkinsAuditAction(projectId, 'connected').catch(() => undefined);
      setConnection(result); setJobs(result.jobs); setApiToken('');
      let savedJob = '';
      try { savedJob = localStorage.getItem(`bankai-jenkins-job:${projectId}`) || ''; } catch { /* optional convenience */ }
      const validSavedJob = result.jobs.find((job) => job.url === savedJob) || result.jobs.find((job) => job.url === result.pipeline.url);
      setSelectedJob(validSavedJob?.url ?? ''); setSelectedJobSupportsPr(Boolean(validSavedJob?.supportsPullRequests)); setRun(null);
      try {
        if (validSavedJob?.supportsPullRequests) localStorage.setItem(`bankai-jenkins-pr-job:${projectId}`, validSavedJob.url);
        else localStorage.removeItem(`bankai-jenkins-pr-job:${projectId}`);
      } catch { /* optional readiness hint */ }
      setMessage(`${result.pipeline.created ? 'Created' : 'Verified'} multibranch pipeline ${result.pipeline.name} for ${github.repo}. Found ${result.jobs.length} Jenkins job${result.jobs.length === 1 ? '' : 's'}.`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const refreshJobs = async () => {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      const discovered = await api.listJenkinsJobs();
      setJobs(discovered);
      const selected = discovered.find((job) => job.url === selectedJob);
      setSelectedJobSupportsPr(Boolean(selected?.supportsPullRequests));
      try {
        if (selected?.supportsPullRequests) localStorage.setItem(`bankai-jenkins-pr-job:${projectId}`, selected.url);
        else localStorage.removeItem(`bankai-jenkins-pr-job:${projectId}`);
      } catch { /* optional readiness hint */ }
      setMessage(`Found ${discovered.length} Jenkins job${discovered.length === 1 ? '' : 's'}.`);
    }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      await api.disconnectJenkins();
      await api.closeJenkinsBrowser();
      setBrowserOpen(false); setBrowserExpanded(false);
      void recordJenkinsAuditAction(projectId, 'disconnected').catch(() => undefined);
      setConnection({ connected: false }); setJobs([]); setSelectedJob(''); setSelectedJobSupportsPr(false); setApiToken(''); setRun(null); setMessage('Jenkins disconnected.');
      try { localStorage.removeItem(`bankai-jenkins-choice:${projectId}`); } catch { /* optional preference */ }
      try { localStorage.removeItem(`bankai-jenkins-job:${projectId}`); } catch { /* optional preference */ }
      try { localStorage.removeItem(`bankai-jenkins-pr-job:${projectId}`); } catch { /* optional preference */ }
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
    setSelectedJobSupportsPr(Boolean(jobs.find((job) => job.url === value)?.supportsPullRequests));
    try { localStorage.setItem(`bankai-jenkins-job:${projectId}`, value); } catch { /* optional convenience */ }
    try {
      if (jobs.find((job) => job.url === value)?.supportsPullRequests) localStorage.setItem(`bankai-jenkins-pr-job:${projectId}`, value);
      else localStorage.removeItem(`bankai-jenkins-pr-job:${projectId}`);
    } catch { /* optional readiness hint */ }
    if (value && choice === 'enabled') {
      try { localStorage.setItem(`bankai-jenkins-choice:${projectId}`, 'enabled'); } catch { /* optional preference */ }
    }
    if (value) void recordJenkinsAuditAction(projectId, 'ci_job_selected').catch(() => undefined);
  };
  const openJenkinsInApp = async (targetUrl: string) => {
    if (!api) return;
    setBrowserUrl(targetUrl);
    setBrowserExpanded(false);
    setBrowserOpen(true);
    try {
      await api.openJenkins(targetUrl, jenkinsBrowserBounds(false));
      setError(null);
    } catch (reason) {
      setBrowserOpen(false);
      setError(errorMessage(reason));
    }
  };
  const closeJenkinsInApp = async () => {
    await api?.closeJenkinsBrowser().catch(() => undefined);
    setBrowserOpen(false);
    setBrowserExpanded(false);
  };
  const openBuild = async () => {
    if (run?.buildUrl) await openJenkinsInApp(run.buildUrl);
  };
  const openJenkinsDashboard = async () => {
    if (!connection.url) return;
    await openJenkinsInApp(connection.url);
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
            <label htmlFor="jenkins-job-trigger">Build job</label>
            <JenkinsJobPicker jobs={jobs} value={selectedJob} onChange={chooseJob} disabled={!jobs.length || busy} />
            <div className="jenkins-job-actions">
              <button className="jenkins-download-cta" type="button" onClick={() => void runJob()} disabled={!selectedJob || busy}>{busy ? 'Working…' : 'Run build'}</button>
              <button className="jenkins-text-button" type="button" onClick={() => void refreshJobs()} disabled={busy}>Refresh jobs</button>
            </div>
            {selectedJob && !selectedJobSupportsPr && <p className="jenkins-download-note" role="status">This job can run manually, but it is not detected as a multibranch PR job. Select a multibranch pipeline with pull request discovery for automatic ticket verification.</p>}
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
        <JenkinsfileSetup projectId={projectId} onOpenJenkins={openJenkinsInApp} />
        </>
      )}
      {choice === 'skipped' && <p className="jenkins-download-note" role="status">Jenkins is skipped for this repository. Other Bankai features remain available.</p>}
      {choice === 'unset' && <p className="jenkins-download-note">No Jenkins jobs will run until you choose Use Jenkins.</p>}
      {browserOpen && <div className="jenkins-in-app-browser-toolbar" style={{ width: jenkinsBrowserBounds(browserExpanded).width }}>
        <div className="jenkins-in-app-browser-heading"><span className="jenkins-in-app-browser-dot" /><span>Jenkins browser</span><span className="jenkins-in-app-browser-url" title={browserUrl}>{browserUrl}</span></div>
        <div className="jenkins-in-app-browser-controls">
          <button type="button" aria-label={browserExpanded ? 'Restore Jenkins browser size' : 'Expand Jenkins browser'} title={browserExpanded ? 'Restore size' : 'Expand'} onClick={() => setBrowserExpanded((value) => !value)}>{browserExpanded ? '↙' : '↗'}</button>
          <button type="button" aria-label="Close Jenkins browser" title="Close" onClick={() => void closeJenkinsInApp()}>×</button>
        </div>
      </div>}
    </>
  );
}

function JenkinsJobPicker({ jobs, value, onChange, disabled }: { jobs: JenkinsJob[]; value: string; onChange: (url: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = jobs.find((job) => job.url === value);
  const filtered = jobs.filter((job) => job.name.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(Math.max(0, jobs.findIndex((job) => job.url === value)));
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [open, jobs, value]);

  const choose = (job: JenkinsJob) => {
    onChange(job.url);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]!);
    } else if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="jenkins-job-picker" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        id="jenkins-job-trigger"
        ref={triggerRef}
        className={`jenkins-job-picker-trigger${open ? ' jenkins-job-picker-trigger--open' : ''}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="jenkins-job-listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected ? '' : 'jenkins-job-picker-placeholder'}>{selected?.name || (jobs.length ? 'Choose a Jenkins job' : 'No jobs found on this Jenkins server')}</span>
        {selected && <span className="jenkins-job-picker-summary">{selected.supportsPullRequests ? 'Multibranch PR pipeline' : 'Manual builds only'}</span>}
        <svg className={`jenkins-job-picker-chevron${open ? ' jenkins-job-picker-chevron--open' : ''}`} width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="m1 1.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="jenkins-job-picker-menu">
          <div className="jenkins-job-picker-search-wrap">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8" stroke="currentColor" strokeWidth="1.5"/><path d="m13.2 13.2 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <input ref={searchRef} className="jenkins-job-picker-search" type="search" aria-label="Search Jenkins jobs" placeholder="Search Jenkins jobs…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} />
          </div>
          <div id="jenkins-job-listbox" className="jenkins-job-picker-options" role="listbox" aria-label="Jenkins jobs">
            {filtered.length ? filtered.map((job, index) => (
              <button
                key={job.url}
                type="button"
                role="option"
                aria-selected={job.url === value}
                className={`jenkins-job-picker-option${job.url === value ? ' jenkins-job-picker-option--selected' : ''}${index === activeIndex ? ' jenkins-job-picker-option--active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(job)}
              >
                <span className="jenkins-job-picker-option-copy"><span className="jenkins-job-picker-option-name">{job.name}</span><span className="jenkins-job-picker-option-type">{job.supportsPullRequests ? 'Multibranch PR pipeline' : 'Manual builds only'}</span></span>
                {job.url === value && <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8.5 3.2 3.1L13 4.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </button>
            )) : <div className="jenkins-job-picker-empty">No Jenkins jobs match “{query}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Check the connection and try again.'; }

function JenkinsfileSetup({ projectId, onOpenJenkins }: { projectId: string; onOpenJenkins: (url: string) => Promise<void> }) {
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
      {createdPr && <div className="jenkinsfile-created-pr"><strong>Jenkinsfile pull request created</strong><span>Review the generated pipeline before merging.</span><a href={createdPr.pullRequest.url} target="_blank" rel="noreferrer">Open PR #{createdPr.pullRequest.number} on GitHub</a>{prBuildMessage && <span role="status">{prBuildMessage}</span>}{prBuildChecking && <span className="jenkins-pr-progress">Looking for the Jenkins PR branch…</span>}{prBuild?.buildUrl && <button className="jenkins-text-button" type="button" onClick={() => void onOpenJenkins(prBuild.buildUrl!)}>Open PR build in Bankai browser</button>}{!prBuildChecking && <button className="jenkins-text-button" type="button" onClick={() => void runPullRequestBuild(createdPr)}>Check Jenkins PR job again</button>}</div>}
      {error && <p className="jenkins-browser-error" role="alert">{error}</p>}
      {!busy && githubConnected && !inspection && error && <button className="jenkins-text-button" type="button" onClick={() => void refresh()}>Try again</button>}
    </section>
  );
}
