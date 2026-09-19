import { render, type RenderResult } from '@testing-library/react';
import { StrictMode } from 'react';
import {
  createMemoryRouter,
  Navigate,
  Outlet,
  useLocation,
  useNavigationType,
} from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { setHttpClient } from '../api/httpClient';
import { AppProviders } from '../app/AppProviders';
import {
  authSession,
  connectionRegistry,
  httpClient,
  queryClient,
  workspaceResourceRegistry,
} from '../app/appRuntime';
import { resetUnsavedDialog } from '../features/editor/unsavedChangesGuard';
import { workspaceSessionStore } from '../features/editor/workspaceSession';
import { NotFoundPage } from '../components/feedback/NotFoundPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { ProjectRoutePage } from '../features/projects/ProjectRoutePage';
import { ProjectsPage } from '../features/projects/ProjectsPage';

export function resetAppRuntime(): void {
  setHttpClient(httpClient);
  connectionRegistry.closeAll();
  workspaceResourceRegistry.disposeAll();
  workspaceSessionStore.getState().reset();
  resetUnsavedDialog();
  queryClient.clear();
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
}

function LocationEcho() {
  const location = useLocation();
  const historyAction = useNavigationType();
  return (
    <div
      data-testid="location-echo"
      hidden
      data-pathname={location.pathname}
      data-history-action={historyAction}
    />
  );
}

export function renderApp(
  options: { initialEntries?: string[]; initialIndex?: number } = {},
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <LocationEcho />
            <Outlet />
          </>
        ),
        children: [
          { path: '/', element: <Navigate to="/projects" replace /> },
          { path: '/login', element: <LoginPage /> },
          {
            element: <RequireAuth />,
            children: [
              { path: '/projects', element: <ProjectsPage /> },
              { path: '/projects/:projectId', element: <ProjectRoutePage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    {
      initialEntries: options.initialEntries ?? ['/projects'],
      initialIndex: options.initialIndex,
    },
  );
  const view = render(
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
  return Object.assign(view, { router });
}

/**
 * Simulates an app switch away and back: hides the document, waits, then goes
 * visible again. React Query's focusManager listens for window
 * `visibilitychange` events and reads `document.visibilityState`.
 */
export async function simulateWindowRefocus(hiddenMs = 150): Promise<void> {
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const setVisibility = (value: string): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    });
  };
  setVisibility('hidden');
  window.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, hiddenMs));
  setVisibility('visible');
  window.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (ownDescriptor) {
    Object.defineProperty(document, 'visibilityState', ownDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
}
