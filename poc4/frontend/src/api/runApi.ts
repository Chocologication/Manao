import {
  parseActiveRunResponse,
  parseLogTicketResponse,
  parseRunListResponse,
  parseRunSummaryForId,
  parseStartRunResponse,
  type ActiveRunResponse,
  type LogTicketResponse,
  type RunId,
  type RunListResponse,
  type RunSummary,
  type StartRunRequest,
} from '../contracts/run';
import { getHttpClient } from './httpClient';

const HISTORY_LIMIT = '20';

function projectRunsUrl(projectId: string, suffix = '', search?: URLSearchParams): string {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/runs${suffix}`;
  if (search === undefined) {
    return base;
  }
  return `${base}?${search.toString()}`;
}

export async function getActiveRun(
  projectId: string,
  signal?: AbortSignal,
): Promise<ActiveRunResponse> {
  const payload = await getHttpClient().request<unknown>(projectRunsUrl(projectId, '/active'), {
    signal,
  });
  return parseActiveRunResponse(payload);
}

export async function getRun(
  projectId: string,
  runId: RunId,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const payload = await getHttpClient().request<unknown>(
    projectRunsUrl(projectId, `/${encodeURIComponent(runId)}`),
    { signal },
  );
  return parseRunSummaryForId(payload, runId);
}

export async function listRuns(
  projectId: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<RunListResponse> {
  const search = new URLSearchParams();
  search.set('limit', HISTORY_LIMIT);
  if (cursor !== undefined && cursor !== null) {
    search.set('cursor', cursor);
  }
  const payload = await getHttpClient().request<unknown>(projectRunsUrl(projectId, '', search), {
    signal,
  });
  return parseRunListResponse(payload);
}

export async function startRun(
  projectId: string,
  request: StartRunRequest,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const payload = await getHttpClient().request<unknown>(projectRunsUrl(projectId), {
    method: 'POST',
    body: { expectedWorkspaceRevision: request.expectedWorkspaceRevision },
    signal,
  });
  return parseStartRunResponse(payload);
}

export async function stopRun(
  projectId: string,
  runId: RunId,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const payload = await getHttpClient().request<unknown>(
    projectRunsUrl(projectId, `/${encodeURIComponent(runId)}/stop`),
    { method: 'POST', signal },
  );
  return parseRunSummaryForId(payload, runId);
}

export async function createLogTicket(
  projectId: string,
  runId: RunId,
  signal?: AbortSignal,
): Promise<LogTicketResponse> {
  const payload = await getHttpClient().request<unknown>(
    projectRunsUrl(projectId, `/${encodeURIComponent(runId)}/log-ticket`),
    { method: 'POST', signal },
  );
  return parseLogTicketResponse(payload);
}
