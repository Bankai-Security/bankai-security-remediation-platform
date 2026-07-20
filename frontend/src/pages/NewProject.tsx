import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import RepoPicker from '../components/RepoPicker';
import {
  ApiError,
  connectGithub,
  connectGithubFromAccount,
  connectJira,
  createProject,
  getGithubAccountStatus,
  githubAuthorizeUrl,
  type GithubAccountStatus,
} from '../lib/api';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
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

export default function NewProject() {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamName, setTeamName] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [newService, setNewService] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [jiraFieldErrors, setJiraFieldErrors] = useState<Record<string, string>>({});

  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubFieldErrors, setGithubFieldErrors] = useState<Record<string, string>>({});

  const [githubAccount, setGithubAccount] = useState<GithubAccountStatus | null>(null);
  const [useManualPat, setUseManualPat] = useState(false);

  useEffect(() => {
    getGithubAccountStatus()
      .then(setGithubAccount)
      .catch(() => {});
  }, []);

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

  const jiraFieldsFilled = site.trim() && email.trim() && apiToken.trim() && projectKey.trim();
  const githubFieldsFilled = usingRepoPicker ? !!repo.trim() : repo.trim() && token.trim();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setJiraError(null);
    setJiraFieldErrors({});
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
          teamName: teamName.trim() || undefined,
          services,
        });
        projectId = project.id;
        setCreatedProjectId(project.id);
      }

      if (jiraFieldsFilled) {
        try {
          await connectJira(projectId, { site, email, apiToken, projectKey: projectKey.toUpperCase() });
        } catch (err) {
          if (err instanceof ApiError && err.fieldErrors?.length) {
            setJiraFieldErrors(Object.fromEntries(err.fieldErrors.map((f) => [f.path, f.message])));
          } else if (err instanceof ApiError) {
            setJiraError(err.message);
          } else {
            setJiraError('Something went wrong connecting Jira. Please try again.');
          }
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
                <label htmlFor="project-team-name">
                  Team name <span className="new-project-optional">(optional)</span>
                </label>
                <input
                  id="project-team-name"
                  type="text"
                  placeholder="e.g. Identity Platform"
                  className="new-project-input"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  disabled={!!createdProjectId}
                  maxLength={120}
                />
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
            <div className="new-project-section-hint">
              New to Jira? <a href="https://www.atlassian.com/software/jira/free" target="_blank" rel="noreferrer">Create a free Jira site</a>, then{' '}
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">generate an API token</a> to connect it here.
            </div>
            {jiraError && <div className="new-project-error" role="alert">{jiraError}</div>}
            <div className="new-project-jira-grid">
              <div className="new-project-field">
                <label htmlFor="jira-site">Site URL</label>
                <input
                  id="jira-site"
                  type="text"
                  placeholder="yoursite.atlassian.net"
                  className="new-project-input"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                />
                {jiraFieldErrors.site && <div className="new-project-field-error">{jiraFieldErrors.site}</div>}
              </div>
              <div className="new-project-field">
                <label htmlFor="jira-key">Project key</label>
                <input
                  id="jira-key"
                  type="text"
                  placeholder="BNK"
                  className="new-project-input new-project-input--upper"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value)}
                />
                {jiraFieldErrors.projectKey && <div className="new-project-field-error">{jiraFieldErrors.projectKey}</div>}
              </div>
              <div className="new-project-field">
                <label htmlFor="jira-email">Email</label>
                <input
                  id="jira-email"
                  type="email"
                  placeholder="you@company.com"
                  className="new-project-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {jiraFieldErrors.email && <div className="new-project-field-error">{jiraFieldErrors.email}</div>}
              </div>
              <div className="new-project-field">
                <label htmlFor="jira-token">API token</label>
                <input
                  id="jira-token"
                  type="password"
                  placeholder="Paste your Atlassian API token"
                  className="new-project-input"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
                {jiraFieldErrors.apiToken && <div className="new-project-field-error">{jiraFieldErrors.apiToken}</div>}
              </div>
            </div>
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
                onClick={() => navigate(`/workspace/${createdProjectId}/intake`)}
              >
                Skip, continue
              </button>
            )}
            <Link to="/projects" className="new-project-cancel-link">Cancel</Link>
          </div>
        </form>
      </main>
    </div>
  );
}
