export type MessageAudit = { taskId: string; messageOrdinal: number; durableHeadSeq: number | null; firstThinkingAt: number | null; firstTextAt: number | null; endedAt: number | null; textRevisions: number[] };
export type Audit = { messages: MessageAudit[]; liveGets: number; error: string | null };

// Self-contained so Playwright and the local DOM fixture execute the identical observer.
export function installOutputAudit(): void {
  const host = window as unknown as { outputAudit: Audit; outputObserver?: MutationObserver; outputFetchInstalled?: boolean };
  host.outputObserver?.disconnect();
  const audit: Audit = host.outputAudit = { messages: [], liveGets: 0, error: null };
  const observer = new MutationObserver(() => {
    const preview = document.querySelector<HTMLElement>('[aria-label="实时预览"]');
    const taskId = preview?.dataset.taskId, ordinal = Number(preview?.dataset.messageOrdinal);
    if (!preview || !taskId || !Number.isInteger(ordinal) || ordinal < 1) return;
    let message = audit.messages.find(item => item.taskId === taskId && item.messageOrdinal === ordinal);
    if (!message) { message = { taskId, messageOrdinal: ordinal, durableHeadSeq: null, firstThinkingAt: null, firstTextAt: null, endedAt: null, textRevisions: [] }; audit.messages.push(message); }
    const now = performance.now();
    if (preview.querySelector('details[open] pre')?.textContent?.trim()) message.firstThinkingAt ??= now;
    if (preview.querySelector('.ai-markdown')?.textContent?.trim()) message.firstTextAt ??= now;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'data-task-id', 'data-message-ordinal'] }); host.outputObserver = observer;
  if (host.outputFetchInstalled) return; host.outputFetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const currentAudit = host.outputAudit;
    const response = await nativeFetch(...args);
    if (String(args[0]).includes('/live-output') && response.ok && response.body) {
      currentAudit.liveGets++;
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
              for (const previous of currentAudit.messages) if (previous.taskId === frame.taskId && previous.durableHeadSeq !== null && frame.durableHeadSeq > previous.durableHeadSeq && (frame.current === null || frame.current.messageOrdinal > previous.messageOrdinal)) previous.endedAt ??= now;
              if (!frame.current) continue;
              const current = frame.current;
              let message = currentAudit.messages.find(item => item.taskId === frame.taskId && item.messageOrdinal === current.messageOrdinal);
              if (!message) { message = { taskId: frame.taskId, messageOrdinal: current.messageOrdinal, durableHeadSeq: frame.durableHeadSeq, firstThinkingAt: null, firstTextAt: null, endedAt: null, textRevisions: [] }; currentAudit.messages.push(message); }
              message.durableHeadSeq ??= frame.durableHeadSeq;
              if (current.phase === 'ended') message.endedAt ??= now;
              if (current.phase === 'generating' && current.blocks.some(block => block.kind === 'text' && block.text.length) && !message.textRevisions.includes(frame.revision)) message.textRevisions.push(frame.revision);
            }
          }
        } catch (error) { if (!(error instanceof TypeError || error instanceof DOMException && error.name === 'AbortError')) currentAudit.error = 'Live frame audit failed'; }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      })();
    }
    return response;
  };
}

export function assertOutputAnswerTiming(audit: Audit, taskId: string, ordinal: number, thinking: boolean): void {
  const timing = audit.messages.find(message => message.taskId === taskId && message.messageOrdinal === ordinal);
  if (audit.error || !timing || timing.firstTextAt === null || timing.endedAt === null || timing.firstTextAt >= timing.endedAt || new Set(timing.textRevisions).size < 2) throw new Error('UNVERIFIED: answer did not stream before its own end');
  if (thinking && (timing.firstThinkingAt === null || timing.firstThinkingAt >= timing.endedAt)) throw new Error('UNVERIFIED: answer thinking did not stream before its own end');
}
export function outputAnswerSelector(taskId: string, seq: number): string {
  return 'article[data-task-id="' + taskId + '"][data-message-seq="' + seq + '"]';
}
