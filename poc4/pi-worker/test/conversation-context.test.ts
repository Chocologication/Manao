import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BackendClient } from "../src/backend-client.js";
import { ConversationContext } from "../src/conversation-context.js";

const id = "00000000-0000-4000-8000-000000000001";
const response = (body: unknown) => new Response(JSON.stringify(body));
function setup() {
  const manager = SessionManager.inMemory("manao-project", { id });
  manager.appendCustomMessageEntry("manao_user_request", "保留中文目标", true);
  const entry = manager.getEntries()[0]!;
  const header = manager.getHeader()!;
  const transport = vi.fn<typeof fetch>();
  const client = new BackendClient({ baseUrl: "http://backend.invalid", token: "test", instanceId: "instance", epoch: 1, fetch: transport });
  return { manager, entry, header, transport, client };
}
describe("conversation context protocol", () => {
  it("reconciles an original batch across response pages with one fixed snapshot head", async () => {
    const { manager, entry, header, transport, client } = setup();
    manager.appendCustomMessageEntry("manao_user_request", "second", true);
    const second = manager.getEntries()[1]!;
    transport.mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce(response({ header, headSeq: 2, entries: [{ seq: 1, sourceTaskId: "task", writerId: "task", entry }], nextAfterSeq: 1 }))
      .mockResolvedValueOnce(response({ header, headSeq: 2, entries: [{ seq: 2, sourceTaskId: "task", writerId: "task", entry: second }], nextAfterSeq: null }));
    expect(await client.appendContext("task", { expectedHeadSeq: 0, header, entries: [entry, second], usage: null })).toEqual({ headSeq: 2 });
    expect(String(transport.mock.calls[2]![0])).toContain("afterSeq=1&throughSeq=2");
    expect(transport.mock.calls.map(([, options]) => options!.method)).toEqual(["POST", "GET", "GET"]);
  });
  it("pins the first head while loading subsequent bounded pages", async () => {
    const { manager, header, transport, client } = setup();
    manager.appendCustomMessageEntry("manao_user_request", "第二个目标", true);
    transport.mockResolvedValueOnce(response({ header, headSeq: 2, entries: [{ seq: 1, sourceTaskId: "task", writerId: "task", entry: manager.getEntries()[0] }], nextAfterSeq: 1 }))
      .mockResolvedValueOnce(response({ header, headSeq: 2, entries: [{ seq: 2, sourceTaskId: "task", writerId: "task", entry: manager.getEntries()[1] }], nextAfterSeq: null }));
    const context = await ConversationContext.load(client, "task", id);
    expect(context.fileEntries).toEqual([header, ...manager.getEntries()]);
    expect(String(transport.mock.calls[1]![0])).toContain("afterSeq=1&throughSeq=2");
  });
  it("reconciles a lost ACK using original IDs and JSON values without another POST", async () => {
    const { entry, header, transport, client } = setup();
    transport.mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce(response({ header, headSeq: 1, entries: [{ seq: 1, sourceTaskId: "task", writerId: "task", entry: Object.fromEntries(Object.entries(entry).reverse()) }], nextAfterSeq: null }));
    expect(await client.appendContext("task", { expectedHeadSeq: 0, header, entries: [entry], usage: null })).toEqual({ headSeq: 1 });
    expect(transport.mock.calls.map(([, options]) => options!.method)).toEqual(["POST", "GET"]);
  });
  it("retries only an explicitly absent original batch with byte-identical IDs/body", async () => {
    const { entry, header, transport, client } = setup();
    transport.mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce(response({ header, headSeq: 0, entries: [], nextAfterSeq: null }))
      .mockResolvedValueOnce(response({ headSeq: 1 }));
    await client.appendContext("task", { expectedHeadSeq: 0, header, entries: [entry], usage: null });
    expect(transport.mock.calls.map(([, options]) => options!.method)).toEqual(["POST", "GET", "POST"]);
    expect(transport.mock.calls[2]![1]!.body).toBe(transport.mock.calls[0]![1]!.body);
  });
  it("fails closed on an uncertain or foreign original suffix", async () => {
    const { entry, header, transport, client } = setup();
    transport.mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce(response({ header, headSeq: 1, entries: [{ seq: 1, sourceTaskId: "other", writerId: "other", entry }], nextAfterSeq: null }));
    await expect(client.appendContext("task", { expectedHeadSeq: 0, header, entries: [entry], usage: null })).rejects.toMatchObject({ code: "AI_CONTEXT_CONFLICT" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects a mismatched header and missing sequence", async () => {
    const { header, entry, transport, client } = setup();
    transport.mockResolvedValueOnce(response({ header: { ...header, id: "other" }, headSeq: 1, entries: [{ seq: 1, entry }], nextAfterSeq: null }));
    await expect(ConversationContext.load(client, "task", id)).rejects.toMatchObject({ code: "AI_CONTEXT_UNAVAILABLE" });
    transport.mockResolvedValueOnce(response({ header, headSeq: 2, entries: [{ seq: 2, entry }], nextAfterSeq: null }));
    await expect(ConversationContext.load(client, "task", id)).rejects.toMatchObject({ code: "AI_CONTEXT_UNAVAILABLE" });
  });
});
