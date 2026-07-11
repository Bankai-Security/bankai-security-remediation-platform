import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import './RemediationWorkflow.css';

const STEPS = [
  {
    n: 1,
    to: '/workspace/workflow/intake-triage',
    title: 'Intake & Triage',
    sub: 'CSV to XLS, split by service',
    done: true,
  },
  {
    n: 2,
    to: '/workspace/workflow/defect-generation',
    title: 'Defect Generation',
    sub: 'XLS to structured defects per service',
    done: true,
  },
  {
    n: 3,
    to: '/workspace/workflow/jira-tickets',
    title: 'Jira Tickets',
    sub: 'Defects to tickets with PR/CR/CD',
    done: false,
  },
];

const DONUTS = [
  {
    name: 'Identity Core',
    total: 152,
    missed: 64,
    approaching: 21,
    segments: [
      { color: '#EF4444', dasharray: '158.7 377', dashoffset: '0' },
      { color: '#EAB308', dasharray: '52.1 377', dashoffset: '-158.7' },
      { color: '#22C55E', dasharray: '166.2 377', dashoffset: '-210.8' },
    ],
  },
  {
    name: 'Identity Apps',
    total: 224,
    missed: 88,
    approaching: 30,
    segments: [
      { color: '#EF4444', dasharray: '148.1 377', dashoffset: '0' },
      { color: '#EAB308', dasharray: '50.5 377', dashoffset: '-148.1' },
      { color: '#22C55E', dasharray: '178.4 377', dashoffset: '-198.6' },
    ],
  },
];

const TRIAGE_SNAPSHOT = [
  { value: 0, label: 'New Delta' },
  { value: 376, label: 'Already in Progress' },
  { value: 0, label: 'Changed' },
  { value: 0, label: 'Resolved/Not Present' },
];

export default function RemediationWorkflow() {
  return (
    <main className="ws-page">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">Identity Platform</span>
      </div>
      <div className="ws-divider" />

      <div className="workflow-stepper">
        {STEPS.map((step) => (
          <Link key={step.n} to={step.to} className="workflow-step-card">
            <div className={`workflow-step-num ${step.done ? 'workflow-step-num--done' : 'workflow-step-num--pending'}`}>
              {step.n}
            </div>
            <div className="workflow-step-text">
              <div className="workflow-step-title">{step.title}</div>
              <div className="workflow-step-sub">{step.sub}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="workflow-step-chevron">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </Link>
        ))}
      </div>

      <section className="ws-card workflow-section">
        <div className="workflow-section-header">
          <div>
            <div className="ws-card-eyebrow">CSV Summary</div>
            <h2 className="workflow-section-title">Identity CVIT Snapshot</h2>
          </div>
          <span className="workflow-total-badge">
            Total CVITs <span className="workflow-total-badge-value">376</span>
          </span>
        </div>

        <div className="workflow-donut-grid">
          {DONUTS.map((d, i) => (
            <Fragment key={d.name}>
              {i === 1 && <div className="workflow-donut-divider" />}
              <div>
                <div className="workflow-donut-header">
                  <div className="workflow-donut-name">{d.name}</div>
                  <button className="workflow-donut-menu">⋯</button>
                </div>
                <div className="workflow-donut-row">
                  <div className="workflow-donut-chart">
                    <svg width="172" height="172" viewBox="0 0 172 172" style={{ transform: 'rotate(-90deg)' }}>
                      {d.segments.map((s, si) => (
                        <circle key={si} cx="86" cy="86" r="60" fill="none" stroke={s.color} strokeWidth="26" strokeDasharray={s.dasharray} strokeDashoffset={s.dashoffset} />
                      ))}
                    </svg>
                    <div className="workflow-donut-center">
                      <div className="workflow-donut-center-value">{d.total}</div>
                      <div className="workflow-donut-center-label">CVITs</div>
                    </div>
                  </div>
                  <div className="workflow-donut-legend">
                    <div className="workflow-donut-legend-row">
                      <span className="ws-dot" style={{ background: '#EF4444' }} />
                      <span className="workflow-donut-legend-label">Missed SLA</span>
                      <span className="workflow-donut-legend-value">{d.missed}</span>
                    </div>
                    <div className="workflow-donut-legend-row">
                      <span className="ws-dot" style={{ background: '#EAB308' }} />
                      <span className="workflow-donut-legend-label">Approaching Target</span>
                      <span className="workflow-donut-legend-value">{d.approaching}</span>
                    </div>
                    <div className="workflow-donut-legend-row">
                      <span className="ws-dot" style={{ background: '#22C55E' }} />
                      <span className="workflow-donut-legend-label">Total CVITs</span>
                      <span className="workflow-donut-legend-value">{d.total}</span>
                    </div>
                  </div>
                </div>
              </div>
            </Fragment>
          ))}
        </div>
      </section>

      <section className="ws-card workflow-section">
        <div className="workflow-section-header">
          <div>
            <div className="ws-card-eyebrow">Weekly Delta</div>
            <h2 className="workflow-section-title">Monday Triage Snapshot</h2>
            <div className="workflow-section-sub">First processed CSV. New delta rows are eligible for Jira creation.</div>
          </div>
          <span className="workflow-pink-badge">0 new Jira row(s)</span>
        </div>
        <div className="workflow-snapshot-grid">
          {TRIAGE_SNAPSHOT.map((s) => (
            <div key={s.label} className="ws-stat-tile">
              <div className="ws-stat-tile-value" style={{ fontSize: 30 }}>{s.value}</div>
              <div className="ws-stat-tile-label" style={{ marginTop: 9 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="ws-card">
        <h2 className="workflow-intake-title">Report Intake &amp; Triage</h2>
        <div className="workflow-intake-sub">
          Upload your vulnerability scan CSV. The pipeline parses, triages and generates a structured XLS with findings split by service.
        </div>
        <div className="ws-dropzone">
          <svg width="64" height="52" viewBox="0 0 64 52" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 40h-4.5C8 40 3.5 35.5 3.5 30c0-5 3.7-9.1 8.5-9.9C13.3 12.6 19.9 6.5 28 6.5c7 0 13 4.5 15.2 10.8 6.6 0.3 11.8 5.7 11.8 12.3 0 5.8-4.1 9.7-9.5 10.4" />
            <circle cx="32" cy="38" r="10.5" fill="var(--color-bg)" />
            <path d="M27.5 38.5 30.8 41.8 36.8 34.8" />
          </svg>
          <div className="ws-dropzone-title">Drag and drop your files here or choose files</div>
          <div className="ws-dropzone-body">
            Upload your vulnerability scan CSV. The pipeline parses, triages and generates a structured XLS with findings split by service.
          </div>
          <Link to="/workspace/intake" className="ws-btn ws-btn-primary" style={{ marginTop: 20 }}>Browse File</Link>
        </div>
      </section>
    </main>
  );
}
