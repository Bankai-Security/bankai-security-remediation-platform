import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const defaultSettings = { bankaiUrl: '', quincyUrl: 'http://127.0.0.1:8000', quincyPath: '', caPath: '', allowedRepositories: '' };

function Mark({ small = false }) {
  return <span className={`brand-mark ${small ? 'brand-mark--small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 2.8 28 8v8.5c0 7.5-5.2 11.2-12 14.2C9.2 27.7 4 24 4 16.5V8l12-5.2Z" fill="currentColor"/><path d="m10.2 16.4 3.8 3.8 7.8-8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

function Icon({ name }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    plug: <><path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-4-8h8"/></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="18" r=".8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V4a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" transform="translate(-1 -1) scale(.95)"/></>,
    external: <><path d="M13 5h6v6m0-6-9 9"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>,
    play: <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function StatusDot({ ready, label }) { return <span className={`status-pill ${ready ? 'is-ready' : ''}`}><i />{label}</span>; }

function App() {
  const [page, setPage] = useState('overview');
  const [settings, setSettings] = useState(defaultSettings);
  const [state, setState] = useState({ paired: false, runnerActive: false, dockerReady: false, jenkinsReady: false, quincyReady: false, jenkinsRunning: false, quincyRunning: false, quincyPathReady: false });
  const [pairCode, setPairCode] = useState('');
  const [quincyToken, setQuincyToken] = useState('');
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    const next = await window.companion.getState();
    setSettings(next.settings || defaultSettings);
    setState(next);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const removeListener = window.companion.onEvent((event) => {
      if (event.type === 'log') setLogs((items) => [...items.slice(-99), event]);
      if (event.type === 'service') void refresh().catch(() => {});
    });
    const timer = window.setInterval(() => void refresh().catch(() => {}), 8000);
    return () => { removeListener(); window.clearInterval(timer); };
  }, [refresh]);

  const runAction = async (name, action, success) => {
    setBusy(name); setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The action could not be completed.'); }
    finally { setBusy(''); }
  };

  const update = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const save = () => runAction('save', async () => { const saved = await window.companion.saveSettings(settings); setSettings(saved); }, 'Settings saved on this computer.');
  const choosePath = async (field, action) => { const value = await window.companion[action](); if (value) update(field, value); };
  const setupComplete = state.paired && settings.quincyPath && settings.allowedRepositories;
  const readiness = useMemo(() => [
    { label: 'Docker Desktop', ready: state.dockerReady, detail: state.dockerReady ? 'Engine reachable' : 'Start Docker Desktop' },
    { label: 'Local Jenkins', ready: state.jenkinsReady, detail: state.jenkinsReady ? 'HTTPS connection verified' : 'Start the isolated stack' },
    { label: 'Quincy API', ready: state.quincyReady, detail: state.quincyReady ? 'Local API responding' : 'Start the local service' },
    { label: 'Bankai link', ready: state.paired, detail: state.paired ? 'This computer is paired' : 'Pair with a workspace' },
  ], [state]);

  const pair = () => runAction('pair', async () => {
    const caPath = settings.caPath || `${settings.quincyPath}\\tools\\local-jenkins\\.local\\certs\\jenkins.crt`;
    await window.companion.pair({ settings, pairingCode: pairCode, quincyToken, caPath });
    setPairCode(''); setQuincyToken('');
  }, 'This computer is paired with Bankai.');

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Mark /><div><strong>BANKAI</strong><span>LOCAL COMPANION</span></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="nav-list" aria-label="Main navigation">
        {[['overview', 'Overview', 'grid'], ['connections', 'Connections', 'plug'], ['activity', 'Activity', 'list'], ['settings', 'Settings', 'settings']].map(([id, label, icon]) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span>{id === 'connections' && <b className={state.paired ? 'nav-count good' : 'nav-count'}>{state.paired ? '1' : '!'}</b>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-health"><span className={`health-orb ${state.runnerActive ? 'pulse' : ''}`} /><div><strong>{state.runnerActive ? 'Companion running' : 'Companion stopped'}</strong><small>{state.paired ? 'Paired to Bankai' : 'Setup required'}</small></div></div><span className="version-label">Version 0.1.0 · Developer preview</span></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><Mark small /><span>Companion</span><Icon name="arrow" /><strong>{page[0].toUpperCase() + page.slice(1)}</strong></div><div className="topbar-actions"><StatusDot ready={state.runnerActive} label={state.runnerActive ? 'Listening for runs' : 'Not listening'} /><button className="button button-soft button-sm" onClick={() => void runAction('bankai', () => window.companion.openBankai())}>Open Bankai <Icon name="external" /></button></div></header>

      <div className="page-content">
        {(error || notice) && <div className={`notice ${error ? 'notice-error' : 'notice-success'}`} role={error ? 'alert' : 'status'}>{error || notice}<button onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss message">×</button></div>}

        {page === 'overview' && <>
          <section className="welcome-row"><div><div className="eyebrow">LOCAL VERIFICATION</div><h1>Your Jenkins workspace</h1><p>Run selected Bankai remediations through Quincy and Jenkins on this computer.</p></div><div className="welcome-actions"><button className="button button-soft" onClick={() => void refresh()}><span className="refresh-mark">↻</span> Refresh status</button><button className="button button-primary" disabled={!state.paired || state.runnerActive} onClick={() => void runAction('runner', () => window.companion.startRunner(), 'The companion is now listening for selected runs.')}><Icon name="play" /> Start companion</button></div></section>
          <div className="trust-banner"><span className="trust-icon"><Icon name="check" /></span><div><strong>Runs stay on your computer</strong><p>Jenkins remains private on localhost. Bankai receives the validated result and evidence; local passes are labeled as local evidence.</p></div><button className="text-button" onClick={() => setPage('connections')}>View connections <Icon name="arrow" /></button></div>
          <section className="section-block"><div className="section-heading"><div><h2>Readiness</h2><p>All local services must be ready before a task can start.</p></div><span className="updated-label">Updated just now</span></div><div className="readiness-grid">{readiness.map((item) => <div className="readiness-card" key={item.label}><div className="readiness-icon"><Icon name={item.ready ? 'check' : item.label === 'Docker Desktop' ? 'settings' : 'plug'} /></div><div className="readiness-copy"><strong>{item.label}</strong><span>{item.detail}</span></div><span className={`readiness-state ${item.ready ? 'ready' : ''}`}>{item.ready ? 'Ready' : 'Setup'}</span></div>)}</div></section>
          <section className="section-block"><div className="section-heading"><div><h2>Get started</h2><p>Set up your local verification environment in a few steps.</p></div></div><div className="setup-grid">
            <article className={`setup-card ${state.paired ? 'complete' : 'current'}`}><div className="step-top"><span className="step-number">{state.paired ? <Icon name="check" /> : '01'}</span><span className="step-tag">{state.paired ? 'CONNECTED' : 'ACCOUNT'}</span></div><h3>Connect to Bankai</h3><p>Pair this computer to the workspace that owns the remediation.</p><button className="text-button" onClick={() => setPage('connections')}>{state.paired ? 'Manage connection' : 'Set up connection'} <Icon name="arrow" /></button></article>
            <article className={`setup-card ${state.dockerReady && state.jenkinsReady && state.quincyReady ? 'complete' : ''}`}><div className="step-top"><span className="step-number">{state.dockerReady && state.jenkinsReady && state.quincyReady ? <Icon name="check" /> : '02'}</span><span className="step-tag">LOCAL SERVICES</span></div><h3>Prepare Jenkins & Quincy</h3><p>Start the pinned Jenkins stack and the local Quincy API.</p><button className="text-button" onClick={() => setPage('connections')}>Open connections <Icon name="arrow" /></button></article>
            <article className={`setup-card ${state.runnerActive ? 'complete' : ''}`}><div className="step-top"><span className="step-number">{state.runnerActive ? <Icon name="check" /> : '03'}</span><span className="step-tag">READY</span></div><h3>Listen for a run</h3><p>Start the companion, then select Run with Jenkins in Bankai.</p><button className="text-button" onClick={() => state.runnerActive ? setPage('activity') : void runAction('runner', () => window.companion.startRunner(), 'The companion is listening.')}>{state.runnerActive ? 'View activity' : 'Start companion'} <Icon name="arrow" /></button></article>
          </div></section>
          <section className="tip-row"><div className="tip-icon">i</div><div><strong>Local passes are developer evidence</strong><p>A run on a user-controlled machine does not mark a remediation VERIFIED or publish trusted GitHub success.</p></div><button className="text-button" onClick={() => void runAction('jenkins-window', () => window.companion.openJenkins())}>Open Jenkins <Icon name="external" /></button></section>
        </>}

        {page === 'connections' && <>
          <section className="welcome-row"><div><div className="eyebrow">SETUP</div><h1>Connections & readiness</h1><p>Configure the Bankai workspace and the local services that run verification.</p></div><button className="button button-soft" onClick={() => void refresh()}>↻ Recheck readiness</button></section>
          <div className="connection-layout"><section className="panel"><div className="panel-heading"><span className="panel-icon"><Mark small /></span><div><h2>Bankai workspace</h2><p>Secure outbound connection to your Bankai backend.</p></div><StatusDot ready={state.paired} label={state.paired ? 'Paired' : 'Not paired'} /></div>
            <label className="field"><span>Bankai backend URL</span><input value={settings.bankaiUrl} onChange={(e) => update('bankaiUrl', e.target.value)} placeholder="https://bankai-backend-staging.up.railway.app" autoComplete="url" /></label>
            {!state.paired && <><div className="field-row"><label className="field"><span>One-time pairing code</span><input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="Paste the code from Jenkins Verification" autoComplete="one-time-code" /></label><label className="field"><span>Local Quincy service token</span><div className="input-with-button"><input type="password" value={quincyToken} onChange={(e) => setQuincyToken(e.target.value)} placeholder="Generated here or enter an existing token" autoComplete="new-password" /><button type="button" className="button button-soft button-sm" onClick={() => void window.companion.generateServiceToken().then(setQuincyToken).catch((e) => setError(e.message))}>Generate</button></div><small>Saved in Windows Credential Manager, not in this app's settings.</small></label></div><label className="field"><span>Jenkins TLS certificate</span><div className="input-with-button"><input value={settings.caPath || (settings.quincyPath ? `${settings.quincyPath}\\tools\\local-jenkins\\.local\\certs\\jenkins.crt` : '')} readOnly placeholder="Select Quincy folder to fill this automatically" /><button className="button button-soft button-sm" onClick={() => void choosePath('caPath', 'chooseCertificate')}>Browse</button></div><small>Generated by the Quincy local Jenkins setup. The certificate is validated; TLS verification is not disabled.</small></label><div className="form-footer"><button className="button button-primary" disabled={busy === 'pair'} onClick={() => void pair()}>{busy === 'pair' ? 'Pairing…' : 'Pair this computer'}</button><span className="form-note">Code expires after 10 minutes and can only be used once.</span></div></>}
            {state.paired && <div className="paired-state"><span className="paired-check"><Icon name="check" /></span><div><strong>This computer is paired</strong><p>Runner ID {state.runnerId}. Revoke it from the Jenkins Verification page in Bankai.</p></div></div>}
          </section>
          <section className="panel"><div className="panel-heading"><span className="panel-icon panel-icon-blue"><Icon name="plug" /></span><div><h2>Local services</h2><p>Jenkins and Quincy stay bound to this computer.</p></div></div>
            <label className="field"><span>Quincy repository folder</span><div className="input-with-button"><input value={settings.quincyPath} onChange={(e) => update('quincyPath', e.target.value)} placeholder="Select the quincy-security-engine folder" /><button className="button button-soft button-sm" onClick={() => void choosePath('quincyPath', 'chooseQuincyDirectory')}>Browse</button></div><small>{state.quincyPathReady ? 'Python virtual environment found.' : 'Folder must include .venv and tools/local-jenkins.'}</small></label>
            <label className="field"><span>Local Quincy API URL</span><input value={settings.quincyUrl} onChange={(e) => update('quincyUrl', e.target.value)} placeholder="http://127.0.0.1:8000" /></label>
            <label className="field"><span>Allowed repositories</span><textarea rows="3" value={settings.allowedRepositories} onChange={(e) => update('allowedRepositories', e.target.value)} placeholder={'owner/repository\nanother-owner/repository'} /><small>Exact public GitHub owner/repo values, one per line. Quincy rejects repositories outside this list.</small></label>
            <div className="service-controls"><div className="service-row"><div><strong>Jenkins</strong><small>{state.jenkinsReady ? 'Healthy · https://localhost:8443' : 'Pinned local controller and agent'}</small></div><StatusDot ready={state.jenkinsReady} label={state.jenkinsReady ? 'Ready' : 'Stopped'} /><button className="button button-soft button-sm" disabled={busy === 'jenkins-start' || !settings.quincyPath} onClick={() => void runAction('jenkins-start', async () => { await window.companion.saveSettings(settings); await window.companion.startJenkins(); }, 'Jenkins startup requested. Watch Activity for setup progress.')}>{state.jenkinsReady ? 'Check stack' : 'Start'}</button><button className="button button-quiet button-sm" disabled={!state.jenkinsReady} onClick={() => void runAction('jenkins-stop', () => window.companion.stopJenkins(), 'Jenkins stop requested.')}>Stop</button><button className="button button-quiet button-sm" disabled={!state.jenkinsReady} onClick={() => void runAction('jenkins-window', () => window.companion.openJenkins())}>Open UI</button></div>
              <div className="service-row"><div><strong>Quincy API</strong><small>{state.quincyRunning ? 'Managed by this companion' : state.quincyReady ? 'Already running · 127.0.0.1:8000' : 'Local Jenkins verification API'}</small></div><StatusDot ready={state.quincyReady} label={state.quincyReady ? 'Ready' : 'Stopped'} /><button className="button button-soft button-sm" disabled={busy === 'quincy-start' || busy === 'quincy-stop' || !state.paired || !state.jenkinsReady || (state.quincyReady && !state.quincyRunning)} onClick={() => void runAction(state.quincyRunning ? 'quincy-stop' : 'quincy-start', async () => { if (state.quincyRunning) await window.companion.stopQuincy(); else { await window.companion.saveSettings(settings); await window.companion.startQuincy(); } }, state.quincyRunning ? 'Quincy stop requested.' : 'Quincy startup requested.')}>{state.quincyRunning ? 'Stop' : state.quincyReady ? 'Connected' : 'Start'}</button></div>
            </div>
            <div className="form-footer"><button className="button button-soft" disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save local settings'}</button><span className="form-note">Secrets are not saved in this settings file.</span></div>
          </section></div>
          <div className="security-note"><strong>Credential handling</strong><span>The Bankai runner token and Quincy service token are kept in Windows Credential Manager. Jenkins credentials are generated by the isolated local stack and passed only to the local Quincy process.</span></div>
        </>}

        {page === 'activity' && <>
          <section className="welcome-row"><div><div className="eyebrow">LIVE STATUS</div><h1>Activity</h1><p>Recent local companion events and service startup output.</p></div><div className="welcome-actions">{state.runnerActive ? <button className="button button-danger-soft" onClick={() => void runAction('runner-stop', () => window.companion.stopRunner(), 'Stop requested. The active verification will be cancelled safely.') }><Icon name="stop" /> Stop companion</button> : <button className="button button-primary" disabled={!state.paired} onClick={() => void runAction('runner-start', () => window.companion.startRunner(), 'The companion is listening.') }><Icon name="play" /> Start companion</button>}<button className="button button-quiet" onClick={() => setLogs([])}>Clear log</button></div></section>
          <section className="panel activity-panel"><div className="panel-heading activity-heading"><div><h2>Local event log</h2><p>Secrets are not written to the activity view.</p></div><StatusDot ready={state.runnerActive} label={state.runnerActive ? 'Live' : 'Idle'} /></div><div className="event-list">{logs.length === 0 ? <div className="empty-state"><span className="empty-symbol">⌁</span><strong>No activity yet</strong><p>Start Jenkins, Quincy, or the companion to see local status here.</p></div> : logs.map((item, index) => <div key={`${item.at}-${index}`} className="event-row"><span className={`event-level ${item.level === 'error' ? 'event-error' : ''}`} /><time>{new Date(item.at).toLocaleTimeString()}</time><span className="event-source">{item.source}</span><p>{item.message}</p></div>)}</div></section>
        </>}

        {page === 'settings' && <>
          <section className="welcome-row"><div><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Local configuration for the companion on this Windows account.</p></div></section>
          <section className="panel settings-panel"><div className="panel-heading"><span className="panel-icon"><Icon name="settings" /></span><div><h2>Verification defaults</h2><p>These values stay on this computer and can be changed any time.</p></div></div><label className="field"><span>Bankai backend</span><input value={settings.bankaiUrl} onChange={(e) => update('bankaiUrl', e.target.value)} placeholder="https://your-bankai-backend" /></label><label className="field"><span>Quincy local API</span><input value={settings.quincyUrl} onChange={(e) => update('quincyUrl', e.target.value)} /></label><label className="field"><span>Quincy checkout</span><div className="input-with-button"><input value={settings.quincyPath} onChange={(e) => update('quincyPath', e.target.value)} placeholder="Local repository folder" /><button className="button button-soft button-sm" onClick={() => void choosePath('quincyPath', 'chooseQuincyDirectory')}>Browse</button></div></label><label className="field"><span>Repository allowlist</span><textarea rows="4" value={settings.allowedRepositories} onChange={(e) => update('allowedRepositories', e.target.value)} placeholder="owner/repository" /></label><button className="button button-primary" disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></section>
          <section className="security-note"><strong>Local evidence only</strong><span>Bankai Companion does not promote a remediation to VERIFIED based on a user-controlled computer. A local pass remains informational evidence until a trusted verification policy accepts it.</span></section>
        </>}
        <footer className="page-footer"><span><Mark small /> Bankai Companion</span><span>Local verification · Windows</span></footer>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
