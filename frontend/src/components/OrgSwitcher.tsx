import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrgs } from '../lib/org-context';
import './OrgSwitcher.css';

// Org picker for the app shell. Selecting an org updates the shared OrgProvider
// selection (persisted) and routes to that org's rollup, so the rollup view and
// the switcher always agree on which org is active.
export default function OrgSwitcher() {
  const { orgs, loading, selectedOrgId, selectOrg } = useOrgs();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (loading && !orgs) {
    return <div className="org-switcher-skeleton ws-skeleton" aria-hidden="true" />;
  }
  if (!orgs || orgs.length === 0) {
    return null;
  }

  const active = orgs.find((o) => o.id === selectedOrgId) ?? orgs[0]!;

  const choose = (orgId: string) => {
    setOpen(false);
    selectOrg(orgId);
    navigate(`/orgs/${orgId}`);
  };

  return (
    <div className="org-switcher">
      <button
        type="button"
        className="org-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="6" height="6" rx="1.4" />
          <rect x="11" y="3" width="6" height="6" rx="1.4" />
          <rect x="3" y="11" width="6" height="6" rx="1.4" />
          <rect x="11" y="11" width="6" height="6" rx="1.4" />
        </svg>
        <span className="org-switcher-name">{active.name}</span>
        <svg className="org-switcher-chevron" width="11" height="7" viewBox="0 0 11 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 1l4.5 4.5L10 1" />
        </svg>
      </button>

      {open && (
        <>
          <div className="org-switcher-backdrop" onClick={() => setOpen(false)} />
          <div className="org-switcher-menu" role="listbox">
            <div className="org-switcher-menu-label">Organizations</div>
            {orgs.map((org) => (
              <button
                key={org.id}
                type="button"
                role="option"
                aria-selected={org.id === active.id}
                className={`org-switcher-item ${org.id === active.id ? 'org-switcher-item--active' : ''}`}
                onClick={() => choose(org.id)}
              >
                <span className="org-switcher-item-name">{org.name}</span>
                <span className="org-switcher-item-role">{org.myRole}</span>
                {org.id === active.id && (
                  <svg className="org-switcher-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </button>
            ))}
            <button
              type="button"
              className="org-switcher-new"
              onClick={() => {
                setOpen(false);
                navigate('/orgs/new');
              }}
            >
              + New organization
            </button>
          </div>
        </>
      )}
    </div>
  );
}
