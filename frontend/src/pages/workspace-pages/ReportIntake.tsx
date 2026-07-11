import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './ReportIntake.css';

type Mode = 'empty' | 'processing' | 'done' | 'error';

const STEP_DEFS = [
  { label: 'Parsing CSV', t: 25 },
  { label: 'Triaging findings', t: 55 },
  { label: 'Splitting by service', t: 80 },
  { label: 'Generating XLS', t: 100 },
];

const PAST_INTAKES = [
  { file: 'weekly_scan_jul06.csv', date: 'Jul 6, 2026', rows: '376', services: '2', status: 'Processed', ok: true, action: 'Download' },
  { file: 'weekly_scan_jun29.csv', date: 'Jun 29, 2026', rows: '371', services: '2', status: 'Processed', ok: true, action: 'Download' },
  { file: 'weekly_scan_jun22.csv', date: 'Jun 22, 2026', rows: '360', services: '2', status: 'Processed', ok: true, action: 'Download' },
  { file: 'adhoc_rescan_jun18.csv', date: 'Jun 18, 2026', rows: '—', services: '—', status: 'Failed', ok: false, action: 'Error log' },
  { file: 'weekly_scan_jun15.csv', date: 'Jun 15, 2026', rows: '348', services: '2', status: 'Processed', ok: true, action: 'Download' },
];

export default function ReportIntake() {
  const [mode, setMode] = useState<Mode>('empty');
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const startUpload = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setMode('processing');
    setProgress(0);
    timerRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + 2;
        if (next >= 100) {
          if (timerRef.current) clearInterval(timerRef.current);
          setMode('done');
          return 100;
        }
        return next;
      });
    }, 90);
  };

  const retry = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setMode('empty');
    setProgress(0);
  };

  let activeFound = false;
  const steps = STEP_DEFS.map((d) => {
    const done = progress >= d.t;
    const active = !done && !activeFound && (activeFound = true);
    return { ...d, done, active };
  });

  return (
    <main className="ws-page">
      <div className="ws-breadcrumb">
        <Link to="/projects" className="ws-breadcrumb-link">Bankai</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <Link to="/workspace/workflow" className="ws-breadcrumb-link">Identity Platform</Link>
        <span className="ws-breadcrumb-sep">›</span>
        <span className="ws-breadcrumb-current">Report Intake</span>
      </div>
      <div className="ws-divider" />

      <section className="ws-card intake-card">
        <div className="intake-card-header">
          <div className="ws-card-eyebrow">Step 1 of 3</div>
          <h2 className="intake-card-title">Report Intake &amp; Triage</h2>
          <div className="intake-card-sub">
            Upload your vulnerability scan CSV. The pipeline parses, triages and generates a structured XLS with findings split by service.
          </div>
        </div>

        {mode === 'empty' && (
          <div className="ws-dropzone">
            <svg width="64" height="52" viewBox="0 0 64 52" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 40h-4.5C8 40 3.5 35.5 3.5 30c0-5 3.7-9.1 8.5-9.9C13.3 12.6 19.9 6.5 28 6.5c7 0 13 4.5 15.2 10.8 6.6 0.3 11.8 5.7 11.8 12.3 0 5.8-4.1 9.7-9.5 10.4" />
              <circle cx="32" cy="38" r="10.5" fill="var(--color-bg)" />
              <path d="M27.5 38.5 30.8 41.8 36.8 34.8" />
            </svg>
            <div className="ws-dropzone-title">Drag and drop your files here or choose files</div>
            <div className="ws-dropzone-body">CSV up to 25 MB. One scan export per intake — Bankai diffs it against the previous state.</div>
            <button onClick={startUpload} className="ws-btn ws-btn-primary" style={{ marginTop: 20 }}>Browse File</button>
          </div>
        )}

        {mode === 'processing' && (
          <div className="intake-processing">
            <div className="intake-processing-header">
              <div className="intake-file-icon">CSV</div>
              <div className="intake-processing-info">
                <div className="intake-processing-filename">weekly_scan_jul06.csv</div>
                <div className="intake-processing-meta">2.4 MB · uploaded just now</div>
              </div>
              <div className="intake-processing-pct">{progress}%</div>
            </div>
            <div className="ws-progress-track" style={{ margin: '16px 0 22px 0' }}>
              <div className="ws-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="intake-steps">
              {steps.map((s) => (
                <div key={s.label} className="intake-step-row">
                  <span
                    className="intake-step-mark"
                    style={{
                      background: s.done ? 'var(--color-green)' : s.active ? 'var(--color-blue)' : 'transparent',
                      border: s.done || s.active ? 'none' : '1.5px solid var(--color-text-faint)',
                      animation: s.active ? 'ws-pulse 1.2s ease-in-out infinite' : 'none',
                    }}
                  >
                    {s.done ? '✓' : ''}
                  </span>
                  <span
                    className="intake-step-label"
                    style={{
                      fontWeight: s.done || s.active ? 600 : 500,
                      color: s.done ? 'var(--color-text)' : s.active ? 'var(--color-blue)' : 'var(--color-text-muted)',
                    }}
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === 'done' && (
          <div className="intake-done">
            <div className="intake-done-header">
              <span className="intake-done-check">✓</span>
              <div>
                <div className="intake-done-title">weekly_scan_jul06.csv processed</div>
                <div className="intake-done-meta">Mon, Jul 6 · 09:05 · diffed against intake of Jun 29</div>
              </div>
            </div>
            <div className="intake-done-stats">
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>376</div><div className="ws-stat-tile-label">Rows found</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>2</div><div className="ws-stat-tile-label">Services detected</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>0</div><div className="ws-stat-tile-label">New delta rows</div></div>
              <div className="ws-stat-tile"><div className="ws-stat-tile-value" style={{ fontSize: 24 }}>376</div><div className="ws-stat-tile-label">Already in progress</div></div>
            </div>
            <div className="intake-done-actions">
              <Link to="/workspace/triage" className="ws-btn ws-btn-primary" style={{ padding: '10px 24px', fontSize: 13.5 }}>View Triage</Link>
              <a href="#" onClick={(e) => e.preventDefault()} className="intake-download-link">Download generated XLS</a>
            </div>
          </div>
        )}

        {mode === 'error' && (
          <div className="intake-error">
            <span className="intake-error-icon">!</span>
            <div className="intake-error-body">
              <div className="intake-error-title">Intake failed</div>
              <div className="intake-error-text">
                weekly_scan_jul06.csv could not be parsed — required column &ldquo;cvit_id&rdquo; is missing at row 214. Fix the export and upload again.
              </div>
              <div className="intake-error-actions">
                <button onClick={retry} className="ws-btn" style={{ background: '#DC2626', color: '#fff', padding: '9px 22px', fontSize: 13 }}>Retry upload</button>
                <a href="#" onClick={(e) => e.preventDefault()} className="intake-error-log-link">Download error log</a>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="ws-card">
        <div className="ws-card-eyebrow">History</div>
        <h2 className="ws-card-title">Past intakes</h2>
        <div className="intake-history-head">
          <span>Filename</span><span>Date</span><span className="ws-col-right">Rows</span><span className="ws-col-right">Services</span><span>Status</span><span className="ws-col-right">XLS</span>
        </div>
        {PAST_INTAKES.map((row) => (
          <div key={row.file} className="intake-history-row">
            <span className="intake-history-filename">{row.file}</span>
            <span className="intake-history-date">{row.date}</span>
            <span className="ws-col-right">{row.rows}</span>
            <span className="ws-col-right">{row.services}</span>
            <span><span className={`ws-badge ${row.ok ? 'ws-badge--pill-green' : 'ws-badge--pill-red'}`}>{row.status}</span></span>
            <span className="ws-col-right"><a href="#" onClick={(e) => e.preventDefault()} className="intake-history-action">{row.action}</a></span>
          </div>
        ))}
      </section>
    </main>
  );
}
