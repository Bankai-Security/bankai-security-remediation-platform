import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import MemberManager from '../components/MemberManager';
import OrgTopBar from '../components/OrgTopBar';
import {
  ApiError,
  inviteTeamMember,
  leaveTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  resendTeamInvite,
  revokeTeamInvite,
  updateTeam,
  updateTeamMemberRole,
  type MemberRole,
  type PendingTeamInvite,
  type TeamMember,
} from '../lib/api';
import { canManageTeam } from '../lib/roles';
import { useOrgs } from '../lib/org-context';
import './TopBar.css';
import './workspace-pages/shared.css';
import './OrgSettings.css';

export default function TeamSettings() {
  const { orgId, teamId } = useParams<{ orgId: string; teamId: string }>();
  const navigate = useNavigate();
  const { selectOrg } = useOrgs();

  const [team, setTeam] = useState<{ name: string; myRole: MemberRole } | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<PendingTeamInvite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    if (orgId) selectOrg(orgId);
  }, [orgId, selectOrg]);

  const reloadMembers = () => {
    if (!orgId || !teamId) return;
    listTeamMembers(orgId, teamId)
      .then(({ members: m, invites: i }) => {
        setMembers(m);
        setInvites(i);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (!orgId || !teamId) return;
    let cancelled = false;
    setLoadError(null);
    // No single getTeam endpoint — the team's name + myRole come from the org's
    // team list (RLS-scoped, so a team the caller can't see just isn't there).
    listTeams(orgId)
      .then(({ teams }) => {
        if (cancelled) return;
        const found = teams.find((t) => t.id === teamId);
        if (!found) {
          setLoadError('Team not found.');
          return;
        }
        setTeam({ name: found.name, myRole: found.myRole });
        setNameDraft(found.name);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this team.');
      });
    reloadMembers();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, teamId]);

  if (!orgId || !teamId) return <Navigate to="/projects" replace />;

  const canManage = canManageTeam(team?.myRole);

  const handleLeave = async () => {
    if (!window.confirm('Leave this team? You will lose access to its projects.')) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await leaveTeam(orgId, teamId);
      navigate(`/orgs/${orgId}`);
    } catch (err) {
      // Org owners/admins get team 'admin' via team_role() without a member
      // row, so "not a member" is the expected 404 for them.
      setLeaveError(err instanceof ApiError ? err.message : 'Could not leave this team.');
      setLeaving(false);
    }
  };

  const saveName = async () => {
    if (!nameDraft.trim() || nameDraft.trim() === team?.name) return;
    setSavingName(true);
    try {
      const { team: updated } = await updateTeam(orgId, teamId, { name: nameDraft.trim() });
      setTeam((prev) => (prev ? { ...prev, name: updated.name } : prev));
    } catch {
      /* keep it simple */
    } finally {
      setSavingName(false);
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
            <button type="button" className="ws-empty-cta" onClick={() => navigate(`/orgs/${orgId}/settings`)}>Back to organization</button>
          </div>
        ) : (
          <>
            <div className="page-eyebrow">
              <Link to={`/orgs/${orgId}/settings`}>Organization</Link> › Team
            </div>
            <h1 className="page-title">{team?.name ?? 'Team'}</h1>
            <div className="page-subtitle">People invited to this team get access to just its projects.</div>

            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">General</div>
              <h2 className="ws-card-title">Name</h2>
              {canManage ? (
                <div className="orgset-inline-form">
                  <input className="orgset-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={120} />
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={savingName || !nameDraft.trim() || nameDraft.trim() === team?.name}
                    onClick={() => void saveName()}
                  >
                    {savingName ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <div className="orgset-readonly">{team?.name}</div>
              )}

              {leaveError && <div className="mm-error" role="alert" style={{ marginTop: 16 }}>{leaveError}</div>}
              <div className="orgset-danger">
                <button type="button" className="ws-btn ws-btn-danger-outline" disabled={leaving} onClick={() => void handleLeave()}>
                  {leaving ? 'Leaving…' : 'Leave team'}
                </button>
              </div>
            </section>

            <section className="ws-card orgset-card">
              <div className="ws-card-eyebrow">Access</div>
              <h2 className="ws-card-title">Team members</h2>
              <MemberManager
                members={members}
                invites={invites}
                canManage={canManage}
                inviteBasePath="/team-invites"
                onInvite={(email, role) => inviteTeamMember(orgId, teamId, { email, role })}
                onChangeRole={(memberId, role) => updateTeamMemberRole(orgId, teamId, memberId, role)}
                onRemove={(memberId) => removeTeamMember(orgId, teamId, memberId)}
                onRevoke={(inviteId) => revokeTeamInvite(orgId, teamId, inviteId)}
                onResend={(inviteId) => resendTeamInvite(orgId, teamId, inviteId)}
                onChanged={reloadMembers}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
