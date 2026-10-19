import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { BackendClient } from "./backend-client.js";

export type LiveBlock = { contentIndex: number; kind: "thinking" | "text"; text: string };
export type LiveSnapshot = {
  revision: number; taskId: string; conversationId: string; durableHeadSeq: number;
  current: null | { messageOrdinal: number; phase: "generating" | "ended"; blocks: LiveBlock[];
    modelTruncated: boolean; displayTruncated: boolean };
  unavailable: boolean;
};
export const LIVE_OUTPUT_MAX_BYTES = 256 * 1024;
const KIND_BYTES = { thinking: 96 * 1024, text: 128 * 1024 };

/** One immutable latest snapshot and one cancellable request; never joins the progress chain. */
export class LiveOutput {
  private latest: LiveSnapshot;
  private completedMessage: AssistantMessage | undefined;
  private ignoredMessage = false;
  private ordinal = 0;
  private readonly clipped = new Set<number>();
  private coalesce: ReturnType<typeof setTimeout> | undefined;
  private readonly pulse: ReturnType<typeof setInterval>;
  private inflight: AbortController | undefined;
  private pending = false;
  private finishing = false;
  private disposed = false;

  constructor(private readonly backend: BackendClient, taskId: string, conversationId: string, headSeq: number) {
    this.latest = { revision: 0, taskId, conversationId, durableHeadSeq: headSeq, current: null, unavailable: false };
    this.pulse = setInterval(() => this.sendLatest(), 2000);
    this.pulse.unref?.();
  }

  observe(event: AgentSessionEvent): void {
    if (this.disposed) return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.ignoredMessage = this.latest.current !== null;
      if (this.ignoredMessage) { this.change({ ...this.latest, unavailable: true }); return; }
      this.clipped.clear();
      this.change({ ...this.latest, current: { messageOrdinal: ++this.ordinal, phase: "generating", blocks: [],
        modelTruncated: false, displayTruncated: false } });
    } else if (event.type === "message_update" && !this.ignoredMessage && this.latest.current) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        this.block(update.contentIndex, update.type === "text_delta" ? "text" : "thinking", update.delta);
      }
    } else if (event.type === "message_end" && event.message.role === "assistant" && !this.ignoredMessage && this.latest.current) {
      this.completedMessage = event.message;
      // The complete response is authoritative for redacted blocks and providers without deltas.
      const blocks: LiveBlock[] = [];
      event.message.content.forEach((part, contentIndex) => {
        if (part.type === "text") blocks.push({ contentIndex, kind: "text", text: part.text });
        if (part.type === "thinking") blocks.push({ contentIndex, kind: "thinking",
          text: part.redacted ? "该段推理未提供可展示文本" : part.thinking });
      });
      const fitted = fitBlocks(blocks);
      this.change({ ...this.latest, current: { ...this.latest.current, phase: "ended", blocks: fitted.blocks,
        modelTruncated: event.message.stopReason === "length", displayTruncated: fitted.truncated } });
    }
  }

  checkpoint(acknowledgedEntries: SessionEntry[], headSeq: number): void {
    const confirmed = this.completedMessage !== undefined && acknowledgedEntries.some(
      (entry) => entry.type === "message" && entry.message === this.completedMessage);
    if (confirmed) this.completedMessage = undefined;
    this.change({ ...this.latest, durableHeadSeq: headSeq, current: confirmed ? null : this.latest.current });
  }

  /** Submit the newest state without waiting for display transport before terminal delivery. */
  finish(): void {
    if (this.disposed || this.finishing) return;
    this.finishing = true;
    clearInterval(this.pulse);
    clearTimeout(this.coalesce);
    this.coalesce = undefined;
    if (this.inflight) {
      this.pending = true;
      this.inflight.abort();
    } else this.sendLatest();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.pulse);
    clearTimeout(this.coalesce);
    this.pending = false;
    this.inflight?.abort();
  }

  private block(contentIndex: number, kind: LiveBlock["kind"], delta: string): void {
    // Once a prefix is clipped, later deltas cannot fill a skipped middle.
    if (this.clipped.has(contentIndex)) return;
    const current = this.latest.current!;
    const existing = current.blocks.find((block) => block.contentIndex === contentIndex && block.kind === kind);
    const blocks = existing ? current.blocks.map((block) => block === existing ? { ...block, text: block.text + delta } : block)
      : [...current.blocks, { contentIndex, kind, text: delta }].sort((a, b) => a.contentIndex - b.contentIndex);
    const fitted = fitBlocks(blocks);
    for (const source of blocks) {
      if (fitted.blocks.find((block) => block.contentIndex === source.contentIndex)?.text !== source.text)
        this.clipped.add(source.contentIndex);
    }
    this.change({ ...this.latest, current: { ...current, blocks: fitted.blocks, displayTruncated: current.displayTruncated || fitted.truncated } });
  }

  private change(next: LiveSnapshot): void {
    if (this.disposed || JSON.stringify(next) === JSON.stringify(this.latest)) return;
    this.latest = { ...next, revision: this.latest.revision + 1 };
    // No block object is ever mutated after it becomes part of latest/inflight.
    if (this.coalesce === undefined) this.coalesce = setTimeout(() => { this.coalesce = undefined; this.sendLatest(); }, 250);
  }

  private sendLatest(): void {
    if (this.disposed) return;
    if (this.inflight) { this.pending = true; return; }
    const controller = new AbortController();
    this.inflight = controller;
    this.pending = false;
    const snapshot = this.latest;
    void Promise.resolve().then(() => this.backend.liveOutput(snapshot.taskId, snapshot, controller.signal))
      .catch(() => {}) // Display failure cannot change execution, context ACK or terminal.
      .finally(() => {
        this.inflight = undefined;
        if (this.pending && !this.disposed) this.sendLatest();
        else if (this.finishing) this.dispose();
      });
  }
}

/** Separate escaped-JSON budgets reserve well over 32 KiB for answer text. */
function fitBlocks(source: LiveBlock[]): { blocks: LiveBlock[]; truncated: boolean } {
  const remaining = { ...KIND_BYTES };
  const blocks: LiveBlock[] = [];
  let truncated = false;
  for (const block of source) {
    const budget = remaining[block.kind];
    const bytes = (text: string) => Buffer.byteLength(JSON.stringify({ ...block, text }), "utf8") + 1;
    if (bytes("") > budget) { truncated = true; continue; }
    let text = block.text;
    if (bytes(text) > budget) {
      let low = 0; let high = text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes(text.slice(0, middle)) <= budget) low = middle; else high = middle - 1;
      }
      if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1]!) && /[\uDC00-\uDFFF]/u.test(text[low] ?? "")) low--;
      text = text.slice(0, low);
      truncated = true;
    }
    remaining[block.kind] -= bytes(text);
    blocks.push({ ...block, text });
  }
  return { blocks, truncated };
}
