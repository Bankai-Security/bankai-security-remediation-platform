import { useState } from 'react';
import { useProject } from '../../lib/project-context';
import './JenkinsDownload.css';

const downloadUrl = import.meta.env.VITE_BANKAI_DESKTOP_DOWNLOAD_URL;

function JenkinsMark({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? 'jenkins-download-mark jenkins-download-mark--large' : 'jenkins-download-mark'} viewBox="0 0 24 24" role="img" aria-label="Jenkins">
      <path fill="#D33833" d="M11.95 1.2c-1.65 0-2.56 2.19-2.56 4.06 0 1.19.49 2.14 1.17 2.58l-.31 1.42-3.2 1.08c-.54.18-.98.62-1.17 1.16l-1.1 3.08c-.15.42-.09.88.16 1.24l1.65 2.35c.28.4.74.62 1.22.58l3.98-.32.47 1.02-1.55 2.22a.9.9 0 0 0 .74 1.42h2.93a.9.9 0 0 0 .74-1.42l-1.55-2.22.47-1.02 3.98.32c.48.04.94-.18 1.22-.58l1.65-2.35c.25-.36.31-.82.16-1.24l-1.1-3.08a1.72 1.72 0 0 0-1.17-1.16l-3.2-1.08-.31-1.42c.68-.44 1.17-1.39 1.17-2.58 0-1.87-.91-4.06-2.56-4.06h-.93Z" />
      <circle cx="10.4" cy="5" r=".55" fill="#fff" /><circle cx="13.55" cy="5" r=".55" fill="#fff" />
      <path d="M10.7 13.2c.85.55 1.75.55 2.6 0" fill="none" stroke="#fff" strokeWidth=".8" strokeLinecap="round" />
    </svg>
  );
}

export default function JenkinsDownload() {
  const { project } = useProject();
  const [desktopStatus] = useState<'web' | 'desktop'>(
    typeof window !== 'undefined' && Boolean(window.bankaiDesktop) ? 'desktop' : 'web',
  );
  const desktopHref = downloadUrl || 'https://github.com/anubhavgpta/bankai-security-remediation-platform/releases/latest';
  const handoffUrl = new URL(desktopHref);
  if (project?.id) handoffUrl.searchParams.set('project', project.id);
  handoffUrl.searchParams.set('source', 'web-jenkins');
  const desktopDeepLink = project?.id ? `bankai://open?project=${encodeURIComponent(project.id)}` : 'bankai://open';

  return (
    <main className="ws-page ws-page--narrow jenkins-download-page">
      <div className="jenkins-download-card">
        <div className="jenkins-download-icon"><JenkinsMark large /></div>
        <div className="jenkins-download-eyebrow">BANKAI DESKTOP</div>
        <h1 className="jenkins-download-title">Run Jenkins from Bankai</h1>
        {desktopStatus === 'desktop' ? (
          <DesktopJenkinsOptions projectId={project?.id ?? ''} />
        ) : (
          <>
            <p className="jenkins-download-copy">
              Connect Jenkins, run builds, and follow deployment results from the Bankai desktop app.
              Your repository workspace will be ready when you open it there.
            </p>

            <a className="jenkins-download-cta" href={handoffUrl.toString()}>
          Download Bankai Desktop
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 13.5v2A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
            </a>
            <a className="jenkins-desktop-existing-link" href={desktopDeepLink}>Already installed? Open Bankai Desktop</a>
            <p className="jenkins-download-note">Jenkins runs in the desktop app. Scanning, triage, remediation, and PR review remain available here.</p>
            <div className="jenkins-download-project">
              <span className="jenkins-download-project-dot" />
              {project?.name ?? 'Current project'}
              <span className="jenkins-download-project-context">will be included when you continue</span>
            </div>
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
      platform: string;
    };
  }
}

function DesktopJenkinsOptions({ projectId }: { projectId: string }) {
  const [jenkinsUrl, setJenkinsUrl] = useState(() => {
    try { return localStorage.getItem('bankai-jenkins-url') ?? ''; } catch { return ''; }
  });
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserStatus, setBrowserStatus] = useState<string | null>(null);
  const [choice, setChoice] = useState<'unset' | 'enabled' | 'skipped'>(() => {
    try {
      const saved = localStorage.getItem(`bankai-jenkins-choice:${projectId}`);
      return saved === 'enabled' || saved === 'skipped' ? saved : 'unset';
    } catch {
      return 'unset';
    }
  });

  const saveChoice = (next: 'enabled' | 'skipped') => {
    setChoice(next);
    try {
      localStorage.setItem(`bankai-jenkins-choice:${projectId}`, next);
    } catch { /* session choice still works if storage is unavailable */ }
  };

  const saveJenkinsUrl = (value: string) => {
    setJenkinsUrl(value);
    setBrowserError(null);
    try { localStorage.setItem('bankai-jenkins-url', value); } catch { /* keep in memory */ }
  };

  const openJenkins = async () => {
    try {
      const parsed = new URL(jenkinsUrl);
      if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) {
        throw new Error('Use an HTTPS address, or a localhost address for local Jenkins.');
      }
      await window.bankaiDesktop?.openJenkins(parsed.toString());
      setBrowserStatus('Jenkins opened in the Bankai browser. Sign in there to continue.');
      setBrowserError(null);
    } catch (error) {
      setBrowserStatus(null);
      setBrowserError(error instanceof Error ? error.message : 'Could not open Jenkins. Check the address and try again.');
    }
  };

  return (
    <>
      <p className="jenkins-download-copy">Choose whether Bankai should use your local Jenkins setup for this repository. You can change this later.</p>
      <div className="jenkins-choice-group" role="group" aria-label="Jenkins preference">
        <button className={`jenkins-choice-card ${choice === 'enabled' ? 'jenkins-choice-card--selected' : ''}`} onClick={() => saveChoice('enabled')}>
          <strong>Use Jenkins</strong><span>Run builds and configured deployment jobs from this desktop app.</span>
        </button>
        <button className={`jenkins-choice-card ${choice === 'skipped' ? 'jenkins-choice-card--selected' : ''}`} onClick={() => saveChoice('skipped')}>
          <strong>Skip Jenkins</strong><span>Keep using Bankai without local Jenkins jobs.</span>
        </button>
      </div>
      {choice === 'enabled' && (
        <div className="jenkins-browser-setup">
          <label htmlFor="jenkins-url">Jenkins address</label>
          <input id="jenkins-url" type="url" placeholder="https://jenkins.example.com" value={jenkinsUrl} onChange={(event) => saveJenkinsUrl(event.target.value)} />
          <p className="jenkins-download-note">Jenkins opens in a separate Bankai window. Sign in there with your Jenkins account. Bankai does not receive your Jenkins password.</p>
          {browserError && <p className="jenkins-browser-error" role="alert">{browserError}</p>}
          {browserStatus && <p className="jenkins-browser-status" role="status">{browserStatus}</p>}
          <button className="jenkins-download-cta" onClick={() => void openJenkins()} disabled={!jenkinsUrl.trim()}>
            Open Jenkins in Bankai
          </button>
        </div>
      )}
      {choice === 'skipped' && <p className="jenkins-download-note" role="status">Jenkins is skipped for this repository. Other Bankai features remain available.</p>}
      {choice === 'unset' && <p className="jenkins-download-note">No Jenkins jobs will run until you choose Use Jenkins.</p>}
    </>
  );
}
