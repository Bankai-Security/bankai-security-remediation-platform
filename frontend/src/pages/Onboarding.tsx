import { Link } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import './AuthLayout.css';

export default function Onboarding() {
  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src={bankaiMark} alt="Bankai" className="auth-brand-mark" />
        <img src={bankaiWordmark} alt="BANKAI" className="auth-brand-wordmark" />
      </div>

      <div className="auth-card">
        <h1 className="auth-title">Welcome</h1>
        <div className="auth-subtitle">
          The full Welcome → Connect Jira → Create project → Upload scan onboarding flow isn&apos;t built out in this pass.
        </div>
        <Link to="/projects" className="auth-submit">Continue to Projects</Link>
      </div>
    </div>
  );
}
