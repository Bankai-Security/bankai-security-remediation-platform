import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  createHostedCiSetupPullRequest,
  generateHostedCiProposal,
  getVerificationSettings,
  setVerificationProvider,
  type HostedCiProposal,
  type VerificationSettings,
} from "../lib/api";
import { canManageProject } from "../lib/roles";

export default function VerificationSetup({ projectId, role }: { projectId: string; role: string }) {
  const [settings, setSettings] = useState<VerificationSettings | null>(null);
  const [proposal, setProposal] = useState<HostedCiProposal | null>(null);
  const [setupPr, setSetupPr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSettings(await getVerificationSettings(projectId)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "Could not load CI settings."); }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const choose = async (provider: VerificationSettings["verification_provider"]) => {
    setBusy(true); setError(null); setProposal(null); setSetupPr(null);
    try {
      const updated = await setVerificationProvider(projectId, provider);
      setSettings(updated);
      if (provider === "hosted_ci" && updated.ci_bootstrap_status !== "ready") {
        if (updated.ci_bootstrap_status === "pr_open" && updated.ci_bootstrap_pr_url) setSetupPr(updated.ci_bootstrap_pr_url);
        else setProposal(await generateHostedCiProposal(projectId));
      }
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "Could not update the CI choice."); }
    finally { setBusy(false); }
  };

  const openHostedProposal = async () => {
    setBusy(true); setError(null);
    try { setProposal(await generateHostedCiProposal(projectId)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "Could not prepare the hosted workflow draft."); }
    finally { setBusy(false); }
  };

  const acceptProposal = async () => {
    if (!proposal) return;
    setBusy(true); setError(null);
    try {
      const result = await createHostedCiSetupPullRequest(projectId, { baseSha: proposal.baseSha, content: proposal.content });
      setSetupPr(result.pullRequest.pullRequest.url);
      setProposal(null);
      await refresh();
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "Could not open the workflow setup pull request."); }
    finally { setBusy(false); }
  };

  if (!settings) return <section className="ws-card settings-section"><div className="page-subtitle">Loading CI choices…</div></section>;
  const editable = canManageProject(role as Parameters<typeof canManageProject>[0]);
  const hostedReady = settings.verification_provider === "hosted_ci" && settings.ci_bootstrap_status === "ready";

  return (
    <section className="ws-card settings-section" aria-labelledby="verification-setup-title">
      <div className="settings-section-header">
        <div>
          <div className="ws-card-eyebrow">Verification</div>
          <h2 id="verification-setup-title" className="settings-h2">Choose a CI provider</h2>
        </div>
        <span className="ws-dot-status" style={{ color: hostedReady ? "#15803D" : "#71717A" }}>
          <span className="ws-dot" style={{ background: hostedReady ? "#22C55E" : "#A1A1AA" }} />
          {hostedReady ? "Ready" : settings.verification_provider === "none" ? "Not configured" : "Setup pending"}
        </span>
      </div>
      <p className="ws-card-hint">Scanning, triage, ticketing, and remediation stay available when you skip CI. Bankai never merges pull requests.</p>
      <div className="settings-jira-actions" style={{ flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="ws-btn ws-btn-secondary" disabled={!editable || busy} onClick={() => void choose("jenkins")}>Use existing Jenkins</button>
        <Link className="ws-btn ws-btn-secondary" to={`/workspace/${projectId}/jenkins`} onClick={() => void choose("jenkins")}>Set up Jenkins</Link>
        <button type="button" className="ws-btn ws-btn-secondary" disabled={!editable || busy} onClick={() => void choose("hosted_ci")}>Use hosted CI</button>
        <button type="button" className="ws-btn ws-btn-secondary" disabled={!editable || busy} onClick={() => void choose("none")}>Continue without CI</button>
        <button type="button" className="settings-jira-toggle-link" disabled={busy} onClick={() => void refresh()}>Refresh status</button>
      </div>
      {!editable && <div className="ws-card-hint" style={{ marginTop: 10 }}>Only project editors and admins can change the verification provider.</div>}
      {settings.verification_provider === "jenkins" && <div className="ws-card-hint" style={{ marginTop: 10 }}>Jenkins verification uses the selected multibranch job in Bankai Desktop. Jenkins starts PR builds; Bankai reports results for the exact commit.</div>}
      {settings.verification_provider === "hosted_ci" && settings.ci_bootstrap_status === "none" && <div className="ws-card-hint" style={{ marginTop: 10 }}>The hosted workflow has not been added yet. Bankai will show the complete draft for review before opening a setup pull request.</div>}
      {settings.verification_provider === "hosted_ci" && settings.ci_bootstrap_status === "pr_open" && (
        <div className="ws-card-hint" style={{ marginTop: 10 }}>Hosted CI is awaiting human review and merge of its workflow setup pull request. Results remain pending until setup is ready. {setupPr && <a href={setupPr} target="_blank" rel="noreferrer">Review setup pull request</a>}{!setupPr && settings.ci_bootstrap_pr_url && <a href={settings.ci_bootstrap_pr_url} target="_blank" rel="noreferrer">Review setup pull request</a>}</div>
      )}
      {settings.verification_provider === "hosted_ci" && settings.ci_bootstrap_status === "ready" && <div className="ws-card-hint" style={{ marginTop: 10 }}>GitHub Actions runs the reviewed, manifest-derived build and test commands on pull request revisions. Bankai observes the workflow run and reports its exact commit.</div>}
      {settings.verification_provider === "hosted_ci" && settings.ci_bootstrap_status !== "ready" && settings.ci_bootstrap_status !== "pr_open" && !proposal && (
        <button type="button" className="ws-btn ws-btn-primary" style={{ marginTop: 12 }} disabled={!editable || busy} onClick={() => void openHostedProposal()}>{busy ? "Preparing workflow…" : "Review hosted CI workflow"}</button>
      )}
      {proposal && (
        <div style={{ marginTop: 14 }}>
          <div className="ws-card-hint"><strong>{proposal.repo}</strong> · {proposal.summary}<br />Base commit: <code>{proposal.baseSha}</code><br />Only <code>{proposal.path}</code> will be added. It uses no credentials or deployment settings.</div>
          {proposal.assumptions.map((item) => <div className="ws-card-hint" key={item} style={{ marginTop: 6 }}>• {item}</div>)}
          <details style={{ marginTop: 10 }} open>
            <summary style={{ cursor: "pointer" }}>Review complete workflow</summary>
            <pre style={{ overflowX: "auto", maxHeight: 360, padding: 12, background: "var(--color-surface-subtle, #F4F4F5)", borderRadius: 8 }}>{proposal.content}</pre>
          </details>
          <div className="settings-jira-actions">
            <button type="button" className="ws-btn ws-btn-primary" disabled={!editable || busy} onClick={() => void acceptProposal()}>{busy ? "Opening pull request…" : "Open workflow setup pull request"}</button>
            <button type="button" className="settings-jira-toggle-link" disabled={busy} onClick={() => setProposal(null)}>Discard draft</button>
          </div>
        </div>
      )}
      {setupPr && <div className="ws-card-hint" role="status" style={{ marginTop: 12 }}>Setup pull request opened. Review and merge it to activate hosted CI. <a href={setupPr} target="_blank" rel="noreferrer">Open pull request</a></div>}
      {error && <div className="settings-jira-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
    </section>
  );
}
