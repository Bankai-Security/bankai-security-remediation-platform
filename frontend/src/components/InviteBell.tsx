import { useEffect, useState } from 'react';
import { acceptInvite, declineInvite, listMyInvites, type MyInvite } from '../lib/api';
import './InviteBell.css';

export default function InviteBell() {
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [open, setOpen] = useState(false);
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const refresh = () => {
    listMyInvites()
      .then(({ invites: fetched }) => setInvites(fetched))
      .catch(() => {
        /* best-effort — an invite list failure shouldn't break the page it's mounted on */
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAccept = async (invite: MyInvite) => {
    setBusyToken(invite.token);
    try {
      const { projectId } = await acceptInvite(invite.token);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      window.location.href = `/workspace/${projectId}/overview`;
    } catch {
      refresh();
    } finally {
      setBusyToken(null);
    }
  };

  const handleDecline = async (invite: MyInvite) => {
    setBusyToken(invite.token);
    try {
      await declineInvite(invite.token);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch {
      refresh();
    } finally {
      setBusyToken(null);
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
                <div key={invite.id} className="invite-bell-item">
                  <div className="invite-bell-item-text">
                    <span className="invite-bell-item-project">{invite.projectName}</span>
                    <span className="invite-bell-item-role">Invited as {invite.role}</span>
                  </div>
                  <div className="invite-bell-item-actions">
                    <button
                      className="invite-bell-accept"
                      disabled={busyToken === invite.token}
                      onClick={() => void handleAccept(invite)}
                    >
                      Accept
                    </button>
                    <button
                      className="invite-bell-decline"
                      disabled={busyToken === invite.token}
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
