import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../../api/ApiRequestError';
import { getFileContent } from '../../api/fileApi';
import {
  changePythonDependencies,
  changePythonDependencyBatch,
  clearPythonDependencyOperationId,
  generateOperationId,
  storePythonDependencyOperationId,
  type PythonDependencyAction,
} from '../../api/pythonDependencyApi';
import type { FileContentResponse } from '../../contracts/file';
import { getWorkspaceRevision } from '../../features/files/fileQueries';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import { reloadWorkspaceAfterTerminalRun } from '../../features/runs/workspaceReload';
import { useWorkspaceSession } from '../../features/editor/workspaceSession';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';
import { Package, Plus, Minus, FileInput } from 'lucide-react';

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
  // The installability verification rejects before any journal or operation row exists:
  // proven no-side-effect, so a corrected change may start a NEW operation.
  'PYTHON_DEPENDENCY_NO_WHEEL',
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

/**
 * The one failure semantics shared by the single change and the batch import: a
 * lost response or an unreadable answer leaves the result unknown (the stored id
 * stays for the recovery entry); a proven no-side-effect rejection clears the id
 * so a corrected change may start a NEW operation.
 */
function settleSubmissionFailure(options: {
  userId: string;
  projectId: string;
  operationId: string;
  error: unknown;
  onResponseLost: (operationId: string) => void;
  reportRejection: (message: string) => void;
  /** The import flow describes the requirements.txt contract, not single-package scope. */
  importContract?: boolean;
}): void {
  const error = options.error;
  if (!isNetworkError(error) && error instanceof ApiRequestError && error.body !== null) {
    if (error.body.code === 'WORKSPACE_RECONCILIATION_REQUIRED') {
      // A registered operation's result is unresolved: the id stays and only
      // the recovery check may resolve it.
      options.onResponseLost(options.operationId);
      options.reportRejection(rejectionMessage(error, options.importContract === true));
      return;
    }
    if (NO_SIDE_EFFECT_CODES.has(error.body.code)) {
      // Explicitly proven no-side-effect rejection: a corrected change may
      // start a NEW operation.
      clearPythonDependencyOperationId(options.userId, options.projectId);
      options.reportRejection(rejectionMessage(error, options.importContract === true));
      return;
    }
  }
  // A lost response or an unreadable/internal answer leaves the result unknown.
  options.onResponseLost(options.operationId);
}

/** The fixed root file read registers no operation, so any read failure is a safe correction. */
function requirementsReadErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.body?.code === 'ENTRY_NOT_FOUND') {
    return 'requirements.txt 未找到，请确认它位于项目根目录。';
  }
  return '无法读取 requirements.txt。';
}

function rejectionMessage(error: unknown, importContract = false): string {
  if (error instanceof ApiRequestError) {
    switch (error.body?.code) {
      case 'VALIDATION_ERROR':
        // The import contract lives on the root requirements.txt, not single packages.
        return importContract
          ? 'requirements.txt 仅支持大小和数量限制内的公开 PyPI 依赖行。'
          : '仅支持 package 名称和可选的精确版本。';
      case 'PYTHON_DEPENDENCY_UNSUPPORTED':
        return error.body.message;
      case 'PYTHON_DEPENDENCY_NO_WHEEL':
        return '当前 package 或版本没有可用的兼容 wheel。';
      case 'PYTHON_DEPENDENCY_RESOLUTION_FAILED':
        return '依赖解析失败，文件未改动。';
      case 'PYTHON_DEPENDENCY_TIMEOUT':
        return '依赖解析超时，文件未改动。';
      case 'WORKSPACE_REVISION_CONFLICT':
        return '工作区已发生变化，请刷新后重试。';
      case 'WORKSPACE_RECONCILIATION_REQUIRED':
        return '依赖变更结果未知，请先核对后再提交新的变更。';
      case 'PROJECT_BUSY':
        return '项目正忙，请等待当前操作完成后重试。';
      case 'PROJECT_LOCKED':
      case 'RUN_ALREADY_ACTIVE':
        return '请先完成或停止当前 Run，再修改依赖。';
      default:
        return error.body?.message ?? '无法修改依赖。';
    }
  }
  return '无法修改依赖。';
}

function disableReason(options: {
  phase: Phase;
  workspaceLocked: boolean;
  dirty: boolean;
  revisionAvailable: boolean;
  unconfirmed: boolean;
}): string | null {
  if (options.phase !== 'idle') {
    return '正在等待当前依赖变更完成';
  }
  if (options.unconfirmed) {
    return '请先核对未确认的依赖变更';
  }
  if (options.dirty) {
    return '请先保存或放弃文件修改';
  }
  if (options.workspaceLocked) {
    return '请先完成或停止当前 Run';
  }
  if (!options.revisionAvailable) {
    return '正在等待工作区 revision';
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
      setRejection('请输入 package 名称。');
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
      settleSubmissionFailure({
        userId,
        projectId,
        operationId,
        error,
        onResponseLost,
        reportRejection: setRejection,
      });
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

  /**
   * The batch import: read the fixed project-root requirements.txt once and hand the
   * whole text to ONE batch POST — never a per-line loop. It reuses the exact single
   * change identity lifecycle: one stored operationId, one reload, clear on success,
   * keep on loss.
   */
  async function submitImport(): Promise<void> {
    if (disabledReason !== null) {
      return;
    }
    setPhase('submitting');
    setRejection(null);
    setSaved(false);
    let requirements: FileContentResponse;
    try {
      // The import reads the fixed root path; the user never picks a path and the
      // browser never splits or parses the text.
      requirements = await getFileContent(projectId, parseProjectRelativePath('requirements.txt'));
    } catch (error) {
      // The read-only GET registers no operation: any read failure is a safe
      // correction and never a lost response.
      setRejection(requirementsReadErrorMessage(error));
      setPhase('idle');
      return;
    }
    // Stored BEFORE the batch POST: a lost response or a refresh keeps asking about
    // this exact operation.
    const operationId = generateOperationId();
    storePythonDependencyOperationId(userId, projectId, operationId);
    let status: Awaited<ReturnType<typeof changePythonDependencyBatch>>;
    try {
      status = await changePythonDependencyBatch(projectId, {
        operationId,
        requirementsText: requirements.content,
        // The revision the file read saw, not the older cached one.
        expectedWorkspaceRevision: requirements.workspaceRevision,
      });
    } catch (error) {
      settleSubmissionFailure({
        userId,
        projectId,
        operationId,
        error,
        onResponseLost,
        reportRejection: setRejection,
        importContract: true,
      });
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
    setSaved(true);
    setPhase('idle');
  }

  return (
    <section aria-label="Python dependencies" className="lab-dependencies flex h-full min-h-0 flex-col gap-3 overflow-auto">
      <div className="lab-dependency-header"><Package size={28} /><p className="lab-eyebrow">PYTHON / UV</p><h2>项目依赖管理</h2><p>公开 PyPI package · 精确版本可选</p></div>
      <form className="flex flex-col items-start gap-3" onSubmit={(event) => event.preventDefault()}>
        <label className="flex flex-col gap-1 text-sm">
          package 名称
          <input
            aria-label="Package name"
            className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          版本（可选）
          <input
            aria-label="Version (optional)"
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
            aria-label="Add dependency"
            disabled={disabledReason !== null}
            title={disabledReason ?? '添加依赖'}
            onClick={() => void submit('ADD')}
          >
            <Plus />添加依赖
          </Button>
          <Button
            type="button"
            aria-label="Remove dependency"
            variant="outline"
            disabled={disabledReason !== null}
            title={disabledReason ?? '移除依赖'}
            onClick={() => void submit('REMOVE')}
          >
            <Minus />移除依赖
          </Button>
          <Button
            type="button"
            aria-label="Import requirements.txt"
            variant="outline"
            disabled={disabledReason !== null}
            title={disabledReason ?? '从 requirements.txt 导入依赖'}
            onClick={() => void submitImport()}
          >
            <FileInput />导入 requirements.txt
          </Button>
        </div>
      </form>
      <p className="lab-dependency-notice">批量导入读取项目根目录的 requirements.txt。</p>
      {disabledReason && <p className="lab-warning" role="status">{disabledReason}</p>}
      {rejection !== null ? <InlineAlert>{rejection}</InlineAlert> : null}
      <p role="status" aria-label="Dependency change result" className="min-h-5 text-sm text-muted-foreground">
        {phase === 'submitting' ? '正在提交依赖变更' : null}
        {phase === 'reloading' ? '正在重新加载工作区' : null}
        {phase === 'idle' && saved ? '依赖变更已保存。' : null}
      </p>
    </section>
  );
}
