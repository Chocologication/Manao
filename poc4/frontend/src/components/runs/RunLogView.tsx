import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Copy, Download, Search, ArrowDownToLine, ChevronDown, ChevronUp, LocateFixed } from 'lucide-react';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import type { RunId } from '@/contracts/run';
import {
  EMPTY_LOG_WINDOW,
  RunLogStore,
  type RunLogConnection,
  type RunLogSnapshot,
} from '@/features/logs/RunLogStore';
import { cn } from '@/lib/utils';
import { RUN_ICON_BUTTON_CLASS } from './RunToolbar';
import { parseRunErrorLocations, type RunErrorLocation } from './runErrorLocator';
import type { RunSummary } from '@/contracts/run';
import { RunEvidenceExport } from './RunEvidenceExport';

const NEAR_BOTTOM_PX = 48;
const MAX_HIGHLIGHTS = 2000;

const EMPTY_SNAPSHOT: RunLogSnapshot = {
  projectId: '',
  runId: '' as RunId,
  chunks: [],
  lastAppliedSeq: null,
  window: EMPTY_LOG_WINDOW,
  connection: 'idle',
  pendingOutput: false,
  error: null,
};

function subscribeNone(): () => void {
  return () => {};
}

function getEmptySnapshot(): RunLogSnapshot {
  return EMPTY_SNAPSHOT;
}

export function logDistanceFromBottom(element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function connectionLabel(connection: RunLogConnection): string {
  if (connection === 'ticketing') {
    return 'Requesting log access';
  }
  if (connection === 'connecting') {
    return 'Connecting';
  }
  if (connection === 'replaying') {
    return 'Replaying';
  }
  if (connection === 'live') {
    return 'Live';
  }
  if (connection === 'reconnecting') {
    return 'Reconnecting';
  }
  if (connection === 'complete') {
    return 'Complete';
  }
  if (connection === 'failed') {
    return 'Failed';
  }
  return 'Idle';
}

export type RunLogViewProps = {
  store: RunLogStore | null;
  onLocateError?: (location: RunErrorLocation) => void;
  run?: RunSummary | null;
  projectId?: string;
};

export function RunLogView({ store, onLocateError, run, projectId }: RunLogViewProps) {
  const [search, setSearch] = useState('');
  const [toolFeedback, setToolFeedback] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [showAllLocations, setShowAllLocations] = useState(false);
  const snapshot = useSyncExternalStore(
    store === null ? subscribeNone : store.subscribe,
    store === null ? getEmptySnapshot : store.getSnapshot,
    store === null ? getEmptySnapshot : store.getSnapshot,
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const ignoreProgrammaticScrollRef = useRef(false);
  const followedStoreRef = useRef<RunLogStore | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  function scrollToBottom(): void {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    ignoreProgrammaticScrollRef.current = true;
    try {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    } finally {
      ignoreProgrammaticScrollRef.current = false;
    }
  }

  useLayoutEffect(() => {
    if (followedStoreRef.current !== store) {
      followedStoreRef.current = store;
      followingRef.current = true;
    }
    if (!followingRef.current) {
      return;
    }
    scrollToBottom();
  }, [snapshot.chunks, snapshot.lastAppliedSeq, store]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (element === null) {
      return undefined;
    }
    function handleScroll(): void {
      if (ignoreProgrammaticScrollRef.current) {
        return;
      }
      const current = storeRef.current;
      const node = scrollerRef.current;
      if (current === null || node === null) {
        return;
      }
      const distance = logDistanceFromBottom(node);
      if (distance <= NEAR_BOTTOM_PX) {
        followingRef.current = true;
        if (current.getSnapshot().pendingOutput) {
          current.setPendingOutput(false);
        }
        return;
      }
      followingRef.current = false;
      if (!current.getSnapshot().pendingOutput) {
        current.setPendingOutput(true);
      }
    }
    element.addEventListener('scroll', handleScroll);
    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const logText = snapshot.chunks.map((chunk) => chunk.text).join('');
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [] as Array<{ start: number; end: number }>;
    const found: Array<{ start: number; end: number }> = [];
    let offset = 0;
    for (const line of logText.split('\n')) {
      const lower = line.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const index = lower.indexOf(query, from);
        if (index < 0) break;
        found.push({ start: offset + index, end: offset + index + query.length });
        if (found.length >= MAX_HIGHLIGHTS) return found;
        from = index + Math.max(query.length, 1);
      }
      offset += line.length + 1;
    }
    return found;
  }, [logText, search]);
  const errorLocations = useMemo(() => parseRunErrorLocations(logText), [logText]);
  const activeMatchIndex = Math.min(matchIndex, Math.max(0, matches.length - 1));
  useLayoutEffect(() => {
    if (!search.trim()) return;
    followingRef.current = false;
    const node = scrollerRef.current;
    const mark = node?.querySelector<HTMLElement>('[data-active-match="true"]');
    if (node && mark) node.scrollTop += mark.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight / 2;
  }, [activeMatchIndex, search, matches]);
  const highlightedLog = useMemo<ReactNode>(() => {
    if (!search.trim() || matches.length === 0) return logText;
    const result: ReactNode[] = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.start > cursor) result.push(logText.slice(cursor, match.start));
      result.push(<mark key={`${match.start}-${index}`} data-active-match={index === activeMatchIndex ? 'true' : undefined}>{logText.slice(match.start, match.end)}</mark>);
      cursor = match.end;
    });
    if (cursor < logText.length) result.push(logText.slice(cursor));
    return result;
  }, [logText, activeMatchIndex, matches, search]);

  async function copyLogs() {
    try { await navigator.clipboard.writeText(logText); setToolFeedback(snapshot.window.truncated ? '已复制当前日志窗口（部分早期日志已截断）' : '日志已复制'); }
    catch { setToolFeedback('复制不可用，可选中日志手动复制或下载'); }
  }

  function downloadLogs() {
    try {
      const url = URL.createObjectURL(new Blob([logText], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'manao-run.log';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToolFeedback(snapshot.window.truncated ? '已下载当前日志窗口（部分早期日志已截断）' : '日志已下载');
    } catch { setToolFeedback('下载失败，请重试或复制日志'); }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="lab-log-heading">
      <div role="status" aria-label="Log connection" className="shrink-0 text-sm text-muted-foreground">
        {connectionLabel(snapshot.connection)}
      </div>
      <label className="lab-log-search"><Search size={14} /><input value={search} placeholder="搜索日志…" aria-label="搜索日志" onChange={(event) => { setSearch(event.target.value); setMatchIndex(0); }} /></label>
      {search && <span className="text-xs text-muted-foreground" aria-live="polite">{matches.length ? activeMatchIndex + 1 : 0} / {matches.length}</span>}
      {search && matches.length > 0 ? <><button type="button" className={RUN_ICON_BUTTON_CLASS} title="上一个命中" aria-label="上一个命中" onClick={() => setMatchIndex((current) => (current - 1 + matches.length) % matches.length)}><ChevronUp size={15} /></button><button type="button" className={RUN_ICON_BUTTON_CLASS} title="下一个命中" aria-label="下一个命中" onClick={() => setMatchIndex((current) => (current + 1) % matches.length)}><ChevronDown size={15} /></button></> : null}
      <button type="button" className={RUN_ICON_BUTTON_CLASS} disabled={!logText} title="复制已读取日志" aria-label="复制日志" onClick={() => void copyLogs()}><Copy size={15} /></button>
      <button type="button" className={RUN_ICON_BUTTON_CLASS} disabled={!logText} title="下载已读取日志" aria-label="下载日志" onClick={downloadLogs}><Download size={15} /></button>
      {run && (projectId || store?.projectId) && <RunEvidenceExport projectId={projectId ?? store!.projectId} run={run} snapshot={snapshot} />}
      <button type="button" className={RUN_ICON_BUTTON_CLASS} title="滚动到最新日志" aria-label="滚动到最新日志" onClick={() => { followingRef.current = true; store?.setPendingOutput(false); scrollToBottom(); }}><ArrowDownToLine size={15} /></button>
      </div>
      {toolFeedback && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">{toolFeedback}</p>}
      {matches.length >= MAX_HIGHLIGHTS && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">命中较多，仅高亮前 {MAX_HIGHLIGHTS} 处；日志原文完整保留。</p>}
      {snapshot.window.truncated ? (
        <div
          role="status"
          aria-label="Log truncation"
          className="shrink-0 border-b px-2 py-1 text-sm text-muted-foreground"
        >
          日志窗口已截断：早期 {snapshot.window.evictedBytes} bytes 未保留，导出仅包含当前窗口
        </div>
      ) : null}
      {snapshot.connection === 'failed' && snapshot.error !== null ? (
        <InlineAlert className="shrink-0 px-2">{snapshot.error}</InlineAlert>
      ) : null}
      <div
        ref={scrollerRef}
        role="region"
        aria-label="Run logs"
        tabIndex={0}
        className="run-log-scroller min-h-0 flex-1 overflow-auto px-2 py-1 text-sm outline-none select-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <pre className="m-0 font-inherit whitespace-pre-wrap break-all">{highlightedLog}</pre>
        {!logText && <div className="lab-log-empty"><span>OUTPUT / RUN LOGS</span><p>{store === null ? '启动项目后，运行输出将显示在这里。' : '等待运行输出…'}</p></div>}
        {search && logText && matches.length === 0 && <p className="text-xs text-muted-foreground">没有匹配的日志。</p>}
      </div>
      {errorLocations.length > 0 ? <div className="lab-error-locations"><div className="mb-1 flex items-center gap-1 font-medium text-foreground"><LocateFixed size={13} />规则解析到 {errorLocations.length}{errorLocations.length >= 100 ? '+' : ''} 个错误位置</div><div className="flex flex-wrap gap-1">{errorLocations.slice(0, showAllLocations ? 100 : 5).map((location, index) => <button key={`${location.path}:${location.line}:${index}`} type="button" title={`${location.path}:${location.line}`} disabled={!onLocateError} className="rounded border px-2 py-1 hover:bg-accent" onClick={() => onLocateError?.(location)}>{location.path}:{location.line}</button>)}</div>{errorLocations.length > 5 && <button type="button" className="lab-text-action" onClick={() => setShowAllLocations(!showAllLocations)}>{showAllLocations ? '收起位置' : '查看其余位置'}</button>}</div> : null}
      {snapshot.pendingOutput ? (
        <button
          type="button"
          className={cn(RUN_ICON_BUTTON_CLASS, 'h-8 w-auto min-w-20 self-end px-2')}
          onClick={() => {
            followingRef.current = true;
            store?.setPendingOutput(false);
            scrollToBottom();
          }}
        >
          New output
        </button>
      ) : null}
    </div>
  );
}
