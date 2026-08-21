import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';

function LoginPage() {
  return <main>Login</main>;
}

function ProjectsPage() {
  return <main>Projects</main>;
}

function ProjectRoutePage() {
  return <main>Project</main>;
}

function NotFoundPage() {
  return <main>Not found</main>;
}

function ProtectedLayout() {
  return <Outlet />;
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
    element: <ProtectedLayout />,
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
