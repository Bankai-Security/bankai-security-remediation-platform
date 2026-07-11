import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import './AITriage.css';

type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
type Sla = 'Missed' | 'Approaching' | 'On track';
type Bucket = 'New Delta' | 'In Progress' | 'Changed' | 'Resolved';

interface Cvit {
  id: string;
  title: string;
  service: string;
  severity: Severity;
  sla: Sla;
  bucket: Bucket;
  conf: number;
  firstSeen: string;
  priority: string;
  desc: string;
  evidence: string;
  rationale: string;
}

const DATA: Cvit[] = [
  { id: 'CVIT-2214', title: 'OpenSSL 3.0.12 heap buffer overflow (CVE-2025-4172)', service: 'Identity Apps', severity: 'Critical', sla: 'Missed', bucket: 'In Progress', conf: 97, firstSeen: 'May 11, 2026', priority: 'P1 — fix this sprint', desc: 'The packaged OpenSSL version in the identity-apps runtime image is vulnerable to a heap buffer overflow reachable via malformed TLS handshake extensions. Remote, unauthenticated exploitation is plausible on public listeners.', evidence: 'host: idp-apps-prod-03\npackage: openssl 3.0.12-1\nscanner: Nessus #841122\nexposure: public :443', rationale: 'Fingerprint matches CVIT-2214 from the Jun 29 intake (same host, package and plugin ID). SLA clock carried over; item remains in the existing remediation ticket.' },
  { id: 'CVIT-2231', title: 'SAML response signature not enforced on ACS endpoint', service: 'Identity Core', severity: 'Critical', sla: 'Missed', bucket: 'In Progress', conf: 94, firstSeen: 'May 18, 2026', priority: 'P1 — fix this sprint', desc: 'The assertion consumer service accepts SAML responses whose signature check is skipped when the Destination attribute is omitted, enabling assertion forgery against federated tenants.', evidence: 'host: idp-core-prod-01\nendpoint: /saml/acs\nscanner: AppScan #55219\nexposure: partner federation', rationale: 'Identical finding present in the two prior intakes with an open defect (DEF-118). Classified as In Progress; no field changes detected.' },
  { id: 'CVIT-2244', title: 'Expired intermediate TLS certificate on login gateway', service: 'Identity Core', severity: 'High', sla: 'Approaching', bucket: 'Changed', conf: 88, firstSeen: 'Jun 8, 2026', priority: 'P2 — next sprint', desc: 'The intermediate certificate served by the login gateway expires within 14 days. Clients with strict chain validation will begin failing handshakes.', evidence: 'host: idp-core-prod-02\ncert CN: login.identity.internal\nexpires: 2026-07-21\nscanner: Qualys #20871', rationale: "Row matched an existing CVIT but the days-to-expiry and severity fields changed since Jun 29. Bucketed as Changed so the linked ticket gets updated rather than duplicated." },
  { id: 'CVIT-2250', title: 'Log4j 2.17 transitive dependency in auth-svc', service: 'Identity Apps', severity: 'High', sla: 'Missed', bucket: 'In Progress', conf: 96, firstSeen: 'Apr 27, 2026', priority: 'P2 — next sprint', desc: 'auth-svc pulls log4j-core 2.17.0 through an internal SDK. The version is below the current baseline and flagged by policy even though known RCE vectors are mitigated.', evidence: 'artifact: auth-svc:4.12.1\npath: sdk-commons → log4j-core 2.17.0\nscanner: Snyk #77123', rationale: 'Same artifact and dependency path as prior intakes. Remediation blocked on sdk-commons release; SLA already breached.' },
  { id: 'CVIT-2259', title: 'S3 bucket with public read ACL: idp-export-archive', service: 'Identity Apps', severity: 'High', sla: 'On track', bucket: 'New Delta', conf: 91, firstSeen: 'Jun 29, 2026', priority: 'P2 — next sprint', desc: 'The idp-export-archive bucket allows public read via a legacy ACL. Objects include weekly XLS exports containing internal hostnames.', evidence: 'bucket: idp-export-archive\nacl: public-read (legacy)\nscanner: Prowler #3319\nregion: us-east-1', rationale: 'No fingerprint match in prior state — first appearance in the Jun 29 intake. Created as a new delta row; ticket BNK-129 opened from this CVIT.' },
  { id: 'CVIT-2260', title: 'JWT signing key rotation exceeds 180-day policy', service: 'Identity Core', severity: 'Medium', sla: 'On track', bucket: 'New Delta', conf: 84, firstSeen: 'Jun 29, 2026', priority: 'P3 — backlog', desc: 'The active RS256 signing key for session tokens is 212 days old, exceeding the 180-day rotation policy for identity-critical keys.', evidence: 'key id: idp-jwt-k7\nage: 212 days\npolicy: SEC-KEY-004\nscanner: internal audit job', rationale: 'New policy-based finding introduced by the Jun 29 scanner ruleset update; no prior-state match. Flagged as New Delta with moderate confidence due to rule newness.' },
  { id: 'CVIT-2183', title: 'SQL injection in legacy admin search (parameter q)', service: 'Identity Apps', severity: 'Critical', sla: 'Missed', bucket: 'In Progress', conf: 98, firstSeen: 'Mar 30, 2026', priority: 'P1 — fix this sprint', desc: 'Boolean-based blind SQL injection confirmed in the legacy admin console search endpoint. The console is internal but reachable from the corporate VPN.', evidence: 'endpoint: /admin/search?q=\nmethod: boolean-based blind\nscanner: Burp Enterprise #9917', rationale: 'Long-running finding with an open P1 ticket (BNK-108). Unchanged fingerprint across five consecutive intakes.' },
  { id: 'CVIT-2205', title: 'Missing rate limiting on password reset endpoint', service: 'Identity Core', severity: 'Medium', sla: 'Approaching', bucket: 'In Progress', conf: 89, firstSeen: 'May 25, 2026', priority: 'P3 — backlog', desc: 'The password reset endpoint accepts unlimited requests per IP, enabling user enumeration and SMS-pumping abuse.', evidence: 'endpoint: /account/reset\nobserved: 600 req/min accepted\nscanner: AppScan #55302', rationale: 'Matched existing CVIT; SLA target is 9 days out, so status moved from On track to Approaching.' },
  { id: 'CVIT-2172', title: 'Container base image with 14 unpatched CVEs', service: 'Identity Apps', severity: 'Low', sla: 'On track', bucket: 'In Progress', conf: 92, firstSeen: 'Mar 16, 2026', priority: 'P4 — routine', desc: 'The shared base image (debian-slim-idp:11.6) accumulates 14 low-severity CVEs. A rebuild against the current upstream tag clears all of them.', evidence: 'image: debian-slim-idp:11.6\ncve count: 14 (all low)\nscanner: Trivy nightly', rationale: 'Aggregated image finding tracked as a single CVIT by rule IMG-ROLLUP-2. Count unchanged since Jun 22.' },
  { id: 'CVIT-2158', title: 'nginx 1.24 — HTTP/2 rapid reset exposure', service: 'Identity Core', severity: 'Low', sla: 'On track', bucket: 'Resolved', conf: 95, firstSeen: 'Feb 9, 2026', priority: '— closed', desc: 'Edge nginx was vulnerable to HTTP/2 rapid reset connection exhaustion. Patched to 1.26.2 in the Jul 2 maintenance window.', evidence: 'host: idp-core-edge-01\nversion: 1.26.2 (was 1.24.0)\nscanner: Qualys #20455', rationale: 'Present in prior state but absent from the Jul 6 scan; version banner confirms the patched release. Marked Resolved / Not Present.' },
];

function sevBadgeClass(sev: Severity) {
  return `ws-badge ws-badge--${sev.toLowerCase()}`;
}

function slaColor(sla: Sla) {
  if (sla === 'Missed') return { color: '#DC2626', dot: '#EF4444' };
  if (sla === 'Approaching') return { color: '#B45309', dot: '#EAB308' };
  return { color: '#16A34A', dot: '#22C55E' };
}

function bucketBadgeClass(bucket: Bucket) {
  if (bucket === 'New Delta') return 'ws-badge ws-badge--outline ws-badge--bucket-new';
  if (bucket === 'In Progress') return 'ws-badge ws-badge--outline ws-badge--bucket-progress';
  if (bucket === 'Changed') return 'ws-badge ws-badge--outline ws-badge--bucket-changed';
  return 'ws-badge ws-badge--outline ws-badge--bucket-resolved';
}

const SEV_RANK: Record<Severity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export default function AITriage() {
  const [fService, setFService] = useState('all');
  const [fSeverity, setFSeverity] = useState('all');
  const [fSla, setFSla] = useState('all');
  const [fBucket, setFBucket] = useState('all');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'severity' | 'confidence' | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const filtered = useMemo(() => {
    let list = DATA.filter((r) =>
      (fService === 'all' || r.service === fService) &&
      (fSeverity === 'all' || r.severity === fSeverity) &&
      (fSla === 'all' || r.sla === fSla) &&
      (fBucket === 'all' || r.bucket === fBucket)
    );
    if (sortKey === 'severity') list = [...list].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) * sortDir);
    if (sortKey === 'confidence') list = [...list].sort((a, b) => (a.conf - b.conf) * sortDir);
    return list;
  }, [fService, fSeverity, fSla, fBucket, sortKey, sortDir]);

  const selCount = Object.values(selected).filter(Boolean).length;
  const openRow = DATA.find((r) => r.id === openId) ?? null;

  const toggleRow = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleSort = (key: 'severity' | 'confidence') => {
    if (sortKey === key) setSortDir((d) => (d === -1 ? 1 : -1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };

  const arrow = (key: 'severity' | 'confidence') => (sortKey === key ? (sortDir === -1 ? '↓' : '↑') : '↕');

  return (
    <main className="ws-page">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <Link to="/workspace/workflow" className="ws-breadcrumb-link">Identity Platform</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">AI Triage</span>
      </div>
      <div className="ws-divider" />

      <div className="ws-header-row">
        <div>
          <div className="ws-header-eyebrow">weekly_scan_jul06.csv · processed Mon 09:05</div>
          <h2 className="ws-header-title">Review AI decisions</h2>
        </div>
        <div className="triage-filters">
          <select className="ws-select" value={fService} onChange={(e) => setFService(e.target.value)}>
            <option value="all">All services</option>
            <option value="Identity Core">Identity Core</option>
            <option value="Identity Apps">Identity Apps</option>
          </select>
          <select className="ws-select" value={fSeverity} onChange={(e) => setFSeverity(e.target.value)}>
            <option value="all">All severities</option>
            <option value="Critical">Critical</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          <select className="ws-select" value={fSla} onChange={(e) => setFSla(e.target.value)}>
            <option value="all">Any SLA status</option>
            <option value="Missed">Missed</option>
            <option value="Approaching">Approaching</option>
            <option value="On track">On track</option>
          </select>
          <select className="ws-select" value={fBucket} onChange={(e) => setFBucket(e.target.value)}>
            <option value="all">All buckets</option>
            <option value="New Delta">New Delta</option>
            <option value="In Progress">In Progress</option>
            <option value="Changed">Changed</option>
            <option value="Resolved">Resolved</option>
          </select>
        </div>
      </div>

      {selCount > 0 && (
        <div className="triage-bulk-toolbar">
          <span className="triage-bulk-count">{selCount} selected</span>
          <span style={{ flex: 1 }} />
          <button className="triage-bulk-clear" onClick={() => setSelected({})}>Clear</button>
          <button className="triage-bulk-create">Create {selCount} Jira ticket(s)</button>
        </div>
      )}

      <section className="ws-table">
        <div className="ws-table-head triage-grid">
          <span></span>
          <span>ID</span>
          <span>Finding</span>
          <span>Service</span>
          <button className="triage-sort-btn" onClick={() => toggleSort('severity')}>Severity {arrow('severity')}</button>
          <span>SLA status</span>
          <span>AI bucket</span>
          <button className="triage-sort-btn" onClick={() => toggleSort('confidence')}>Confidence {arrow('confidence')}</button>
          <span className="ws-col-right">Action</span>
        </div>
        {filtered.map((r) => {
          const checked = !!selected[r.id];
          const sla = slaColor(r.sla);
          return (
            <div
              key={r.id}
              className="ws-table-row ws-table-row--clickable triage-grid"
              style={{ background: checked ? '#EFF6FF' : openId === r.id ? 'var(--color-bg)' : 'transparent' }}
              onClick={() => setOpenId(r.id)}
            >
              <span
                className="triage-checkbox-cell"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRow(r.id);
                }}
              >
                <span className={`ws-checkbox ${checked ? 'ws-checkbox--checked' : ''}`}>{checked ? '✓' : ''}</span>
              </span>
              <span className="ws-mono triage-id">{r.id}</span>
              <span className="triage-title">{r.title}</span>
              <span className="triage-service">{r.service}</span>
              <span><span className={sevBadgeClass(r.severity)}>{r.severity}</span></span>
              <span className="ws-dot-status" style={{ color: sla.color }}><span className="ws-dot" style={{ background: sla.dot }} />{r.sla}</span>
              <span><span className={bucketBadgeClass(r.bucket)}>{r.bucket}</span></span>
              <span className="triage-confidence-cell">
                <span className="triage-confidence-track"><span className="triage-confidence-fill" style={{ width: `${r.conf}%` }} /></span>
                <span className="triage-confidence-pct">{r.conf}%</span>
              </span>
              <span className="ws-col-right triage-review-link">Review</span>
            </div>
          );
        })}
        <div className="triage-count-label">{filtered.length} of {DATA.length} CVITs</div>
      </section>

      {openRow && (
        <>
          <div className="triage-drawer-backdrop" onClick={() => setOpenId(null)} />
          <div className="triage-drawer">
            <div className="triage-drawer-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="triage-drawer-tags">
                  <span className="ws-mono triage-drawer-id">{openRow.id}</span>
                  <span className={sevBadgeClass(openRow.severity)} style={{ padding: '3px 9px', fontSize: 10.5 }}>{openRow.severity}</span>
                  <span className="ws-dot-status" style={{ color: slaColor(openRow.sla).color, fontSize: 11.5 }}>
                    <span className="ws-dot" style={{ width: 6, height: 6, background: slaColor(openRow.sla).dot }} />{openRow.sla}
                  </span>
                </div>
                <div className="triage-drawer-title">{openRow.title}</div>
                <div className="triage-drawer-meta">{openRow.service} · first seen {openRow.firstSeen}</div>
              </div>
              <button className="triage-drawer-close" onClick={() => setOpenId(null)}>✕</button>
            </div>

            <div className="triage-drawer-body">
              <div>
                <div className="triage-drawer-label">FINDING</div>
                <div className="triage-drawer-desc">{openRow.desc}</div>
              </div>
              <div>
                <div className="triage-drawer-label">EVIDENCE</div>
                <div className="triage-drawer-evidence">{openRow.evidence}</div>
              </div>
              <div>
                <div className="triage-drawer-label">AI RATIONALE</div>
                <div className="triage-drawer-rationale">{openRow.rationale}</div>
                <div className="triage-drawer-confidence-row">
                  <span className="triage-drawer-confidence-label">Confidence</span>
                  <span className="triage-confidence-track"><span className="triage-confidence-fill" style={{ width: `${openRow.conf}%` }} /></span>
                  <span className="triage-drawer-confidence-value">{openRow.conf}%</span>
                </div>
              </div>
              <div className="triage-drawer-meta-grid">
                <div className="triage-drawer-meta-tile">
                  <div className="triage-drawer-meta-tile-label">AI bucket</div>
                  <div className="triage-drawer-meta-tile-value">{openRow.bucket}</div>
                </div>
                <div className="triage-drawer-meta-tile">
                  <div className="triage-drawer-meta-tile-label">Suggested priority</div>
                  <div className="triage-drawer-meta-tile-value">{openRow.priority}</div>
                </div>
              </div>
            </div>

            <div className="triage-drawer-actions">
              <button className="ws-btn ws-btn-success" style={{ flex: 1 }} onClick={() => setOpenId(null)}>Accept</button>
              <button className="ws-btn ws-btn-secondary" style={{ flex: 1 }}>Reassign bucket</button>
              <button className="ws-btn ws-btn-outline-blue" style={{ flex: 1 }}>Mark for Jira</button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
