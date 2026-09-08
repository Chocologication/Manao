export const DEFAULT_PROJECT_LIMIT = 8;

export type ProjectState = 'CREATING' | 'READY' | 'FAILED';
export type ProjectSummary = {
  id: string;
  name: string;
  state: ProjectState;
  createdAt: string;
  failureReason: string | null;
};
export type ProjectListResponse = { items: ProjectSummary[]; limit: number };
export type CreateProjectRequest = { name: string };
