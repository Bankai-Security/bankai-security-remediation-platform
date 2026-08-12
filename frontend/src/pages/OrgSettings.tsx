import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import MemberManager from '../components/MemberManager';
import OrgTopBar from '../components/OrgTopBar';
import {
  ApiError,
  createTeam,
  deleteOrg,
  deleteTeam,
  getOrg,
  inviteOrgMember,
  listOrgMembers,
  listTeams,
  removeOrgMember,
  revokeOrgInvite,
  updateOrg,
  updateOrgMemberRole,
  type MemberRole,
  type OrgMember,
  type PendingOrgInvite,
  type TeamSummary,
} from '../lib/api';
import { canManageOrg } from '../lib/roles';
import { useOrgs } from '../lib/org-context';
import './TopBar.css';
import './workspace-pages/shared.css';
import './OrgSettings.css';

export default function OrgSettings() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const { selectOrg, refresh: refreshOrgs } = useOrgs();

  const [org, setOrg] = useState<{ name: string; myRole: MemberRole } | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<PendingOrgInvite[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [newTeam, setNewTeam] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  // Keep the switcher's selection in sync with the URL.
  useEffect(() => {
    if (orgId) selectOrg(orgId);
  }, [orgId, selectOrg]);

  const reloadMembers = () => {
    if (!orgId) return;
    listOrgMembers(orgId)
      .then(({ members: m, invites: i }) => {
        setMembers(m);
        setInvites(i);
      })
      .catch(() => {});
  };

  const reloadTeams = () => {
    if (!orgId) return;
    listTeams(orgId)
      .then(({ teams: t }) => setTeams(t))
      .catch(() => {});
  };

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoadError(null);
    getOrg(orgId)
      .then(({ org: o }) => {
        if (cancelled) return;
        setOrg({ name: o.name, myRole: o.myRole });
        setNameDraft(o.name);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this organization.');
      });
    reloadMembers();
    reloadTeams();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (!orgId) return <Navigate to="/projects" replace />;

  const canManage = canManageOrg(org?.myRole);
  const isOwner = org?.myRole === 'owner';

  const saveName = async () => {
    if (!nameDraft.trim() || nameDraft.trim() === org?.name) return;
    setSavingName(true);
    try {
      const { org: updated } = await updateOrg(orgId, { name: nameDraft.trim() });
      setOrg((prev) => (prev ? { ...prev, name: updated.name } : prev));
      refreshOrgs();
    } catch {
      /* surfaced via the disabled state resetting; keep it simple */
    } finally {
      setSavingName(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteOrg(orgId);
      refreshOrgs();
      navigate('/projects');
    } catch {
      setDeleting(false);
    }
  };

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeam.trim()) return;
    setCreatingTeam(true);
    setTeamError(null);
    try {
      await createTeam(orgId, { name: newTeam.trim() });
      setNewTeam('');
      reloadTeams();
      refreshOrgs();
    } catch (err) {
      setTeamError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Could not create the team.');
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleDeleteTeam = async (teamId: string) => {
    try {
      await deleteTeam(orgId, teamId);
      reloadTeams();
      refreshOrgs();
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className="topbar-page">
      <OrgTopBar />

      <main className="page-main">
        {loadError ? (
          <div className="ws-empty">
            <div className="ws-empty-title">{loadError}</div>
            <div className="ws-empty-body">It may have been deleted, or you may not have access to it.</div>
            <button type="button" className="ws-empty-cta" onClick={() => navigate('/projects')}>Back to projects</button>
          </div>
        ) : (
          <>
            <div className="page-eyebrow">Organization</div>
            <h1 className="page-title">{org?.name ?? 'Organization'}</h1>
            <div className="page-subtitle">
              Manage this organization's name, its members, and the teams projects roll up into.
              {' '}
              <Link to={`/orgs/${orgId}`}>View rollup →</Link>
            </div>

            {/* General */}
            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">General</div>
              <h2 className="ws-card-title">Name</h2>
              {canManage ? (
                <div className="orgset-inline-form">
                  <input
                    className="orgset-input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    maxLength={120}
                  />
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={savingName || !nameDraft.trim() || nameDraft.trim() === org?.name}
                    onClick={() => void saveName()}
                  >
                    {savingName ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <div className="orgset-readonly">{org?.name}</div>
              )}

              {isOwner && (
                <div className="orgset-danger">
                  {!showDelete ? (
                    <button type="button" className="ws-btn ws-btn-danger-outline" onClick={() => setShowDelete(true)}>
                      Delete organization
                    </button>
                  ) : (
                    <div className="orgset-danger-confirm">
                      <div className="orgset-danger-hint">
                        This permanently deletes the organization, its teams, memberships, and invites. Projects are kept but
                        unassigned from their teams. Type <strong>{org?.name}</strong> to confirm.
                      </div>
                      <div className="orgset-inline-form">
                        <input
                          className="orgset-input"
                          placeholder={org?.name}
                          value={confirmDelete}
                          onChange={(e) => setConfirmDelete(e.target.value)}
                        />
                        <button
                          type="button"
                          className="ws-btn ws-btn-danger-outline"
                          disabled={deleting || confirmDelete !== org?.name}
                          onClick={() => void handleDelete()}
                        >
                          {deleting ? 'Deleting…' : 'Delete forever'}
                        </button>
                        <button type="button" className="ws-btn ws-btn-secondary" onClick={() => { setShowDelete(false); setConfirmDelete(''); }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Members */}
            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">Access</div>
              <h2 className="ws-card-title">Members</h2>
              <MemberManager
                members={members}
                invites={invites}
                canManage={canManage}
                inviteBasePath="/org-invites"
                onInvite={(email, role) => inviteOrgMember(orgId, { email, role })}
                onChangeRole={(memberId, role) => updateOrgMemberRole(orgId, memberId, role)}
                onRemove={(memberId) => removeOrgMember(orgId, memberId)}
                onRevoke={(inviteId) => revokeOrgInvite(orgId, inviteId)}
                onChanged={reloadMembers}
              />
            </section>

            {/* Teams */}
            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">Structure</div>
              <h2 className="ws-card-title">Teams</h2>
              <div className="ws-card-hint">Projects are grouped into teams. Invite people to a team to give them access to just its projects.</div>

              {canManage && (
                <form className="orgset-inline-form orgset-team-create" onSubmit={handleCreateTeam}>
                  <input
                    className="orgset-input"
                    placeholder="New team name"
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    maxLength={120}
                  />
                  <button type="submit" className="ws-btn ws-btn-primary" disabled={creatingTeam || !newTeam.trim()}>
                    {creatingTeam ? 'Creating…' : 'Create team'}
                  </button>
                </form>
              )}
              {teamError && <div className="mm-error" role="alert">{teamError}</div>}

              {teams.length === 0 ? (
                <div className="orgset-empty">No teams yet.</div>
              ) : (
                <div className="orgset-team-list">
                  {teams.map((t) => (
                    <div key={t.id} className="orgset-team-row">
                      <span className="orgset-team-name">{t.name}</span>
                      <Link to={`/orgs/${orgId}/teams/${t.id}`} className="orgset-team-manage">Manage members →</Link>
                      {canManage && (
                        <button type="button" className="mm-remove" onClick={() => void handleDeleteTeam(t.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
