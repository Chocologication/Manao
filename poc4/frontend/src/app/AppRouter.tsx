import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ErrorRecoveryView } from '../components/feedback/AppErrorBoundary';
import { NotFoundPage } from '../components/feedback/NotFoundPage';
import { LoginPage } from '../features/auth/LoginPage';
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
        path: '/projects',
        element: <RequireAuth />,
        children: [
          { index: true, element: <ProjectsPage /> },
          { path: ':projectId', element: <ProjectRoutePage /> },
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
