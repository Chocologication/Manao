import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createProject, deleteProject, getProject, listProjects } from '../../api/projectApi';
import {
  PROJECT_BUSY_READ_RETRY_DELAY_MS,
  retryProjectBusyRead,
} from '../../api/projectBusyRetry';
import { DEFAULT_PROJECT_LIMIT, type ProjectListResponse, type ProjectSummary } from '../../contracts/project';

import { ApiRequestError } from '../../api/ApiRequestError';
import { authSession, workspaceBufferRegistry } from '../../app/appRuntime';

export const projectKeys = {
  all: ['projects'] as const,
  detail: (projectId: string) => ['projects', projectId] as const,
};

type QueryDataState<T> = { state: { data: T | undefined } };

export function projectsRefetchInterval(
  query: QueryDataState<ProjectListResponse>,
): number | false {
  const data = query.state.data;
  if (data === undefined) {
    return false;
  }
  return data.items.some((project) => project.state === 'CREATING' || project.state === 'DELETING')
    ? 1000
    : false;
}

export function projectDetailRefetchInterval(
  query: QueryDataState<ProjectSummary>,
): number | false {
  const data = query.state.data;
  return data?.state === 'CREATING' || data?.state === 'DELETING' ? 1000 : false;
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.all,
    queryFn: listProjects,
    retry: retryProjectBusyRead,
    retryDelay: PROJECT_BUSY_READ_RETRY_DELAY_MS,
    refetchOnWindowFocus: false,
    refetchInterval: projectsRefetchInterval,
  });
}

export function useProjectQuery(projectId: string) {
  return useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => getProject(projectId),
    retry: retryProjectBusyRead,
    retryDelay: PROJECT_BUSY_READ_RETRY_DELAY_MS,
    refetchOnWindowFocus: false,
    refetchInterval: projectDetailRefetchInterval,
    enabled: projectId.length > 0,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProject,
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectListResponse>(projectKeys.all, (current) => {
        if (current === undefined) {
          return { items: [created], limit: DEFAULT_PROJECT_LIMIT };
        }
        if (current.items.some((item) => item.id === created.id)) {
          return current;
        }
        return { ...current, items: [...current.items, created] };
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

/** No optimistic removal and no automatic DELETE retry: read the owner list after every attempt. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (projectId: string) => {
      const token = authSession.getAccessToken();
      let deletionError: unknown;
      try {
        await deleteProject(projectId);
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          throw error;
        }
        deletionError = error;
      }
      if (token === null || token !== authSession.getAccessToken()) {
        throw new Error('Session changed. Sign in again to check the project.');
      }
      await queryClient.cancelQueries({ queryKey: projectKeys.all, exact: true });
      let result: ProjectListResponse;
      try {
        result = await queryClient.fetchQuery({
          queryKey: projectKeys.all,
          staleTime: 0,
          retry: false,
          queryFn: async () => {
            const fresh = await listProjects();
            if (token !== authSession.getAccessToken()) {
              throw new Error('Session changed');
            }
            return fresh;
          },
        });
      } catch {
        throw new Error('Unable to confirm deletion. Refresh the project list before trying again.');
      }
      if (result.items.some((project) => project.id === projectId)) {
        throw deletionError ?? new Error('Deletion has not completed. Refresh the list to check its status.');
      }
      // Only dispose this project's cached state after an authenticated read confirms absence.
      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          ['projects', 'project-files', 'project-runs', 'terminal-audits'].includes(String(query.queryKey[0]))
          && query.queryKey[1] === projectId,
      };
      await queryClient.cancelQueries(filters);
      queryClient.removeQueries(filters);
      workspaceBufferRegistry.disposeProject(projectId);
    },
  });
}
