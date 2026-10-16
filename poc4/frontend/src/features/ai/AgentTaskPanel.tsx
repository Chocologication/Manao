import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  getAgentTask,
  getAgentToolCallResult,
  submitAgentTask,
  clearAgentTaskId,
  generateAgentTaskId,
  readAgentTaskId,
  storeAgentTaskId,
} from '@/api/agentTaskApi';
import { ApiRequestError } from '@/api/ApiRequestError';
import { Button } from '@/components/ui/button';
import { parseRunId } from '@/contracts/run';
import {
  buildCleanupConfirmed,
  buildExitCode,
  buildToolCallId,
  isAgentTaskOccupying,
  applicationData,
  applicationError,
  appHttpGetData,
  type AgentTaskSnapshot,
  type AgentToolCallResult,
} from '@/contracts/agentTask';
import { getWorkspaceRevision, useWorkspaceRevision } from '@/features/files/fileQueries';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { resolveAgentTaskPreconditions } from './agentTaskPreconditions';

export type AgentTaskPanelProps = {
  projectId: string;
  userId: string;
  /** The occupying task from the shell's 2s poll; null when the project is free. */
  task: AgentTaskSnapshot | null;
  /** The last settled snapshot the shell fetched after the project was released. */
  settledTask: AgentTaskSnapshot | null;
  /** The last status poll failed; the shell keeps retrying every two seconds. */
  pollFailed: boolean;
  /** Shell-computed write pending: file saves plus dependency and recovery work. */
  writePending: boolean;
  hasActiveRun: boolean;
  runAuthorityKnown: boolean;
  reloading: boolean;
  closePending: boolean;
  /** Reports a task this browser now knows about (submitted or recovered). */
  onTaskAccepted: (task: AgentTaskSnapshot) => void;
  /** The explicit owner abandon; the shell performs the close request. */
  onClose: () => void;
  onViewRun?: (runId: string) => void;
};

type Probe = { kind: 'found'; task: AgentTaskSnapshot } | { kind: 'missing' } | { kind: 'unknown' };

export { buildToolCallId } from '@/contracts/agentTask';

function agentTaskStartErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.body !== null) {
    return `Could not start the task (${error.body.code})`;
  }
  if (error instanceof Error && /network request failed/i.test(error.message)) {
    return 'Network request failed';
  }
  return 'Could not start the task';
}

export function AgentTaskPanel({
  projectId,
  userId,
  task,
  settledTask,
  pollFailed,
  writePending,
  hasActiveRun,
  runAuthorityKnown,
  reloading,
  closePending,
  onTaskAccepted,
  onClose,
  onViewRun,
}: AgentTaskPanelProps) {
  const queryClient = useQueryClient();
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const [goal, setGoal] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const previousTaskRef = useRef<AgentTaskSnapshot | null>(null);
  const activeTaskId = (task ?? settledTask)?.taskId ?? null;
  const scope = useMemo(() => ({ active: true, token: 0 }), [projectId, activeTaskId]);
  const [resultCache, setResultCache] = useState<{ scope: typeof scope; calls: Record<string, AgentToolCallResult | 'error'> } | null>(null);
  const [loading, setLoading] = useState<{ scope: typeof scope; callId: string } | null>(null);
  const buildResults = resultCache?.scope === scope ? resultCache.calls : {};
  const loadingCallId = loading?.scope === scope ? loading.callId : null;
  useEffect(() => {
    scope.active = true;
    return () => { scope.active = false; scope.token += 1; };
  }, [scope]);

  const handleViewBuildResult = useCallback(
    async (toolCallId: string) => {
      if (activeTaskId === null) {
        return;
      }
      const token = ++scope.token;
      const current = () => scope.active && scope.token === token;
      setLoading({ scope, callId: toolCallId });
      try {
        const result = await getAgentToolCallResult(projectId, activeTaskId, toolCallId);
        if (current()) setResultCache((cache) => ({ scope, calls: { ...(cache?.scope === scope ? cache.calls : {}), [toolCallId]: result } }));
      } catch {
        if (current()) setResultCache((cache) => ({ scope, calls: { ...(cache?.scope === scope ? cache.calls : {}), [toolCallId]: 'error' } }));
      } finally {
        if (current()) setLoading(null);
      }
    },
    [activeTaskId, projectId, scope],
  );

  const workspaceRevision = useWorkspaceRevision(projectId);
  const preconditions = resolveAgentTaskPreconditions({
    dirtyCount,
    writePending,
    hasActiveRun,
    runAuthorityKnown,
    workspaceRevision,
    taskWritesLocked: task !== null && task.writesLocked,
    reloading,
  });
  // A failed status poll means the browser cannot know whether a task occupies
  // the project: start stays locked (fail-closed) until the poll recovers.
  const canStart = preconditions.canStart && !pollFailed && !starting;

  useEffect(() => {
    const previous = previousTaskRef.current;
    previousTaskRef.current = task;
    if (task !== null && !isAgentTaskOccupying(task.state)) {
      // The backend reported the task settled (for example the close response):
      // the id is done and the next start must be a new task.
      clearAgentTaskId(userId, projectId);
      return;
    }
    if (previous !== null && task === null) {
      // The occupying task released (settled or closed): its id is done.
      clearAgentTaskId(userId, projectId);
    }
  }, [task, userId, projectId]);

  const handleStart = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canStart) {
        return;
      }
      const prompt = goal.trim();
      if (prompt === '') {
        setStartError('Enter a goal for the task.');
        return;
      }
      const revision = getWorkspaceRevision(queryClient, projectId);
      if (revision === undefined || revision.length === 0) {
        return;
      }
      setStarting(true);
      setStartError(null);
      const probe = async (taskId: string): Promise<Probe> => {
        try {
          return { kind: 'found', task: await getAgentTask(projectId, taskId) };
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 404) {
            return { kind: 'missing' };
          }
          return { kind: 'unknown' };
        }
      };
      try {
        const storedId = readAgentTaskId(userId, projectId);
        if (storedId !== null) {
          // A previous start may have landed without its response reaching this
          // browser: ask about the SAME task id before ever creating a second one.
          const existing = await probe(storedId);
          if (existing.kind === 'found') {
            if (isAgentTaskOccupying(existing.task.state)) {
              onTaskAccepted(existing.task);
              return;
            }
            clearAgentTaskId(userId, projectId);
          } else if (existing.kind === 'missing') {
            // Provably never created: the stored id is free for reuse-free restart.
            clearAgentTaskId(userId, projectId);
          } else {
            setStartError('Could not verify the previous task. Try again in a moment.');
            return;
          }
        }
        const taskId = generateAgentTaskId();
        // Durable BEFORE the request: a lost response still reconciles this task.
        storeAgentTaskId(userId, projectId, taskId);
        let snapshot: AgentTaskSnapshot;
        try {
          snapshot = await submitAgentTask(projectId, {
            taskId,
            prompt,
            expectedWorkspaceRevision: revision,
          });
        } catch (submitError) {
          // The start response was lost: query the ORIGINAL task id — a second
          // task is never generated for the same intent.
          const recovered = await probe(taskId);
          if (recovered.kind === 'found') {
            onTaskAccepted(recovered.task);
            return;
          }
          if (recovered.kind === 'missing') {
            clearAgentTaskId(userId, projectId);
          }
          throw submitError;
        }
        onTaskAccepted(snapshot);
      } catch (error) {
        setStartError(agentTaskStartErrorMessage(error));
      } finally {
        setStarting(false);
      }
    },
    [canStart, goal, onTaskAccepted, projectId, queryClient, userId],
  );

  const displayTask = task ?? settledTask;
  const occupying = task !== null && isAgentTaskOccupying(task.state);

  return (
    <section aria-label="AI task" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {pollFailed ? (
          <InlineAlert>Could not load the agent task status.</InlineAlert>
        ) : null}
        {startError !== null ? <InlineAlert>{startError}</InlineAlert> : null}
        <form onSubmit={handleStart} className="flex flex-col gap-2">
          <label htmlFor="agent-task-goal" className="text-sm font-medium">
            Task goal
          </label>
          <textarea
            id="agent-task-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            disabled={occupying || starting}
            rows={4}
            className="min-h-16 w-full resize-y rounded-md border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64"
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={!canStart}
              title={canStart ? 'Start task' : (preconditions.reason ?? 'Start task')}
            >
              Start task
            </Button>
            {occupying ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={closePending}
                onClick={onClose}
              >
                End task
              </Button>
            ) : null}
            {!canStart && preconditions.reason !== null ? (
              <span className="text-xs text-muted-foreground">{preconditions.reason}</span>
            ) : null}
          </div>
        </form>
        {displayTask !== null ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Status</span>
              <span>{displayTask.state}</span>
            </div>
            {displayTask.summary !== null ? <p>{displayTask.summary}</p> : null}
            {displayTask.failureCode !== null ? (
              <p className="text-destructive">{displayTask.failureCode}</p>
            ) : null}
            {displayTask.progress.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium">Progress</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {displayTask.progress.map((item) => {
                    const buildCallId = item.kind === 'tool_end' ? buildToolCallId(item.text) : null;
                    return (
                      <li key={item.seq} className="whitespace-pre-wrap font-mono text-xs">
                        {item.text}
                        {item.truncated ? ' (truncated)' : ''}
                        {buildCallId !== null ? (
                          <span className="mt-1 block">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={loadingCallId !== null}
                              onClick={() => {
                                void handleViewBuildResult(buildCallId);
                              }}
                            >
                              View {item.text.startsWith('application ') ? 'application result' : item.text.startsWith('app_http_get ') ? 'HTTP result' : 'build result'}
                            </Button>
                          </span>
                        ) : null}
                        {buildCallId !== null && buildResults[buildCallId] === 'error' ? (
                          <span className="mt-1 block text-destructive">
                            Could not load the build result.
                          </span>
                        ) : null}
                        {buildCallId !== null && buildResults[buildCallId] !== undefined
                          && buildResults[buildCallId] !== 'error' ? (
                          <ToolResultView result={buildResults[buildCallId] as AgentToolCallResult} onViewRun={onViewRun} />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {displayTask.changedPaths.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium">Changed paths</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {displayTask.changedPaths.map((path) => (
                    <li key={path} className="font-mono text-xs">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function isNavigableRunId(runId: unknown): boolean {
  try {
    parseRunId(runId);
    return true;
  } catch {
    return false;
  }
}

function ToolResultView({ result, onViewRun }: { result: AgentToolCallResult; onViewRun?: (runId: string) => void }) {
  const rejected = applicationError(result);
  if (rejected !== null) return <div className="text-destructive">{rejected.code}: {rejected.message}</div>;
  const app = applicationData(result);
  const http = appHttpGetData(result);
  if (app !== null) {
    const runId = app.run?.id ?? app.activeRunId;
    return (
      <div className="mt-1 flex flex-col gap-1 rounded border p-2">
        <div>Application: {app.action}</div>
        <div>Run: {runId ?? 'none'}</div>
        <div>State: {app.run?.state ?? 'unknown'}</div>
        <div>Revision: {app.run?.requestedWorkspaceRevision ?? 'unknown'}</div>
        <div>Ready: {app.run === null ? 'unknown' : app.run.state === 'RUNNING' && app.run.firstReadyAt !== null ? 'yes' : 'no'}</div>
        <div>Stopped confirmed: {app.stoppedConfirmed ? 'yes' : 'no'}</div>
        {runId !== null && isNavigableRunId(runId) && onViewRun ? <Button type="button" size="sm" variant="outline" onClick={() => onViewRun(runId)}>View run</Button> : null}
        {app.logs !== null ? <>
          <div>Log sequence: {app.logs.firstSeq ?? 'unknown'}–{app.logs.lastSeq ?? 'unknown'} · Complete: {app.logs.complete ? 'yes' : 'no'}{app.logs.truncated ? ' (truncated)' : ''}</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{app.logs.text}</pre>
        </> : null}
      </div>
    );
  }
  if (http !== null) {
    return (
      <div className="mt-1 flex flex-col gap-1 rounded border p-2">
        <div>Run: {http.runId}</div>
        <div>HTTP GET {http.path}</div>
        <div>Status: {http.statusCode ?? 'unknown'}</div>
        <div>Content-Type: {http.contentType ?? 'unknown'}</div>
        {http.error !== null ? <div className="text-destructive">{http.error.code}: {http.error.message}</div> : null}
        {http.truncated ? <div>(truncated)</div> : null}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{http.body}</pre>
        {isNavigableRunId(http.runId) && onViewRun ? <Button type="button" size="sm" variant="outline" onClick={() => onViewRun(http.runId)}>View run</Button> : null}
      </div>
    );
  }
  return result.toolName === 'build' ? <BuildResultView result={result} /> : <div>Result unavailable</div>;
}

/** The settled build evidence the backend serves the owner: real exit facts, bounded output. */
function BuildResultView({ result }: { result: AgentToolCallResult }) {
  const exitCode = buildExitCode(result);
  const cleanupConfirmed = buildCleanupConfirmed(result);
  const output = typeof result.data['output'] === 'string' ? result.data['output'] : null;
  const terminationReason =
    typeof result.data['terminationReason'] === 'string' ? result.data['terminationReason'] : null;
  return (
    <div className="mt-1 flex flex-col gap-1 rounded border p-2">
      <div>
        <span className="font-medium">Exit code: </span>
        <span className={exitCode !== null && exitCode !== 0 ? 'text-destructive' : ''}>
          {exitCode === null ? 'unknown' : exitCode}
        </span>
      </div>
      {terminationReason !== null ? (
        <div>
          <span className="font-medium">Termination: </span>
          <span>{terminationReason}</span>
        </div>
      ) : null}
      <div>
        <span className="font-medium">Cleanup confirmed: </span>
        <span>{cleanupConfirmed === null ? 'unknown' : cleanupConfirmed ? 'yes' : 'no'}</span>
      </div>
      {output !== null ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{output}</pre>
      ) : null}
    </div>
  );
}
