import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { enterBlur, enterFade, viewportOnce } from '../../lib/animations';

interface Stage {
  key: string;
  label: string;
  heading: string;
  body: string;
  log: string[];
}

const STAGES: Stage[] = [
  {
    key: 'ingest',
    label: 'INGEST',
    heading: 'Any scanner, one shape',
    body: 'CSV exports from any vendor, AI repo scans through Gemini, Jira imports, and push-triggered rescans all normalize into one canonical finding.',
    log: [
      'source: csv upload (snyk-export.csv)',
      'aliasing columns: severity, cvss, cwe, component',
      'normalized 38 rows into findings',
      'webhook registered: rescan on push to main',
    ],
  },
  {
    key: 'triage',
    label: 'TRIAGE',
    heading: 'Fingerprinted, not re-flagged',
    body: 'Every finding is fingerprinted, so repeat scans classify into New, Changed, and Resolved deltas. SLA clocks start per severity.',
    log: [
      'fingerprint match: 27 known, skipped',
      'delta: 8 new, 3 changed',
      'sla policy: CRIT 7d, HIGH 30d, MED 60d',
      'status: 2 approaching, 0 missed',
    ],
  },
  {
    key: 'ticket',
    label: 'TICKET',
    heading: 'Findings become work',
    body: 'Findings are promoted into sequentially-keyed tickets and pushed to Jira as real issues, with status kept in sync both ways.',
    log: [
      'created BNK-114 from finding f_8c21',
      'jira sync: SEC-2031 created',
      'transition mirror: To Do, In Progress, In Review, Done',
      'evidence comments will post automatically',
    ],
  },
  {
    key: 'fix',
    label: 'FIX PR',
    heading: 'A worker, not a wizard',
    body: 'Bankai creates a remediation branch, gathers bounded repo context, asks Gemini for a concrete patch, commits it, and opens a pull request.',
    log: [
      'branch: bankai/fix-bnk-114',
      'context: 6 files, 2 tests, tree depth 3',
      'patch: api/src/db/query.ts (+18 -6)',
      'PR #87 opened, jira transitioned',
    ],
  },
  {
    key: 'verify',
    label: 'VERIFY',
    heading: 'No fix trusted blindly',
    body: 'Every remediation branch is dispatched through a CI workflow Bankai bootstraps into your repo. The webhook drives live status, job by job.',
    log: [
      'workflow: bankai-verify.yml',
      'build ✓   image ✓   deploy-dev ✓',
      'functional-test ✓   integration-test ✓',
      'workflow_run: success, evidence recorded',
    ],
  },
  {
    key: 'merge',
    label: 'MERGED',
    heading: 'Or it retries itself',
    body: 'On CI failure, Bankai parses the build logs, regenerates the fix, and retries within a bounded number of attempts before a human ever looks.',
    log: [
      'ci failed on attempt 1: functional-test',
      'parsed log: assertion in payments.spec.ts',
      'attempt 2 dispatched with corrected patch',
      'ci green. ready for human review.',
    ],
  },
];

export default function Pipeline() {
  const [active, setActive] = useState(0);
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;
  const stage = STAGES[active];

  return (
    <section className="ldg-section ldg-pipeline" id="pipeline">
      <motion.div
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <p className="ldg-kicker">the loop</p>
        <h2 className="ldg-h2">Everything after the scan</h2>
        <p className="ldg-section-sub">
          Six stages between a spreadsheet of CVEs and a merged fix. Walk through each one.
        </p>
      </motion.div>

      <motion.div
        className="ldg-pipeline-panel"
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <div className="ldg-stage-rail" role="tablist" aria-label="Pipeline stages">
          {STAGES.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`stage-tab-${item.key}`}
              aria-selected={index === active}
              aria-controls="stage-panel"
              className={`ldg-stage-tab ${index === active ? 'ldg-stage-tab-active' : ''}`}
              onClick={() => setActive(index)}
            >
              <span className="ldg-stage-index">{String(index + 1).padStart(2, '0')}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div
          className="ldg-stage-detail"
          id="stage-panel"
          role="tabpanel"
          aria-labelledby={`stage-tab-${stage.key}`}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={stage.key}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={
                reduceMotion
                  ? { opacity: 0, transition: { duration: 0.12 } }
                  : { opacity: 0, y: -6, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] } }
              }
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              <h3 className="ldg-h3">{stage.heading}</h3>
              <p className="ldg-stage-body">{stage.body}</p>
              <div className="ldg-stage-log">
                {stage.log.map((line) => (
                  <p key={line} className="ldg-stage-log-line">
                    <span aria-hidden="true">{'  '}</span>
                    {line}
                  </p>
                ))}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </section>
  );
}
