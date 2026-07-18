import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { ApiError, changePassword, deleteAccount, listProjects, updateProfile, type Project } from '../lib/api';
import { getAvatarStyle, getDisplayName, getInitials, useCurrentUser } from '../lib/auth-context';
import './AccountSettings.css';
import './NewProject.css';

export default function AccountSettings() {
  const { user, setUser } = useCurrentUser();
  const navigate = useNavigate();

  const [ownedProjects, setOwnedProjects] = useState<Project[] | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteEmailConfirm, setDeleteEmailConfirm] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    listProjects()
      .then(({ projects }) => setOwnedProjects(projects.filter((p) => p.myRole === 'owner')))
      .catch(() => setOwnedProjects([]));
  }, []);

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError(null);
    setProfileSuccess(false);

    if (!fullName.trim()) {
      setProfileError('Full name is required');
      return;
    }

    setSavingProfile(true);
    try {
      const { user: updated } = await updateProfile({ fullName });
      setUser(updated);
      setProfileSuccess(true);
    } catch (err) {
      setProfileError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Something went wrong. Please try again.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    setSavingPassword(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(true);
    } catch (err) {
      setPasswordError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Something went wrong. Please try again.');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError(null);

    if (deleteEmailConfirm.trim().toLowerCase() !== (user?.email ?? '').toLowerCase()) {
      setDeleteError('Type your account email exactly to confirm.');
      return;
    }

    setDeleteBusy(true);
    try {
      await deleteAccount(deletePassword);
      setUser(null);
      navigate('/login');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete your account.');
      setDeleteBusy(false);
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
          <span className="new-project-breadcrumb-current">Account settings</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Account</div>
        <h1 className="new-project-title">Account settings</h1>
        <div className="new-project-subtitle">Manage your profile and password. This applies to your account, not any one project.</div>

        <form onSubmit={handleSaveProfile}>
          <section className="new-project-section">
            <h2 className="new-project-section-title">Profile</h2>

            <div className="account-settings-profile-row">
              <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
              <div>
                <div className="account-settings-profile-name">{getDisplayName(user)}</div>
                {user?.email && <div className="account-settings-profile-email">{user.email}</div>}
              </div>
            </div>

            {profileError && <div className="new-project-error" role="alert">{profileError}</div>}
            {profileSuccess && <div className="account-settings-success" role="status">Profile updated.</div>}

            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="account-name">Full name</label>
                <input
                  id="account-name"
                  type="text"
                  className="new-project-input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="account-email">Email</label>
                <input id="account-email" type="email" className="new-project-input" value={user?.email ?? ''} disabled />
                <div className="account-settings-hint">Contact support to change the email on your account.</div>
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>

        <form onSubmit={handleChangePassword}>
          <section className="new-project-section" style={{ marginTop: 28 }}>
            <h2 className="new-project-section-title">Password</h2>

            {passwordError && <div className="new-project-error" role="alert">{passwordError}</div>}
            {passwordSuccess && <div className="account-settings-success" role="status">Password changed.</div>}

            <div className="new-project-field-stack">
              <div className="new-project-field">
                <label htmlFor="current-password">Current password</label>
                <input
                  id="current-password"
                  type="password"
                  className="new-project-input"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  className="new-project-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
              <div className="new-project-field">
                <label htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  className="new-project-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
            </div>
          </section>

          <div className="new-project-actions">
            <button type="submit" className="new-project-create-btn" disabled={savingPassword}>
              {savingPassword ? 'Updating…' : 'Change password'}
            </button>
            <Link to="/projects" className="new-project-cancel-link">Back to projects</Link>
          </div>
        </form>

        <section
          className="new-project-section"
          style={{ marginTop: 28, border: '1px solid var(--color-red)', borderRadius: 14, padding: 20 }}
        >
          <h2 className="new-project-section-title" style={{ color: 'var(--color-red)' }}>Danger zone</h2>
          <div className="account-settings-hint" style={{ marginTop: 4 }}>
            Permanently deletes your account.
            {ownedProjects && ownedProjects.length > 0 && (
              <>
                {' '}You own {ownedProjects.length} project{ownedProjects.length > 1 ? 's' : ''} — deleting your account
                permanently deletes {ownedProjects.length > 1 ? 'all of them' : 'it'} too, including every scan, finding,
                and ticket in {ownedProjects.length > 1 ? 'them' : 'it'} and any teammates&rsquo; access to{' '}
                {ownedProjects.length > 1 ? 'them' : 'it'} — not just your own membership.
              </>
            )}
            {' '}This cannot be undone.
          </div>

          {ownedProjects && ownedProjects.length > 0 && (
            <ul style={{ margin: '10px 0 0 0', paddingLeft: 20, fontSize: 13 }}>
              {ownedProjects.map((p) => (
                <li key={p.id}>{p.name}</li>
              ))}
            </ul>
          )}

          {!showDeleteConfirm ? (
            <div className="new-project-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="new-project-create-btn"
                style={{ background: 'var(--color-red)' }}
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete account
              </button>
            </div>
          ) : (
            <form onSubmit={handleDeleteAccount} style={{ marginTop: 16 }}>
              {deleteError && <div className="new-project-error" role="alert">{deleteError}</div>}
              <div className="new-project-field-stack">
                <div className="new-project-field">
                  <label htmlFor="delete-email-confirm">Type your email ({user?.email}) to confirm</label>
                  <input
                    id="delete-email-confirm"
                    type="email"
                    className="new-project-input"
                    value={deleteEmailConfirm}
                    onChange={(e) => setDeleteEmailConfirm(e.target.value)}
                    required
                  />
                </div>
                <div className="new-project-field">
                  <label htmlFor="delete-password">Password</label>
                  <input
                    id="delete-password"
                    type="password"
                    className="new-project-input"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="new-project-actions" style={{ marginTop: 16 }}>
                <button
                  type="submit"
                  className="new-project-create-btn"
                  style={{ background: 'var(--color-red)' }}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? 'Deleting…' : 'Permanently delete my account'}
                </button>
                <button
                  type="button"
                  className="new-project-cancel-link"
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteError(null);
                    setDeleteEmailConfirm('');
                    setDeletePassword('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
