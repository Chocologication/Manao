import type { ContextUsage } from '@/contracts/agentConversation';

/** Shows the current context estimate, rather than cumulative token spend. */
export function ContextUsageIndicator({ usage }: { usage: ContextUsage | null }) {
  const percent = usage?.tokens != null ? usage.percent : null;
  const value = percent == null ? undefined : Math.min(100, Math.max(0, percent));
  const label = percent == null ? '占用暂不可用' : '约 ' + percent.toFixed(1) + '%';
  const description = [
    label,
    percent != null && usage?.tokens != null
      ? usage.tokens.toLocaleString('en-US') + ' / ' + usage.contextWindow.toLocaleString('en-US') + ' tokens'
      : '等待有效的上下文统计',
    '自动压缩阈值：75%；占用为最近一次上下文估算',
  ].join(' · ');

  return <span role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={value} aria-valuetext={description} title={description} tabIndex={0}
    className="inline-flex shrink-0 items-center gap-1.5 rounded text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true" className="shrink-0">
      <circle cx={10} cy={10} r={7.5} fill="none" stroke="currentColor" strokeWidth={2.5} opacity={0.2} />
      {value !== undefined ? <circle cx={10} cy={10} r={7.5} fill="none" stroke="currentColor" strokeWidth={2.5}
        pathLength={100} strokeDasharray={value + ' 100'} transform="rotate(-90 10 10)"
        className={value >= 75 ? 'text-warning' : 'text-primary'} />
        : <text x={10} y={10} dy=".35em" textAnchor="middle" fill="currentColor" fontSize={10}>?</text>}
    </svg>
    <span>{label}</span>
  </span>;
}
