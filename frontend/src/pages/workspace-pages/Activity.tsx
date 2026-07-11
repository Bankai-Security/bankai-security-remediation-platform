import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import './Activity.css';

type EventType = 'upload' | 'triage' | 'ticket' | 'sync' | 'sla';

interface ActivityEvent {
  day: string;
  type: EventType;
  actor: string;
  text: string;
  link: string;
  linkTo: string;
  meta: string;
  time: string;
}

const DATA: ActivityEvent[] = [
  { day: 'Today — Wed, Jul 9', type: 'sla', actor: 'System / AI', text: 'flagged an SLA breach on', link: 'CVIT-2214', linkTo: '/workspace/triage', meta: 'Identity Apps · SLA target Jul 4 exceeded by 5 days', time: '08:12' },
  { day: 'Today — Wed, Jul 9', type: 'sync', actor: 'System / AI', text: 'synced 9 tickets with Jira —', link: 'BNK board', linkTo: '/workspace/tickets', meta: '2 status changes pulled: BNK-112 → In Review, BNK-102 → Done', time: '07:40' },
  { day: 'Yesterday — Tue, Jul 8', type: 'ticket', actor: 'Abhinav Gupta', text: 'reassigned', link: 'BNK-121', linkTo: '/workspace/tickets', meta: 'Rotate expiring intermediate TLS certificate · MT is the new assignee', time: '16:24' },
  { day: 'Yesterday — Tue, Jul 8', type: 'triage', actor: 'Abhinav Gupta', text: 'accepted the AI bucket for', link: 'CVIT-2244', linkTo: '/workspace/triage', meta: 'Changed · confidence 88% · ticket BNK-121 updated in place', time: '11:03' },
  { day: 'Monday — Jul 6', type: 'triage', actor: 'System / AI', text: 'completed triage for', link: 'weekly_scan_jul06.csv', linkTo: '/workspace/intake', meta: '376 CVITs · 0 new delta · 376 already in progress · 0 changed', time: '09:05' },
  { day: 'Monday — Jul 6', type: 'upload', actor: 'Abhinav Gupta', text: 'uploaded', link: 'weekly_scan_jul06.csv', linkTo: '/workspace/intake', meta: '2.4 MB · 376 rows · diffed against intake of Jun 29', time: '09:01' },
  { day: 'Monday — Jul 6', type: 'sync', actor: 'System / AI', text: 'synced 9 tickets with Jira —', link: 'BNK board', linkTo: '/workspace/tickets', meta: 'no drift detected', time: '07:40' },
  { day: 'Week of Jun 29', type: 'ticket', actor: 'System / AI', text: 'created', link: 'BNK-129', linkTo: '/workspace/tickets', meta: 'Remove public read ACL from idp-export-archive · from CVIT-2259 (new delta)', time: 'Jun 29 · 09:12' },
  { day: 'Week of Jun 29', type: 'ticket', actor: 'System / AI', text: 'created', link: 'BNK-127', linkTo: '/workspace/tickets', meta: 'Add rate limiting to password reset endpoint · from CVIT-2205', time: 'Jun 29 · 09:12' },
  { day: 'Week of Jun 29', type: 'triage', actor: 'System / AI', text: 'completed triage for', link: 'weekly_scan_jun29.csv', linkTo: '/workspace/intake', meta: '371 CVITs · 2 new delta · 368 already in progress · 1 changed', time: 'Jun 29 · 09:06' },
  { day: 'Week of Jun 29', type: 'upload', actor: 'Abhinav Gupta', text: 'uploaded', link: 'weekly_scan_jun29.csv', linkTo: '/workspace/intake', meta: '2.3 MB · 371 rows', time: 'Jun 29 · 09:01' },
  { day: 'Week of Jun 29', type: 'sla', actor: 'System / AI', text: 'flagged an SLA breach on', link: 'CVIT-2183', linkTo: '/workspace/triage', meta: 'Identity Apps · SQL injection in legacy admin search', time: 'Jun 30 · 06:00' },
];

const TABS: { key: EventType | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upload', label: 'Uploads' },
  { key: 'triage', label: 'Triage' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'sync', label: 'Sync' },
  { key: 'sla', label: 'SLA' },
];

function eventIcon(type: EventType): { bg: string; icon: ReactElement } {
  const stroke = { fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (type === 'upload') return { bg: 'var(--color-fill)', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#3A3A3C" {...stroke}><path d="M8 11V3.5" /><path d="M5 6 8 3l3 3" /><path d="M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" /></svg>
  ) };
  if (type === 'triage') return { bg: '#DCFCE7', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#15803D" {...stroke}><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
  ) };
  if (type === 'ticket') return { bg: '#DBEAFE', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#1D4ED8" {...stroke}><path d="M2.5 6v-1A1 1 0 0 1 3.5 4h9a1 1 0 0 1 1 1v1a2 2 0 0 0 0 4v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1a2 2 0 0 0 0-4Z" /></svg>
  ) };
  if (type === 'sync') return { bg: '#DBEAFE', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#1D4ED8" {...stroke}><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 1.5v3h-3" /></svg>
  ) };
  return { bg: '#FEE2E2', icon: (
    <svg width="15" height="15" viewBox="0 0 16 16" stroke="#B91C1C" {...stroke}><path d="M8 5v4" /><circle cx="8" cy="11.5" r="0.4" fill="#B91C1C" /><path d="M7.1 2.3 1.8 12a1 1 0 0 0 .9 1.5h10.6a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0Z" /></svg>
  ) };
}

export default function Activity() {
  const [fType, setFType] = useState<EventType | 'all'>('all');
  const [fActor, setFActor] = useState('all');

  const filtered = useMemo(
    () => DATA.filter((ev) => (fType === 'all' || ev.type === fType) && (fActor === 'all' || ev.actor === fActor)),
    [fType, fActor]
  );

  const groups = useMemo(() => {
    const order: string[] = [];
    const byDay: Record<string, ActivityEvent[]> = {};
    filtered.forEach((ev) => {
      if (!byDay[ev.day]) {
        byDay[ev.day] = [];
        order.push(ev.day);
      }
      byDay[ev.day].push(ev);
    });
    return order.map((day) => ({ day, items: byDay[day] }));
  }, [filtered]);

  return (
    <main className="ws-page ws-page--narrow">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <Link to="/workspace/workflow" className="ws-breadcrumb-link">Identity Platform</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">Activity</span>
      </div>
      <div className="ws-divider" />

      <div className="ws-header-row">
        <div>
          <div className="ws-header-eyebrow">Audit log</div>
          <h2 className="ws-header-title">Activity</h2>
        </div>
        <div className="activity-filters">
          <div className="ws-segmented">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                className={`ws-segmented-btn ${fType === tab.key ? 'ws-segmented-btn--active' : ''}`}
                onClick={() => setFType(tab.key)}
                style={{ padding: '6px 13px', fontSize: 12 }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select className="ws-select" value={fActor} onChange={(e) => setFActor(e.target.value)}>
            <option value="all">All actors</option>
            <option value="Abhinav Gupta">Abhinav Gupta</option>
            <option value="System / AI">System / AI</option>
          </select>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="ws-empty">
          <div className="ws-empty-icon">
            <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 10h3.2l2.1-5 3.9 10 2.1-5h3.7" /></svg>
          </div>
          <div className="ws-empty-title">No activity yet</div>
          <div className="ws-empty-body">Every upload, triage run, ticket and sync will be recorded here as an auditable trail.</div>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.day} className="activity-group">
              <div className="activity-group-day">{g.day}</div>
              <section className="activity-group-card">
                {g.items.map((ev, i) => {
                  const ic = eventIcon(ev.type);
                  return (
                    <div key={i} className="activity-row">
                      <span className="activity-row-icon" style={{ background: ic.bg }}>{ic.icon}</span>
                      <div className="activity-row-body">
                        <div className="activity-row-text">
                          <strong>{ev.actor}</strong> {ev.text} <Link to={ev.linkTo} className="activity-row-link">{ev.link}</Link>
                        </div>
                        <div className="activity-row-meta">{ev.meta}</div>
                      </div>
                      <span className="activity-row-time">{ev.time}</span>
                    </div>
                  );
                })}
              </section>
            </div>
          ))}
          <div className="activity-count-footer">{filtered.length} events shown · retained for 400 days</div>
        </>
      )}
    </main>
  );
}
