export type MessageAudit = { taskId: string; messageOrdinal: number; durableHeadSeq: number | null; firstApiThinkingAt: number | null; firstThinkingAt: number | null; firstTextAt: number | null; endedAt: number | null; textRevisions: number[] };
export type Audit = { messages: MessageAudit[]; liveGets: number; error: string | null; connections: { requestedAt: number; requestedAtUtc: string; receivedAt: number | null; taskId: string | null; status: number | null }[]; abortOnGeneratingThinking: boolean; reconnect: null | { taskId: string; messageOrdinal: number; revision: number; abortedAt: number; abortedAtUtc: string } };

// Self-contained so Playwright and the local DOM fixture execute the identical observer.
export function installOutputAudit(options: { abortOnGeneratingThinking?: boolean } = {}): void {
  const host = window as unknown as { outputAudit: Audit; outputObserver?: MutationObserver; outputFetchInstalled?: boolean; outputAbortLive?: () => void };
  host.outputObserver?.disconnect();
  const audit: Audit = host.outputAudit = { messages: [], liveGets: 0, error: null, connections: [], abortOnGeneratingThinking: options.abortOnGeneratingThinking === true, reconnect: null };
  const observer = new MutationObserver(() => {
    const preview = document.querySelector<HTMLElement>('[aria-label="实时预览"]');
    const taskId = preview?.dataset.taskId, ordinal = Number(preview?.dataset.messageOrdinal);
    if (!preview || !taskId || !Number.isInteger(ordinal) || ordinal < 1) return;
    let message = audit.messages.find(item => item.taskId === taskId && item.messageOrdinal === ordinal);
    if (!message) { message = { taskId, messageOrdinal: ordinal, durableHeadSeq: null, firstApiThinkingAt: null, firstThinkingAt: null, firstTextAt: null, endedAt: null, textRevisions: [] }; audit.messages.push(message); }
    const now = performance.now();
    if (preview.querySelector('details[open] pre')?.textContent?.trim()) message.firstThinkingAt ??= now;
    if (preview.querySelector('.ai-markdown')?.textContent?.trim()) message.firstTextAt ??= now;
    host.outputAbortLive?.();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'data-task-id', 'data-message-ordinal'] }); host.outputObserver = observer;
  if (host.outputFetchInstalled) return; host.outputFetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const currentAudit = host.outputAudit;
    const input = args[0], url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!url.includes('/live-output')) return nativeFetch(...args);
    const connection = { requestedAt: performance.now(), requestedAtUtc: new Date().toISOString(), receivedAt: null as number | null, taskId: null as string | null, status: null as number | null };
    currentAudit.connections.push(connection);
    const controller = new AbortController(), originalSignal = args[1]?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : null);
    const abortFromCaller = () => controller.abort(originalSignal?.reason);
    if (originalSignal?.aborted) abortFromCaller(); else originalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    let response: Response;
    try { response = await nativeFetch(input, { ...args[1], signal: controller.signal }); }
    catch (error) { originalSignal?.removeEventListener('abort', abortFromCaller); throw error; }
    connection.status = response.status; connection.receivedAt = performance.now();
    if (response.ok && response.body) {
      currentAudit.liveGets++;
      let generating: { taskId: string; messageOrdinal: number; revision: number } | null = null;
      const interrupt = () => {
        if (currentAudit !== host.outputAudit || !currentAudit.abortOnGeneratingThinking || currentAudit.reconnect || currentAudit.connections[0] !== connection || !generating) return;
        const message = currentAudit.messages.find(item => item.taskId === generating!.taskId && item.messageOrdinal === generating!.messageOrdinal);
        if (!message || message.firstApiThinkingAt === null || message.firstThinkingAt === null || message.endedAt !== null) return;
        currentAudit.reconnect = { ...generating, abortedAt: performance.now(), abortedAtUtc: new Date().toISOString() };
        controller.abort();
      };
      host.outputAbortLive = interrupt;
      // Only identities, revision numbers and timestamps survive; never retain model text.
      void (async () => {
        const reader = response.clone().body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
            if (new TextEncoder().encode(buffer).length > 260 * 1024) throw new Error('Frame audit budget exceeded');
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); if (!line.startsWith('data:')) continue;
              const frame = JSON.parse(line.slice(5).trim()) as { taskId: string; revision: number; durableHeadSeq: number; current: null | { messageOrdinal: number; phase: string; blocks: { kind: string; text: string }[] } };
              const now = performance.now();
              connection.taskId = frame.taskId;
              generating = null;
              for (const previous of currentAudit.messages) if (previous.taskId === frame.taskId && previous.durableHeadSeq !== null && frame.durableHeadSeq > previous.durableHeadSeq && (frame.current === null || frame.current.messageOrdinal > previous.messageOrdinal)) previous.endedAt ??= now;
              if (!frame.current) continue;
              const current = frame.current;
              let message = currentAudit.messages.find(item => item.taskId === frame.taskId && item.messageOrdinal === current.messageOrdinal);
              if (!message) { message = { taskId: frame.taskId, messageOrdinal: current.messageOrdinal, durableHeadSeq: frame.durableHeadSeq, firstApiThinkingAt: null, firstThinkingAt: null, firstTextAt: null, endedAt: null, textRevisions: [] }; currentAudit.messages.push(message); }
              message.durableHeadSeq ??= frame.durableHeadSeq;
              if (current.phase === 'ended') message.endedAt ??= now;
              if (current.phase === 'generating' && current.blocks.some(block => block.kind === 'thinking' && block.text.trim())) {
                message.firstApiThinkingAt ??= now; generating = { taskId: frame.taskId, messageOrdinal: current.messageOrdinal, revision: frame.revision }; interrupt();
              }
              if (current.phase === 'generating' && current.blocks.some(block => block.kind === 'text' && block.text.length) && !message.textRevisions.includes(frame.revision)) message.textRevisions.push(frame.revision);
            }
          }
        } catch (error) { if (!(error instanceof TypeError || error instanceof DOMException && error.name === 'AbortError')) currentAudit.error = 'Live frame audit failed'; }
        finally { originalSignal?.removeEventListener('abort', abortFromCaller); if (host.outputAbortLive === interrupt) delete host.outputAbortLive; await reader.cancel().catch(() => {}); reader.releaseLock(); }
      })();
    } else originalSignal?.removeEventListener('abort', abortFromCaller);
    return response;
  };
}

export function assertOutputAnswerTiming(audit: Audit, taskId: string, ordinal: number, thinking: boolean): void {
  const timing = audit.messages.find(message => message.taskId === taskId && message.messageOrdinal === ordinal);
  if (audit.error || !timing || timing.firstTextAt === null || timing.endedAt === null || timing.firstTextAt >= timing.endedAt || new Set(timing.textRevisions).size < 2) throw new Error('UNVERIFIED: answer did not stream before its own end');
  if (thinking && !audit.messages.some(message => message.taskId === taskId && message.firstApiThinkingAt !== null && message.firstThinkingAt !== null && message.endedAt !== null && message.firstApiThinkingAt < message.endedAt && message.firstThinkingAt < message.endedAt)) throw new Error('UNVERIFIED: task API thinking was not displayed before its own message end');
}
export function outputAnswerSelector(taskId: string, seq: number): string {
  return 'article[data-task-id="' + taskId + '"][data-message-seq="' + seq + '"]';
}
