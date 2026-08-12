import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getOrg, listOrgs, type OrgDetail, type OrgSummary } from './api';
import { useCurrentUser } from './auth-context';

interface OrgContextValue {
  // The orgs the user belongs to (for the switcher). null while first loading.
  orgs: OrgSummary[] | null;
  loading: boolean;
  error: string | null;
  // The currently selected org id, persisted across sessions.
  selectedOrgId: string | null;
  selectOrg: (orgId: string) => void;
  // The selected org's teams → projects rollup. null while loading or when no
  // org is selected. RLS-scoped server-side, so it already reflects exactly
  // what this user is allowed to see.
  rollup: OrgDetail | null;
  rollupLoading: boolean;
  rollupError: string | null;
  refresh: () => void;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

const STORAGE_KEY = 'bankai-selected-org';

function readStoredOrgId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useCurrentUser();
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => readStoredOrgId());
  const [rollup, setRollup] = useState<OrgDetail | null>(null);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [rollupError, setRollupError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Load the org list once the user is known — same gating InviteBell uses, so
  // /api/orgs is never hit on the public (logged-out) pages.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setOrgs(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    listOrgs()
      .then(({ orgs: fetched }) => {
        if (cancelled) return;
        setOrgs(fetched);
        // Keep the stored selection if it's still a member org; otherwise fall
        // back to the first org so the switcher always has a valid target.
        setSelectedOrgId((current) => {
          if (current && fetched.some((o) => o.id === current)) return current;
          return fetched[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your organizations.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, authLoading, refreshTick]);

  // Load the selected org's rollup whenever the selection changes.
  useEffect(() => {
    if (!selectedOrgId) {
      setRollup(null);
      return;
    }

    let cancelled = false;
    setRollupLoading(true);
    setRollupError(null);

    getOrg(selectedOrgId)
      .then(({ org }) => {
        if (!cancelled) setRollup(org);
      })
      .catch(() => {
        if (!cancelled) setRollupError('Could not load this organization.');
      })
      .finally(() => {
        if (!cancelled) setRollupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedOrgId, refreshTick]);

  const selectOrg = (orgId: string) => {
    setSelectedOrgId(orgId);
    try {
      localStorage.setItem(STORAGE_KEY, orgId);
    } catch {
      /* ignore */
    }
  };

  const refresh = () => setRefreshTick((t) => t + 1);

  const value = useMemo<OrgContextValue>(
    () => ({ orgs, loading, error, selectedOrgId, selectOrg, rollup, rollupLoading, rollupError, refresh }),
    [orgs, loading, error, selectedOrgId, rollup, rollupLoading, rollupError],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrgs(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrgs must be used within an OrgProvider');
  return ctx;
}
