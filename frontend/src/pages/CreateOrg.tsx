import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, createOrg } from '../lib/api';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
import { useOrgs } from '../lib/org-context';
import './NewProject.css';

export default function CreateOrg() {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { refresh, selectOrg } = useOrgs();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Organization name is required');
      return;
    }
    setSubmitting(true);
    try {
      const { org } = await createOrg({ name: name.trim() });
      refresh(); // let the switcher pick up the new org
      selectOrg(org.id);
      navigate(`/orgs/${org.id}/settings`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Something went wrong. Please try again.');
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
          <span className="new-project-breadcrumb-current">New organization</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Organization</div>
        <h1 className="new-project-title">New organization</h1>
        <div className="new-project-subtitle">
          An organization groups teams and projects, and lets you invite people who then see everything they're entitled to.
        </div>

        <form onSubmit={handleCreate}>
          {error && <div className="new-project-error" role="alert">{error}</div>}

          <section className="new-project-section">
            <div className="new-project-step">Step 1</div>
            <h2 className="new-project-section-title">Organization details</h2>
            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="org-name">Organization name</label>
                <input
                  id="org-name"
                  type="text"
                  placeholder="e.g. Bankai Security"
                  className="new-project-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  required
                  autoFocus
                />
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create organization'}
            </button>
            <Link to="/projects" className="new-project-cancel-link">Cancel</Link>
          </div>
        </form>
      </main>
    </div>
  );
}
