import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../../api/ApiRequestError';
import {
  changePythonDependencies,
  clearPythonDependencyOperationId,
  generateOperationId,
  storePythonDependencyOperationId,
  type PythonDependencyAction,
} from '../../api/pythonDependencyApi';
import { getWorkspaceRevision } from '../../features/files/fileQueries';
import { reloadWorkspaceAfterTerminalRun } from '../../features/runs/workspaceReload';
import { useWorkspaceSession } from '../../features/editor/workspaceSession';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';

export type PythonDependenciesPanelProps = {
  projectId: string;
  userId: string;
  /** The workbench write gate: active Run, authority loading or a workspace reload. */
  workspaceLocked: boolean;
  /** Operation whose result is unknown; a new change waits until it is checked. */
  unconfirmedOperationId: string | null;
  /** Reports a POST whose result is unknown; the shell then shows the recovery entry. */
  onResponseLost: (operationId: string) => void;
  /**
   * Reports whether an operation is in flight (any phase other than idle) so the
   * shell can lock workspace writes while the change runs, whatever tab is visible.
   */
  onBusyChange?: (busy: boolean) => void;
};

type Phase = 'idle' | 'submitting' | 'reloading';

/**
 * Fixed agent/prepare rejections are proven no-side-effect answers: the stored
 * operation id is removed and a corrected change may start a NEW operation. Any
 * other failure (lost response, internal error, unreadable body) leaves the result
 * unknown — the id stays and only a check may resolve it.
 * WORKSPACE_RECONCILIATION_REQUIRED is deliberately NOT listed: the backend answers
 * it only after an operation row was registered, so its result is unknown.
 */
const NO_SIDE_EFFECT_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'PYTHON_DEPENDENCY_UNSUPPORTED',
  'PYTHON_DEPENDENCY_RESOLUTION_FAILED',
  'PYTHON_DEPENDENCY_TIMEOUT',
  'DEPENDENCY_REQUEST_MISMATCH',
  'WORKSPACE_REVISION_CONFLICT',
  'PROJECT_LOCKED',
  'RUN_ALREADY_ACTIVE',
  'PROJECT_BUSY',
  'ENTRY_NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
]);

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

function rejectionMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.body?.code) {
      case 'VALIDATION_ERROR':
        return 'Only package names with an optional exact version are supported.';
      case 'PYTHON_DEPENDENCY_UNSUPPORTED':
        return error.body.message;
      case 'PYTHON_DEPENDENCY_RESOLUTION_FAILED':
        return 'Dependency resolution failed. No files were changed.';
      case 'PYTHON_DEPENDENCY_TIMEOUT':
        return 'Dependency resolution timed out. No files were changed.';
      case 'WORKSPACE_REVISION_CONFLICT':
        return 'The workspace changed. Refresh the workspace and try again.';
      case 'WORKSPACE_RECONCILIATION_REQUIRED':
        return 'The result of the dependency change is unknown. Check it before making another change.';
      case 'PROJECT_BUSY':
        return 'Project is busy. Wait for the current operation to finish, then try again.';
      case 'PROJECT_LOCKED':
      case 'RUN_ALREADY_ACTIVE':
        return 'Finish or stop the active Run before changing dependencies.';
      default:
        return error.body?.message ?? 'Unable to change dependencies';
    }
  }
  return 'Unable to change dependencies';
}

function disableReason(options: {
  phase: Phase;
  workspaceLocked: boolean;
  dirty: boolean;
  revisionAvailable: boolean;
  unconfirmed: boolean;
}): string | null {
  if (options.phase !== 'idle') {
    return 'Waiting for the current dependency change';
  }
  if (options.unconfirmed) {
    return 'Check the unconfirmed dependency change first';
  }
  if (options.dirty) {
    return 'Save or discard file changes first';
  }
  if (options.workspaceLocked) {
    return 'Finish or stop the active Run first';
  }
  if (!options.revisionAvailable) {
    return 'Waiting for the workspace revision';
  }
  return null;
}

export function PythonDependenciesPanel({
  projectId,
  userId,
  workspaceLocked,
  unconfirmedOperationId,
  onResponseLost,
  onBusyChange,
}: PythonDependenciesPanelProps) {
  const queryClient = useQueryClient();
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [rejection, setRejection] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = useWorkspaceSession((state) => state.dirtyPaths.size) > 0;
  const revision = getWorkspaceRevision(queryClient, projectId);

  const busy = phase !== 'idle';
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const disabledReason = disableReason({
    phase,
    workspaceLocked,
    dirty,
    revisionAvailable: revision !== undefined,
    unconfirmed: unconfirmedOperationId !== null,
  });

  async function submit(action: PythonDependencyAction): Promise<void> {
    if (disabledReason !== null) {
      return;
    }
    const name = packageName.trim();
    if (name === '') {
      setRejection('Enter a package name.');
      setSaved(false);
      return;
    }
    // Stored BEFORE the first POST: a lost response or a refresh keeps asking about
    // this exact operation.
    const operationId = generateOperationId();
    storePythonDependencyOperationId(userId, projectId, operationId);
    setPhase('submitting');
    setRejection(null);
    setSaved(false);
    let status: Awaited<ReturnType<typeof changePythonDependencies>>;
    try {
      status = await changePythonDependencies(projectId, {
        operationId,
        action,
        packageName: name,
        // Removal is by name only; an optional exact version applies to ADD.
        version: action === 'ADD' && version.trim() !== '' ? version.trim() : null,
        expectedWorkspaceRevision: revision!,
      });
    } catch (error) {
      if (isNetworkError(error)) {
        onResponseLost(operationId);
      } else if (
        error instanceof ApiRequestError &&
        error.body !== null &&
        error.body.code === 'WORKSPACE_RECONCILIATION_REQUIRED'
      ) {
        // A registered operation's result is unresolved: the id stays and only
        // the recovery check may resolve it.
        onResponseLost(operationId);
        setRejection(rejectionMessage(error));
      } else if (
        error instanceof ApiRequestError &&
        error.body !== null &&
        NO_SIDE_EFFECT_CODES.has(error.body.code)
      ) {
        // Explicitly proven no-side-effect rejection: a corrected change may
        // start a NEW operation.
        clearPythonDependencyOperationId(userId, projectId);
        setRejection(rejectionMessage(error));
      } else {
        // An unreadable or internal error answer leaves the result unknown.
        onResponseLost(operationId);
      }
      setPhase('idle');
      return;
    }
    if (status.state !== 'COMMITTED') {
      // A 200 without a COMMITTED answer is not a success to build on.
      onResponseLost(operationId);
      setPhase('idle');
      return;
    }
    setPhase('reloading');
    try {
      // The committed files are re-read from the authoritative workspace; the
      // historical resultWorkspaceRevision never overrides newer content.
      await reloadWorkspaceAfterTerminalRun({ projectId, queryClient });
    } catch {
      // The change IS committed but the surface is not reloaded yet: keep the
      // stored id so the recovery entry re-reads COMMITTED and reloads.
      onResponseLost(operationId);
      setPhase('idle');
      return;
    }
    clearPythonDependencyOperationId(userId, projectId);
    setPackageName('');
    setVersion('');
    setSaved(true);
    setPhase('idle');
  }

  return (
    <section aria-label="Python dependencies" className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <h2 className="text-sm font-medium">Python dependencies</h2>
      <p className="text-sm text-muted-foreground">
        Adds or removes a main dependency through uv. Only public PyPI packages with an optional
        exact version are supported.
      </p>
      <form className="flex flex-col items-start gap-3" onSubmit={(event) => event.preventDefault()}>
        <label className="flex flex-col gap-1 text-sm">
          Package name
          <input
            className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Version (optional)
          <input
            className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="e.g. 0.28.1"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={disabledReason !== null}
            title={disabledReason ?? 'Add dependency'}
            onClick={() => void submit('ADD')}
          >
            Add dependency
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={disabledReason !== null}
            title={disabledReason ?? 'Remove dependency'}
            onClick={() => void submit('REMOVE')}
          >
            Remove dependency
          </Button>
        </div>
      </form>
      {rejection !== null ? <InlineAlert>{rejection}</InlineAlert> : null}
      <p role="status" aria-label="Dependency change result" className="min-h-5 text-sm text-muted-foreground">
        {phase === 'submitting' ? 'Saving dependency change' : null}
        {phase === 'reloading' ? 'Reloading workspace' : null}
        {phase === 'idle' && saved ? 'Dependency change saved.' : null}
      </p>
    </section>
  );
}
