import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { acceptTeamInvite, ApiError, declineTeamInvite, getTeamInviteByToken, type TeamInviteDetails } from '../lib/api';
import { useOrgs } from '../lib/org-context';
import './NewProject.css';

export default function TeamInviteAccept() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh, selectOrg } = useOrgs();
  const [invite, setInvite] = useState<TeamInviteDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getTeamInviteByToken(token)
      .then((fetched) => {
        if (!cancelled) setInvite(fetched);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setNeedsLogin(true);
        } else {
          setError(err instanceof ApiError ? err.message : 'This invite could not be found.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { orgId } = await acceptTeamInvite(token);
      refresh();
      // Accepting a team invite also makes you an org viewer, so the org rollup
      // is a sensible landing spot.
      if (orgId) {
        selectOrg(orgId);
        navigate(`/orgs/${orgId}`);
      } else {
        navigate('/projects');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this invite.');
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await declineTeamInvite(token);
      setDeclined(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not decline this invite.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-project-page">
      <div className="new-project-topbar">
        <div className="new-project-brand">
          <img src={bankaiMark} alt="Bankai" className="new-project-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="new-project-brand-wordmark" />
        </div>
      </div>

      <main className="new-project-main">
        <div className="new-project-breadcrumb">
          <Link to="/projects" className="new-project-breadcrumb-link">Bankai</Link>
          <span className="new-project-breadcrumb-sep">›</span>
          <span className="new-project-breadcrumb-current">Team invite</span>
        </div>
        <div className="new-project-divider" />

        <div className="new-project-eyebrow">Team invitation</div>

        {needsLogin ? (
          <>
            <h1 className="new-project-title">Log in to view this invite</h1>
            <div className="new-project-subtitle">
              <Link to="/login">Log in</Link> with the email address this invite was sent to, then come back to this link.
            </div>
          </>
        ) : declined ? (
          <>
            <h1 className="new-project-title">Invite declined</h1>
            <div className="new-project-subtitle">You can safely close this page.</div>
          </>
        ) : error ? (
          <>
            <h1 className="new-project-title">{error}</h1>
            <div className="new-project-subtitle"><Link to="/projects">Back to projects</Link></div>
          </>
        ) : !invite ? (
          <div className="new-project-subtitle">Loading…</div>
        ) : (
          <>
            <h1 className="new-project-title">Join {invite.teamName}</h1>
            <div className="new-project-subtitle">
              <span style={{ textTransform: 'capitalize' }}>Invited as {invite.role}</span> in {invite.orgName}.
            </div>
            <div className="new-project-actions" style={{ marginTop: 24 }}>
              <button className="new-project-create-btn" disabled={busy} onClick={() => void handleAccept()}>
                {busy ? 'Joining…' : 'Accept invite'}
              </button>
              <button className="new-project-cancel-link" disabled={busy} onClick={() => void handleDecline()}>
                Decline
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
