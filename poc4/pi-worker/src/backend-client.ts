/**
 * The worker's client for the backend's internal task routes. Transport contract:
 * a tool submission whose POST response is lost is followed by a GET of the ORIGINAL
 * call (same toolCallId — the request id is the dedup identity and the backend's
 * durable ledger is the only authority), and a progress submission repeats the SAME
 * seq with a byte-identical payload until the backend answers. The client never
 * invents a replacement request or a replacement sequence number.
 */

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

export class BackendClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly instanceId: string;
  private readonly epoch: string;
  private readonly transport: typeof fetch;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.instanceId = options.instanceId;
    this.epoch = String(options.epoch);
    this.transport = options.fetch ?? fetch;
  }

  /**
   * Submits one tool invocation and returns its durable result. When the POST
   * response is lost the original call is queried by GET; a 404 from that GET means
   * the POST never landed, so the POST is retried once with the identical body.
   * Anything still unresolved throws — the caller must not start the next side
   * effect while this call's outcome is unknown.
   */
  async invoke(taskId: string, request: ToolRequest): Promise<ToolResult> {
    const path = `/internal/ai/tasks/${encodeURIComponent(taskId)}/calls/${encodeURIComponent(request.toolCallId)}`;
    const post = (): Promise<Response> => this.transport(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let response: Response;
    try {
      response = await post();
    } catch (error) {
      // The POST outcome is unknown: query the original call before anything else.
      let query: Response;
      try {
        query = await this.transport(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: this.headers(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new BackendHttpError(0, "AI_CALL_UNKNOWN", "tool call outcome is unknown after a lost response and a failed query");
      }
      if (query.status === 404) {
        // The submission never landed; replay the identical POST once.
        try {
          response = await post();
        } catch {
          throw new BackendHttpError(0, "AI_CALL_UNKNOWN", "tool call outcome is unknown after a lost submission");
        }
      } else {
        response = query;
      }
    }
    return await parseJson(response, (status, body) =>
      new BackendHttpError(status,
        typeof body.code === "string" ? body.code : "AI_CALL_REJECTED",
        `tool call was refused (${status})`));
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
    throw new BackendHttpError(response.status, "AI_PROGRESS_REJECTED", `progress submission was refused (${response.status})`);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-manao-worker-token": this.token,
      "x-manao-worker-instance": this.instanceId,
      "x-manao-worker-epoch": this.epoch,
    };
  }
}

async function parseJson<T>(response: Response, onError: (status: number, body: Record<string, unknown>) => Error): Promise<T> {
  const body = await safeJson(response);
  if (!response.ok || body === null) {
    throw onError(response.status, body ?? {});
  }
  return body as T;
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Serialized, at-most-one-HTTP-call-at-a-time progress delivery. SDK listeners are
 * never awaited by the agent loop, so every item goes through this promise chain;
 * the terminal state is only sent after the chain has drained. A lost response is
 * retried with the same seq and identical payload; a gap answer from the backend
 * re-sends the buffered items starting at the expected seq; a mismatch answer is
 * dropped (the backend kept its authoritative copy) and never re-sent.
 */
export class ProgressChain {
  private readonly client: BackendClient;
  private readonly taskId: string;
  private readonly buffer: ProgressItem[] = [];
  private nextSeq = 1;
  private queue: Promise<void> = Promise.resolve();
  private lastError: unknown = null;

  constructor(client: BackendClient, taskId: string) {
    this.client = client;
    this.taskId = taskId;
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
    this.queue = this.queue.then(() => this.deliver(item));
  }

  /** Waits until every enqueued item has been delivered. */
  async drain(): Promise<void> {
    const pending = this.queue;
    await pending;
  }

  /**
   * Drains the chain, then submits the terminal state and waits for its answer:
   * the terminal item is never overtaken by an earlier progress item.
   */
  async sendTerminal(state: "COMPLETED" | "FAILED", summary: string, failureCode: string | null): Promise<void> {
    await this.drain();
    const payload = JSON.stringify({ state, summary, failureCode });
    const item: ProgressItem = { seq: this.nextSeq++, kind: "terminal", text: payload, truncated: false };
    this.buffer.push(item);
    await this.deliver(item);
  }

  /** The first delivery error, for diagnostics at settlement time. */
  error(): unknown {
    return this.lastError;
  }

  private async deliver(item: ProgressItem): Promise<void> {
    try {
      const ack = await this.client.progress(this.taskId, item);
      if (ack.accepted) {
        return;
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
        if (retry.accepted || retry.mismatch) {
          return;
        }
        throw new BackendHttpError(0, "AI_PROGRESS_REJECTED", "progress gap replay did not settle");
      }
      if (ack.mismatch) {
        // Same seq, different payload: the backend's copy wins and this item is
        // dropped — resending would only repeat the conflict.
        return;
      }
    } catch (error) {
      this.lastError = error;
      // One identical retry for transport-level losses; the same seq + payload is
      // idempotent on the backend.
      try {
        const retry = await this.client.progress(this.taskId, item);
        if (retry.accepted || retry.mismatch) {
          return;
        }
      } catch (retryError) {
        this.lastError = retryError;
      }
      // Delivery stays failed but the chain continues: progress loss must never
      // wedge the task; the terminal state below is sent through the same chain.
    }
  }
}
