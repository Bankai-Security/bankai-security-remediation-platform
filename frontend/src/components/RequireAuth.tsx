import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../lib/auth-context';
import BrandLoadingScreen from './BrandLoadingScreen';

export default function RequireAuth() {
  const { user, loading } = useCurrentUser();
  const location = useLocation();
  if (loading) return <BrandLoadingScreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  return <Outlet />;
}
