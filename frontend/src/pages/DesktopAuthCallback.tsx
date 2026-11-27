import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BrandLoadingScreen from '../components/BrandLoadingScreen';
import { exchangeDesktopAuthTransfer } from '../lib/api';
import { useCurrentUser } from '../lib/auth-context';

export default function DesktopAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loading, setUser } = useCurrentUser();
  const started = useRef(false);

  useEffect(() => {
    if (loading || started.current) return;
    started.current = true;
    const code = searchParams.get('code');
    window.history.replaceState(null, '', '/auth/desktop-callback');
    if (!code || searchParams.get('error')) {
      navigate('/login?sso_error=1', { replace: true });
      return;
    }
    void exchangeDesktopAuthTransfer(code)
      .then(({ user, needsOnboarding }) => {
        setUser(user);
        navigate(needsOnboarding ? '/onboarding' : '/projects', { replace: true });
      })
      .catch(() => navigate('/login?sso_error=1', { replace: true }));
  }, [loading, navigate, searchParams, setUser]);

  return <BrandLoadingScreen />;
}
