import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import InviteBell from '../components/InviteBell';
import OrgSwitcher from '../components/OrgSwitcher';
import { listProjects, type OrgProjectRef, type Project, type ProjectStats } from '../lib/api';
import { getAvatarStyle, getInitials, useCurrentUser } from '../lib/auth-context';
import { useOrgs } from '../lib/org-context';
import { aggregate, withStats as attachStats } from '../lib/org-rollup';
import { canManageOrg } from '../lib/roles';
import './TopBar.css';
import './workspace-pages/shared.css';
import './OrgRollup.css';

export default function OrgRollup() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { selectedOrgId, selectOrg, rollup, rollupLoading, rollupError } = useOrgs();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // Keep the shared selection in sync with the URL, so landing here directly
  // (or via the switcher) loads the right org's rollup.
  useEffect(() => {
    if (orgId && orgId !== selectedOrgId) selectOrg(orgId);
  }, [orgId, selectedOrgId, selectOrg]);

  // Per-project CVIT/ticket counts come from the existing projects endpoint,
  // itself RLS-scoped to what the user can see — the same numbers the Projects
  // page and Overview dashboard already render. We only aggregate them here.
  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then(({ projects: fetched }) => {
        if (!cancelled) setProjects(fetched);
      })
      .catch(() => {
        if (!cancelled) setProjectsError('Could not load project stats.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const statsById = useMemo(() => {
    const map = new Map<string, ProjectStats>();
    for (const p of projects ?? []) map.set(p.id, p.stats);
    return map;
  }, [projects]);

  const withStats = (ref: OrgProjectRef) => attachStats(ref, statsById);

  // rollup in context may still be pointing at the previously selected org for
  // one render after the URL changes — gate on the id matching this route.
  const activeRollup = rollup && rollup.id === orgId ? rollup : null;

  // A project can belong to several teams, so it appears under each in the
  // rollup tree. De-duplicate by project id before computing org-level totals,
  // or a shared project would double-count its CVITs/tickets and the project
  // count. (Per-team subtotals below intentionally still count membership.)
  const allProjects = useMemo(() => {
    if (!activeRollup) return [];
    const unique = new Map<string, ReturnType<typeof attachStats>>();
    for (const team of activeRollup.teams) {
      for (const ref of team.projects) {
        if (!unique.has(ref.id)) unique.set(ref.id, attachStats(ref, statsById));
      }
    }
    return [...unique.values()];
  }, [activeRollup, statsById]);
  const orgTotals = useMemo(() => aggregate(allProjects), [allProjects]);

  return (
    <div className="topbar-page">
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

      <main className="page-main">
        <div className="page-eyebrow">Organization</div>
        <div className="org-rollup-title-row">
          <h1 className="page-title">{activeRollup?.name ?? 'Organization rollup'}</h1>
          {activeRollup && canManageOrg(activeRollup.myRole) && (
            <Link to={`/orgs/${activeRollup.id}/settings`} className="ws-btn ws-btn-secondary org-rollup-manage">
              Manage organization
            </Link>
          )}
        </div>
        <div className="page-subtitle">
          Findings and CVIT counts aggregated across every team and project you can see in this organization.
        </div>

        {rollupError ? (
          <div className="ws-empty">
            <div className="ws-empty-title">{rollupError}</div>
            <div className="ws-empty-body">It may have been deleted, or you may not have access to it.</div>
            <button type="button" className="ws-empty-cta" onClick={() => navigate('/projects')}>Back to projects</button>
          </div>
        ) : rollupLoading || !activeRollup ? (
          <div className="page-subtitle">Loading organization…</div>
        ) : (
          <>
            {/* Aggregate KPIs — reuse the shared .ws-stat-tile dashboard component. */}
            <section className="org-kpi-grid">
              <div className="ws-stat-tile">
                <div className="ws-stat-tile-value">{orgTotals.totalCvits}</div>
                <div className="ws-stat-tile-label">Total CVITs</div>
              </div>
              <div className="ws-stat-tile">
                <div className="ws-stat-tile-value org-stat-value--alert">{orgTotals.slaBreachedPct}%</div>
                <div className="ws-stat-tile-label">SLA breached</div>
              </div>
              <div className="ws-stat-tile">
                <div className="ws-stat-tile-value">{orgTotals.openTickets}</div>
                <div className="ws-stat-tile-label">Open tickets</div>
              </div>
              <div className="ws-stat-tile">
                <div className="ws-stat-tile-value">{activeRollup.teams.length}</div>
                <div className="ws-stat-tile-label">Teams</div>
              </div>
              <div className="ws-stat-tile">
                <div className="ws-stat-tile-value">{orgTotals.projectCount}</div>
                <div className="ws-stat-tile-label">Projects</div>
              </div>
            </section>

            {projectsError && <div className="org-inline-warning">{projectsError} Counts may be incomplete.</div>}

            {/* Per-team breakdown, reusing the shared .ws-table dashboard component. */}
            {activeRollup.teams.length === 0 ? (
              <div className="ws-empty">
                <div className="ws-empty-title">No teams yet</div>
                <div className="ws-empty-body">This organization has no teams or projects you can see.</div>
              </div>
            ) : (
              <div className="org-teams">
                {activeRollup.teams.map((team) => {
                  const teamProjects = team.projects.map(withStats);
                  const teamTotals = aggregate(teamProjects);
                  return (
                    <section key={team.id} className="ws-card org-team-card">
                      <div className="org-team-head">
                        <div>
                          <div className="ws-card-eyebrow">Team</div>
                          <h2 className="org-team-title">{team.name}</h2>
                        </div>
                        <div className="org-team-subtotal">
                          <span><strong>{teamTotals.totalCvits}</strong> CVITs</span>
                          <span><strong>{teamTotals.openTickets}</strong> open</span>
                          <span>{teamProjects.length} {teamProjects.length === 1 ? 'project' : 'projects'}</span>
                        </div>
                      </div>

                      {teamProjects.length === 0 ? (
                        <div className="org-team-empty">No projects in this team.</div>
                      ) : (
                        <div className="ws-table org-project-table" style={{ ['--ws-cols' as string]: '2fr 1fr 0.9fr 1fr' }}>
                          <div className="ws-table-head">
                            <span>Project</span>
                            <span className="ws-col-right">CVITs</span>
                            <span className="ws-col-right">SLA breached</span>
                            <span className="ws-col-right">Open tickets</span>
                          </div>
                          {teamProjects.map((project) => (
                            <Link
                              key={project.id}
                              to={`/workspace/${project.id}/${project.status === 'active' ? 'overview' : 'intake'}`}
                              className="ws-table-row ws-table-row--clickable org-project-row"
                            >
                              <span className="org-project-name">
                                <span className={`ws-dot ${project.status === 'active' ? 'org-dot--active' : 'org-dot--muted'}`} />
                                {project.name}
                              </span>
                              <span className="ws-col-right org-project-figure">{project.stats.totalCvits}</span>
                              <span className="ws-col-right org-project-figure org-stat-value--alert">{project.stats.slaBreachedPct}%</span>
                              <span className="ws-col-right org-project-figure">{project.stats.openTickets}</span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
