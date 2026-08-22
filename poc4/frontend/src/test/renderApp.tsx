import { render, type RenderResult } from '@testing-library/react';
import { StrictMode } from 'react';
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from 'react-router';
import { setHttpClient } from '../api/httpClient';
import { AppProviders } from '../app/AppProviders';
import {
  authSession,
  connectionRegistry,
  httpClient,
  queryClient,
  workspaceResourceRegistry,
} from '../app/appRuntime';
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

export function renderApp(options: { initialEntries?: string[] } = {}): RenderResult {
  return render(
    <StrictMode>
      <AppProviders>
        <MemoryRouter initialEntries={options.initialEntries ?? ['/projects']}>
          <LocationEcho />
          <Routes>
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectRoutePage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </MemoryRouter>
      </AppProviders>
    </StrictMode>,
  );
}
