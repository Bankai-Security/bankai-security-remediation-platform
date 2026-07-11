import { Link } from 'react-router-dom';
import './StubPage.css';

interface StubPageProps {
  eyebrow: string;
  title: string;
  description: string;
}

export default function StubPage({ eyebrow, title, description }: StubPageProps) {
  return (
    <main className="stub-page">
      <div className="stub-breadcrumb">
        <Link to="/projects" className="stub-breadcrumb-link">Bankai</Link>
        <span className="stub-breadcrumb-sep">›</span>
        <Link to="/workspace/workflow" className="stub-breadcrumb-link">Identity Platform</Link>
        <span className="stub-breadcrumb-sep">›</span>
        <span className="stub-breadcrumb-current">{title}</span>
      </div>
      <div className="stub-divider" />

      <div className="stub-eyebrow">{eyebrow}</div>
      <h1 className="stub-title">{title}</h1>

      <div className="stub-card">
        <div className="stub-card-icon">
          <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="#8A8A8E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2.5"></rect>
            <path d="M2.5 8h15" />
          </svg>
        </div>
        <div className="stub-card-title">Coming soon</div>
        <div className="stub-card-body">{description}</div>
      </div>
    </main>
  );
}
