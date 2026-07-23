import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { enterBlur, enterFade, staggerParent, tapScale } from '../../lib/animations';

// Each line of the terminal is a row of typed spans so state words can carry
// state colors (green = pass, red = critical) per the design system.
type Tone = 'cmd' | 'dim' | 'ok' | 'crit' | 'high' | 'text';

interface TermSegment {
  text: string;
  tone: Tone;
}

const SESSION: TermSegment[][] = [
  [
    { text: '▸ scan #42', tone: 'cmd' },
    { text: '      acme/payments-api @ 9f3c2e1', tone: 'dim' },
  ],
  [
    { text: '  findings 12', tone: 'text' },
    { text: '  [2 CRIT]', tone: 'crit' },
    { text: ' [3 HIGH]', tone: 'high' },
    { text: ' [5 MED] [2 LOW]', tone: 'dim' },
  ],
  [
    { text: '▸ triage', tone: 'cmd' },
    { text: '        fingerprint dedup', tone: 'dim' },
  ],
  [{ text: '  4 new delta  1 changed  7 in progress', tone: 'text' }],
  [
    { text: '▸ ticket BNK-114', tone: 'cmd' },
    { text: '  CWE-89 api/src/db/query.ts', tone: 'dim' },
  ],
  [{ text: '  jira SEC-2031  status: In Progress', tone: 'text' }],
  [
    { text: '▸ fix-pr #87', tone: 'cmd' },
    { text: '    branch bankai/fix-bnk-114', tone: 'dim' },
  ],
  [{ text: '  gemini patch  2 files  +18 -6', tone: 'text' }],
  [
    { text: '▸ ci verify', tone: 'cmd' },
    { text: '  build ', tone: 'dim' },
    { text: '✓', tone: 'ok' },
    { text: ' functional ', tone: 'dim' },
    { text: '✓', tone: 'ok' },
    { text: ' integration ', tone: 'dim' },
    { text: '✓', tone: 'ok' },
  ],
  [
    { text: '✓ verified', tone: 'ok' },
    { text: '    evidence posted, ready for review.', tone: 'text' },
  ],
];

function useTypedLines(lineCount: number, disabled: boolean) {
  const [visibleLines, setVisibleLines] = useState(disabled ? lineCount : 0);
  useEffect(() => {
    if (disabled) {
      setVisibleLines(lineCount);
      return;
    }
    if (visibleLines >= lineCount) return;
    const delay = visibleLines === 0 ? 900 : 420;
    const timer = window.setTimeout(() => setVisibleLines((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [visibleLines, lineCount, disabled]);
  return visibleLines;
}

// The Bankai slash, redrawn in block characters as the hero backdrop.
const ASCII_SLASH = `                                  ▂▖
                              ▗▟█▛
                           ▗▟███▛
                         ▟█████▛
                      ▗▟██████▛
                    ▟████████▘
                 ▗▟████████▛
               ▟█████████▛
            ▗▟█████████▛
          ▟██████████▛
       ▗▟██████████▛
     ▟███████████▘
  ▗▟███████████▛
▄▟█████████████▙▄▄▁▁`;

export default function Hero() {
  const reduceMotion = useReducedMotion();
  const visibleLines = useTypedLines(SESSION.length, Boolean(reduceMotion));
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-hero" id="top">
      <pre className="ldg-hero-slash" aria-hidden="true">
        {ASCII_SLASH}
      </pre>
      <div className="ldg-hero-glow" aria-hidden="true" />

      <motion.div
        className="ldg-hero-inner"
        variants={staggerParent}
        initial="hidden"
        animate="visible"
      >
        <motion.p className="ldg-kicker" variants={enter}>
          security remediation platform
        </motion.p>
        <motion.h1 className="ldg-hero-title" variants={enter}>
          Scanners find.
          <br />
          Bankai fixes.
        </motion.h1>
        <motion.p className="ldg-hero-sub" variants={enter}>
          Raw vulnerability reports in. Merged, CI-verified pull requests out. Ingest, triage,
          ticket, fix, verify: one loop.
        </motion.p>
        <motion.div className="ldg-hero-ctas" variants={enter}>
          <motion.span whileTap={reduceMotion ? undefined : tapScale} className="ldg-inline-block">
            <Link to="/signup" className="ldg-btn-primary">
              Get started
            </Link>
          </motion.span>
          <a href="#pipeline" className="ldg-btn-secondary">
            See how it works
          </a>
        </motion.div>
      </motion.div>

      <motion.div
        className="ldg-hero-terminal"
        variants={enter}
        initial="hidden"
        animate="visible"
      >
        <div className="ldg-terminal" role="img" aria-label="Example remediation session: a scan finds 12 vulnerabilities, Bankai deduplicates them, opens ticket BNK-114, generates a fix pull request, and CI verifies the build, functional, and integration stages.">
          <div className="ldg-terminal-bar" aria-hidden="true">
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-title">remediation session</span>
          </div>
          <pre className="ldg-terminal-body" aria-hidden="true">
            {SESSION.slice(0, visibleLines).map((line, lineIndex) => (
              <span key={lineIndex} className="ldg-terminal-line">
                {line.map((segment, segmentIndex) => (
                  <span key={segmentIndex} className={`ldg-t-${segment.tone}`}>
                    {segment.text}
                  </span>
                ))}
                {'\n'}
              </span>
            ))}
            {visibleLines < SESSION.length && <span className="ldg-terminal-caret" />}
          </pre>
        </div>
      </motion.div>
    </section>
  );
}
