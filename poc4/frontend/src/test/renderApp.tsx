import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { setHttpClient } from '../api/httpClient';
import { AppProviders } from '../app/AppProviders';
import { authSession, httpClient, queryClient } from '../app/appRuntime';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { ProjectRoutePage } from '../features/projects/ProjectRoutePage';
import { ProjectsPage } from '../features/projects/ProjectsPage';

export function resetAppRuntime(): void {
  setHttpClient(httpClient);
  queryClient.clear();
  if (authSession.getSnapshot().status === 'authenticated') {
    authSession.clear('logout');
  }
}

export function renderApp(options: { initialEntries?: string[] } = {}): RenderResult {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/projects']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectRoutePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}
