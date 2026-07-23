import { motion, useReducedMotion } from 'framer-motion';
import GithubIcon from '../../components/GithubIcon';
import JiraIcon from '../../components/JiraIcon';
import { enterBlur, enterFade, viewportOnce } from '../../lib/animations';
import {
  DockerMark,
  GeminiMark,
  GithubActionsMark,
  RedisMark,
  SupabaseMark,
} from './BrandMarks';

const INTEGRATIONS = [
  { name: 'GitHub', icon: <GithubIcon size={24} /> },
  { name: 'Jira', icon: <JiraIcon size={22} /> },
  { name: 'Supabase', icon: <SupabaseMark size={22} /> },
  { name: 'Google Gemini', icon: <GeminiMark size={22} /> },
  { name: 'GitHub Actions', icon: <GithubActionsMark size={22} /> },
  { name: 'Redis', icon: <RedisMark size={22} /> },
  { name: 'Docker', icon: <DockerMark size={22} /> },
];

export default function IntegrationStrip() {
  const reduceMotion = useReducedMotion();
  return (
    <section className="ldg-integrations" aria-label="Integrations">
      <motion.div
        className="ldg-integrations-inner"
        variants={reduceMotion ? enterFade : enterBlur}
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
      >
        <p className="ldg-integrations-lead">Runs on the tools you already trust</p>
        <ul className="ldg-integrations-list">
          {INTEGRATIONS.map((integration) => (
            <li key={integration.name} className="ldg-integration" title={integration.name}>
              {integration.icon}
              <span className="ldg-visually-hidden">{integration.name}</span>
            </li>
          ))}
        </ul>
      </motion.div>
    </section>
  );
}
