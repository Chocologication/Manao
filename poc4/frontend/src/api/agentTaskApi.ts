import { getHttpClient } from './httpClient';
import {
  parseAgentTaskSnapshot,
  type AgentTaskSnapshot,
  type SubmitAgentTaskRequest,
} from '../contracts/agentTask';

/**
 * The four browser-facing agent task endpoints (stage one). The browser only
 * ever talks to the same-origin /api surface; nothing about the worker, its
 * instance or the model appears here.
 */

function agentTaskUrl(projectId: string, suffix = ''): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/agent-tasks${suffix}`;
}

/** First POST: submits a pre-generated task id, the goal text and the saved revision. */
export async function submitAgentTask(
  projectId: string,
  request: SubmitAgentTaskRequest,
): Promise<AgentTaskSnapshot> {
  const payload = await getHttpClient().request<unknown>(agentTaskUrl(projectId), {
    method: 'POST',
    body: request,
  });
  return parseAgentTaskSnapshot(payload);
}

/** The task that currently owns the project's writes, if any. */
export async function getCurrentAgentTask(projectId: string): Promise<AgentTaskSnapshot> {
  const payload = await getHttpClient().request<unknown>(agentTaskUrl(projectId, '/current'));
  return parseAgentTaskSnapshot(payload);
}

/** One task by id, visible only through the owner's project. */
export async function getAgentTask(projectId: string, taskId: string): Promise<AgentTaskSnapshot> {
  const payload = await getHttpClient().request<unknown>(
    agentTaskUrl(projectId, `/${encodeURIComponent(taskId)}`),
  );
  return parseAgentTaskSnapshot(payload);
}

/** The owner's explicit abandon; idempotent on the backend. */
export async function closeAgentTask(
  projectId: string,
  taskId: string,
): Promise<AgentTaskSnapshot> {
  const payload = await getHttpClient().request<unknown>(
    agentTaskUrl(projectId, `/${encodeURIComponent(taskId)}/close`),
    { method: 'POST' },
  );
  return parseAgentTaskSnapshot(payload);
}

// ---------------------------------------------------------------------------
// Task identity: generated before the first submission and kept per user/
// project in sessionStorage so a refresh or a lost start response keeps asking
// about the SAME task instead of creating a second one. The owner comes from
// the authenticated session, never from the pathname. Public HTTP pages have
// no secure-context crypto.randomUUID guarantee, so the id is built from
// getRandomValues in the canonical lowercase UUID form the backend validates.
// ---------------------------------------------------------------------------

const AGENT_TASK_STORAGE_PREFIX = 'manao.agent-task.id.';

export function agentTaskStorageKey(userId: string, projectId: string): string {
  return `${AGENT_TASK_STORAGE_PREFIX}${userId}.${projectId}`;
}

export function generateAgentTaskId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}` +
    `-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Called BEFORE the first submission of a task, per user/project. */
export function storeAgentTaskId(userId: string, projectId: string, taskId: string): void {
  sessionStorageOrNull()?.setItem(agentTaskStorageKey(userId, projectId), taskId);
}

export function readAgentTaskId(userId: string, projectId: string): string | null {
  return sessionStorageOrNull()?.getItem(agentTaskStorageKey(userId, projectId)) ?? null;
}

/** Removed once the task is provably settled or the id is provably unused. */
export function clearAgentTaskId(userId: string, projectId: string): void {
  sessionStorageOrNull()?.removeItem(agentTaskStorageKey(userId, projectId));
}

/** Logout and session expiry must not hand the task id to the next user. */
export function clearAgentTaskIdsForUser(userId: string): void {
  const storage = sessionStorageOrNull();
  if (storage === null) {
    return;
  }
  const userPrefix = `${AGENT_TASK_STORAGE_PREFIX}${userId}.`;
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(userPrefix)) {
      stale.push(key);
    }
  }
  for (const key of stale) {
    storage.removeItem(key);
  }
}
