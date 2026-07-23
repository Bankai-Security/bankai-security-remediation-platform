import { motion, useReducedMotion } from 'framer-motion';
import GithubIcon from '../../components/GithubIcon';
import { enterBlur, enterFade, tapScale, viewportOnce } from '../../lib/animations';

export default function SelfHost() {
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-section ldg-selfhost">
      <motion.div
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <p className="ldg-kicker">open source</p>
        <h2 className="ldg-h2">MIT licensed. Runs on your metal.</h2>
        <p className="ldg-section-sub">
          The whole loop is open source: API, worker, frontend, migrations. Two containers and a
          Supabase project, and the pipeline is yours.
        </p>
      </motion.div>

      <motion.div
        className="ldg-selfhost-terminal"
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <div className="ldg-terminal">
          <div className="ldg-terminal-bar" aria-hidden="true">
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-dot" />
            <span className="ldg-terminal-title">self-host</span>
          </div>
          <pre className="ldg-terminal-body">
            <span className="ldg-t-dim">$ </span>
            <span className="ldg-t-text">git clone bankai-security-remediation-platform</span>
            {'\n'}
            <span className="ldg-t-dim">$ </span>
            <span className="ldg-t-text">docker compose up --build</span>
            {'\n'}
            <span className="ldg-t-ok">✓</span>
            <span className="ldg-t-dim"> frontend on :8080, api behind /api, worker consuming queues</span>
          </pre>
        </div>
        <motion.span whileTap={reduceMotion ? undefined : tapScale} className="ldg-inline-block">
          <a
            href="https://github.com/anubhavgpta/bankai-security-remediation-platform"
            target="_blank"
            rel="noreferrer"
            className="ldg-btn-secondary ldg-btn-github"
          >
            <GithubIcon size={18} />
            View the source
          </a>
        </motion.span>
      </motion.div>
    </section>
  );
}
