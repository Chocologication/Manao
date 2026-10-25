import { describe, expect, it, vi } from "vitest";
import { BackendClient, BackendHttpError, ProgressChain } from "../src/backend-client.js";
import { terminalContentSha256, terminalReportId } from "../src/report-identity.js";

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
