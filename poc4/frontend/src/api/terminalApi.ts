import type { RunId } from '../contracts/run';
import {
  parseCreateTerminalSessionRequest,
  parseCreateTerminalSessionResponse,
  parseTerminalAuditListResponse,
  type CreateTerminalSessionRequest,
  type CreateTerminalSessionResponse,
  type TerminalAuditListResponse,
} from '../contracts/terminal';
import { getHttpClient } from './httpClient';

const TERMINAL_AUDIT_LIMIT = '50';

function terminalUrl(projectId: string, runId: RunId, suffix: string, search?: URLSearchParams): string {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}${suffix}`;
  return search === undefined ? base : `${base}?${search.toString()}`;
}

export async function createTerminalSession(projectId: string, runId: RunId, request: CreateTerminalSessionRequest, signal?: AbortSignal): Promise<CreateTerminalSessionResponse> {
  const body = parseCreateTerminalSessionRequest(request);
  const payload = await getHttpClient().request<unknown>(terminalUrl(projectId, runId, '/terminal-sessions'), { method: 'POST', body, signal });
  return parseCreateTerminalSessionResponse(payload);
}

export async function listTerminalAudits(projectId: string, runId: RunId, cursor?: string | null, signal?: AbortSignal): Promise<TerminalAuditListResponse> {
  const search = new URLSearchParams({ limit: TERMINAL_AUDIT_LIMIT });
  if (cursor !== undefined && cursor !== null) search.set('cursor', cursor);
  const payload = await getHttpClient().request<unknown>(terminalUrl(projectId, runId, '/terminal-audits', search), { signal });
  return parseTerminalAuditListResponse(payload);
}
