import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../lib/auth-context';

export default function RequireAuth() {
  const { user, loading } = useCurrentUser();
  const location = useLocation();
  if (loading) return <div className="auth-session-loading" role="status">Checking your session…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  return <Outlet />;
}
