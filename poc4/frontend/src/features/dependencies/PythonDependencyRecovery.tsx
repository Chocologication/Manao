import { useState } from 'react';
import {
  clearPythonDependencyOperationId,
  getPythonDependencyStatus,
  listPendingPythonDependencies,
  readPythonDependencyOperationId,
  reconcilePythonDependency,
  storePythonDependencyOperationId,
} from '../../api/pythonDependencyApi';
import type { ProjectSummary } from '../../contracts/project';
import { isPythonRuntimeTemplate } from '../../contracts/project';
import { useWorkspaceSession } from '../../features/editor/workspaceSession';
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
    isPythonRuntimeTemplate(project.runtime?.templateId)
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
  const [discoveredId, setDiscoveredId] = useState<string | null>(() =>
    controlled ? null : readPythonDependencyOperationId(userId, projectId),
  );
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const dirtyPaths = useWorkspaceSession((state) => state.dirtyPaths.size);
  // Only the READY page has an editor mounted: a dirty buffer means the workspace
  // content is not authoritative, so a Check (which may reload it) waits (design 6.1).
  const checkBlocked = variant === 'ready' && dirtyPaths > 0;
  const activeId = controlled ? operationId : (discoveredId ?? null);
  // The FAILED page always offers the entry: without a local id it can still find
  // the owner-scoped pending operation when the user checks.
  const showEntry = controlled ? activeId !== null : variant === 'failed';

  if (!showEntry) {
    return null;
  }

  async function check(): Promise<void> {
    if (checking || checkBlocked) {
      return;
    }
    setChecking(true);
    setFeedback('');
    try {
      let target = activeId;
      if (target === null) {
        const pending = await listPendingPythonDependencies(projectId);
        target = pending[0]?.operationId ?? null;
        if (target === null) {
          setFeedback('未找到可核对的记录，变更仍未确认。可以稍后重试。');
          // No record anywhere: keep showing the unconfirmed entry, never fabricate success.
          return;
        }
        // The reconcile may commit server-side even when its response is lost: persist
        // the discovered id (and adopt it in state) so every later Check queries the
        // SAME operation instead of finding an empty pending list.
        storePythonDependencyOperationId(userId, projectId, target);
        setDiscoveredId(target);
      }
      const status = await getPythonDependencyStatus(projectId, target);
      if (status.state === 'UNCONFIRMED') {
        setFeedback('服务端尚未确认该操作结果，请稍后再次核对。');
        // A missing record is not a proof of absence; keep the id and the entry.
        return;
      }
      if (status.state === 'PENDING') {
        const reconciled = await reconcilePythonDependency(projectId, target);
        if (reconciled.state !== 'COMMITTED') {
          setFeedback('变更尚未提交完成，请稍后再次核对。');
          return;
        }
      }
      clearPythonDependencyOperationId(userId, projectId);
      onRecovered();
    } catch {
      setFeedback('核对失败，操作结果仍未知。原 operationId 已保留，请重试核对。');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <InlineAlert>依赖变更尚未确认</InlineAlert>
      <p className="text-sm text-muted-foreground">
        上一次依赖变更的结果未知，请先核对后再提交新的变更。
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={checking || checkBlocked}
        title={checkBlocked ? '请先保存或放弃文件修改' : undefined}
        onClick={() => void check()}
        aria-label="Check dependency change"
      >
        核对依赖变更
      </Button>
      {checkBlocked ? (
        <p className="text-sm text-muted-foreground">请先保存或放弃文件修改</p>
      ) : null}
      {checking ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在核对依赖变更
        </p>
      ) : null}
      {feedback && <p role="status" className="text-sm text-muted-foreground">{feedback}</p>}
    </div>
  );
}
