import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { runStateLabels } from '@/components/ui/labPresentation';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { RUNTIME_TEMPLATE_META, type RuntimeTemplateId } from '@/contracts/project';
import {
  isRunTerminalState,
  resolveRunAvailability,
  runRuntimeLabel,
  templateRunDisplay,
  type RunState,
  type RunSummary,
} from '@/contracts/run';

export const RUN_ICON_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-64';

export type RunToolbarProps = {
  run: RunSummary | null;
  /** Template of the project the toolbar belongs to; used only while no run is selected. */
  projectTemplateId: RuntimeTemplateId;
  statusText: string;
  nowMs: number;
  canStart: boolean;
  startTitle: string;
  startPending: boolean;
  canStop: boolean;
  stopBlockedByAgent?: boolean;
  onOpenAgentTask?: () => void;
  stopWaiting: boolean;
  stopPending: boolean;
  authorityError: string | null;
  startError: string | null;
  stopError: string | null;
  reloadFailed: boolean;
  onStart: () => void;
  onStop: () => void;
  onRetryAuthority: () => void;
  onRetryReload: () => void;
};

export function formatRunElapsed(fromIso: string, toMs: number): string {
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) {
    return '0:00';
  }
  const elapsed = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stateIcon(state: RunState | null, loading: boolean): ReactNode {
  const className = 'h-4 w-4';
  if (loading) {
    return <Loader2 className={className} aria-hidden />;
  }
  if (state === 'STARTING') {
    return <Loader2 className={className} aria-hidden />;
  }
  if (state === 'RUNNING') {
    return <Play className={className} aria-hidden />;
  }
  if (state === 'STOPPING') {
    return <Square className={className} aria-hidden />;
  }
  if (state === 'RECOVERING') {
    return <RefreshCw className={className} aria-hidden />;
  }
  if (state === 'SUCCEEDED') {
    return <CircleCheck className={className} aria-hidden />;
  }
  if (state === 'FAILED') {
    return <CircleX className={className} aria-hidden />;
  }
  if (state === 'CANCELLED') {
    return <Ban className={className} aria-hidden />;
  }
  if (state === 'TIMED_OUT') {
    return <Clock className={className} aria-hidden />;
  }
  return <CircleAlert className={className} aria-hidden />;
}

function clockLabel(run: RunSummary | null, nowMs: number): string | null {
  if (run === null) {
    return null;
  }
  if (run.finishedAt !== null) {
    return `结束于 ${run.finishedAt}`;
  }
  const origin = run.startedAt ?? run.createdAt;
  return `已运行 ${formatRunElapsed(origin, nowMs)}`;
}

/**
 * Lifetime status of a SERVICE run, derived only from the verified readiness lifetime:
 * the countdown starts at firstReadyAt (never before), displays the remaining time until
 * the immutable expiresAt and distinguishes an address that exists from one that answers.
 * Display only — the server, not the browser, ends the run.
 */
function serviceLifetimeLabel(run: RunSummary, nowMs: number): string {
  if (run.state === 'TIMED_OUT') {
    return run.terminationReason === 'STARTUP_TIME_LIMIT_EXCEEDED'
      ? '失败'
      : '已达到两小时运行上限';
  }
  if (isRunTerminalState(run.state)) {
    return run.state === 'CANCELLED' || run.state === 'SUCCEEDED' ? '已停止' : '失败';
  }
  const availability = resolveRunAvailability(run, nowMs);
  if (availability === 'STARTING') {
    return '正在启动';
  }
  if (availability === 'READY' && run.expiresAt !== null) {
    return `可访问 · 剩余 ${formatRunElapsed(new Date(nowMs).toISOString(), Date.parse(run.expiresAt))}`;
  }
  return '暂不可用';
}

export function RunToolbar({
  run,
  projectTemplateId,
  statusText,
  nowMs,
  canStart,
  startTitle,
  startPending,
  canStop,
  stopBlockedByAgent = false,
  onOpenAgentTask,
  stopWaiting,
  stopPending,
  authorityError,
  startError,
  stopError,
  reloadFailed,
  onStart,
  onStop,
  onRetryAuthority,
  onRetryReload,
}: RunToolbarProps) {
  // A selected run always displays its own policy; only the no-run state falls back to
  // the current project template so a Python project never shows a Maven default.
  const templateDisplay = templateRunDisplay(projectTemplateId);
  const command = run?.policy.command ?? templateDisplay.command;
  const runtimeLabel = run !== null ? runRuntimeLabel(run.policy.runtime) : templateDisplay.runtimeLabel;
  const timeoutSeconds = run?.policy.timeoutSeconds ?? templateDisplay.timeoutSeconds;
  const servicePolicy = run?.policy.executionKind === 'SERVICE' ? run.policy : null;
  const servicePreview = run === null && RUNTIME_TEMPLATE_META[projectTemplateId].web;
  const policyLabel = servicePolicy !== null
    ? `启动时限 ${servicePolicy.startupTimeoutSeconds} 秒 · 就绪后可运行 ${servicePolicy.serviceLifetimeSeconds} 秒`
    : servicePreview ? `启动时限 ${timeoutSeconds} 秒 · 就绪后可运行 7200 秒` : `运行时限 ${timeoutSeconds} 秒`;
  const clock = clockLabel(run, nowMs);
  const serviceLifetime =
    run !== null && run.policy.executionKind === 'SERVICE'
      ? serviceLifetimeLabel(run, nowMs)
      : null;
  const loading = /正在核对|正在读取|正在.*加载|loading/i.test(statusText);
  const displayedStatus = run !== null && statusText === run.state
    ? runStateLabels[run.state]
    : statusText === '已就绪' ? '可以运行' : statusText;
  const stopTitle = stopBlockedByAgent ? 'AI 任务正在管理应用，请先结束任务。'
    : stopWaiting ? '正在等待服务端确认' : '停止运行';

  return (
    <div className="lab-run-toolbar flex shrink-0 flex-col gap-1 border-b">
      <div role="toolbar" aria-label="运行控制" className="flex h-8 min-w-0 items-center gap-2">
        <button
          type="button"
          title={startTitle}
          aria-label="启动运行"
          aria-busy={startPending}
          className={RUN_ICON_BUTTON_CLASS}
          disabled={!canStart || startPending}
          onClick={onStart}
        >
          <Play className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title={stopTitle}
          aria-label="停止运行"
          aria-busy={stopPending}
          className={RUN_ICON_BUTTON_CLASS}
          disabled={!canStop || stopPending || stopBlockedByAgent}
          onClick={onStop}
        >
          <Square className="h-4 w-4" aria-hidden />
        </button>
        <div role="status" aria-label="运行状态" className="flex min-w-0 items-center gap-1.5 text-sm">
          {stateIcon(run?.state ?? null, loading)}
          <span className="truncate" title={statusText}>{displayedStatus}</span>
          {stopWaiting && <span className="lab-machine-state">正在等待服务端确认</span>}
        </div>
        <span className="font-mono truncate text-sm">{command}</span>
        {clock !== null ? (
          <span className="shrink-0 text-sm text-muted-foreground">{clock}</span>
        ) : null}
        {serviceLifetime !== null ? (
          <span
            role="status"
            aria-label="服务可用状态"
            className="shrink-0 text-sm text-muted-foreground"
          >
            {serviceLifetime}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {runtimeLabel} · {policyLabel}
        </span>
      </div>
      {servicePolicy !== null && run?.expiresAt != null ? <span className="text-xs text-muted-foreground">到期时间：{run.expiresAt}</span> : null}
      {stopBlockedByAgent ? <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
        <span>{stopTitle}</span>
        {onOpenAgentTask ? <button type="button" className="h-8 shrink-0 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={onOpenAgentTask}>查看 AI 任务</button> : null}
      </div> : null}
      {authorityError !== null ? (
        <div className="flex items-center gap-2 pb-1">
          <InlineAlert>{authorityError}</InlineAlert>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetryAuthority}
          >
            重试读取运行状态
          </button>
        </div>
      ) : null}
      {reloadFailed ? (
        <div className="flex items-center gap-2 pb-1">
          <InlineAlert>工作区重新加载失败</InlineAlert>
          <button
            type="button"
            className="h-8 shrink-0 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onRetryReload}
          >
            重试加载工作区
          </button>
        </div>
      ) : null}
      {startError !== null ? <InlineAlert>{startError}</InlineAlert> : null}
      {stopError !== null ? <InlineAlert>{stopError}</InlineAlert> : null}
    </div>
  );
}
