import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendClient, BackendHttpError, ProgressChain } from "../src/backend-client.js";
import {
  CONFIRMED_RECORD_LIMIT,
  TERMINAL_BACKOFF_MS,
  TerminalDelivery,
  selectConfirmedEvictions,
  type TerminalBackend,
  type TerminalDeliverySnapshot,
  type TerminalDiagnostic,
} from "../src/terminal-delivery.js";
import {
  terminalContentSha256,
  terminalReportId,
  type TerminalAck,
  type TerminalReport,
} from "../src/report-identity.js";

/**
 * Terminal settlement regression fixtures (repair plan 2026-10-25, task 1). RED baseline
 * against the CURRENT delivery path: ProgressChain.sendTerminal swallows a twice-refused
 * delivery and resolves normally, so a failed terminal delivery is indistinguishable from
 * an acknowledged one — the hidden false ACK of the diagnosed incident (evidence:
 * terminal-settlement-race-safe.json, lastError AI_PROGRESS_REJECTED behind a resolved
 * sendTerminal). A terminal that the backend never acknowledged must never resolve as if
 * it had been. The dedicated terminal-delivery module (task 4) extends this file with its
 * own contract; this case stays as the behavioral floor.
 */
describe("terminal delivery", () => {
  it("terminalDeliveryFailureNeverClaimsAcknowledgement: a twice-refused terminal must not resolve as acknowledged", async () => {
    const task = "00000000-0000-4000-8000-000000000001";
    // The incident's backend shape: the project gate is contended, so every progress
    // POST is refused 409 PROJECT_BUSY (race-safe.json failedDeliveries).
    const deliveries: { seq: number; kind: string; text: string }[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ code: "PROJECT_BUSY" }), { status: 409 });
    });
    const client = new BackendClient({
      baseUrl: "http://backend.invalid",
      token: "test-only",
      instanceId: "worker-1",
      epoch: 1,
      fetch: transport as unknown as typeof fetch,
      delay: async () => {},
    });
    const chain = new ProgressChain(client, task);
    // The last display progress may fail without aborting the task; the failure is
    // known to the chain but must never masquerade as a delivered terminal.
    chain.send("message", "the model has finished the task");
    await chain.drain();
    expect(chain.error()).toBeInstanceOf(BackendHttpError);

    // The terminal delivery must be distinguishable from an acknowledged one: a
    // backend that answered 409 twice has NOT acknowledged this terminal.
    await expect(
      chain.sendTerminal("COMPLETED", "the model has finished the task", null),
    ).rejects.toThrow(BackendHttpError);

    // Every terminal attempt kept the SAME seq with a byte-identical payload, so a
    // later delivery stays an idempotent replay instead of a second identity.
    const terminal = deliveries.filter((item) => item.kind === "terminal");
    expect(terminal.length).toBeGreaterThanOrEqual(2);
    expect(new Set(terminal.map((item) => `${item.seq}:${item.text}`))).toHaveLength(1);
  });

  it("sendTerminalMismatchFailsClosed: an AI_PROGRESS_MISMATCH answer must not resolve as acknowledged", async () => {
    const task = "00000000-0000-4000-8000-000000000003";
    // The cross-restart legacy shape: the old backend kept a DIFFERENT payload at this
    // seq and answers 409 AI_PROGRESS_MISMATCH — this content was NOT acknowledged.
    const deliveries: { seq: number; kind: string; text: string }[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ code: "AI_PROGRESS_MISMATCH" }), { status: 409 });
    });
    const client = new BackendClient({
      baseUrl: "http://backend.invalid",
      token: "test-only",
      instanceId: "worker-1",
      epoch: 1,
      fetch: transport as unknown as typeof fetch,
      delay: async () => {},
    });
    const chain = new ProgressChain(client, task);
    // Resolving here would let the settlement layer report "delivered" for content the
    // backend never accepted — the false-ACK class this repair removes.
    await expect(
      chain.sendTerminal("COMPLETED", "the model has finished the task", null),
    ).rejects.toMatchObject({ status: 409, code: "AI_PROGRESS_MISMATCH" });
    // Resending would only repeat the conflict: one attempt, same seq, same bytes.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(new Set(deliveries.map((item) => `${item.seq}:${item.text}`))).toHaveLength(1);
  });
});

/**
 * The terminal identity algorithm is pinned by the cross-language vectors (repair design
 * protocol supplement): reportId and the content digest are the lowercase SHA-256 of the
 * compact JSON array with raw Unicode, unescaped slashes and preserved nulls. The pinned
 * values below were computed independently and are asserted identically by the Java test
 * {@code AgentTaskStoreTest.terminalIdentityMatchesThePinnedCrossLanguageVectors} — any
 * serialization drift on either side breaks both.
 */
describe("terminal identity", () => {
  it("matches the pinned cross-language Unicode vectors", () => {
    const taskId = "00000000-0000-4000-8000-000000000002";
    const requestSha256 = "a".repeat(64);
    const summary = "模型已完成任务 ✅🚀 \"引用\" a/b\n第二行";
    expect(terminalReportId(taskId, 1, requestSha256)).toBe(
      "263ade2fcde171dbcea4fc769d7b2f39ee0c5ef92beee2b559ab75458c4ec606",
    );
    const reportId = terminalReportId(taskId, 1, requestSha256);
    expect(terminalContentSha256(reportId, "COMPLETED", summary, null)).toBe(
      "11feecc769a1fe7f825999d9260131e5a5461b08cf004bcc9d5e88019be70a2a",
    );
    expect(terminalContentSha256(reportId, "FAILED", summary, "AI_PROVIDER_ERROR")).toBe(
      "2f3c92b5efe892a112a63d6bcdc5372e852aa65f81b8a0e20dd45e0f15ff8051",
    );
  });
});

// ---------------------------------------------------------------------------
// Terminal delivery manager (task 4): controlled fetch + fake timers.
// ---------------------------------------------------------------------------

const taskId = "00000000-0000-4000-8000-000000000004";
const requestSha256 = "b".repeat(64);
const epoch = 1;
const reportId = terminalReportId(taskId, epoch, requestSha256);

function report(state: "COMPLETED" | "FAILED" = "COMPLETED", summary = "构建通过，已修复 src/Demo.java"): TerminalReport {
  return {
    protocolVersion: 1,
    reportId: terminalReportId(taskId, epoch, requestSha256),
    state,
    summary,
    failureCode: state === "FAILED" ? "AI_PROVIDER_ERROR" : null,
  };
}

function ackFor(deliveryReport: TerminalReport, disposition: TerminalAck["disposition"] = "RECORDED"): TerminalAck {
  return {
    reportId: deliveryReport.reportId,
    reportSha256: terminalContentSha256(
      deliveryReport.reportId, deliveryReport.state, deliveryReport.summary, deliveryReport.failureCode),
    disposition,
  };
}

interface Harness {
  delivery: TerminalDelivery;
  requests: Array<{ body: string; signal: AbortSignal; at: number }>;
  pulls: Array<{ at: number }>;
  diagnostics: TerminalDiagnostic[];
  confirmed: Array<TerminalDeliverySnapshot["state"]>;
  maxInflight(): number;
  now: () => number;
  advance(ms: number): Promise<void>;
}

type PostStep = (request: { body: string; signal: AbortSignal }) => Promise<TerminalAck>;
type GetStep = () => Promise<TerminalAck>;

function harness(steps: PostStep[], options: {
  get?: GetStep[];
  jitter?: () => number;
  legacy?: (report: TerminalReport) => Promise<void>;
  pullIntervalMs?: number;
} = {}): Harness {
  let clock = 0;
  const requests: Harness["requests"] = [];
  const pulls: Harness["pulls"] = [];
  const diagnostics: TerminalDiagnostic[] = [];
  const confirmed: Array<TerminalDeliverySnapshot["state"]> = [];
  let inflight = 0;
  let maxInflight = 0;
  let post = 0;
  let pull = 0;
  const client: TerminalBackend = {
    postTerminal: async (_id, body, signal) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      requests.push({ body, signal, at: clock });
      try {
        return await steps[Math.min(post, steps.length - 1)]!({ body, signal });
      } finally {
        post++;
        inflight--;
      }
    },
    getTerminalAck: async () => {
      pulls.push({ at: clock });
      const getter = options.get?.[Math.min(pull, (options.get.length ?? 1) - 1)];
      pull++;
      if (!getter) throw new BackendHttpError(404, "AI_TERMINAL_NOT_FOUND", "terminal receipt not found");
      return await getter();
    },
  };
  const delivery = new TerminalDelivery({
    client,
    taskId,
    epoch,
    jitterMs: options.jitter ?? (() => 50),
    ...(options.legacy !== undefined ? { legacyTerminal: options.legacy } : {}),
    ...(options.pullIntervalMs !== undefined ? { pullIntervalMs: options.pullIntervalMs } : {}),
    now: () => clock,
    onConfirmed: (state) => confirmed.push(state),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return {
    delivery,
    requests,
    pulls,
    diagnostics,
    confirmed,
    maxInflight: () => maxInflight,
    now: () => clock,
    advance: async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("terminal delivery manager", () => {
  it("confirms the one identical report through PROJECT_BUSY, a lost response and the ACK (deterministic sequence)", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const canonical = ackFor(deliveryReport);
    const h = harness([
      () => { throw new BackendHttpError(409, "PROJECT_BUSY", "admission busy"); },
      async () => { throw new TypeError("response lost"); }, // server records R but the response is lost
      () => Promise.resolve(canonical),
    ]);
    h.delivery.publish(deliveryReport);
    expect(h.delivery.snapshot()).toEqual({ report: deliveryReport, state: "PENDING" });
    await h.advance(0); // fetch #1 -> 409 PROJECT_BUSY
    expect(h.delivery.snapshot().state).toBe("PENDING"); // pending
    await h.advance(250 + 50); // 250ms backoff plus injected deterministic jitter -> fetch #2 (response lost)
    expect(h.delivery.snapshot().state).toBe("PENDING"); // pending
    await h.advance(500 + 50); // next retry -> fetch #3 -> ACK with R.id and canonical hash
    expect(h.delivery.snapshot().state).toBe("ACKED"); // acked
    expect(h.requests).toHaveLength(3);
    expect(new Set(h.requests.map((request) => request.body))).toHaveLength(1); // same body bytes every attempt
    expect(h.maxInflight()).toBe(1); // one in-flight request
    expect(h.confirmed).toEqual(["ACKED"]);
    // The execution outcome is unchanged: the published report object was never
    // replaced or mutated by the delivery retries.
    expect(h.delivery.snapshot().report).toBe(deliveryReport);
    expect(deliveryReport).toEqual(report());
  });

  it.each([
    ["5xx", () => { throw new BackendHttpError(503, "AI_TERMINAL_REJECTED", "backend unavailable"); }],
    ["408", () => { throw new BackendHttpError(408, "AI_TERMINAL_REJECTED", "request timeout"); }],
    ["429", () => { throw new BackendHttpError(429, "AI_TERMINAL_REJECTED", "too many requests"); }],
    ["transport", () => { throw new TypeError("fetch failed"); }],
  ])("retries a %s failure on the bounded backoff schedule with byte-identical bodies", async (_name, failure) => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const canonical = ackFor(deliveryReport);
    const h = harness([
      ...Array.from({ length: 7 }, () => failure),
      () => Promise.resolve(canonical),
    ]);
    h.delivery.publish(deliveryReport);
    // 250 -> 500 -> 1000 -> 2000 -> 4000 -> 5000 cap, each plus the injected 50ms jitter.
    for (const base of TERMINAL_BACKOFF_MS) {
      await h.advance(base + 50);
    }
    await h.advance(TERMINAL_BACKOFF_MS[TERMINAL_BACKOFF_MS.length - 1]! + 50); // capped schedule repeats
    expect(h.delivery.snapshot().state).toBe("ACKED");
    expect(h.requests).toHaveLength(8);
    expect(h.requests.map((request) => request.at))
      .toEqual([0, 300, 850, 1900, 3950, 8000, 13050, 18100]);
    expect(new Set(h.requests.map((request) => request.body))).toHaveLength(1);
    expect(h.maxInflight()).toBe(1);
  });

  it("aborts a single request at ten seconds and retries the identical bytes", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([
      ({ signal }) => new Promise<TerminalAck>((_resolve, reject) => {
        // A real provider transport rejects when its signal aborts; the harness models it.
        signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "TimeoutError")), { once: true });
      }),
      () => Promise.resolve(ackFor(deliveryReport)),
    ]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.requests).toHaveLength(1);
    await h.advance(10_000);
    expect(h.requests[0]!.signal.aborted).toBe(true); // the single request never outlives 10s
    await h.advance(250 + 50); // transient timeout -> bounded retry
    expect(h.delivery.snapshot().state).toBe("ACKED");
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.at).toBe(10_000 + 300);
    expect(new Set(h.requests.map((request) => request.body))).toHaveLength(1);
    expect(h.maxInflight()).toBe(1);
  });

  it("stops pushing on a permanent identity conflict and confirms only through a matching pull", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness(
      [() => { throw new BackendHttpError(409, "AI_TERMINAL_IDENTITY", "the terminal report id does not match this execution"); }],
      {
        get: [
          () => { throw new BackendHttpError(404, "AI_TERMINAL_NOT_FOUND", "Terminal report not found"); },
          () => Promise.resolve(ackFor(deliveryReport, "SETTLED")),
        ],
      },
    );
    h.delivery.publish(deliveryReport);
    await h.advance(0); // push attempt -> 409 AI_TERMINAL_IDENTITY
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // unconfirmed, kept
    expect(h.confirmed).toEqual([]);
    await h.advance(30_000); // the immediate pull found nothing; the 30s pull answers
    expect(h.delivery.snapshot().state).toBe("ACKED");
    expect(h.confirmed).toEqual(["ACKED"]);
    await h.advance(120_000); // the push loop never resumes after a permanent refusal
    expect(h.requests).toHaveLength(1);
    expect(h.pulls).toHaveLength(2);
  });

  it("never claims delivery for a mismatched ack on push or pull", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const mismatched: TerminalAck = {
      reportId: deliveryReport.reportId,
      reportSha256: "c".repeat(64), // a different content hash: NOT this report's content
      disposition: "SETTLED",
    };
    const h = harness(
      [() => Promise.resolve(mismatched)],
      { get: [() => Promise.resolve(mismatched)] },
    );
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // the 200 ack did not match our content
    expect(h.confirmed).toEqual([]); // MISMATCH must never claim the content was delivered
    await h.advance(60_000);
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // the pull repeats the mismatch
    expect(h.confirmed).toEqual([]);
    expect(h.requests).toHaveLength(1); // no push retries after the mismatch
  });

  it("treats a task-not-found refusal as permanent without unlocking", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness(
      [() => { throw new BackendHttpError(404, "AI_TASK_NOT_FOUND", "Task not found"); }],
      { get: [() => { throw new BackendHttpError(404, "AI_TERMINAL_NOT_FOUND", "not found"); }] },
    );
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.delivery.snapshot().state).toBe("REJECTED");
    await h.advance(120_000);
    expect(h.requests).toHaveLength(1); // never retried
    expect(h.confirmed).toEqual([]); // and never unlocked by the 404s
    expect(h.pulls.length).toBeGreaterThanOrEqual(4); // the pull keeps asking at the 30s cadence
  });

  it("confirms a CLOSING disposition as CLOSING", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([() => Promise.resolve(ackFor(deliveryReport, "CLOSING"))]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.delivery.snapshot().state).toBe("CLOSING");
    expect(h.confirmed).toEqual(["CLOSING"]);
  });

  it("publishes one report per task and refuses a different one", async () => {
    vi.useFakeTimers();
    const first = report("COMPLETED");
    const second = report("FAILED", "模型执行失败");
    const h = harness([() => Promise.resolve(ackFor(first))]);
    h.delivery.publish(first);
    h.delivery.publish(second); // a different report for the same task is refused
    expect(h.diagnostics.some((diagnostic) => diagnostic.kind === "terminal-publish-conflict")).toBe(true);
    await h.advance(0);
    expect(h.delivery.snapshot()).toEqual({ report: first, state: "ACKED" });
    h.delivery.publish(first); // the same report is an idempotent no-op
    h.delivery.publish(second); // even after confirmation nothing changes
    expect(h.delivery.snapshot().report).toBe(first);
    expect(h.requests).toHaveLength(1);
  });

  it("falls back to the legacy progress terminal when the endpoint is absent", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const legacy = vi.fn<(deliveryReport: TerminalReport) => Promise<void>>();
    legacy.mockRejectedValueOnce(new BackendHttpError(409, "PROJECT_BUSY", "gate busy"));
    legacy.mockResolvedValueOnce(undefined);
    const h = harness(
      [() => { throw new BackendHttpError(404, "AI_TERMINAL_REJECTED", "endpoint absent"); }],
      { legacy },
    );
    h.delivery.publish(deliveryReport);
    await h.advance(0); // POST /terminal answered 404 without a backend code: route absent
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0]![0]).toEqual(deliveryReport);
    expect(h.delivery.snapshot().state).toBe("PENDING"); // the legacy attempt was refused (busy)
    await h.advance(250 + 50); // bounded backoff, same report
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(h.delivery.snapshot().state).toBe("ACKED");
    expect(h.confirmed).toEqual(["ACKED"]);
    expect(h.requests).toHaveLength(1); // the absent endpoint is never POSTed again
  });

  it("does not confirm a legacy mismatch answer and falls back to the read-only pull", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    // The legacy adapter is wired to a REAL progress chain: the old backend answers the
    // legacy terminal item with a same-seq different-payload conflict (409
    // AI_PROGRESS_MISMATCH) — it kept another payload, so nothing of ours is delivered.
    const legacyTransport = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ code: "AI_PROGRESS_MISMATCH" }), { status: 409 }));
    const legacyClient = new BackendClient({
      baseUrl: "http://backend.invalid", token: "test-only", instanceId: "worker-1", epoch: 1,
      fetch: legacyTransport as unknown as typeof fetch, delay: async () => {},
    });
    const chain = new ProgressChain(legacyClient, taskId);
    const h = harness(
      [() => { throw new BackendHttpError(404, "AI_TERMINAL_REJECTED", "endpoint absent"); }],
      {
        legacy: (legacyReport) => chain.sendTerminal(legacyReport.state, legacyReport.summary, legacyReport.failureCode),
        get: [() => { throw new BackendHttpError(404, "AI_TERMINAL_NOT_FOUND", "not found"); }],
      },
    );
    h.delivery.publish(deliveryReport);
    await h.advance(0); // POST /terminal absent -> legacy item -> 409 AI_PROGRESS_MISMATCH
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // the mismatch is NOT a delivery
    expect(h.confirmed).toEqual([]); // the slot is NOT released
    await h.advance(120_000);
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // the pull keeps asking, never unlocks
    expect(h.confirmed).toEqual([]);
    expect(h.requests).toHaveLength(1); // the absent endpoint is never re-POSTed
    expect(legacyTransport).toHaveBeenCalledTimes(1); // resending would only repeat the conflict
  });

  it("treats an absent endpoint without a wired legacy fallback as permanently undeliverable", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([() => { throw new BackendHttpError(404, "AI_TERMINAL_REJECTED", "endpoint absent"); }]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.delivery.snapshot().state).toBe("REJECTED"); // no delivery path exists at all
    await h.advance(120_000);
    expect(h.requests).toHaveLength(1); // no push retries and no legacy attempts
  });

  it("dispose clears every timer, aborts the in-flight request and stops all activity", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([() => { throw new BackendHttpError(503, "AI_TERMINAL_REJECTED", "down"); }]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    h.delivery.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const seen = h.requests.length;
    await h.advance(60_000);
    expect(h.requests).toHaveLength(seen); // no retries after dispose
    expect(h.delivery.snapshot().state).toBe("PENDING"); // unconfirmed stays unconfirmed
  });

  it("dispose aborts an in-flight request", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([
      ({ signal }) => new Promise<TerminalAck>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    ]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    expect(h.requests).toHaveLength(1);
    h.delivery.dispose();
    expect(h.requests[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await h.advance(60_000);
    expect(h.requests).toHaveLength(1);
  });

  it("records only the safe diagnostic fields", async () => {
    vi.useFakeTimers();
    const deliveryReport = report();
    const h = harness([
      () => { throw new BackendHttpError(409, "PROJECT_BUSY", "password=sensitive http://private.invalid"); },
      () => Promise.resolve(ackFor(deliveryReport)),
    ]);
    h.delivery.publish(deliveryReport);
    await h.advance(0);
    await h.advance(250 + 50);
    const allowed = new Set(["kind", "taskId", "reportId", "epoch", "status", "code", "attempt", "elapsed", "nextRetryAt"]);
    expect(h.diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const diagnostic of h.diagnostics) {
      expect(Object.keys(diagnostic).every((key) => allowed.has(key))).toBe(true);
    }
    expect(JSON.stringify(h.diagnostics)).not.toMatch(/sensitive|private\.invalid/);
  });

  it("fits the whole serialized report inside the 8 KiB bound without corrupting code points", async () => {
    vi.useFakeTimers();
    const oversized: TerminalReport = {
      protocolVersion: 1,
      reportId,
      state: "FAILED",
      summary: "x".repeat(9000) + "😀".repeat(40) + "🏁",
      failureCode: "AI_PROVIDER_ERROR",
    };
    // A canonical server: hash whatever actually arrived, so the ack only matches the
    // fitted content the delivery really sent.
    const h = harness([async ({ body }) => {
      const received = JSON.parse(body) as TerminalReport;
      return {
        reportId: received.reportId,
        reportSha256: terminalContentSha256(received.reportId, received.state, received.summary, received.failureCode),
        disposition: "RECORDED",
      };
    }]);
    h.delivery.publish(oversized);
    const stored = h.delivery.snapshot().report!;
    expect(stored).not.toBe(oversized); // the caller's report object stays untouched
    expect(oversized.summary.startsWith(stored.summary)).toBe(true); // cut, never rewritten
    expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThanOrEqual(8 * 1024);
    const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpairedSurrogate.test(stored.summary)).toBe(false);
    await h.advance(0);
    expect(h.delivery.snapshot().state).toBe("ACKED"); // the fitted report round-trips and confirms
  });
});

describe("confirmed record retention", () => {
  it("evicts confirmed records beyond the 100 limit, oldest first, and never PENDING/REJECTED ones", () => {
    const now = 1_000_000;
    const entries: Array<readonly [string, { confirmedAt: number | null }]> = Array.from(
      { length: CONFIRMED_RECORD_LIMIT + 1 },
      (_, index) => [`confirmed-${index}`, { confirmedAt: now - 1000 + index }] as const,
    );
    entries.push(["pending", { confirmedAt: null }]);
    entries.push(["rejected", { confirmedAt: null }]);
    const evicted = selectConfirmedEvictions(entries, now);
    expect(evicted).toEqual(["confirmed-0"]); // exactly the oldest confirmed record
    expect(evicted).not.toContain("pending");
    expect(evicted).not.toContain("rejected");
  });

  it("evicts confirmed records older than 24h while unconfirmed ones stay", () => {
    const now = 25 * 60 * 60 * 1000;
    const entries: Array<readonly [string, { confirmedAt: number | null }]> = [
      ["old-confirmed", { confirmedAt: 0 }],
      ["fresh-confirmed", { confirmedAt: now - 1000 }],
      ["still-pending", { confirmedAt: null }],
    ];
    expect(selectConfirmedEvictions(entries, now)).toEqual(["old-confirmed"]);
  });

  it("keeps exactly-at-limit fresh confirmed records", () => {
    const now = 1_000_000;
    const entries: Array<readonly [string, { confirmedAt: number | null }]> = Array.from(
      { length: CONFIRMED_RECORD_LIMIT },
      (_, index) => [`confirmed-${index}`, { confirmedAt: now - index - 1 }] as const,
    );
    expect(selectConfirmedEvictions(entries, now)).toEqual([]);
  });
});
