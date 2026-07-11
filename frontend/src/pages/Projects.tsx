import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import './TopBar.css';
import './Projects.css';

const PAGE_STATE: 'data' | 'empty' = 'data';

export default function Projects() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const isEmpty = PAGE_STATE === 'empty';

  return (
    <div className="topbar-page">
      <div className="topbar">
        <Link to="/projects" className="topbar-brand">
          <img src={bankaiMark} alt="Bankai" className="topbar-brand-mark" />
          <img src={bankaiWordmark} alt="BANKAI" className="topbar-brand-wordmark" />
        </Link>
        <div className="topbar-user">
          <div className="avatar-ring">AG</div>
          <div>
            <div className="topbar-user-name">Abhinav Gupta</div>
            <div className="topbar-user-email">abhiyug5@gmail.com</div>
          </div>
          <button className="topbar-user-menu-btn" onClick={() => setMenuOpen((v) => !v)}>⋯</button>

          {menuOpen && (
            <>
              <div className="topbar-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="topbar-menu">
                <button
                  className="topbar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/login');
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8"></path>
                    <path d="M13 13.5 17 10l-4-3.5"></path>
                    <path d="M17 10H8"></path>
                  </svg>
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <main className="page-main">
        <div className="page-eyebrow">Workspace</div>
        <h1 className="page-title">Projects</h1>
        <div className="page-subtitle">Pick a project to open its remediation pipeline.</div>

        {isEmpty ? (
          <div className="projects-empty">
            <div className="projects-empty-icon">
              <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="#8A8A8E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="4.5" width="15" height="11" rx="2"></rect>
                <path d="M2.5 8h15"></path>
              </svg>
            </div>
            <div className="projects-empty-title">No projects yet</div>
            <div className="projects-empty-body">
              Connect a scanner export for a project and Bankai will start triaging CVITs into a remediation pipeline.
            </div>
            <Link to="/projects/new" className="projects-empty-cta">+ New project</Link>
          </div>
        ) : (
          <div className="projects-grid">
            <Link to="/workspace/workflow" className="project-card project-card--active">
              <div className="project-card-status-row">
                <span className="project-card-status project-card-status--active">
                  <span className="project-card-status-dot project-card-status-dot--active" />
                  Active
                </span>
              </div>
              <div className="project-card-title">Identity Platform</div>
              <div className="project-card-tags">
                <span className="project-card-tag">Identity Core</span>
                <span className="project-card-tag">Identity Apps</span>
              </div>
              <div className="project-card-stats">
                <div>
                  <div className="project-card-stat-value">376</div>
                  <div className="project-card-stat-label">Total CVITs</div>
                </div>
                <div>
                  <div className="project-card-stat-value project-card-stat-value--red">40%</div>
                  <div className="project-card-stat-label">SLA breached</div>
                </div>
                <div>
                  <div className="project-card-stat-value">37</div>
                  <div className="project-card-stat-label">Open tickets</div>
                </div>
              </div>
              <div className="project-card-footer">Last intake Jul 6, 2026</div>
            </Link>

            <div className="project-card project-card--muted">
              <div className="project-card-status-row">
                <span className="project-card-status">
                  <span className="project-card-status-dot" />
                  Not connected
                </span>
              </div>
              <div className="project-card-title project-card-title--muted">Payments Platform</div>
              <div className="project-card-muted-body">
                Connect a scanner export for this project to start triaging CVITs.
              </div>
            </div>

            <div className="project-card project-card--muted">
              <div className="project-card-status-row">
                <span className="project-card-status">
                  <span className="project-card-status-dot" />
                  Not connected
                </span>
              </div>
              <div className="project-card-title project-card-title--muted">Cloud Infrastructure</div>
              <div className="project-card-muted-body">
                Connect a scanner export for this project to start triaging CVITs.
              </div>
            </div>

            <Link to="/projects/new" className="project-card-new">
              <div className="project-card-new-icon">+</div>
              <div className="project-card-new-title">New project</div>
              <div className="project-card-new-sub">Connect another scanner feed</div>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
