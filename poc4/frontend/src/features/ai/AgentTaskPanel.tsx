import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from 'react';
import {
  getAgentTask,
  getAgentToolCallResult,
  submitAgentTask,
  clearAgentTaskId,
  generateAgentTaskId,
  readAgentTaskId,
  readAgentTaskIntent,
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
  type ReasoningEffort,
  type AgentToolCallResult,
} from '@/contracts/agentTask';
import { getWorkspaceRevision, useWorkspaceRevision } from '@/features/files/fileQueries';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { resolveAgentTaskPreconditions } from './agentTaskPreconditions';
import { submitConversationTask } from '@/api/agentConversationApi';
import { AssistantMarkdown } from './AssistantMarkdown';
import type { ContextUsage } from '@/contracts/agentConversation';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { canContinueTask, CONTINUE_TASK_PROMPT } from './agentTaskControl';
import './AgentChat.css';

export type AgentTaskPanelProps = {
  conversationHeader?: ReactNode;
  conversationHistory?: ReactNode;
  uiActive?: boolean;
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
  closeError?: string | null;
  pausePending?: boolean;
  pauseError?: string | null;
  onPause?: () => void;
  continuationAllowed?: boolean;
  /** Reports a task this browser now knows about (submitted or recovered). */
  onTaskAccepted: (task: AgentTaskSnapshot) => void;
  /** The explicit owner abandon; the shell performs the close request. */
  onClose: () => void;
  onViewRun?: (runId: string) => void;
  conversationId?: string;
  nextReasoningEffort?: ReasoningEffort;
  contextUsage?: ContextUsage | null;
  fullHistory?: boolean;
  displayTask?: AgentTaskSnapshot | null;
  submissionBlocked?: boolean;
  onSubmissionPendingChange?: (pending: boolean) => void;
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
  closeError,
  onTaskAccepted,
  onClose,
  onPause,
  pausePending = false,
  pauseError,
  continuationAllowed = true,
  onViewRun,
  conversationId,
  fullHistory = false,
  displayTask: selectedTask,
  submissionBlocked = false,
  onSubmissionPendingChange,
  nextReasoningEffort = 'high',
  contextUsage,
  conversationHeader,
  conversationHistory,
  uiActive = true,
}: AgentTaskPanelProps) {
  const queryClient = useQueryClient();
  const dirtyCount = useWorkspaceSession((state) => state.dirtyPaths.size);
  const [goal, setGoal] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => nextReasoningEffort);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const previousTaskRef = useRef<AgentTaskSnapshot | null>(null);
  const displayTaskId = (selectedTask === undefined ? task ?? settledTask : selectedTask)?.taskId ?? null;
  const scope = useMemo(() => ({ active: true, token: 0 }), [userId, projectId, conversationId, displayTaskId]);
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
      if (displayTaskId === null) {
        return;
      }
      const token = ++scope.token;
      const current = () => scope.active && scope.token === token;
      setLoading({ scope, callId: toolCallId });
      try {
        const result = await getAgentToolCallResult(projectId, displayTaskId, toolCallId);
        if (current()) setResultCache((cache) => ({ scope, calls: { ...(cache?.scope === scope ? cache.calls : {}), [toolCallId]: result } }));
      } catch {
        if (current()) setResultCache((cache) => ({ scope, calls: { ...(cache?.scope === scope ? cache.calls : {}), [toolCallId]: 'error' } }));
      } finally {
        if (current()) setLoading(null);
      }
    },
    [displayTaskId, projectId, scope],
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
  const canStart = preconditions.canStart && !pollFailed && !starting && !submissionBlocked;
  const displayTask = selectedTask === undefined ? task ?? settledTask : selectedTask;
  const continuation = continuationAllowed && canContinueTask(displayTask, conversationId);
  const continuationClosing = continuationAllowed && displayTask?.conversationId === conversationId
    && Boolean(conversationId) && displayTask?.writesLocked
    && ['AI_PAUSED_BY_OWNER', 'AI_WORKER_RESTARTED'].includes(displayTask.closeReasonCode ?? '');

  useEffect(() => {
    const previous = previousTaskRef.current;
    previousTaskRef.current = task;
    if (task !== null && !isAgentTaskOccupying(task.state)) {
      // The backend reported the task settled (for example the close response):
      // the id is done and the next start must be a new task.
      clearAgentTaskId(userId, projectId, task.taskId);
      return;
    }
    if (previous !== null && task === null) {
      // The occupying task released (settled or closed): its id is done.
      clearAgentTaskId(userId, projectId, previous.taskId);
    }
  }, [task, userId, projectId]);

  const handleStart = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canStart) {
        return;
      }
      const prompt = goal.trim() || (continuation ? CONTINUE_TASK_PROMPT : '');
      if (prompt === '') {
        setStartError('Enter a goal for the task.');
        return;
      }
      const revision = getWorkspaceRevision(queryClient, projectId);
      if (revision === undefined || revision.length === 0) {
        return;
      }
      setStarting(true);
      onSubmissionPendingChange?.(true);
      setStartError(null);
      const probe = async (taskId: string): Promise<Probe> => {
        try {
          const found = await getAgentTask(projectId, taskId);
          const intent = readAgentTaskIntent(userId, projectId);
          if (found.taskId !== taskId || intent?.taskId === taskId && intent.conversationId !== null && found.conversationId !== intent.conversationId) return { kind: 'unknown' };
          return { kind: 'found', task: found };
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
            if (!isAgentTaskOccupying(existing.task.state)) clearAgentTaskId(userId, projectId, storedId);
            setGoal('');
            onTaskAccepted(existing.task);
            return;
          } else if (existing.kind === 'missing') {
            // Provably never created: the stored id is free for reuse-free restart.
            clearAgentTaskId(userId, projectId, storedId);
          } else {
            setStartError('Could not verify the previous task. Try again in a moment.');
            return;
          }
        }
        const taskId = generateAgentTaskId();
        // Durable BEFORE the request: a lost response still reconciles this task.
        storeAgentTaskId(userId, projectId, taskId, conversationId);
        let snapshot: AgentTaskSnapshot;
        try {
          const request = {
            taskId,
            prompt,
            expectedWorkspaceRevision: revision,
            reasoningEffort,
          };
          snapshot = conversationId === undefined ? await submitAgentTask(projectId, request) : await submitConversationTask(projectId, conversationId, request);
        } catch (submitError) {
          // The start response was lost: query the ORIGINAL task id — a second
          // task is never generated for the same intent.
          const recovered = await probe(taskId);
          if (recovered.kind === 'found') {
            if (!isAgentTaskOccupying(recovered.task.state)) clearAgentTaskId(userId, projectId, taskId);
            setGoal('');
            onTaskAccepted(recovered.task);
            return;
          }
          if (recovered.kind === 'missing') {
            clearAgentTaskId(userId, projectId, taskId);
          }
          throw submitError;
        }
        if (!isAgentTaskOccupying(snapshot.state)) clearAgentTaskId(userId, projectId, taskId);
        setGoal('');
        onTaskAccepted(snapshot);
      } catch (error) {
        setStartError(agentTaskStartErrorMessage(error));
      } finally {
        setStarting(false);
        onSubmissionPendingChange?.(false);
      }
    },
    [canStart, continuation, goal, reasoningEffort, onTaskAccepted, projectId, queryClient, userId, conversationId, onSubmissionPendingChange],
  );

  const occupying = task !== null && isAgentTaskOccupying(task.state);
  // A retained identity can still have been admitted after both POST and GET fail.
  // Keep its effort immutable until reconciliation returns a matching task or clears it.
  const pendingIntent = readAgentTaskIntent(userId, projectId);
  const admissionUnknown = pendingIntent !== null && ![task, settledTask, displayTask].some(snapshot =>
    snapshot?.taskId === pendingIntent.taskId && (pendingIntent.conversationId === null || snapshot.conversationId === pendingIntent.conversationId));

  return (
    <section aria-label="AI task" className="manao-ai-chat bg-background">
      {conversationHeader}
      <div className="manao-ai-scroll flex flex-col gap-3">
        {conversationHistory}
        {pollFailed ? (
          <InlineAlert>Could not load the agent task status.</InlineAlert>
        ) : null}
        {startError !== null ? <InlineAlert>{startError}</InlineAlert> : null}

        {displayTask !== null ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Status</span>
              <span>{displayTask.closeReasonCode === 'AI_PAUSED_BY_OWNER' ? displayTask.writesLocked ? 'Stopping and verifying' : 'Paused'
                : displayTask.closeReasonCode === 'AI_WORKER_RESTARTED' ? displayTask.writesLocked ? 'Stopping and verifying' : 'Interrupted by service restart; verified'
                : displayTask.state}</span>
            </div>
            <div>本轮推理强度：{displayTask.reasoningEffort ?? '未记录'}</div>
            {displayTask.failureCode === 'AI_LENGTH_LIMIT' ? <p className="text-destructive">模型响应达到输出上限，本条内容可能不完整</p> : null}
            {!fullHistory && displayTask.summary !== null ? <AssistantMarkdown text={displayTask.summary} /> : null}
            {displayTask.failureCode !== null ? (
              <p className="text-destructive">{displayTask.failureCode}</p>
            ) : null}
            {!fullHistory && displayTask.progress.length > 0 ? (
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
        <form onSubmit={handleStart} className="manao-ai-composer flex flex-col gap-2">
          {occupying ? <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p>Ending the AI task may stop applications it started.</p>
            {task.state === 'NEEDS_ATTENTION' ? <p role="status" aria-label="Task settlement">
              {task.failureCode === 'AI_CLOSING' ? 'Settling task. ' : ''}Waiting for confirmation; project controls stay locked. You can retry ending the task.
            </p> : null}
          </div> : null}
          {occupying && closeError ? <InlineAlert>{closeError}</InlineAlert> : null}
          {occupying && pauseError ? <InlineAlert>{pauseError}</InlineAlert> : null}
          {task?.state === 'QUEUED' ? <p>Task is starting; pause will be available shortly.</p> : null}
          {(continuation || continuationClosing) ? <p>Continue in this conversation with a new task and a fresh budget (up to 30 minutes).</p> : null}
          {continuation && hasActiveRun ? <p>AI is paused. The application is still running; stop it before editing.</p> : null}
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
          <div className="manao-ai-composer-toolbar">
            <div className="manao-ai-composer-settings">
              <ReasoningEffortPicker value={reasoningEffort} disabled={occupying || starting || submissionBlocked || admissionUnknown} active={uiActive} onChange={setReasoningEffort} />
              {conversationId ? <ContextUsageIndicator usage={contextUsage ?? null} /> : null}
            </div>
            <div className="manao-ai-composer-actions">
            <Button
              type="submit"
              size="sm"
              disabled={!canStart || continuationClosing}
              title={canStart ? continuation ? 'Continue task' : 'Start task' : (preconditions.reason ?? 'Start task')}
            >
              {continuation || continuationClosing ? 'Continue task' : 'Start task'}
            </Button>
            {occupying ? <Button type="button" variant="outline" size="sm"
              disabled={task.state === 'QUEUED' || Boolean(task.closeReasonCode) || pausePending || closePending || !onPause}
              onClick={onPause}>Pause &amp; take over</Button> : null}
            {occupying ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={closePending}
                onClick={onClose}
              >
                {task.state === 'NEEDS_ATTENTION' ? 'Retry ending task' : 'End task'}
              </Button>
            ) : null}
            </div>
          </div>
            <span className="text-xs text-muted-foreground">AI task time budget is separate from application startup and ready lifetime limits.</span>
            {!canStart && preconditions.reason !== null ? (
              <span className="text-xs text-muted-foreground">{preconditions.reason}</span>
            ) : null}
        </form>
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

export function ToolResultView({ result, onViewRun }: { result: AgentToolCallResult; onViewRun?: (runId: string) => void }) {
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
  if (['read_file', 'list_files', 'write_file'].includes(result.toolName)) return <FileToolResultView result={result} />;
  return result.toolName === 'build' ? <BuildResultView result={result} /> : <div>Result unavailable</div>;
}

/** Only explicit browser result fields are rendered; file content and paths stay literal text. */
function FileToolResultView({ result }: { result: AgentToolCallResult }) {
  const data = result.data;
  const malformed = <div role="alert" className="text-destructive">工具结果格式不完整</div>;
  if (data.error !== undefined) {
    const error = data.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error) ||
        !('code' in error) || typeof error.code !== 'string' ||
        !('message' in error) || typeof error.message !== 'string') return malformed;
    return <div role="alert" className="whitespace-pre-wrap break-words text-destructive">{error.code}: {error.message}</div>;
  }
  if (result.toolName === 'list_files') {
    const { directory, entries, hasMore } = data;
    if (typeof directory !== 'string' || !Array.isArray(entries) || typeof hasMore !== 'boolean') return malformed;
    const rows: { path: string; kind: 'file' | 'directory' }[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.path !== 'string' || (entry.kind !== 'file' && entry.kind !== 'directory')) return malformed;
      rows.push({ path: entry.path, kind: entry.kind });
    }
    return <div className="mt-1 flex min-w-0 flex-col gap-1 rounded border p-2">
      <div className="whitespace-pre-wrap break-words">目录：{directory === '' ? '/' : directory}</div>
      {rows.length === 0 && !hasMore ? <div>目录为空</div> : null}
      {rows.length > 0 ? <ul className="max-h-48 overflow-auto font-mono text-xs">
        {rows.map((entry, index) => <li key={index} className="flex gap-2">
          <span className="shrink-0 text-muted-foreground">{entry.kind === 'directory' ? '目录' : '文件'}</span>
          <span className="whitespace-pre-wrap break-words">{entry.path}</span>
        </li>)}
      </ul> : null}
      {hasMore ? <div>列表已截断，仍有更多条目</div> : null}
    </div>;
  }
  const { path, sha256, content } = data;
  if (typeof path !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
      (result.toolName === 'read_file' && typeof content !== 'string')) return malformed;
  return <div className="mt-1 flex min-w-0 flex-col gap-1 rounded border p-2">
    {result.toolName === 'write_file' ? <div>文件已写入</div> : null}
    <div className="whitespace-pre-wrap break-words">路径：{path}</div>
    <div className="break-all font-mono text-xs">SHA-256: {sha256}</div>
    {result.toolName === 'read_file' ? content === '' ? <div>文件内容为空</div>
      : <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{content as string}</pre> : null}
  </div>;
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
