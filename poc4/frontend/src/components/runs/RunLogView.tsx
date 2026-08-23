import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
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

const NEAR_BOTTOM_PX = 48;

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
};

export function RunLogView({ store }: RunLogViewProps) {
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div role="status" aria-label="Log connection" className="shrink-0 px-2 py-1 text-sm text-muted-foreground">
        {connectionLabel(snapshot.connection)}
      </div>
      {snapshot.window.truncated ? (
        <div
          role="status"
          aria-label="Log truncation"
          className="shrink-0 border-b px-2 py-1 text-sm text-muted-foreground"
        >
          Log truncated · {snapshot.window.evictedBytes} bytes evicted
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
        <pre className="m-0 font-inherit whitespace-pre-wrap break-all">{logText}</pre>
      </div>
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
