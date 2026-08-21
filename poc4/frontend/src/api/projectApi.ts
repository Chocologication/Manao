import type {
  CreateProjectRequest,
  ProjectListResponse,
  ProjectSummary,
} from '../contracts/project';
import { getHttpClient } from './httpClient';

export function listProjects(): Promise<ProjectListResponse> {
  return getHttpClient().request<ProjectListResponse>('/api/v1/projects');
}

export function createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
  return getHttpClient().request<ProjectSummary>('/api/v1/projects', {
    method: 'POST',
    body: request,
  });
}

export function getProject(projectId: string): Promise<ProjectSummary> {
  return getHttpClient().request<ProjectSummary>(
    `/api/v1/projects/${encodeURIComponent(projectId)}`,
  );
}
