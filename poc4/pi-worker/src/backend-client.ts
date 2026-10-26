/**
 * The worker's client for the backend's internal task routes. Transport contract:
 * a tool submission whose POST response is lost is followed by a GET of the ORIGINAL
 * call (same toolCallId — the request id is the dedup identity and the backend's
 * durable ledger is the only authority), and a progress submission repeats the SAME
 * seq with a byte-identical payload until the backend answers. The client never
 * invents a replacement request or a replacement sequence number. A call that is
 * registered but still executing (RUNNING — a build may legitimately run for minutes)
 * is awaited with a BOUNDED poll of the same GET; "executing" is never misread as
 * "unregistered", and a budget exhaustion fails closed instead of guessing.
 */

import { isDeepStrictEqual } from "node:util";
import { LIVE_OUTPUT_MAX_BYTES, type LiveSnapshot } from "./live-output.js";
import { CONTEXT_PAGE_BYTES, type ContextPage, type ContextAppend, type CompactStart, type CompactResult } from "./conversation-context.js";
import type { TerminalAck } from "./report-identity.js";

export interface ToolRequest {
  toolCallId: string;
  name: string;
  expectedRevision: number;
  args: unknown;
}

export interface ToolResult {
  toolCallId: string;
  workspaceRevision: string;
  data: unknown;
  truncated: boolean;
}

/** The reconciliation answer for one call: executing/undecided (no result) or settled. */
export interface ToolCallStatus {
  state: "RUNNING" | "NEEDS_ATTENTION" | "COMPLETED";
  result: ToolResult | null;
}

export interface ProgressItem {
  seq: number;
  kind: string;
  text: string;
  truncated: boolean;
}

export interface ProgressAck {
  accepted: boolean;
  expectedSeq?: number;
  mismatch?: boolean;
}

export interface BackendClientOptions {
  baseUrl: string;
  token: string;
  instanceId: string;
  epoch: string | number;
  fetch?: typeof fetch;
  /** Overrides the inter-poll wait (tests run the bounded poll synchronously). */
  delay?: (ms: number) => Promise<void>;
  /** Overrides the wall clock the settle budget is measured against (tests). */
  now?: () => number;
}

export class BackendHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expectedSeq?: number;

  constructor(status: number, code: string, message: string, expectedSeq?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.expectedSeq = expectedSeq;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_TOOL_DIAGNOSTIC_CODES = new Set([
  "PROJECT_BUSY", "AI_CALL_UNSETTLED", "AI_CALL_NEEDS_ATTENTION", "AI_TASK_NOT_ACTIVE",
  "AI_CALL_MISMATCH", "AI_CALL_RUNNING", "WORKSPACE_REVISION_CONFLICT", "VALIDATION_ERROR",
]);
/** Concrete codes safe to carry in progress diagnostics; anything else stays generic. */
const SAFE_PROGRESS_DIAGNOSTIC_CODES = new Set([
  "PROJECT_BUSY", "AI_PROGRESS_GAP", "AI_PROGRESS_MISMATCH", "AI_PROGRESS_TOO_LARGE",
  "AI_TERMINAL_IDENTITY", "AI_TERMINAL_TOO_LARGE", "AI_TASK_NOT_FOUND", "AI_TASK_NOT_ACTIVE",
  "AI_EPOCH_MISMATCH", "AI_INSTANCE_MISMATCH", "VALIDATION_ERROR",
]);
/** Concrete codes safe to carry in terminal diagnostics (the delivery classifies by status). */
const SAFE_TERMINAL_DIAGNOSTIC_CODES = new Set([
  "PROJECT_BUSY", "AI_TERMINAL_IDENTITY", "AI_TERMINAL_TOO_LARGE", "AI_PROGRESS_TOO_LARGE",
  "AI_TASK_NOT_FOUND", "AI_TERMINAL_NOT_FOUND", "AI_EPOCH_MISMATCH", "AI_INSTANCE_MISMATCH",
  "AI_TASK_NOT_ACTIVE", "VALIDATION_ERROR",
]);

function safeToolDiagnosticCode(code: unknown): string {
  return typeof code === "string" && SAFE_TOOL_DIAGNOSTIC_CODES.has(code) ? code : "AI_CALL_REJECTED";
}

function safeProgressDiagnosticCode(code: unknown): string {
  return typeof code === "string" && SAFE_PROGRESS_DIAGNOSTIC_CODES.has(code) ? code : "AI_PROGRESS_REJECTED";
}

function safeTerminalDiagnosticCode(code: unknown): string {
  return typeof code === "string" && SAFE_TERMINAL_DIAGNOSTIC_CODES.has(code) ? code : "AI_TERMINAL_REJECTED";
}

function isTerminalAck(body: Record<string, unknown> | null): boolean {
  return body !== null && typeof body["reportId"] === "string" && typeof body["reportSha256"] === "string"
    && ["RECORDED", "SETTLED", "CLOSING"].includes(body["disposition"] as string);
}

/** The inter-poll wait of the bounded settle poll (matches the browser's 2s cadence). */
const SETTLE_POLL_INTERVAL_MS = 2_000;
/**
 * The bounded wait for an already-registered call to settle: the build deadline is
 * 600s and its finish path adds up to 120s, so one bound covers every legitimate
 * server-side execution (spec section 5).
 */
export const SETTLE_BUDGET_MS = 720_000;
/** The UTF-8 byte bound of one progress item's text (spec section 3; enforced backend-side). */
export const PROGRESS_TEXT_MAX_BYTES = 8 * 1024;

export interface InvokeOptions {
  /** Overrides the bounded wait for an already-registered call to settle. */
  settleBudgetMs?: number;
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly instanceId: string;
  private readonly epoch: string;
  private readonly transport: typeof fetch;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.instanceId = options.instanceId;
    this.epoch = String(options.epoch);
    this.transport = options.fetch ?? fetch;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Submits one tool invocation and returns its durable result. When the POST response
   * is lost or admission is busy the original call is queried by GET. Only a404
   * permits an identical replay; a RUNNING answer means the call IS registered and executing and
   * is awaited with a bounded poll of the same GET, and NEEDS_ATTENTION fails the call
   * closed — the outcome is unknown, so the next side effect must never start. Anything
   * still unresolved throws.
   */
  async invoke(taskId: string, request: ToolRequest, options: InvokeOptions = {}): Promise<ToolResult> {
    const path = `/internal/ai/tasks/${encodeURIComponent(taskId)}/calls/${encodeURIComponent(request.toolCallId)}`;
    const body = JSON.stringify(request);
    const post = (timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> => this.transport(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const settleBudgetMs = options.settleBudgetMs ?? SETTLE_BUDGET_MS;
    const isBusy = (error: unknown): error is BackendHttpError => error instanceof BackendHttpError
      && error.status === 409 && error.code === "PROJECT_BUSY";
    let admissionDeadline: number | null = null;
    let submissionUnknown = false;
    const noteBusy = () => { admissionDeadline ??= this.now() + Math.min(10_000, settleBudgetMs); };
    try {
      return await this.parseResult(await post());
    } catch (postFailure) {
      if (isBusy(postFailure)) noteBusy();
      else if (postFailure instanceof BackendHttpError) throw postFailure;
      else submissionUnknown = true;
    }
    let deadline = this.now() + settleBudgetMs;
    let registered = false;
    let replayed = false;
    for (;;) {
      const currentDeadline = registered || submissionUnknown ? deadline : admissionDeadline ?? deadline;
      if (this.now() >= currentDeadline) {
        const definitelyBusy = admissionDeadline !== null && !registered && !submissionUnknown;
        throw new BackendHttpError(definitelyBusy ? 409 : 0,
          definitelyBusy ? "PROJECT_BUSY" : "AI_CALL_UNKNOWN",
          definitelyBusy ? "tool call admission remained busy (409, PROJECT_BUSY)"
            : "the tool call did not settle within the bounded wait; the next side effect must not start");
      }
      try {
        const query = await this.transport(`${this.baseUrl}${path}`, {
          method: "GET", headers: this.headers(),
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, currentDeadline - this.now())),
        });
        if (query.status === 404) {
          if (registered || (replayed && admissionDeadline === null)) {
            throw new BackendHttpError(0, "AI_CALL_UNKNOWN", "the original tool call is absent after reconciliation");
          }
          if (this.now() >= (admissionDeadline ?? deadline)) {
            throw new BackendHttpError(0, "AI_CALL_UNKNOWN", "the original call is absent after admission expired; no further execution was submitted");
          }
          submissionUnknown = false;
          replayed = true;
          // Only a fresh ledger404 permits the SAME request; any lost reply returns to GET.
          try { return await this.parseResult(await post(Math.min(REQUEST_TIMEOUT_MS, (admissionDeadline ?? deadline) - this.now()))); }
          catch (error) {
            if (isBusy(error)) noteBusy();
            else if (error instanceof BackendHttpError) throw error;
            else submissionUnknown = true;
          }
        } else {
          const status = await this.parseStatus(query);
          if (!registered) { registered = true; deadline = this.now() + settleBudgetMs; }
          if (status.state === "COMPLETED" && status.result !== null) return status.result;
          if (status.state === "NEEDS_ATTENTION") {
            throw new BackendHttpError(0, "AI_CALL_NEEDS_ATTENTION", "the call outcome is unknown; it needs attention before further writes");
          }
        }
      } catch (error) {
        if (isBusy(error)) { if (!registered) noteBusy(); }
        else if (error instanceof BackendHttpError) throw error;
      }
      const remaining = (registered || submissionUnknown ? deadline : admissionDeadline ?? deadline) - this.now();
      if (remaining > 0) await this.delay(Math.min(SETTLE_POLL_INTERVAL_MS, remaining));
    }
  }

  /**
   * Submits one progress item. The backend answers 200 when the item was appended
   * (or was an idempotent replay), 409 with the expected seq on a gap, and 409 on a
   * same-seq different-payload conflict. Every outcome is returned to the caller —
   * progress failures never abort the task by themselves.
   */
  async progress(taskId: string, item: ProgressItem): Promise<ProgressAck> {
    const response = await this.transport(
      `${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/progress`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(item),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    if (response.status === 200) {
      return { accepted: true };
    }
    const body = await safeJson(response);
    if (response.status === 409 && body !== null) {
      const code = typeof body.code === "string" ? body.code : "";
      if (code === "AI_PROGRESS_GAP" && typeof body.expectedSeq === "number") {
        return { accepted: false, expectedSeq: body.expectedSeq };
      }
      if (code === "AI_PROGRESS_MISMATCH") {
        return { accepted: false, mismatch: true };
      }
    }
    // The concrete backend code is preserved (safe list) so callers can distinguish a
    // contended gate from a decided refusal instead of a generic rejection.
    const code = safeProgressDiagnosticCode(body?.code);
    throw new BackendHttpError(response.status, code, `progress submission was refused (${response.status}, ${code})`);
  }

  /**
   * One terminal report POST on the dedicated receipt route. The caller (the terminal
   * delivery) owns the per-request timeout through the signal and retries the SAME
   * bytes; this method only carries the report and surfaces the decided refusal with
   * its safe concrete code. A 404 is preserved as a 404 — never collapsed into a
   * generic transport failure — so the delivery can distinguish "no receipt stored"
   * from an unreachable backend.
   */
  async postTerminal(taskId: string, body: string, signal?: AbortSignal): Promise<TerminalAck> {
    const response = await this.transport(`${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/terminal`, {
      method: "POST",
      headers: this.headers(),
      body,
      signal,
    });
    const parsed = await safeJson(response);
    if (response.ok && isTerminalAck(parsed)) {
      return parsed as unknown as TerminalAck;
    }
    const code = safeTerminalDiagnosticCode(parsed?.code);
    throw new BackendHttpError(response.status, code, `terminal report was refused (${response.status}, ${code})`);
  }

  /**
   * The read-only pull of the stored terminal decision (worker-side compensation): the
   * stored TerminalAck, or a 404 kept as AI_TERMINAL_NOT_FOUND when no receipt exists
   * yet. This route only reads; it never starts a side effect.
   */
  async getTerminalAck(taskId: string): Promise<TerminalAck> {
    const response = await this.transport(`${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/terminal`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await safeJson(response);
    if (response.ok && isTerminalAck(parsed)) {
      return parsed as unknown as TerminalAck;
    }
    const code = safeTerminalDiagnosticCode(parsed?.code);
    throw new BackendHttpError(response.status, code, `terminal decision was refused (${response.status}, ${code})`);
  }

  async liveOutput(taskId: string, snapshot: LiveSnapshot, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({ revision: snapshot.revision, taskId: snapshot.taskId, conversationId: snapshot.conversationId,
      durableHeadSeq: snapshot.durableHeadSeq, current: snapshot.current === null ? null : {
        messageOrdinal: snapshot.current.messageOrdinal, phase: snapshot.current.phase,
        blocks: snapshot.current.blocks.map(({ contentIndex, kind, text }) => ({ contentIndex, kind, text })),
        modelTruncated: snapshot.current.modelTruncated, displayTruncated: snapshot.current.displayTruncated,
      }, unavailable: snapshot.unavailable });
    if (Buffer.byteLength(body, "utf8") > LIVE_OUTPUT_MAX_BYTES) throw new Error("live output exceeds its byte limit");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", cancel, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("live output cancelled")); });
    controller.signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => controller.abort(), 2000);
    try {
      if (controller.signal.aborted) throw new Error("live output cancelled");
      const response = await Promise.race([this.transport(`${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/live-output`, {
        method: "POST", headers: this.headers(), body, signal: controller.signal,
      }), cancelled]);
      if (response.status !== 204) throw new BackendHttpError(response.status, "AI_LIVE_OUTPUT_REJECTED", "live output was refused");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abort);
    }
  }

  async readContext(taskId: string, afterSeq = 0, throughSeq?: number): Promise<ContextPage> {
    const query = new URLSearchParams({ afterSeq: String(afterSeq) });
    if (throughSeq !== undefined) query.set("throughSeq", String(throughSeq));
    const response = await this.transport(`${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/context?${query}`, {
      method: "GET", headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await this.contextJson(response);
    return body as unknown as ContextPage;
  }

  async readCompactionContext(start: CompactStart, afterSeq = 0, throughSeq?: number): Promise<ContextPage> {
    const query = new URLSearchParams({ expectedHeadSeq: String(start.expectedHeadSeq), afterSeq: String(afterSeq) });
    if (throughSeq !== undefined) query.set("throughSeq", String(throughSeq));
    return await this.contextJson(await this.transport(`${this.baseUrl}/internal/ai/conversations/${start.conversationId}/compactions/${start.requestId}/context?${query}`, {
      method: "GET", headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })) as unknown as ContextPage;
  }

  async finishCompaction(start: CompactStart, result: CompactResult): Promise<void> {
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body, "utf8") > CONTEXT_PAGE_BYTES) throw new BackendHttpError(0, "AI_CONTEXT_UNAVAILABLE", "compaction result is too large");
    const ack = await this.contextJson(await this.transport(`${this.baseUrl}/internal/ai/conversations/${start.conversationId}/compactions/${start.requestId}/result`, {
      method: "POST", headers: this.headers(), body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    if (ack.headSeq !== start.expectedHeadSeq + result.entries.length) throw new BackendHttpError(0, "AI_CONTEXT_UNAVAILABLE", "compaction ACK did not match its result");
  }

  async appendContext(taskId: string, append: ContextAppend): Promise<{ headSeq: number }> {
    const body = JSON.stringify(append);
    const wire = JSON.parse(body) as ContextAppend;
    const post = async () => this.contextJson(await this.transport(`${this.baseUrl}/internal/ai/tasks/${encodeURIComponent(taskId)}/context`, {
      method: "POST", headers: this.headers(), body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    try { return await post() as unknown as { headSeq: number }; }
    catch (error) {
      if (error instanceof BackendHttpError) throw error;
      // A lost POST response never permits a new identity: inspect the original suffix.
      let page = await this.readContext(taskId, append.expectedHeadSeq);
      if (!isDeepStrictEqual(page.header, wire.header)) throw new BackendHttpError(409, "AI_CONTEXT_CONFLICT", "conversation header changed");
      if (page.headSeq === append.expectedHeadSeq && page.entries.length === 0) {
        return await post() as unknown as { headSeq: number };
      }
      const expected = append.expectedHeadSeq + append.entries.length;
      const rows = [...page.entries];
      while (page.nextAfterSeq !== null && rows.length < append.entries.length) {
        const after = append.expectedHeadSeq + rows.length;
        if (page.headSeq !== expected || page.nextAfterSeq !== after || page.entries.length === 0) break;
        page = await this.readContext(taskId, after, expected);
        if (!isDeepStrictEqual(page.header, wire.header)) break;
        rows.push(...page.entries);
      }
      if (page.headSeq !== expected || page.nextAfterSeq !== null
        || !isDeepStrictEqual(rows.map((row) => row.entry), wire.entries)
        || rows.some((row, index) => row.seq !== append.expectedHeadSeq + index + 1 || row.writerId !== taskId)) {
        throw new BackendHttpError(409, "AI_CONTEXT_CONFLICT", "conversation suffix changed");
      }
      return { headSeq: page.headSeq };
    }
  }

  private async contextJson(response: Response): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > CONTEXT_PAGE_BYTES) throw new BackendHttpError(0, "AI_CONTEXT_UNAVAILABLE", "context response exceeds its byte limit");
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("unreadable context response"); }
    if (!response.ok) throw new BackendHttpError(response.status, "AI_CONTEXT_UNAVAILABLE", "context request was refused");
    return body;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-manao-worker-token": this.token,
      "x-manao-worker-instance": this.instanceId,
      "x-manao-worker-epoch": this.epoch,
    };
  }

  /** Parses a POST answer: the settled ToolResult, or a decided backend refusal. */
  private async parseResult(response: Response): Promise<ToolResult> {
    const body = await safeJson(response);
    if (!response.ok || body === null || typeof body.toolCallId !== "string") {
      throw new BackendHttpError(response.status,
        typeof body?.code === "string" ? body.code : "AI_CALL_REJECTED",
        `tool call was refused (${response.status}, ${safeToolDiagnosticCode(body?.code)})`);
    }
    return body as unknown as ToolResult;
  }

  /** Parses a reconciliation GET answer into its three-state contract. */
  private async parseStatus(response: Response): Promise<ToolCallStatus> {
    const body = await safeJson(response);
    if (!response.ok || body === null) {
      throw new BackendHttpError(response.status,
        typeof body?.code === "string" ? body.code : "AI_CALL_REJECTED",
        `tool call reconciliation was refused (${response.status}, ${safeToolDiagnosticCode(body?.code)})`);
    }
    if (typeof body.toolCallId === "string") {
      // A legacy settled answer carried the bare result: still a settlement.
      return { state: "COMPLETED", result: body as unknown as ToolResult };
    }
    const state = body.state;
    if (state === "RUNNING" || state === "NEEDS_ATTENTION") {
      return { state, result: null };
    }
    if (state === "COMPLETED" && body.result !== null && typeof body.result === "object") {
      return { state: "COMPLETED", result: body.result as ToolResult };
    }
    throw new BackendHttpError(response.status, "AI_CALL_REJECTED",
      `tool call reconciliation carried an unreadable state (${response.status})`);
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Shrinks a terminal summary until the COMPLETE serialized terminal payload fits the
 * 8 KiB UTF-8 text bound (review fix I8). The cut works on the real serialized bytes,
 * so every quoting, escaping (newlines, quotes, backslashes) and multi-byte effect is
 * already accounted for; the cut never splits a multi-byte character, never ends
 * inside a surrogate pair (an explicit code-point back-off — review round 2 — so a
 * boundary emoji can never be corrupted into a lone surrogate) and always keeps a
 * true prefix of the summary.
 */
export function fitSummary(summary: string, state: "COMPLETED" | "FAILED", failureCode: string | null): string {
  const serializedBytes = (candidate: string): number =>
    Buffer.byteLength(JSON.stringify({ state, summary: candidate, failureCode }), "utf-8");
  if (serializedBytes(summary) <= PROGRESS_TEXT_MAX_BYTES) {
    return summary;
  }
  let cut = summary.length;
  while (cut > 0 && serializedBytes(summary.slice(0, cut)) > PROGRESS_TEXT_MAX_BYTES) {
    // Binary retreat: halving converges fast and the final verification below
    // guarantees the emitted payload really fits.
    cut = Math.floor(cut / 2);
  }
  while (cut < summary.length
      && serializedBytes(summary.slice(0, cut + 1)) <= PROGRESS_TEXT_MAX_BYTES) {
    cut += 1;
  }
  // Explicit surrogate safety: a cut whose last unit is a high surrogate whose low
  // pair member follows would emit a lone surrogate (serialized as an escape that
  // corrupts the emoji). Back the cut off to the complete code-point boundary.
  while (cut > 0 && cut < summary.length
      && isHighSurrogate(summary.charCodeAt(cut - 1))
      && isLowSurrogate(summary.charCodeAt(cut))) {
    cut -= 1;
  }
  return summary.slice(0, cut);
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The bounded wait before a progress item's identical retry (design section 5). */
export const PROGRESS_RETRY_DELAY_MS = 250;

/**
 * Serialized, at-most-one-HTTP-call-at-a-time progress delivery. SDK listeners are
 * never awaited by the agent loop, so every item goes through this promise chain;
 * the terminal state is only sent after the chain has drained. A lost response is
 * retried with the same seq and identical payload after a bounded delay; a gap answer
 * from the backend re-sends the buffered items starting at the expected seq; a mismatch
 * answer is dropped (the backend kept its authoritative copy) and never re-sent.
 */
export class ProgressChain {
  private readonly client: BackendClient;
  private readonly taskId: string;
  private readonly buffer: ProgressItem[] = [];
  private readonly retryDelay: (ms: number) => Promise<void>;
  private nextSeq = 1;
  private queue: Promise<void> = Promise.resolve();
  private lastError: unknown = null;

  constructor(client: BackendClient, taskId: string, retryDelay?: (ms: number) => Promise<void>) {
    this.client = client;
    this.taskId = taskId;
    this.retryDelay = retryDelay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Enqueues one item; never throws, never blocks the caller. */
  send(kind: string, text: string, truncated = false): void {
    const item: ProgressItem = { seq: this.nextSeq++, kind, text, truncated };
    this.buffer.push(item);
    // The resend buffer matches the backend's 100-item retained window (the protocol
    // bound the progress envelope enforces), so every gap answer can be replayed.
    if (this.buffer.length > 100) {
      this.buffer.shift();
    }
    this.queue = this.queue.then(() => this.deliver(item)).then(() => undefined);
  }

  /** Waits until every enqueued item has been delivered. */
  async drain(): Promise<void> {
    const pending = this.queue;
    await pending;
  }

  /**
   * Drains the chain, then submits the terminal state and waits for its answer:
   * the terminal item is never overtaken by an earlier progress item. The summary
   * is shrunk against the WHOLE serialized payload (review fix I8): the backend
   * bounds the item TEXT in UTF-8 bytes, and the JSON wrapper, quotes and escapes
   * all count — so a summary that only overflows after serialization is cut here
   * instead of being rejected backend-side (which would leave the task occupied).
   *
   * A terminal the backend never acknowledged REJECTS (repair task 2): a refused,
   * lost OR MISMATCHED delivery must never resolve as if it had been acknowledged —
   * a same-seq different-payload answer means the backend kept ANOTHER payload, so
   * this content was never accepted (repair round 1, I-1: resolving here let the
   * legacy fallback report a false ACK). The settlement layer (task 4) owns the
   * retry loop and the unconfirmed state; the mismatch surfaces as the decided 409
   * the delivery classifies as permanent.
   */
  async sendTerminal(state: "COMPLETED" | "FAILED", summary: string, failureCode: string | null): Promise<void> {
    await this.drain();
    const payload = JSON.stringify({ state, summary: fitSummary(summary, state, failureCode), failureCode });
    const item: ProgressItem = { seq: this.nextSeq++, kind: "terminal", text: payload, truncated: false };
    this.buffer.push(item);
    const outcome = await this.deliver(item);
    if (outcome === "dropped") {
      // The backend kept a different payload at this seq: not our content, never a
      // delivery — resending would only repeat the conflict.
      throw new BackendHttpError(409, "AI_PROGRESS_MISMATCH",
        "terminal delivery was not acknowledged: the backend kept a different payload at this seq");
    }
    if (outcome === "failed") {
      throw this.lastError instanceof BackendHttpError
        ? this.lastError
        : new BackendHttpError(0, "AI_PROGRESS_REJECTED", "terminal delivery was not acknowledged");
    }
  }

  /** The first delivery error, for diagnostics at settlement time. */
  error(): unknown {
    return this.lastError;
  }

  /**
   * Delivers one item with the identical-retry contract and reports what happened:
   * accepted (the backend appended it), dropped (a same-seq different-payload replay —
   * the backend kept its authoritative copy) or failed (nothing acknowledged). Progress
   * items never abort the chain on failure; the TERMINAL caller inspects the outcome.
   */
  private async deliver(item: ProgressItem): Promise<"accepted" | "dropped" | "failed"> {
    try {
      const ack = await this.client.progress(this.taskId, item);
      if (ack.accepted) {
        return "accepted";
      }
      if (ack.expectedSeq !== undefined && ack.expectedSeq <= item.seq) {
        // The backend has not durably reached this item yet: replay the buffered
        // range from the seq it expects (an equality gap means the very first item
        // never landed), then retry THIS item with its identical payload.
        for (const pending of this.buffer) {
          if (pending.seq >= ack.expectedSeq && pending.seq < item.seq) {
            await this.client.progress(this.taskId, pending);
          }
        }
        const retry = await this.client.progress(this.taskId, item);
        if (retry.accepted) {
          return "accepted";
        }
        if (retry.mismatch) {
          return "dropped";
        }
        throw new BackendHttpError(0, "AI_PROGRESS_REJECTED", "progress gap replay did not settle");
      }
      if (ack.mismatch) {
        // Same seq, different payload: the backend's copy wins and this item is
        // dropped — resending would only repeat the conflict.
        return "dropped";
      }
    } catch (error) {
      this.lastError = error;
      // One bounded identical retry (same seq, same payload — idempotent on the
      // backend) after the bounded delay; the retry never invents a new identity.
      await this.retryDelay(PROGRESS_RETRY_DELAY_MS);
      try {
        const retry = await this.client.progress(this.taskId, item);
        if (retry.accepted) {
          return "accepted";
        }
        if (retry.mismatch) {
          return "dropped";
        }
      } catch (retryError) {
        this.lastError = retryError;
      }
      // Delivery stays failed but the chain continues: progress loss must never
      // wedge the task; the terminal state below is sent through the same chain.
    }
    return "failed";
  }
}
