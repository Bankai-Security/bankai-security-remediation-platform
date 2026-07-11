import { Link } from 'react-router-dom';
import './Overview.css';

const KPI_CARDS = [
  { label: 'Total CVITs', value: '376', delta: '▲ 5 vs last week', deltaColor: '#DC2626' },
  { label: 'SLA breached', value: '40.4', unit: '%', delta: '▼ 2.1 pts vs last week', deltaColor: '#16A34A' },
  { label: 'Open tickets', value: '37', delta: 'no change', deltaColor: '#8A8A8E' },
  { label: 'Mean time to remediate', value: '11.4', unit: 'd', delta: '▼ 0.8d vs last week', deltaColor: '#16A34A' },
];

const SEVERITY_DISTRIBUTION = [
  { label: 'Critical', count: 41, pct: 11, color: '#DC2626' },
  { label: 'High', count: 118, pct: 31, color: '#F97316' },
  { label: 'Medium', count: 152, pct: 40, color: '#EAB308' },
  { label: 'Low', count: 65, pct: 17, color: '#8A8A8E' },
];

const SERVICE_ROWS = [
  { name: 'Identity Core', total: 152, missed: 64, approaching: 21, onTrack: 67 },
  { name: 'Identity Apps', total: 224, missed: 88, approaching: 30, onTrack: 106 },
];

const RECENT_ACTIVITY = [
  { dot: '#EF4444', text: <><strong>CVIT-2214</strong> breached its SLA (Identity Apps)</>, time: 'Today 08:12' },
  { dot: '#2563EB', text: <><strong>BNK-142</strong> synced with Jira</>, time: 'Today 07:40' },
  { dot: '#22C55E', text: <>AI triage completed for <strong>weekly_scan_jul06.csv</strong></>, time: 'Mon 09:05' },
  { dot: '#8A8A8E', text: <><strong>weekly_scan_jul06.csv</strong> uploaded by Abhinav</>, time: 'Mon 09:01' },
];

const TREND_PATH = 'M10,176 L110,156 L210,114 L310,136 L410,91 L510,71 L610,52 L710,44';
const TREND_AREA = `${TREND_PATH} L710,190 L10,190 Z`;
const TREND_LABELS = ['May 18', 'May 25', 'Jun 1', 'Jun 8', 'Jun 15', 'Jun 22', 'Jun 29', 'Jul 6'];

export default function Overview() {
  return (
    <main className="ws-page">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <Link to="/workspace/workflow" className="ws-breadcrumb-link">Identity Platform</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">Overview</span>
      </div>
      <div className="ws-divider" />

      <div className="overview-kpi-grid">
        {KPI_CARDS.map((kpi) => (
          <div key={kpi.label} className="ws-card overview-kpi-card">
            <div className="overview-kpi-label">{kpi.label}</div>
            <div className="overview-kpi-value">
              {kpi.value}
              {kpi.unit && <span className="overview-kpi-unit">{kpi.unit}</span>}
            </div>
            <div className="overview-kpi-delta" style={{ color: kpi.deltaColor }}>{kpi.delta}</div>
          </div>
        ))}
      </div>

      <div className="overview-trend-grid">
        <section className="ws-card overview-trend-card">
          <div className="ws-card-eyebrow">Last 8 weeks</div>
          <h2 className="ws-card-title">CVITs over time</h2>
          <svg viewBox="0 0 720 210" className="overview-trend-svg">
            <line x1="10" y1="10" x2="710" y2="10" stroke="var(--color-divider)" strokeWidth="1" />
            <line x1="10" y1="70" x2="710" y2="70" stroke="var(--color-divider)" strokeWidth="1" />
            <line x1="10" y1="130" x2="710" y2="130" stroke="var(--color-divider)" strokeWidth="1" />
            <line x1="10" y1="190" x2="710" y2="190" stroke="var(--color-divider)" strokeWidth="1" />
            <path d={TREND_AREA} fill="rgba(37,99,235,0.07)" />
            <path d={TREND_PATH} fill="none" stroke="var(--color-blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="710" cy="44" r="4.5" fill="var(--color-blue)" stroke="var(--color-surface)" strokeWidth="2" />
          </svg>
          <div className="overview-trend-labels">
            {TREND_LABELS.map((l) => <span key={l}>{l}</span>)}
          </div>
        </section>

        <section className="ws-card overview-severity-card">
          <div className="ws-card-eyebrow">All services</div>
          <h2 className="ws-card-title">Severity distribution</h2>
          <div className="overview-severity-list">
            {SEVERITY_DISTRIBUTION.map((s) => (
              <div key={s.label}>
                <div className="overview-severity-row">
                  <span className="overview-severity-name">{s.label}</span>
                  <span className="overview-severity-count">{s.count}</span>
                </div>
                <div className="ws-progress-track">
                  <div className="ws-progress-fill" style={{ width: `${s.pct}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="overview-bottom-grid">
        <section className="ws-card overview-service-card">
          <div className="ws-card-eyebrow">Per service</div>
          <h2 className="ws-card-title">Service breakdown</h2>
          <div className="overview-service-head">
            <span>Service</span>
            <span className="ws-col-right">Total</span>
            <span className="ws-col-right">Missed SLA</span>
            <span className="ws-col-right">Approaching</span>
            <span className="ws-col-right">On track</span>
          </div>
          {SERVICE_ROWS.map((row) => (
            <div key={row.name} className="overview-service-row">
              <span className="overview-service-name">{row.name}</span>
              <span className="ws-col-right overview-service-total">{row.total}</span>
              <span className="ws-col-right overview-service-missed">{row.missed}</span>
              <span className="ws-col-right overview-service-approaching">{row.approaching}</span>
              <span className="ws-col-right overview-service-ontrack">{row.onTrack}</span>
            </div>
          ))}
          <div className="overview-service-bar">
            <div style={{ width: '40.4%', background: '#EF4444' }} />
            <div style={{ width: '13.6%', background: '#EAB308' }} />
            <div style={{ width: '46%', background: '#22C55E' }} />
          </div>
          <div className="overview-service-legend">
            <span><span className="overview-legend-dot" style={{ background: '#EF4444' }} />Missed SLA</span>
            <span><span className="overview-legend-dot" style={{ background: '#EAB308' }} />Approaching</span>
            <span><span className="overview-legend-dot" style={{ background: '#22C55E' }} />On track</span>
          </div>
        </section>

        <section className="ws-card overview-activity-card">
          <div className="overview-activity-header">
            <div>
              <div className="ws-card-eyebrow">Latest events</div>
              <h2 className="ws-card-title">Recent activity</h2>
            </div>
            <Link to="/workspace/activity" className="overview-activity-view-all">View all</Link>
          </div>
          <div>
            {RECENT_ACTIVITY.map((ev, i) => (
              <div key={i} className="overview-activity-item">
                <span className="ws-dot" style={{ background: ev.dot }} />
                <span className="overview-activity-text">{ev.text}</span>
                <span className="overview-activity-time">{ev.time}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
