import { motion, useReducedMotion } from 'framer-motion';
import { enterBlur, enterFade, viewportOnce } from '../../lib/animations';

interface TrustCluster {
  name: string;
  items: { title: string; detail: string }[];
}

const CLUSTERS: TrustCluster[] = [
  {
    name: 'Sessions',
    items: [
      {
        title: 'httpOnly cookie sessions',
        detail: 'Access and refresh tokens never touch localStorage or a response body.',
      },
      {
        title: 'CSRF defense-in-depth',
        detail: 'Explicit Origin checks on state-changing requests, layered on SameSite.',
      },
      {
        title: 'Server-side revocation',
        detail: 'Logout revokes the refresh token globally, not just a cookie clear.',
      },
    ],
  },
  {
    name: 'Data at rest',
    items: [
      {
        title: 'Row-level security',
        detail: 'Postgres RLS is the primary boundary. Controllers re-check roles and fail loudly.',
      },
      {
        title: 'Encrypted secrets',
        detail: 'Jira tokens, GitHub PATs, and webhook secrets encrypted before persisting.',
      },
    ],
  },
  {
    name: 'Perimeter',
    items: [
      {
        title: 'HMAC-verified webhooks',
        detail: 'GitHub payloads verified against the raw body, mounted ahead of the parser.',
      },
      {
        title: 'WAF, bot detection, rate limits',
        detail: 'Arcjet shields auth and sensitive endpoints, and rejects disposable emails.',
      },
      {
        title: 'Enumeration resistance',
        detail: 'Signup responds identically whether or not the email exists.',
      },
    ],
  },
];

export default function Trust() {
  const reduceMotion = useReducedMotion();
  const enter = reduceMotion ? enterFade : enterBlur;

  return (
    <section className="ldg-section ldg-trust" id="security">
      <motion.div
        className="ldg-trust-head"
        variants={enter}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <h2 className="ldg-h2">Built like it audits itself</h2>
        <p className="ldg-section-sub">
          A remediation platform is a target. Bankai's own security posture is part of the product,
          and every state change lands in an append-only activity log.
        </p>
      </motion.div>

      <div className="ldg-trust-clusters">
        {CLUSTERS.map((cluster, index) => (
          <motion.div
            key={cluster.name}
            className="ldg-trust-cluster"
            variants={enter}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            custom={index}
          >
            <h3 className="ldg-trust-cluster-name">{cluster.name}</h3>
            <dl className="ldg-trust-list">
              {cluster.items.map((item) => (
                <div key={item.title} className="ldg-trust-item">
                  <dt>{item.title}</dt>
                  <dd>{item.detail}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
