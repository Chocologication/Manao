import { isDeepStrictEqual } from "node:util";
import { estimateTokens, shouldCompact, SessionManager, type AgentSession, type FileEntry, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { BackendHttpError, type BackendClient } from "./backend-client.js";

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }
export interface ContextPage {
  header: SessionHeader; headSeq: number;
  entries: Array<{ seq: number; sourceTaskId: string | null; writerId: string; entry: SessionEntry }>;
  nextAfterSeq: number | null;
}
export interface ContextAppend { expectedHeadSeq: number; header: SessionHeader; entries: SessionEntry[]; usage: ContextUsage | null }
export interface CompactStart { conversationId: string; requestId: string; expectedHeadSeq: number }
export interface CompactResult { expectedHeadSeq: number; entries: SessionEntry[]; usage: ContextUsage | null; failureCode: string | null }
export const CONTEXT_WINDOW = 1_048_576;
export const COMPACTION_THRESHOLD = 786_432;
export const COMPACTION_SETTINGS = { enabled: true, reserveTokens: CONTEXT_WINDOW - COMPACTION_THRESHOLD + 1, keepRecentTokens: 20_000 };

/** SDK usage calibrates the active projection; a fresh compaction has no measured usage yet. */
export function needsCompaction(session: AgentSession, pendingTokens = 0): boolean {
  const tokens = session.getContextUsage()?.tokens
    ?? session.sessionManager.buildSessionContext().messages.reduce((total, message) => total + estimateTokens(message), 0);
  return shouldCompact(tokens + pendingTokens, CONTEXT_WINDOW, COMPACTION_SETTINGS);
}
export const CONTEXT_PAGE_BYTES = 4 * 1024 * 1024;
const ENTRY_BYTES = 2 * 1024 * 1024;
const unavailable = () => new BackendHttpError(0, "AI_CONTEXT_UNAVAILABLE", "conversation history could not be durably confirmed");

/** The backend owns history; this object tracks only the acknowledged native suffix. */
export class ConversationContext {
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private constructor(private readonly backend: BackendClient, private readonly taskId: string,
    readonly fileEntries: FileEntry[], private headSeq: number) { }

  static async load(backend: BackendClient, taskId: string, conversationId: string): Promise<ConversationContext> {
    return this.loadEntries(backend, taskId, conversationId, (after, through) => backend.readContext(taskId, after, through));
  }

  static async loadForCompaction(backend: BackendClient, start: CompactStart): Promise<ConversationContext> {
    const context = await this.loadEntries(backend, start.requestId, start.conversationId,
      (after, through) => backend.readCompactionContext(start, after, through));
    if (context.headSeq !== start.expectedHeadSeq) throw unavailable();
    return context;
  }

  private static async loadEntries(backend: BackendClient, taskId: string, conversationId: string,
    read: (after: number, through?: number) => Promise<ContextPage>): Promise<ConversationContext> {
    try {
      let after = 0;
      let through: number | undefined;
      let header: SessionHeader | undefined;
      const entries: SessionEntry[] = [];
      for (;;) {
        const page = await read(after, through);
        if (page.header.type !== "session" || page.header.version !== 3 || page.header.id !== conversationId
          || (header && !isDeepStrictEqual(header, page.header)) || (through !== undefined && page.headSeq !== through)
          || !Number.isSafeInteger(page.headSeq) || page.headSeq < after || page.entries.length > 32) throw unavailable();
        header ??= structuredClone(page.header);
        through ??= page.headSeq;
        for (const row of page.entries) {
          if (row.seq !== ++after || row.seq > through || !row.entry.id || entries.some((entry) => entry.id === row.entry.id)) throw unavailable();
          entries.push(structuredClone(row.entry));
        }
        if (page.nextAfterSeq === null) {
          if (after !== through) throw unavailable();
          return new ConversationContext(backend, taskId, [header, ...entries], through);
        }
        if (page.nextAfterSeq !== after || page.entries.length === 0) throw unavailable();
      }
    } catch { throw unavailable(); }
  }

  /** Manual work commits its whole suffix together with the terminal verdict, never in separate flush batches. */
  compactionResult(session: AgentSession): CompactResult {
    const entries = structuredClone(session.sessionManager.getEntries().slice(this.headSeq));
    const usage = session.getContextUsage();
    const result: CompactResult = { expectedHeadSeq: this.headSeq, entries,
      usage: usage ? { tokens: usage.tokens, contextWindow: CONTEXT_WINDOW, percent: usage.percent } : null, failureCode: null };
    if (entries.length > 32 || entries.some(entry => Buffer.byteLength(JSON.stringify(entry), "utf8") > ENTRY_BYTES)
      || Buffer.byteLength(JSON.stringify(result), "utf8") > CONTEXT_PAGE_BYTES) throw unavailable();
    return result;
  }

  /** Keep original rows and suppress only an incomplete old tool round in Pi's projection. */
  prepare(manager: SessionManager, revision: string): void {
    const effective = manager.buildSessionContext().messages;
    const entries = manager.getEntries();
    let interrupted = false;
    for (let index = 0; index < effective.length; index++) {
      const message = effective[index]!;
      if (message.role !== "assistant") continue;
      const calls = message.content.filter((part) => part.type === "toolCall");
      if (!calls.length) continue;
      const results = effective.slice(index + 1).filter((item) => item.role === "toolResult" && calls.some((call) => call.id === item.toolCallId));
      if (calls.every((call) => results.some((result) => result.role === "toolResult" && result.toolCallId === call.id))) continue;
      for (const item of [message, ...results]) {
        const entry = entries.find((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, item));
        if (entry) manager.appendContextEdit(entry.id, null);
      }
      interrupted = true;
    }
    manager.appendCustomMessageEntry("manao_context_note",
      `Current workspace revision: ${revision}. Re-read relevant files before changes. Historical files, Runs and results are not current workspace facts.`
      + (interrupted ? " The previous task was interrupted. Its incomplete tool round is omitted; re-read current results and files. Do not execute or resume old tool calls." : ""), false);
  }

  get acknowledgedHeadSeq(): number { return this.headSeq; }

  flush(session: AgentSession, onAcknowledged?: (entries: SessionEntry[], headSeq: number) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      try {
        const entries = session.sessionManager.getEntries();
        while (this.headSeq < entries.length) {
          const usage = session.getContextUsage();
          const batch: ContextAppend = { expectedHeadSeq: this.headSeq, header: structuredClone(this.fileEntries[0] as SessionHeader), entries: [],
            usage: usage ? { tokens: usage.tokens, contextWindow: CONTEXT_WINDOW, percent: usage.percent } : null };
          for (const entry of entries.slice(this.headSeq, this.headSeq + 32)) {
            if (Buffer.byteLength(JSON.stringify(entry), "utf8") > ENTRY_BYTES) throw unavailable();
            batch.entries.push(structuredClone(entry));
            if (Buffer.byteLength(JSON.stringify(batch), "utf8") > CONTEXT_PAGE_BYTES) { batch.entries.pop(); break; }
          }
          if (!batch.entries.length) throw unavailable();
          const expected = this.headSeq + batch.entries.length;
          // Only the final batch represents this exact SDK projection/head. Intermediate
          // chunks must invalidate the previous measurement rather than label it current.
          if (expected !== entries.length) batch.usage = null;
          const ack = await this.backend.appendContext(this.taskId, batch);
          if (ack.headSeq !== expected) throw unavailable();
          const acknowledgedEntries = entries.slice(this.headSeq, expected);
          this.headSeq = expected;
          // A display observer cannot invalidate an already successful durable ACK.
          try { onAcknowledged?.(acknowledgedEntries, this.headSeq); } catch {}
        }
      } catch { this.failure = unavailable(); throw this.failure; }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
