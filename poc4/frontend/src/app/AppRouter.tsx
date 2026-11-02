import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ErrorRecoveryView } from '../components/feedback/AppErrorBoundary';
import { NotFoundPage } from '../components/feedback/NotFoundPage';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { ProjectRoutePage } from '../features/projects/ProjectRoutePage';
import { ProjectsPage } from '../features/projects/ProjectsPage';

const router = createBrowserRouter([
  {
    element: <Outlet />,
    errorElement: <ErrorRecoveryView />,
    children: [
      {
        path: '/',
        element: <Navigate to="/projects" replace />,
      },
      {
        path: '/login',
        element: <LoginPage />,
      },
      {
        path: '/register',
        element: <RegisterPage />,
      },
      {
        path: '/forgot-password',
        element: <ForgotPasswordPage />,
      },
      {
        path: '/account',
        element: <RequireAuth />,
        children: [{ path: 'password', element: <ChangePasswordPage /> }],
      },
      {
        path: '/projects',
        element: <RequireAuth />,
        children: [
          { index: true, element: <ProjectsPage /> },
          { path: ':projectId', element: <ProjectRoutePage /> },
          { path: ':projectId/overview', element: <ProjectRoutePage /> },
          { path: ':projectId/compare', element: <ProjectRoutePage /> },
        ],
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
