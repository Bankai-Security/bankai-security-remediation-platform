import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import RepoPicker from '../components/RepoPicker';
import JiraIcon from '../components/JiraIcon';
import {
  ApiError,
  connectGithub,
  connectGithubFromAccount,
  createProject,
  getJiraAccountOAuthProjects,
  getJiraAccountOAuthSites,
  getJiraAccountOAuthStatus,
  getJiraConnection,
  getJiraOAuthProjects,
  getJiraOAuthSites,
  getGithubAccountStatus,
  githubAuthorizeUrl,
  selectJiraOAuthProject,
  startJiraAccountOAuth,
  type GithubAccountStatus,
  type JiraOAuthProject,
  type JiraOAuthSite,
} from '../lib/api';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
import { useOrgs } from '../lib/org-context';
import './NewProject.css';

const SERVICE_SUGGESTIONS = [
  'api',
  'web',
  'auth',
  'backend',
  'frontend',
  'mobile',
  'infra',
  'database',
  'payments',
  'identity',
];

type OnboardingDraft = { name: string; description: string; teamIds: string[]; services: string[]; repo: string; baseBranch: string; useManualPat: boolean };
function readOnboardingDraft(): Partial<OnboardingDraft> {
  try { return JSON.parse(sessionStorage.getItem('bankai-new-project-draft') || '{}') as Partial<OnboardingDraft>; }
  catch { return {}; }
}

export default function NewProject() {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { rollup } = useOrgs();
  const oauthParams = new URLSearchParams(window.location.search);
  const oauthProjectId = oauthParams.get('projectId');
  const oauthResult = oauthParams.get('jiraOAuth');
  const jiraAccountResult = oauthParams.get('jira_account');
  const [name, setName] = useState(() => readOnboardingDraft().name || '');
  const [description, setDescription] = useState(() => readOnboardingDraft().description || '');
  const [teamIds, setTeamIds] = useState<string[]>(() => readOnboardingDraft().teamIds || []);
  const [services, setServices] = useState<string[]>(() => readOnboardingDraft().services || []);
  const [newService, setNewService] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [createdProjectId, setCreatedProjectId] = useState<string | null>(oauthProjectId);
  const [jiraOAuthBusy, setJiraOAuthBusy] = useState(false);
  const [jiraOAuthError, setJiraOAuthError] = useState<string | null>(oauthResult === 'error' || jiraAccountResult === 'error' ? 'Atlassian authorization did not complete. Try connecting Jira again.' : null);
  const [jiraOAuthSites, setJiraOAuthSites] = useState<JiraOAuthSite[]>([]);
  const [jiraOAuthProjects, setJiraOAuthProjects] = useState<JiraOAuthProject[]>([]);
  const [jiraOAuthCloudId, setJiraOAuthCloudId] = useState('');
  const [jiraOAuthProjectKey, setJiraOAuthProjectKey] = useState('');
  const [jiraConnected, setJiraConnected] = useState(false);
  const [jiraProjectSelected, setJiraProjectSelected] = useState(false);
  const [jiraAccountLoading, setJiraAccountLoading] = useState(true);
  const [jiraAccountConnected, setJiraAccountConnected] = useState(false);

  const [repo, setRepo] = useState(() => readOnboardingDraft().repo || '');
  const [token, setToken] = useState('');
  const [baseBranch, setBaseBranch] = useState(() => readOnboardingDraft().baseBranch || '');
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubFieldErrors, setGithubFieldErrors] = useState<Record<string, string>>({});

  const [githubAccount, setGithubAccount] = useState<GithubAccountStatus | null>(null);
  const [useManualPat, setUseManualPat] = useState(() => readOnboardingDraft().useManualPat || false);

  useEffect(() => {
    getGithubAccountStatus()
      .then(setGithubAccount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (jiraAccountResult === 'connected' || jiraAccountResult === 'error') {
      oauthParams.delete('jira_account');
      const rest = oauthParams.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    getJiraAccountOAuthStatus().then(async ({ connected }) => {
      if (cancelled) return;
      setJiraAccountConnected(connected);
      if (!connected) return;
      const { sites } = await getJiraAccountOAuthSites();
      if (!cancelled) setJiraOAuthSites(sites);
    }).catch((err) => {
      if (!cancelled && jiraAccountResult === 'connected') setJiraOAuthError(err instanceof ApiError ? err.message : 'Could not load your Atlassian sites. Try again.');
    }).finally(() => { if (!cancelled) setJiraAccountLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!oauthProjectId || oauthResult !== 'connected') return;
    setJiraOAuthBusy(true);
    void Promise.all([getJiraOAuthSites(oauthProjectId), getJiraConnection(oauthProjectId)]).then(([{ sites }, connection]) => {
      setJiraOAuthSites(sites);
      setJiraConnected(connection.connected);
    }).catch((err) => {
      setJiraOAuthError(err instanceof ApiError ? err.message : 'Could not load your Atlassian sites. Try connecting Jira again.');
    }).finally(() => setJiraOAuthBusy(false));
  }, [oauthProjectId, oauthResult]);

  const usingRepoPicker = !!githubAccount?.connected && !useManualPat;

  const addServiceValue = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (services.some((s) => s.toLowerCase() === trimmed.toLowerCase())) return;
    setServices((prev) => [...prev, trimmed]);
  };

  const removeService = (index: number) => {
    setServices((prev) => prev.filter((_, i) => i !== index));
  };

  const addService = () => {
    addServiceValue(newService);
    setNewService('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addService();
    }
  };

  const suggestions = SERVICE_SUGGESTIONS.filter(
    (s) => !services.some((added) => added.toLowerCase() === s.toLowerCase()),
  );

  const githubFieldsFilled = usingRepoPicker ? !!repo.trim() : repo.trim() && token.trim();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setGithubError(null);
    setGithubFieldErrors({});

    if (!createdProjectId && !name.trim()) {
      setError('Project name is required');
      return;
    }

    setSubmitting(true);
    try {
      let projectId = createdProjectId;
      if (!projectId) {
        const { project } = await createProject({
          name,
          description: description.trim() || undefined,
          teamIds,
          services,
        });
        projectId = project.id;
        setCreatedProjectId(project.id);
      }

      if (!jiraConnected && jiraOAuthCloudId && jiraOAuthProjectKey) {
        try {
          await selectJiraOAuthProject(projectId, { cloudId: jiraOAuthCloudId, projectKey: jiraOAuthProjectKey });
          setJiraConnected(true);
        } catch (err) {
          setJiraOAuthError(err instanceof ApiError ? err.message : 'Could not connect the selected Jira project.');
          return;
        }
      }

      if (githubFieldsFilled) {
        try {
          if (usingRepoPicker) {
            await connectGithubFromAccount(projectId, { repo, baseBranch: baseBranch.trim() || undefined });
          } else {
            await connectGithub(projectId, { repo, token, baseBranch: baseBranch.trim() || undefined });
          }
        } catch (err) {
          if (err instanceof ApiError && err.fieldErrors?.length) {
            setGithubFieldErrors(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
          } else if (err instanceof ApiError) {
            setGithubError(err.message);
          } else {
            setGithubError('Something went wrong connecting GitHub. Please try again.');
          }
          return;
        }
      }

      try { sessionStorage.removeItem('bankai-new-project-draft'); } catch { /* optional onboarding draft */ }
      navigate(`/workspace/${projectId}/intake`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fieldErrors?.[0]?.message ?? err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartJiraOAuth = async () => {
    setJiraOAuthBusy(true);
    setJiraOAuthError(null);
    try {
      try { sessionStorage.setItem('bankai-new-project-draft', JSON.stringify({ name, description, teamIds, services, repo, baseBranch, useManualPat } satisfies OnboardingDraft)); } catch { /* OAuth can continue without restoring the form draft */ }
      const { authorizationUrl } = await startJiraAccountOAuth('onboarding');
      window.location.assign(authorizationUrl);
    } catch (err) {
      setJiraOAuthError(err instanceof Error ? err.message : 'Could not start Atlassian authorization.');
      setJiraOAuthBusy(false);
    }
  };

  const handleJiraOAuthSite = async (cloudId: string) => {
    setJiraOAuthCloudId(cloudId);
    setJiraOAuthProjectKey('');
    setJiraProjectSelected(false);
    setJiraOAuthProjects([]);
    if (!cloudId) return;
    setJiraOAuthBusy(true);
    setJiraOAuthError(null);
    try {
      const { projects } = createdProjectId
        ? await getJiraOAuthProjects(createdProjectId, cloudId)
        : await getJiraAccountOAuthProjects(cloudId);
      setJiraOAuthProjects(projects);
    } catch (err) {
      setJiraOAuthError(err instanceof ApiError ? err.message : 'Could not load Jira projects for this site.');
    } finally { setJiraOAuthBusy(false); }
  };

  const handleSelectJiraProject = async () => {
    if (!jiraOAuthCloudId || !jiraOAuthProjectKey) return;
    if (!createdProjectId) {
      setJiraProjectSelected(true);
      return;
    }
    setJiraOAuthBusy(true);
    setJiraOAuthError(null);
    try {
      await selectJiraOAuthProject(createdProjectId, { cloudId: jiraOAuthCloudId, projectKey: jiraOAuthProjectKey });
      setJiraConnected(true);
    } catch (err) {
      setJiraOAuthError(err instanceof ApiError ? err.message : 'Could not connect the selected Jira project.');
    } finally { setJiraOAuthBusy(false); }
  };

  const selectedJiraSite = jiraOAuthSites.find((site) => site.id === jiraOAuthCloudId);
  const selectedJiraProject = jiraOAuthProjects.find((project) => project.key === jiraOAuthProjectKey);

  return (
    <div className="new-project-page">
      <div className="new-project-topbar">
        <div className="new-project-brand">
          <img src={bankaiMark} alt="Bankai" className="new-project-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="new-project-brand-wordmark" />
        </div>
        <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
      </div>

      <main className="new-project-main">
        <div className="new-project-breadcrumb">
          <Link to="/projects" className="new-project-breadcrumb-link">Bankai</Link>
          <span className="new-project-breadcrumb-sep">›</span>
          <span className="new-project-breadcrumb-current">New project</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Workspace</div>
        <h1 className="new-project-title">New project</h1>
        <div className="new-project-subtitle">
          Connect a scanner feed to a new project. You can upload the first scan right after.
        </div>

        <form onSubmit={handleCreate}>
          {error && <div className="new-project-error" role="alert">{error}</div>}
          {createdProjectId && (
            <div className="new-project-notice">
              Project created — connect Jira and GitHub below, or skip them and continue.
            </div>
          )}

          <section className="new-project-section">
            <div className="new-project-step">Step 1</div>
            <h2 className="new-project-section-title">Project details</h2>
            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="project-name">Project name</label>
                <input
                  id="project-name"
                  type="text"
                  placeholder="e.g. Payments Platform"
                  className="new-project-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!!createdProjectId}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="project-description">
                  Description <span className="new-project-optional">(optional)</span>
                </label>
                <textarea
                  id="project-description"
                  placeholder="What does this project cover?"
                  rows={2}
                  className="new-project-textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!!createdProjectId}
                />
              </div>
              <div className="new-project-field">
                <label>
                  Teams <span className="new-project-optional">(optional)</span>
                </label>
                {rollup && rollup.teams.length > 0 ? (
                  <>
                    {teamIds.length > 0 && (
                      <div className="new-project-chips">
                        {teamIds.map((id) => {
                          const team = rollup.teams.find((t) => t.id === id);
                          return (
                            <span key={id} className="new-project-chip">
                              {team?.name ?? id}
                              <button
                                type="button"
                                className="new-project-chip-remove"
                                onClick={() => setTeamIds((prev) => prev.filter((x) => x !== id))}
                                aria-label={`Remove ${team?.name ?? 'team'}`}
                                disabled={!!createdProjectId}
                              >
                                ✕
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="new-project-suggestions">
                      <span className="new-project-suggestions-label">Add to team:</span>
                      {rollup.teams.filter((t) => !teamIds.includes(t.id)).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="new-project-suggestion-chip"
                          onClick={() => setTeamIds((prev) => [...prev, t.id])}
                          disabled={!!createdProjectId}
                        >
                          + {t.name}
                        </button>
                      ))}
                    </div>
                    <div className="new-project-section-hint" style={{ marginTop: 6 }}>
                      Files this project under <strong>{rollup.name}</strong> in the org rollup (one or more teams). You can change this later in Settings.
                    </div>
                  </>
                ) : (
                  <div className="new-project-section-hint">
                    No teams available yet — create one from your organization, then assign this project in Settings.
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="new-project-section">
            <div className="new-project-step">Step 2</div>
            <h2 className="new-project-section-title new-project-section-title--tight">Services</h2>
            <div className="new-project-section-hint">
              CVITs from this project&apos;s scans will be split and tracked per service.
            </div>

            {services.length > 0 && (
              <div className="new-project-chips">
                {services.map((serviceName, i) => (
                  <span key={`${serviceName}-${i}`} className="new-project-chip">
                    {serviceName}
                    <button
                      type="button"
                      className="new-project-chip-remove"
                      onClick={() => removeService(i)}
                      aria-label={`Remove ${serviceName}`}
                      disabled={!!createdProjectId}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="new-project-add-row">
              <input
                type="text"
                value={newService}
                onChange={(e) => setNewService(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add a service name…"
                className="new-project-add-input"
                disabled={!!createdProjectId}
              />
              <button type="button" className="new-project-add-btn" onClick={addService} disabled={!!createdProjectId}>
                Add
              </button>
            </div>

            {suggestions.length > 0 && (
              <div className="new-project-suggestions">
                <span className="new-project-suggestions-label">Suggestions:</span>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="new-project-suggestion-chip"
                    onClick={() => addServiceValue(s)}
                    disabled={!!createdProjectId}
                  >
                    + {s}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="new-project-section">
            <div className="new-project-step">Step 3</div>
            <h2 className="new-project-section-title new-project-section-title--tight">
              Connect Jira <span className="new-project-optional">(optional)</span>
            </h2>
            <div className="new-project-section-hint">
              Fill this in to have tickets created in Jira automatically from accepted findings. You can skip this
              and connect Jira later from Settings instead.
            </div>
            {jiraConnected ? (
              <div className="new-project-section-hint" role="status">Jira connected with Atlassian OAuth. Tickets will sync to the selected project.</div>
            ) : jiraOAuthSites.length > 0 ? (
              <>
                <div className="new-project-section-hint">Atlassian is authorized. Choose the Jira site and project to link when this Bankai project is created.</div>
                <div className="new-project-jira-grid">
                  <div className="new-project-field">
                    <label htmlFor="onboarding-jira-site">Jira site</label>
                    <select id="onboarding-jira-site" className="new-project-input" value={jiraOAuthCloudId} onChange={(event) => void handleJiraOAuthSite(event.target.value)} disabled={jiraOAuthBusy}>
                      <option value="">Choose a Jira site</option>
                      {jiraOAuthSites.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.url}</option>)}
                    </select>
                  </div>
                  <div className="new-project-field">
                    <label htmlFor="onboarding-jira-project">Jira project</label>
                    <select id="onboarding-jira-project" className="new-project-input" value={jiraOAuthProjectKey} onChange={(event) => { setJiraOAuthProjectKey(event.target.value); setJiraProjectSelected(false); }} disabled={!jiraOAuthCloudId || jiraOAuthBusy}>
                      <option value="">{jiraOAuthBusy ? 'Loading projects…' : 'Choose a project'}</option>
                      {jiraOAuthProjects.map((item) => <option key={item.id} value={item.key}>{item.key} · {item.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="new-project-actions">
                  <button type="button" className="new-project-create-btn" onClick={() => void handleSelectJiraProject()} disabled={!jiraOAuthCloudId || !jiraOAuthProjectKey || jiraOAuthBusy}>
                    {jiraOAuthBusy ? 'Loading…' : createdProjectId ? 'Connect selected Jira project' : 'Use selected Jira project'}
                  </button>
                </div>
                {jiraProjectSelected && selectedJiraSite && selectedJiraProject && (
                  <div className="new-project-section-hint" role="status" style={{ marginTop: 10, marginBottom: 0 }}>
                    <JiraIcon size={15} /> Selected {selectedJiraProject.key} · {selectedJiraProject.name} on {selectedJiraSite.name}. It will connect when you create the project.
                  </div>
                )}
              </>
            ) : jiraAccountLoading ? (
              <div className="new-project-section-hint" role="status">Checking your Jira account connection…</div>
            ) : (
              <>
                <div className="new-project-actions">
                  <button type="button" className="new-project-create-btn" onClick={() => void handleStartJiraOAuth()} disabled={jiraOAuthBusy}>
                    <JiraIcon size={16} />
                    {jiraOAuthBusy ? 'Opening Atlassian…' : 'Connect Jira with Atlassian'}
                  </button>
                </div>
                <div className="new-project-section-hint" style={{ marginTop: 12, marginBottom: 0 }}>{jiraAccountConnected ? 'No Jira sites are available to this account. Check your Atlassian access, or reconnect to refresh permissions.' : 'Secure authorization using OAuth 2.0 (3LO). After authorizing, you’ll return here to choose a site and project before creating the Bankai project.'}</div>
              </>
            )}
            {jiraOAuthError && <div className="new-project-error" role="alert">{jiraOAuthError}</div>}
          </section>

          <section className="new-project-section">
            <div className="new-project-step">Step 4</div>
            <h2 className="new-project-section-title new-project-section-title--tight">
              Connect GitHub <span className="new-project-optional">(optional)</span>
            </h2>
            <div className="new-project-section-hint">
              Fill this in to have Bankai scan the repo with AI, populate AI Triage, and open a remediation branch
              per finding. You can skip this and connect GitHub later from Settings instead.
            </div>
            {githubError && <div className="new-project-error" role="alert">{githubError}</div>}

            {usingRepoPicker ? (
              <>
                <div className="new-project-section-hint">
                  Picking from your connected GitHub account (@{githubAccount!.login}).
                </div>
                <div className="new-project-field" style={{ marginBottom: 12 }}>
                  <label htmlFor="github-base-branch">Base branch (optional)</label>
                  <input
                    id="github-base-branch"
                    type="text"
                    placeholder="main"
                    className="new-project-input"
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                  />
                  {githubFieldErrors.baseBranch && <div className="new-project-field-error">{githubFieldErrors.baseBranch}</div>}
                </div>
                <RepoPicker onSelect={(picked) => setRepo(picked.fullName)} selectedFullName={repo || null} />
                {repo && <div className="new-project-section-hint" style={{ marginTop: 8 }}>Selected: <strong>{repo}</strong></div>}
                {githubFieldErrors.repo && <div className="new-project-field-error">{githubFieldErrors.repo}</div>}
                <button
                  type="button"
                  className="new-project-cancel-link"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', marginTop: 10, padding: 0 }}
                  onClick={() => {
                    setUseManualPat(true);
                    setRepo('');
                  }}
                >
                  Use a personal access token instead
                </button>
              </>
            ) : (
              <>
                <div className="new-project-section-hint">
                  Generate a{' '}
                  <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">personal access token</a>{' '}
                  with contents read/write access to the repo, or{' '}
                  <a href={githubAuthorizeUrl()}>connect your GitHub account</a> to pick from a list instead.
                </div>
                <div className="new-project-jira-grid">
                  <div className="new-project-field">
                    <label htmlFor="github-repo">Repository</label>
                    <input
                      id="github-repo"
                      type="text"
                      placeholder="owner/repo"
                      className="new-project-input"
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                    />
                    {githubFieldErrors.repo && <div className="new-project-field-error">{githubFieldErrors.repo}</div>}
                  </div>
                  <div className="new-project-field">
                    <label htmlFor="github-base-branch">Base branch (optional)</label>
                    <input
                      id="github-base-branch"
                      type="text"
                      placeholder="main"
                      className="new-project-input"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                    />
                    {githubFieldErrors.baseBranch && <div className="new-project-field-error">{githubFieldErrors.baseBranch}</div>}
                  </div>
                  <div className="new-project-field">
                    <label htmlFor="github-token">Personal access token</label>
                    <input
                      id="github-token"
                      type="password"
                      placeholder="Paste your GitHub token"
                      className="new-project-input"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    {githubFieldErrors.token && <div className="new-project-field-error">{githubFieldErrors.token}</div>}
                  </div>
                </div>
                {githubAccount?.connected && (
                  <button
                    type="button"
                    className="new-project-cancel-link"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', marginTop: 10, padding: 0 }}
                    onClick={() => setUseManualPat(false)}
                  >
                    Pick from your GitHub repos instead
                  </button>
                )}
              </>
            )}
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={submitting}>
              {submitting ? 'Saving…' : createdProjectId ? 'Retry connection' : 'Create project'}
            </button>
            {createdProjectId && (
              <button
                type="button"
                className="new-project-cancel-link"
                style={{ border: 'none', background: 'none', cursor: 'pointer' }}
                onClick={() => {
                  try { sessionStorage.removeItem('bankai-new-project-draft'); } catch { /* optional onboarding draft */ }
                  navigate(`/workspace/${createdProjectId}/intake`);
                }}
              >
                Skip, continue
              </button>
            )}
            <Link to="/projects" className="new-project-cancel-link" onClick={() => { try { sessionStorage.removeItem('bankai-new-project-draft'); } catch { /* optional onboarding draft */ } }}>Cancel</Link>
          </div>
        </form>
      </main>
    </div>
  );
}
