import { useState } from 'react';
import {
  clearPythonDependencyOperationId,
  getPythonDependencyStatus,
  listPendingPythonDependencies,
  readPythonDependencyOperationId,
  reconcilePythonDependency,
} from '../../api/pythonDependencyApi';
import type { ProjectSummary } from '../../contracts/project';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';

/**
 * The failure reason a stuck dependency commit leaves behind. Only this failure on a
 * Python runtime project is recoverable through the dependency entry — never other
 * failures and never a DELETING project.
 */
export const WORKSPACE_RECONCILIATION_REQUIRED = 'WORKSPACE_RECONCILIATION_REQUIRED';

export function isPythonDependencyRecoveryFailure(project: ProjectSummary): boolean {
  return (
    project.state === 'FAILED' &&
    project.failureReason === WORKSPACE_RECONCILIATION_REQUIRED &&
    (project.runtime?.templateId === 'python-console' ||
      project.runtime?.templateId === 'python-fastapi-web')
  );
}

/**
 * The concrete recovery UI shared by the READY and FAILED pages (design 8): while a
 * dependency operation's result is unknown it only allows checking the SAME operation
 * — never a resend, never a fabricated success, never an unlock of another failure.
 */
export type PythonDependencyRecoveryProps = {
  projectId: string;
  userId: string;
  /**
   * 'ready' reloads the workspace through the shell after a confirmed commit;
   * 'failed' refetches the project so the lifted failure reopens the workbench.
   */
  variant: 'ready' | 'failed';
  /**
   * READY pages pass the shell-known unconfirmed operation id. When omitted (the
   * FAILED page), Recovery discovers the stored id itself and falls back to the
   * owner-scoped pending list for a new session.
   */
  operationId?: string | null;
  /** Runs after the recovered operation is COMMITTED and its stored id is cleared. */
  onRecovered: () => void;
};

export function PythonDependencyRecovery({
  projectId,
  userId,
  variant,
  operationId,
  onRecovered,
}: PythonDependencyRecoveryProps) {
  const controlled = operationId !== undefined;
  const [discoveredId] = useState<string | null>(() =>
    controlled ? null : readPythonDependencyOperationId(userId, projectId),
  );
  const [checking, setChecking] = useState(false);
  const activeId = controlled ? operationId : (discoveredId ?? null);
  // The FAILED page always offers the entry: without a local id it can still find
  // the owner-scoped pending operation when the user checks.
  const showEntry = controlled ? activeId !== null : variant === 'failed';

  if (!showEntry) {
    return null;
  }

  async function check(): Promise<void> {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      let target = activeId;
      if (target === null) {
        const pending = await listPendingPythonDependencies(projectId);
        target = pending[0]?.operationId ?? null;
        if (target === null) {
          // No record anywhere: keep showing the unconfirmed entry, never fabricate success.
          return;
        }
      }
      const status = await getPythonDependencyStatus(projectId, target);
      if (status.state === 'UNCONFIRMED') {
        // A missing record is not a proof of absence; keep the id and the entry.
        return;
      }
      if (status.state === 'PENDING') {
        const reconciled = await reconcilePythonDependency(projectId, target);
        if (reconciled.state !== 'COMMITTED') {
          return;
        }
      }
      clearPythonDependencyOperationId(userId, projectId);
      onRecovered();
    } catch {
      // The check failed without a durable answer; the user can check again.
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <InlineAlert>Dependency change is unconfirmed</InlineAlert>
      <p className="text-sm text-muted-foreground">
        The result of the last dependency change is unknown. Check it before making another change.
      </p>
      <Button type="button" variant="outline" disabled={checking} onClick={() => void check()}>
        Check dependency change
      </Button>
      {checking ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking dependency change
        </p>
      ) : null}
    </div>
  );
}
