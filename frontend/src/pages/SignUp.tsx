import { Link, useNavigate } from 'react-router-dom';
import bankaiMark from '../assets/bankai-mark.svg';
import bankaiWordmark from '../assets/bankai-wordmark.svg';
import './AuthLayout.css';

export default function SignUp() {
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate('/onboarding');
  };

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src={bankaiMark} alt="Bankai" className="auth-brand-mark" />
        <img src={bankaiWordmark} alt="BANKAI" className="auth-brand-wordmark" />
      </div>

      <div className="auth-card">
        <h1 className="auth-title">Create your account</h1>
        <div className="auth-subtitle">Start triaging vulnerabilities with Bankai.</div>

        <form className="auth-fields" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="signup-name">Full name</label>
            <input id="signup-name" className="auth-input" type="text" placeholder="Abhinav Gupta" required />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-email">Work email</label>
            <input id="signup-email" className="auth-input" type="email" placeholder="you@company.com" required />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-password">Password</label>
            <input id="signup-password" className="auth-input" type="password" placeholder="Create a password" required />
          </div>

          <button type="submit" className="auth-submit">Create account</button>
        </form>

        <div className="auth-fineprint">
          By creating an account you agree to Bankai&apos;s Terms of Service and Privacy Policy.
        </div>
        <div className="auth-footer">
          Already have an account? <Link to="/login">Log in</Link>
        </div>
      </div>
    </div>
  );
}
