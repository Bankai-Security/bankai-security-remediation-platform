import { Link } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
import InviteBell from './InviteBell';
import OrgSwitcher from './OrgSwitcher';
import '../pages/TopBar.css';
import './OrgTopBar.css';

// Shared app-shell header for the org pages (settings, team settings). Brand +
// org switcher on the left; projects link, invite bell, avatar on the right.
export default function OrgTopBar() {
  const { user } = useCurrentUser();
  return (
    <div className="topbar">
      <div className="org-topbar-left">
        <Link to="/projects" className="topbar-brand">
          <img src={bankaiMark} alt="Bankai" className="topbar-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="topbar-brand-wordmark" />
        </Link>
        <span className="org-topbar-sep" aria-hidden="true">/</span>
        <OrgSwitcher />
      </div>
      <div className="topbar-user">
        <Link to="/projects" className="org-topbar-link">Projects</Link>
        <InviteBell />
        <div className="avatar-ring" style={getAvatarStyle(user)}>{getInitials(user)}</div>
      </div>
    </div>
  );
}
