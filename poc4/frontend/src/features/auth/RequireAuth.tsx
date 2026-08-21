import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthProvider';

export function RequireAuth() {
  const { snapshot } = useAuth();
  const location = useLocation();

  if (snapshot.status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
