import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createProject, getProject, listProjects } from '../../api/projectApi';
import type { ProjectListResponse, ProjectSummary } from '../../contracts/project';

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
  return data.items.some((project) => project.state === 'CREATING') ? 1000 : false;
}

export function projectDetailRefetchInterval(
  query: QueryDataState<ProjectSummary>,
): number | false {
  const data = query.state.data;
  return data?.state === 'CREATING' ? 1000 : false;
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.all,
    queryFn: listProjects,
    retry: false,
    refetchInterval: projectsRefetchInterval,
  });
}

export function useProjectQuery(projectId: string) {
  return useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
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
          return { items: [created], limit: 3 };
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
