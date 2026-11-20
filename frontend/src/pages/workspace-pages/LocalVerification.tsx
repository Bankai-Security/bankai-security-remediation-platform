import { useCallback, useEffect, useState } from 'react';
import WorkspaceBreadcrumb from '../../components/WorkspaceBreadcrumb';
import { cancelLocalVerification, chooseLocalVerification, createLocalRunnerPairingCode, downloadLocalVerificationArtifact, listLocalVerification, revokeLocalRunner, type LocalRunnerInstallation, type LocalVerificationEligible, type LocalVerificationTask } from '../../lib/api';
import { useProject } from '../../lib/project-context';

function shortSha(value: string) { return value.slice(0, 12); }

export default function LocalVerification() {
  const { project } = useProject();
  const [tasks, setTasks] = useState<LocalVerificationTask[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [runners, setRunners] = useState<LocalRunnerInstallation[]>([]);
  const [eligible, setEligible] = useState<LocalVerificationEligible[]>([]);
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      const result = await listLocalVerification(project.id);
      setTasks(result.tasks);
      setRunners(result.runners);
      setEligible(result.eligible);
      setEnabled(result.enabled && result.dispatch_enabled);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load verification history.');
    } finally { setLoading(false); }
  }, [project]);

  useEffect(() => { void refresh(); }, [refresh]);

  const cancel = async (task: LocalVerificationTask) => {
    if (!project) return;
    setBusyId(task.id);
    try { await cancelLocalVerification(project.id, task.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not request cancellation.'); }
    finally { setBusyId(null); }
  };

  const pair = async () => {
    if (!project) return;
    try {
      const result = await createLocalRunnerPairingCode(project.id);
      setPairingCode({ code: result.pairing_code, expiresAt: result.expires_at });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create a pairing code.'); }
  };

  const revoke = async (runner: LocalRunnerInstallation) => {
    if (!project) return;
    setBusyId(runner.id);
    try { await revokeLocalRunner(project.id, runner.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke the companion.'); }
    finally { setBusyId(null); }
  };

  const choose = async (remediation: LocalVerificationEligible, choice: 'run' | 'skip') => {
    if (!project) return;
    setBusyId(remediation.id);
    try { await chooseLocalVerification(project.id, remediation.id, choice); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the verification choice.'); }
    finally { setBusyId(null); }
  };

  const downloadArtifact = async (task: LocalVerificationTask, name: 'build-log' | 'test-report' | 'scan-evidence') => {
    if (!project) return;
    setBusyId(`${task.id}:${name}`);
    try {
      const blob = await downloadLocalVerificationArtifact(project.id, task.id, name);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${task.execution_id}-${name}.bin`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not download verification evidence.'); }
    finally { setBusyId(null); }
  };

  if (loading) return <main className="ws-page">Loading local verification…</main>;
  return (
    <main className="ws-page">
      <WorkspaceBreadcrumb current="Jenkins Verification" />
      <div className="ws-divider" />
      <div className="ws-header-row">
        <div><div className="ws-header-eyebrow">Remediation evidence</div><h1 className="ws-header-title">Jenkins Verification</h1></div>
      </div>
      <section className="ws-card" aria-labelledby="local-verification-state">
        <div className="ws-card-eyebrow">Local runner</div>
        <h2 className="ws-card-title" id="local-verification-state">{enabled ? 'Runner dispatch enabled' : 'Companion setup is not available yet'}</h2>
        <p className="ws-card-hint">
          Local Jenkins verification is optional. A local pass records evidence and provenance, but does not promote the remediation to Bankai VERIFIED.
        </p>
        <p className="ws-card-hint">
          Dispatch follows the server feature flag. A run is bound to the current remediation attempt and commit. Local results remain informational until the trusted verification policy accepts them.
        </p>
        {!enabled && <span className="ws-badge">Not available</span>}
        <div style={{ marginTop: 16 }}>
          <button className="ws-btn ws-btn-secondary" onClick={() => void pair()}>Create one-time pairing code</button>
          <p className="ws-card-hint" style={{ marginTop: 8 }}>Pairing codes are single-use and expire after ten minutes. The companion requires a local Quincy verification service and the isolated Jenkins stack.</p>
          {pairingCode && <div role="status" className="ws-card" style={{ marginTop: 12 }}><strong>{pairingCode.code}</strong><div className="ws-card-hint">Expires {new Date(pairingCode.expiresAt).toLocaleString()}. This code is shown once.</div></div>}
        </div>
      </section>
      {error && <div role="alert" className="ws-card" style={{ marginTop: 16 }}>{error}</div>}
      <section style={{ marginTop: 24 }}>
        <h2 className="ws-card-title">Choose verification</h2>
        {eligible.length === 0 ? <p className="ws-card-hint">No current remediation attempts are waiting for a local verification choice.</p> : <div className="ws-card" style={{ display: 'grid', gap: 12 }}>
          {eligible.map((item) => <article key={item.id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 12 }}>
            <div className="ws-header-row"><div><strong>{item.finding_title}</strong><div className="ws-card-hint">{item.repository_id} · attempt {item.attempt.attempt_number}</div><div className="ws-card-hint">Candidate {shortSha(item.attempt.candidate_sha)} · Base {shortSha(item.attempt.base_sha)}</div></div><span className="ws-badge">{item.choice ? `Choice: ${item.choice.choice}` : item.state}</span></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="ws-btn ws-btn-primary" disabled={!enabled || busyId === item.id || item.choice?.choice === 'run'} onClick={() => void choose(item, 'run')}>{busyId === item.id ? 'Saving…' : 'Run with Jenkins'}</button>
              <button className="ws-btn ws-btn-secondary" disabled={busyId === item.id || item.choice?.choice === 'skip'} onClick={() => void choose(item, 'skip')}>Skip Jenkins</button>
            </div>
          </article>)}
        </div>}
      </section>
      <section style={{ marginTop: 24 }}>
        <h2 className="ws-card-title">Paired companions</h2>
        {runners.length === 0 ? <p className="ws-card-hint">No companion is paired with this project.</p> : <div className="ws-card" style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
          {runners.map((runner) => <div key={runner.id} className="ws-header-row"><div><strong>{runner.capabilities.companion_version}</strong><div className="ws-card-hint">{runner.status} · {runner.last_seen_at ? `Last seen ${new Date(runner.last_seen_at).toLocaleString()}` : 'Not connected yet'}</div></div>{runner.status === 'active' && <button className="ws-btn ws-btn-secondary" disabled={busyId === runner.id} onClick={() => void revoke(runner)}>{busyId === runner.id ? 'Revoking…' : 'Revoke'}</button>}</div>)}
        </div>}
        <div className="ws-header-row"><h2 className="ws-card-title">Attempt history</h2></div>
        {tasks.length === 0 ? (
          <div className="ws-empty"><div className="ws-empty-title">No local Jenkins attempts</div><div className="ws-empty-body">When a paired runner is available, runs will remain bound to their remediation attempt and exact commit.</div></div>
        ) : (
          <div className="ws-card" style={{ display: 'grid', gap: 12 }}>
            {tasks.map((task) => <article key={task.id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 12 }}>
              <div className="ws-header-row"><div><strong>{task.repository}</strong><div className="ws-card-hint">Candidate {shortSha(task.candidate_sha)} · Base {shortSha(task.baseline_sha)}</div></div><span className="ws-badge">{task.state === 'passed' ? 'Passed locally · not verified' : task.state}</span></div>
              <div className="ws-card-hint">Execution {task.execution_id} · Updated {new Date(task.updated_at).toLocaleString()}</div>
              {task.result?.manifest?.integrity_digest && <div className="ws-card-hint">Quincy manifest {task.result.manifest.integrity_digest} · build {task.result.manifest.jenkins_build_id ?? 'unavailable'} · comparison {task.result.manifest.comparison_outcome ?? 'incomplete'}</div>}
              {['passed', 'failed', 'cancelled', 'incomplete', 'infrastructure_failure'].includes(task.state) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {(['build-log', 'test-report', 'scan-evidence'] as const).map((name) => <button key={name} className="ws-btn ws-btn-secondary" disabled={busyId === `${task.id}:${name}`} onClick={() => void downloadArtifact(task, name)}>{busyId === `${task.id}:${name}` ? 'Downloading…' : `Download ${name}`}</button>)}
              </div>}
              {['leased', 'running'].includes(task.state) && <button className="ws-btn ws-btn-secondary" disabled={busyId === task.id} onClick={() => void cancel(task)}>{busyId === task.id ? 'Requesting…' : 'Cancel run'}</button>}
            </article>)}
          </div>
        )}
      </section>
    </main>
  );
}
