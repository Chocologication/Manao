/**
 * The worker's independent terminal delivery (repair design 2026-10-25, section 5):
 * ONE unique report per task, delivered separately from model execution and from the
 * display progress chain. The frozen execution outcome is published here and only the
 * backend's durable TerminalAck confirms — a push the backend never acknowledged is
 * never reported as delivered (the false-ACK incident of the diagnosed failure).
 *
 * Protocol: POST /internal/ai/tasks/{taskId}/terminal with byte-identical body on every
 * attempt (same reportId, same JSON bytes). Only an ack whose reportId AND canonical
 * content digest match THIS report confirms: RECORDED/SETTLED -> ACKED, CLOSING ->
 * CLOSING. A 200 with a different identity/content never confirms and never re-pushes.
 *
 * Transient failures (transport errors, 408, 429, 5xx, PROJECT_BUSY) retry on the
 * bounded schedule 250ms -> 500ms -> 1s -> 2s -> 4s -> 5s cap plus <=20% jitter, one
 * in-flight request at a time, each single request aborted at 10s.
 *
 * Permanent failures (401/403; the identity/epoch/instance conflicts and every other
 * 409 except PROJECT_BUSY; 422) stop the automatic push and keep the state REJECTED —
 * unconfirmed. 422 covers AI_TERMINAL_TOO_LARGE and its legacy-route equivalent
 * AI_PROGRESS_TOO_LARGE: the two codes mean the same 8 KiB bound on the whole
 * serialized terminal payload, and the manager fits the report before publishing so
 * neither code is reachable in normal operation. A 404 that names the task
 * (AI_TASK_NOT_FOUND) is permanent too; a 404 WITHOUT a backend code means the endpoint
 * is absent (an old backend) and switches the delivery to the legacy /progress
 * kind=terminal path, whose 200 answers the committed receipt entry.
 *
 * After a permanent refusal the manager switches to the read-only GET
 * /internal/ai/tasks/{taskId}/terminal pull at the <=30s cadence: only an ack matching
 * this report's identity (reportId + digest) releases the task slot. A 404 kept as
 * NOT_FOUND (never collapsed into a generic transport error) means no receipt exists
 * yet and never unlocks by itself; transport errors and 401/403 on the pull likewise
 * never confirm.
 *
 * The delivery is in-memory by design: no disk outbox. A worker restart before the ACK
 * loses the report; the backend then fails safe (budget close / operator decision) —
 * this degradation is explicit in the design and is not repaired here. Diagnostics
 * carry only taskId/reportId/epoch/kind/status/code/attempt/elapsed/nextRetryAt —
 * never tokens, prompts, or model request/response bodies.
 */
import { BackendHttpError } from "./backend-client.js";
import { terminalContentSha256, type TerminalAck, type TerminalReport } from "./report-identity.js";

export type DeliveryState = "PENDING" | "ACKED" | "CLOSING" | "REJECTED";

/** Bounded transient retry schedule; the last entry is the cap (design section 5). */
export const TERMINAL_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 5_000] as const;
/** A single in-flight request never outlives this bound. */
export const TERMINAL_REQUEST_TIMEOUT_MS = 10_000;
/** The pull-compaction cadence after a permanent push refusal: at most every 30s. */
export const TERMINAL_PULL_INTERVAL_MS = 30_000;
/** Confirmed delivery records are retained by count and age; either bound may evict. */
export const CONFIRMED_RECORD_LIMIT = 100;
export const CONFIRMED_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The whole serialized terminal report is bounded at 8 KiB including escaping (design contract 4). */
export const TERMINAL_REPORT_MAX_BYTES = 8 * 1024;

export interface TerminalDeliverySnapshot {
  report: TerminalReport | null;
  state: DeliveryState;
}

/** The two terminal routes the delivery drives; BackendClient implements this shape. */
export interface TerminalBackend {
  postTerminal(taskId: string, body: string, signal: AbortSignal): Promise<TerminalAck>;
  getTerminalAck(taskId: string): Promise<TerminalAck>;
}

export interface TerminalDiagnostic {
  kind: "terminal-push" | "terminal-pull" | "terminal-legacy" | "terminal-ack-mismatch"
    | "terminal-publish-conflict" | "terminal-confirmed" | "terminal-loop-error";
  taskId: string;
  reportId: string | null;
  epoch: number;
  status: number | null;
  code: string | null;
  attempt: number;
  elapsed: number;
  nextRetryAt: number | null;
}

export interface TerminalDeliveryOptions {
  client: TerminalBackend;
  taskId: string;
  epoch: number;
  /** Legacy /progress kind=terminal fallback (route absent on an old backend). */
  legacyTerminal?: (report: TerminalReport) => Promise<void>;
  /** Deterministic jitter addend (tests); production defaults to <=20% of the base. */
  jitterMs?: () => number;
  now?: () => number;
  requestTimeoutMs?: number;
  pullIntervalMs?: number;
  onConfirmed?: (state: DeliveryState) => void;
  onDiagnostic?: (diagnostic: TerminalDiagnostic) => void;
}

type ErrorVerdict = "transient" | "permanent" | "legacy-route";

export class TerminalDelivery {
  private options: TerminalDeliveryOptions;
  private report: TerminalReport | null = null;
  private body: string | null = null;
  private contentSha256: string | null = null;
  private state: DeliveryState = "PENDING";
  private disposed = false;
  private attempt = 0;
  private transientFailures = 0;
  private publishedAt = 0;
  private useLegacy = false;
  private mismatchLogged = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeup: (() => void) | null = null;
  private inflight: AbortController | null = null;

  constructor(options: TerminalDeliveryOptions) {
    this.options = options;
  }

  /**
   * Publishes THE one report of this task. The first publish wins: a different report
   * is refused with a safe diagnostic (one execution must never grow a second
   * identity), the same report is an idempotent no-op. The body bytes and the canonical
   * content digest are computed once here and reused on every attempt.
   */
  publish(report: TerminalReport): void {
    if (this.disposed) return;
    if (this.report !== null) {
      if (sameReport(this.report, report)) return;
      this.diagnostic("terminal-publish-conflict", { status: null, code: null });
      return;
    }
    const fitted = fitTerminalReport(report);
    this.report = fitted;
    this.body = JSON.stringify(fitted);
    this.contentSha256 = terminalContentSha256(fitted.reportId, fitted.state, fitted.summary, fitted.failureCode);
    this.publishedAt = (this.options.now ?? Date.now)();
    void this.pushLoop().catch(() => this.diagnostic("terminal-loop-error", { status: null, code: null }));
  }

  snapshot(): TerminalDeliverySnapshot {
    return { report: this.report, state: this.state };
  }

  /** Clears every timer, aborts the in-flight request and stops all loops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.inflightTimer !== null) {
      clearTimeout(this.inflightTimer);
      this.inflightTimer = null;
    }
    this.wakeup?.();
    this.wakeup = null;
    this.inflight?.abort();
  }

  /** The push loop: one in-flight request, bounded identical retries, then pull. */
  private async pushLoop(): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      if (this.state === "ACKED" || this.state === "CLOSING") return;
      if (this.state === "REJECTED") return await this.pullLoop();
      try {
        if (this.useLegacy) {
          this.attempt += 1;
          await this.options.legacyTerminal!(this.report!);
          // The legacy receipt entry committed (backend contract for a 200): the same
          // report identity the new endpoint derives backend-side.
          this.confirm("ACKED", "terminal-legacy", { status: 200, code: null });
          return;
        }
        const ack = await this.postAttempt();
        if (this.matches(ack)) {
          this.confirm(ack.disposition === "CLOSING" ? "CLOSING" : "ACKED", "terminal-push", { status: 200, code: ack.disposition });
          return;
        }
        // A 200 whose identity does not match this report is NOT a delivery: unconfirmed,
        // the read-only pull decides (never claim the content was acknowledged).
        this.reject("terminal-ack-mismatch", { status: 200, code: null });
      } catch (error) {
        const verdict = classifyTerminalError(error, this.useLegacy);
        const fields = { status: httpStatus(error), code: httpCode(error) };
        if (verdict === "permanent") {
          this.reject(diagnosticKind(error, this.useLegacy), fields);
        } else if (verdict === "legacy-route") {
          if (this.options.legacyTerminal !== undefined) {
            this.useLegacy = true;
          } else {
            // Without a wired legacy fallback there is no delivery path at all:
            // unconfirmed, the pull keeps asking.
            this.reject(diagnosticKind(error, this.useLegacy), fields);
          }
        } else {
          this.transientFailures += 1;
          const delay = this.backoffDelay();
          this.diagnostic(diagnosticKind(error, this.useLegacy), { ...fields, nextRetryAt: this.now() + delay });
          if (!(await this.sleep(delay))) return;
        }
      }
    }
  }

  /** The pull loop after a permanent refusal: read-only, identity-matched, <=30s cadence. */
  private async pullLoop(): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      try {
        this.attempt += 1;
        const ack = await this.withRequestTimeout((_signal) => this.options.client.getTerminalAck(this.options.taskId));
        if (this.matches(ack)) {
          this.confirm(ack.disposition === "CLOSING" ? "CLOSING" : "ACKED", "terminal-pull", { status: 200, code: ack.disposition });
          return;
        }
        if (!this.mismatchLogged) {
          this.mismatchLogged = true;
          this.diagnostic("terminal-ack-mismatch", { status: 200, code: null });
        }
      } catch {
        // A 404 (NOT_FOUND) means no receipt exists yet and never unlocks by itself;
        // transport errors and 401/403 likewise never confirm (design section 4).
      }
      if (!(await this.sleep(this.options.pullIntervalMs ?? TERMINAL_PULL_INTERVAL_MS))) return;
    }
  }

  private async postAttempt(): Promise<TerminalAck> {
    this.attempt += 1;
    const body = this.body!;
    return await this.withRequestTimeout((signal) => this.options.client.postTerminal(this.options.taskId, body, signal));
  }

  private matches(ack: TerminalAck): boolean {
    return this.report !== null && this.contentSha256 !== null
      && ack.reportId === this.report.reportId
      && ack.reportSha256 === this.contentSha256
      && (ack.disposition === "RECORDED" || ack.disposition === "SETTLED" || ack.disposition === "CLOSING");
  }

  private confirm(state: DeliveryState, kind: TerminalDiagnostic["kind"], fields: { status: number | null; code: string | null }): void {
    if (this.disposed || (this.state !== "PENDING" && this.state !== "REJECTED")) return;
    this.state = state;
    this.diagnostic("terminal-confirmed", fields);
    this.options.onConfirmed?.(state);
  }

  private reject(kind: TerminalDiagnostic["kind"], fields: { status: number | null; code: string | null }): void {
    if (this.disposed) return;
    this.state = "REJECTED"; // unconfirmed: never reported as delivered, slot stays held
    this.diagnostic(kind, fields);
  }

  private backoffDelay(): number {
    // The schedule indexes by TRANSIENT failures: a route switch (legacy fallback) or a
    // permanent refusal consumes no slot, so the first real transient failure always
    // waits 250ms.
    const base = TERMINAL_BACKOFF_MS[Math.min(this.transientFailures - 1, TERMINAL_BACKOFF_MS.length - 1)]!;
    const jitter = this.options.jitterMs ?? (() => Math.random() * 0.2 * base);
    return base + jitter();
  }

  private async withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.inflight = controller;
    this.inflightTimer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? TERMINAL_REQUEST_TIMEOUT_MS);
    const timeout = this.inflightTimer;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("the terminal request exceeded its 10s bound", "TimeoutError"));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } finally {
      clearTimeout(timeout);
      this.inflightTimer = null;
      removeAbortListener();
      this.inflight = null;
    }
  }

  /** Resolves false when dispose woke the sleeper, true when the timer really fired. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.wakeup = () => {
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.wakeup = null;
        resolve(false);
      };
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.wakeup = null;
        resolve(true);
      }, ms);
    });
  }

  private diagnostic(kind: TerminalDiagnostic["kind"], fields: { status: number | null; code: string | null; nextRetryAt?: number | null }): void {
    // The diagnostic vocabulary is fixed by the design: no tokens, prompts or bodies.
    const diagnostic: TerminalDiagnostic = {
      kind,
      taskId: this.options.taskId,
      reportId: this.report?.reportId ?? null,
      epoch: this.options.epoch,
      status: fields.status,
      code: fields.code,
      attempt: this.attempt,
      elapsed: this.now() - this.publishedAt,
      nextRetryAt: fields.nextRetryAt ?? null,
    };
    const sink = this.options.onDiagnostic;
    if (sink) sink(diagnostic);
    else console.error(`[terminal-delivery] ${JSON.stringify(diagnostic)}`);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** Classification of one terminal attempt failure (design section 5). */
function classifyTerminalError(error: unknown, legacy: boolean): ErrorVerdict {
  if (!(error instanceof BackendHttpError)) return "transient";
  if (error.status === 404) {
    // An old backend has no terminal routes at all: fall back once; after the fallback
    // a 404 means nothing can deliver this report (permanent, pull keeps asking).
    if (legacy) return "permanent";
    return error.code === "AI_TASK_NOT_FOUND" ? "permanent" : "legacy-route";
  }
  if (error.status === 408 || error.status === 429 || error.status >= 500) return "transient";
  // PROJECT_BUSY is the one transient 409; every other 409 is a concrete conflict
  // (identity/epoch/instance/content) and never a success.
  if (error.status === 409) return error.code === "PROJECT_BUSY" ? "transient" : "permanent";
  if (error.status === 401 || error.status === 403 || error.status === 422) return "permanent";
  return "transient";
}

function diagnosticKind(_error: unknown, legacy: boolean): TerminalDiagnostic["kind"] {
  return legacy ? "terminal-legacy" : "terminal-push";
}

function httpStatus(error: unknown): number | null {
  return error instanceof BackendHttpError ? error.status : null;
}

function httpCode(error: unknown): string | null {
  return error instanceof BackendHttpError ? error.code : null;
}

function sameReport(a: TerminalReport, b: TerminalReport): boolean {
  return a.protocolVersion === b.protocolVersion && a.reportId === b.reportId
    && a.state === b.state && a.summary === b.summary && a.failureCode === b.failureCode;
}

/**
 * Shrinks the summary until the WHOLE serialized report fits the 8 KiB bound (the same
 * serialized-bytes algorithm as fitSummary, applied to the full report envelope so the
 * protocolVersion/reportId overhead is accounted for). The cut never splits a multi-byte
 * character, never ends inside a surrogate pair, and keeps a true prefix of the summary.
 */
export function fitTerminalReport(report: TerminalReport): TerminalReport {
  const bytes = (candidate: string): number =>
    Buffer.byteLength(JSON.stringify({ ...report, summary: candidate }), "utf8");
  if (bytes(report.summary) <= TERMINAL_REPORT_MAX_BYTES) {
    return report;
  }
  let cut = report.summary.length;
  while (cut > 0 && bytes(report.summary.slice(0, cut)) > TERMINAL_REPORT_MAX_BYTES) {
    cut = Math.floor(cut / 2);
  }
  while (cut < report.summary.length && bytes(report.summary.slice(0, cut + 1)) <= TERMINAL_REPORT_MAX_BYTES) {
    cut += 1;
  }
  while (cut > 0 && cut < report.summary.length
      && isHighSurrogate(report.summary.charCodeAt(cut - 1))
      && isLowSurrogate(report.summary.charCodeAt(cut))) {
    cut -= 1;
  }
  return { ...report, summary: report.summary.slice(0, cut) };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export interface ConfirmedRecordInfo {
  confirmedAt: number | null;
}

/**
 * Selects the confirmed per-task records to evict: a confirmed record older than
 * `maxAgeMs` is always evicted, and beyond `limit` confirmed records the oldest are
 * evicted first. Records without a confirmed decision (PENDING/REJECTED deliveries)
 * are never evicted — they still hold the execution slot. An eviction only forgets the
 * worker-side record; the backend's durable receipt is unaffected.
 */
export function selectConfirmedEvictions<K>(
  entries: Iterable<readonly [K, ConfirmedRecordInfo]>,
  now: number,
  limit: number = CONFIRMED_RECORD_LIMIT,
  maxAgeMs: number = CONFIRMED_RECORD_MAX_AGE_MS,
): K[] {
  const confirmed: Array<{ key: K; confirmedAt: number }> = [];
  for (const [key, info] of entries) {
    if (info.confirmedAt !== null) confirmed.push({ key, confirmedAt: info.confirmedAt });
  }
  const expired = confirmed.filter((entry) => now - entry.confirmedAt > maxAgeMs).map((entry) => entry.key);
  const kept = confirmed.filter((entry) => now - entry.confirmedAt <= maxAgeMs)
    .sort((a, b) => a.confirmedAt - b.confirmedAt);
  const overLimit = kept.slice(0, Math.max(0, kept.length - limit)).map((entry) => entry.key);
  return [...expired, ...overLimit];
}
