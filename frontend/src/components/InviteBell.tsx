import { useEffect, useState } from 'react';
import {
  acceptInvite,
  acceptOrgInvite,
  acceptTeamInvite,
  declineInvite,
  declineOrgInvite,
  declineTeamInvite,
  listMyInvites,
  listMyOrgInvites,
  listMyTeamInvites,
  type MemberRole,
} from '../lib/api';
import './InviteBell.css';

// Unified pending-invite item across the three invite kinds so one dropdown can
// show them all.
interface UnifiedInvite {
  kind: 'project' | 'org' | 'team';
  id: string;
  token: string;
  label: string; // project / org / team name
  context: string | null; // e.g. the org a team belongs to
  role: Exclude<MemberRole, 'owner'>;
}

export default function InviteBell() {
  const [invites, setInvites] = useState<UnifiedInvite[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => {
    // Each list is best-effort — one failing (or one endpoint being absent for
    // a logged-out probe) shouldn't blank out the others or break the page.
    Promise.allSettled([listMyInvites(), listMyOrgInvites(), listMyTeamInvites()]).then((results) => {
      const merged: UnifiedInvite[] = [];
      if (results[0].status === 'fulfilled') {
        for (const i of results[0].value.invites) {
          merged.push({ kind: 'project', id: i.id, token: i.token, label: i.projectName, context: null, role: i.role });
        }
      }
      if (results[1].status === 'fulfilled') {
        for (const i of results[1].value.invites) {
          merged.push({ kind: 'org', id: i.id, token: i.token, label: i.orgName, context: null, role: i.role });
        }
      }
      if (results[2].status === 'fulfilled') {
        for (const i of results[2].value.invites) {
          merged.push({ kind: 'team', id: i.id, token: i.token, label: i.teamName, context: i.orgName, role: i.role });
        }
      }
      setInvites(merged);
    });
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAccept = async (invite: UnifiedInvite) => {
    setBusyId(invite.id);
    try {
      if (invite.kind === 'project') {
        const { projectId } = await acceptInvite(invite.token);
        window.location.href = `/workspace/${projectId}/overview`;
      } else if (invite.kind === 'org') {
        const { orgId } = await acceptOrgInvite(invite.token);
        window.location.href = `/orgs/${orgId}`;
      } else {
        const { orgId } = await acceptTeamInvite(invite.token);
        window.location.href = orgId ? `/orgs/${orgId}` : '/projects';
      }
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch {
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleDecline = async (invite: UnifiedInvite) => {
    setBusyId(invite.id);
    try {
      if (invite.kind === 'project') await declineInvite(invite.token);
      else if (invite.kind === 'org') await declineOrgInvite(invite.token);
      else await declineTeamInvite(invite.token);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch {
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="invite-bell">
      <button className="invite-bell-btn" onClick={() => setOpen((v) => !v)} title="Invites">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 8a5 5 0 0 1 10 0c0 3.5 1.2 4.5 1.2 4.5H3.8S5 11.5 5 8Z" />
          <path d="M8.3 15a1.8 1.8 0 0 0 3.4 0" />
        </svg>
        {invites.length > 0 && <span className="invite-bell-badge">{invites.length}</span>}
      </button>

      {open && (
        <>
          <div className="invite-bell-backdrop" onClick={() => setOpen(false)} />
          <div className="invite-bell-menu">
            <div className="invite-bell-menu-title">Invitations</div>
            {invites.length === 0 ? (
              <div className="invite-bell-empty">No pending invites.</div>
            ) : (
              invites.map((invite) => (
                <div key={`${invite.kind}-${invite.id}`} className="invite-bell-item">
                  <div className="invite-bell-item-text">
                    <span className="invite-bell-item-project">
                      {invite.label}
                      {invite.context && <span className="invite-bell-item-context"> · {invite.context}</span>}
                    </span>
                    <span className="invite-bell-item-role">
                      {invite.kind === 'team' ? 'Team' : invite.kind === 'org' ? 'Organization' : 'Project'} · invited as {invite.role}
                    </span>
                  </div>
                  <div className="invite-bell-item-actions">
                    <button
                      className="invite-bell-accept"
                      disabled={busyId === invite.id}
                      onClick={() => void handleAccept(invite)}
                    >
                      Accept
                    </button>
                    <button
                      className="invite-bell-decline"
                      disabled={busyId === invite.id}
                      onClick={() => void handleDecline(invite)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
