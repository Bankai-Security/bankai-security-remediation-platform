import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { collapseOpen, enterBlur, enterFade, viewportOnce } from '../../lib/animations';

const QUESTIONS = [
  {
    q: 'Which scanners does Bankai work with?',
    a: 'Any scanner that exports CSV. Column aliasing normalizes differing vendor schemas (severity, CVSS, CWE, CVEs, affected and fixed versions) into one canonical finding shape. You can also run AI repo scans directly against a connected GitHub repository, or import existing Jira issues as findings.',
  },
  {
    q: 'How are AI fixes verified before anyone reviews them?',
    a: 'Bankai bootstraps a CI workflow into your repository with build, functional-test, and integration-test commands auto-detected from your stack. Every remediation branch is dispatched through it, and the workflow_run webhook drives the ticket\'s live CI status. A fix that has not passed CI is not presented as done.',
  },
  {
    q: 'What happens when CI fails on a generated fix?',
    a: 'Bankai parses the build and test logs, generates a corrected fix with that failure context, and retries, up to a bounded number of attempts. If it still fails, the ticket is handed to a human with the full attempt history attached.',
  },
  {
    q: 'Do I need Jira?',
    a: 'No. Jira is optional per project. Without it, tickets live entirely in Bankai with the same SLA tracking, CI status, and activity trail. With it, tickets become real Jira issues kept in sync bidirectionally.',
  },
  {
    q: 'What does Bankai do with my code?',
    a: 'Repo scans and fix generation send bounded slices of source to Google Gemini, capped by configurable file-count and byte budgets. Tokens and webhook secrets are encrypted at rest, sessions are httpOnly cookies, and every project is isolated by Postgres row-level security.',
  },
  {
    q: 'Can I self-host it?',
    a: 'Yes. The entire platform is MIT licensed: Express API, background worker, React frontend, and SQL migrations. A docker compose file runs the production-like stack locally with your own Supabase project and Redis.',
  },
];

function FaqItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const panelId = `faq-panel-${index}`;
  const buttonId = `faq-button-${index}`;

  return (
    <div className="ldg-faq-item">
      <button
        type="button"
        id={buttonId}
        className="ldg-faq-question"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{q}</span>
        <motion.span
          className="ldg-faq-chevron"
          animate={{ rotate: open ? 45 : 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2 }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            className="ldg-faq-answer-wrap"
            variants={reduceMotion ? enterFade : collapseOpen}
            initial={reduceMotion ? 'hidden' : 'collapsed'}
            animate={reduceMotion ? 'visible' : 'open'}
            exit={reduceMotion ? 'hidden' : 'collapsed'}
          >
            <p className="ldg-faq-answer">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Faq() {
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-section ldg-faq" id="faq">
      <motion.h2
        className="ldg-h2"
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        Questions
      </motion.h2>
      <motion.div
        className="ldg-faq-list"
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        {QUESTIONS.map((item, index) => (
          <FaqItem key={item.q} q={item.q} a={item.a} index={index} />
        ))}
      </motion.div>
    </section>
  );
}
