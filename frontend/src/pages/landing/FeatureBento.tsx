import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { enterBlur, enterFade, hoverLift, viewportOnce } from '../../lib/animations';

// Each cell gets a distinct internal visual: diff, job list, delta chips,
// severity bars, sync arrows, role ledger. No repeated card anatomy.

function DiffVisual() {
  return (
    <pre className="ldg-diff" aria-hidden="true">
      <span className="ldg-diff-meta">api/src/db/query.ts</span>
      {'\n'}
      <span className="ldg-diff-del">{'- const q = `SELECT * FROM txns WHERE id = ${id}`;'}</span>
      {'\n'}
      <span className="ldg-diff-add">+ const q = 'SELECT * FROM txns WHERE id = $1';</span>
      {'\n'}
      <span className="ldg-diff-add">+ const rows = await db.query(q, [id]);</span>
    </pre>
  );
}

function CiVisual() {
  const jobs = [
    ['build', 'ok'],
    ['image', 'ok'],
    ['deploy-dev', 'ok'],
    ['functional-test', 'ok'],
    ['integration-test', 'run'],
  ] as const;
  return (
    <div className="ldg-ci-jobs" aria-hidden="true">
      {jobs.map(([name, state]) => (
        <span key={name} className="ldg-ci-job">
          <span className={state === 'ok' ? 'ldg-t-ok' : 'ldg-ci-running'}>
            {state === 'ok' ? '✓' : '◌'}
          </span>
          {name}
        </span>
      ))}
    </div>
  );
}

function DeltaVisual() {
  return (
    <div className="ldg-delta-chips" aria-hidden="true">
      <span className="ldg-chip ldg-chip-new">4 new</span>
      <span className="ldg-chip ldg-chip-changed">1 changed</span>
      <span className="ldg-chip ldg-chip-resolved">7 resolved</span>
    </div>
  );
}

function SlaVisual() {
  return (
    <pre className="ldg-sla" aria-hidden="true">
      <span className="ldg-t-crit">CRIT </span>
      <span className="ldg-t-crit">▓▓▓▓▓▓░░</span> 5d left{'\n'}
      <span className="ldg-t-high">HIGH </span>
      <span className="ldg-t-high">▓▓▓░░░░░</span> 21d left{'\n'}
      <span className="ldg-t-dim">MED  </span>
      <span className="ldg-t-dim">▓░░░░░░░</span> 54d left
    </pre>
  );
}

function JiraVisual() {
  return (
    <pre className="ldg-jira-sync" aria-hidden="true">
      BNK-114  ⇄  SEC-2031{'\n'}
      <span className="ldg-t-dim">To Do ▸ In Progress ▸ In Review ▸ Done</span>
    </pre>
  );
}

function RolesVisual() {
  return (
    <pre className="ldg-roles" aria-hidden="true">
      owner   admin   editor   viewer{'\n'}
      <span className="ldg-t-dim">RLS + explicit 403s, never silent no-ops</span>
    </pre>
  );
}

interface Cell {
  key: string;
  className: string;
  title: string;
  body: string;
  visual: ReactNode;
}

const CELLS: Cell[] = [
  {
    key: 'fix',
    className: 'ldg-cell-large',
    title: 'AI-authored fix PRs',
    body: 'Bounded repo context in, concrete patch out. Committed to a dedicated branch and opened as a real pull request against your repo.',
    visual: <DiffVisual />,
  },
  {
    key: 'ci',
    className: 'ldg-cell-wide',
    title: 'CI-verified, job by job',
    body: 'A bootstrap PR adds bankai-verify.yml with stack-detected commands. Every fix runs the full gauntlet before review.',
    visual: <CiVisual />,
  },
  {
    key: 'dedup',
    className: 'ldg-cell-small',
    title: 'Dedup fingerprinting',
    body: 'Repeat scans classify deltas instead of re-flagging the same CVE every run.',
    visual: <DeltaVisual />,
  },
  {
    key: 'sla',
    className: 'ldg-cell-small',
    title: 'SLA tracking',
    body: 'Days-to-remediate per severity, with missed and approaching status computed live.',
    visual: <SlaVisual />,
  },
  {
    key: 'jira',
    className: 'ldg-cell-half',
    title: 'Bidirectional Jira sync',
    body: 'Tickets become real Jira issues. Transitions mirror pipeline progress, and fix evidence posts back as comments.',
    visual: <JiraVisual />,
  },
  {
    key: 'roles',
    className: 'ldg-cell-half',
    title: 'Role-based teams',
    body: 'Four roles enforced twice: Postgres row-level security plus explicit checks in every controller.',
    visual: <RolesVisual />,
  },
];

export default function FeatureBento() {
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-section" id="features">
      <motion.div
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <h2 className="ldg-h2">Built for the gap scanners leave behind</h2>
      </motion.div>

      <div className="ldg-bento">
        {CELLS.map((cell, index) => (
          <motion.article
            key={cell.key}
            className={`ldg-cell ${cell.className}`}
            variants={enter}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            // Stagger lives on the reveal only; hover must stay instant, so the
            // delay is scoped to the "visible" transition instead of the shared
            // transition prop (which whileHover would inherit).
            custom={index}
            whileHover={
              reduceMotion ? undefined : { ...hoverLift, transition: { duration: 0.2 } }
            }
          >
            <h3 className="ldg-h3">{cell.title}</h3>
            <p className="ldg-cell-body">{cell.body}</p>
            <div className="ldg-cell-visual">{cell.visual}</div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
