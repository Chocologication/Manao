import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';

function ProjectsPage() {
  return <main>Projects</main>;
}

function ProjectRoutePage() {
  return <main>Project</main>;
}

function NotFoundPage() {
  return <main>Not found</main>;
}

const router = createBrowserRouter([
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
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
