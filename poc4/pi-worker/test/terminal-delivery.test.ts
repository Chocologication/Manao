import { describe, expect, it, vi } from "vitest";
import { BackendClient, BackendHttpError, ProgressChain } from "../src/backend-client.js";

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
