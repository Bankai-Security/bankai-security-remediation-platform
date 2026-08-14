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
  leaveOrg,
  listOrgActivity,
  listOrgMembers,
  listTeams,
  transferOrgOwnership,
  removeOrgMember,
  resendOrgInvite,
  revokeOrgInvite,
  updateOrg,
  updateOrgMemberRole,
  type MemberRole,
  type OrgActivityEvent,
  type OrgMember,
  type PendingOrgInvite,
  type TeamSummary,
} from '../lib/api';
import { canManageOrg } from '../lib/roles';
import { useOrgs } from '../lib/org-context';
import './TopBar.css';
import './workspace-pages/shared.css';
import './workspace-pages/Overview.css'; // overview-activity-item list styles, reused by the audit card
import './OrgSettings.css';

const ACTIVITY_DOT: Record<OrgActivityEvent['type'], string> = {
  org: 'var(--color-blue)',
  team: 'var(--color-green)',
  member: 'var(--color-text-muted)',
  invite: 'var(--color-text-muted)',
};

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

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

  const [activity, setActivity] = useState<OrgActivityEvent[] | null>(null);

  const [transferTo, setTransferTo] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dangerError, setDangerError] = useState<string | null>(null);

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

  const reloadActivity = () => {
    if (!orgId) return;
    listOrgActivity(orgId)
      .then(({ activity: a }) => setActivity(a))
      .catch(() => setActivity([]));
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
    reloadActivity();
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

  // The API 409s with a project count the first time, so the impact is
  // acknowledged explicitly before anything is detached.
  const handleDelete = async (force = false) => {
    setDeleting(true);
    setDangerError(null);
    try {
      await deleteOrg(orgId, force);
      refreshOrgs();
      navigate('/projects');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.projectCount !== null) {
        setDeleting(false);
        if (window.confirm(`${err.projectCount} project assignment(s) will be removed with this organization. Continue?`)) {
          void handleDelete(true);
        }
        return;
      }
      setDangerError(err instanceof ApiError ? err.message : 'Could not delete this organization.');
      setDeleting(false);
    }
  };

  const handleLeave = async () => {
    if (!window.confirm('Leave this organization? You will lose access to its teams and projects.')) return;
    setLeaving(true);
    setDangerError(null);
    try {
      await leaveOrg(orgId);
      refreshOrgs();
      navigate('/projects');
    } catch (err) {
      setDangerError(err instanceof ApiError ? err.message : 'Could not leave this organization.');
      setLeaving(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferTo) return;
    const target = members.find((m) => m.userId === transferTo);
    if (!window.confirm(`Transfer ownership to ${target?.email ?? target?.name ?? 'this member'}? You will become an admin.`)) return;
    setTransferring(true);
    setDangerError(null);
    try {
      await transferOrgOwnership(orgId, transferTo);
      setTransferTo('');
      // Ownership changed, so myRole and the roster both moved.
      const { org: fresh } = await getOrg(orgId);
      setOrg({ name: fresh.name, myRole: fresh.myRole });
      reloadMembers();
      reloadActivity();
      refreshOrgs();
    } catch (err) {
      setDangerError(err instanceof ApiError ? err.message : 'Could not transfer ownership.');
    } finally {
      setTransferring(false);
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

  const handleDeleteTeam = async (teamId: string, force = false) => {
    try {
      await deleteTeam(orgId, teamId, force);
      reloadTeams();
      reloadActivity();
      refreshOrgs();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.projectCount !== null) {
        if (window.confirm(`${err.projectCount} project(s) will lose this team. Continue?`)) {
          void handleDeleteTeam(teamId, true);
        }
        return;
      }
      setTeamError(err instanceof ApiError ? err.message : 'Could not delete the team.');
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

              {dangerError && <div className="mm-error" role="alert" style={{ marginTop: 16 }}>{dangerError}</div>}

              {/* Non-owners can leave; the owner must transfer first (they have
                  no membership row to delete). */}
              {!isOwner && org && (
                <div className="orgset-danger">
                  <button type="button" className="ws-btn ws-btn-danger-outline" disabled={leaving} onClick={() => void handleLeave()}>
                    {leaving ? 'Leaving…' : 'Leave organization'}
                  </button>
                </div>
              )}

              {isOwner && members.some((m) => m.role !== 'owner') && (
                <div className="orgset-danger">
                  <div className="orgset-danger-hint">
                    Transfer ownership to another member. You&rsquo;ll become an admin of this organization.
                  </div>
                  <div className="orgset-inline-form">
                    <select className="orgset-input" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                      <option value="">Select a member…</option>
                      {members.filter((m) => m.role !== 'owner').map((m) => (
                        <option key={m.userId} value={m.userId}>{m.email ?? m.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ws-btn ws-btn-secondary"
                      disabled={transferring || !transferTo}
                      onClick={() => void handleTransfer()}
                    >
                      {transferring ? 'Transferring…' : 'Transfer ownership'}
                    </button>
                  </div>
                </div>
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
                onResend={(inviteId) => resendOrgInvite(orgId, inviteId)}
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

            {/* Audit trail */}
            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">Audit</div>
              <h2 className="ws-card-title">Recent activity</h2>
              {activity === null ? (
                <div className="orgset-empty">Loading activity…</div>
              ) : activity.length === 0 ? (
                <div className="orgset-empty">No activity recorded yet.</div>
              ) : (
                <div>
                  {activity.map((ev) => (
                    <div key={ev.id} className="overview-activity-item">
                      <span className="ws-dot" style={{ background: ACTIVITY_DOT[ev.type] }} />
                      <span className="overview-activity-text">
                        <strong>{ev.actor}</strong> {ev.summary}
                      </span>
                      <span className="overview-activity-time">{formatEventTime(ev.createdAt)}</span>
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
