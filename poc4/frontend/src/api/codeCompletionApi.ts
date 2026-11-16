import { getHttpClient } from './httpClient';

export type FimContext = { prefix: string; suffix: string };
export type FimCompletion = { completion: string | null };

export function requestTabCompletion(projectId: string, context: FimContext, signal: AbortSignal): Promise<FimCompletion> {
  return getHttpClient().request<FimCompletion>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/code-completions`,
    { method: 'POST', body: context, signal },
  );
}
