import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { BackendHttpError, type BackendClient } from "./backend-client.js";

export interface AttachmentRef {
  kind: "manao_image_ref"; version: 1; attachmentId: string; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; uploadedAt: string; expiresAt: string; taskId: string; availability: string;
}
export interface AttachmentPage { kind: "image_catalog"; items: AttachmentRef[]; nextCursor: string | null }
export const IMAGE_REQUEST_BYTES = 48 * 1024 * 1024;
const expiredText = "图片已失效，请重新上传";
const failure = (code: string) => new BackendHttpError(0, code, code);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
function reference(value: unknown): AttachmentRef | undefined {
  const r = record(value);
  return r?.kind === "manao_image_ref" && r.version === 1 && typeof r.attachmentId === "string" ? value as AttachmentRef : undefined;
}
/** Only server custom goals and durable read_image details carry references. Never parse text/Markdown. */
function references(message: AgentMessage): AttachmentRef[] {
  const m = message as unknown as Record<string, unknown>;
  if (m.role === "custom" && m.customType === "manao_user_request") {
    const refs = record(m.details)?.attachments;
    return Array.isArray(refs) ? refs.map(reference).filter((r): r is AttachmentRef => !!r) : [];
  }
  const data = record(record(m.details)?.data);
  if (m.role === "toolResult" && m.toolName === "read_image" && data?.kind === "image_reference") {
    const ref = reference(data.image); return ref ? [ref] : [];
  }
  return [];
}

/** Studio already stores attachments by turn; keep only their task/index references in Pi history. */
export async function installTaskImageContext(session: AgentSession, taskId: string,
  images: readonly { type: "image"; data: string; mimeType: string }[]): Promise<{ dispose(): void; pendingTokens: number }> {
  if (!session.model?.input.includes("image")) throw failure("AI_IMAGE_INPUT_DISABLED");
  if (Buffer.byteLength(JSON.stringify(images), "utf8") > IMAGE_REQUEST_BYTES) throw failure("AI_IMAGE_REQUEST_TOO_LARGE");
  const content = `Image attachments for the current task ${taskId}.`;
  const taskImages = images.map(image => ({ ...image }));
  const pendingTokens = estimateTokens({ role: "user", content: taskImages, timestamp: Date.now() });
  await session.sendCustomMessage({ customType: "manao_task_images", content, display: false,
    details: { taskId, attachments: images.map((image, index) => ({ index, mimeType: image.mimeType })) } }, { triggerTurn: false });
  const transform = session.agent.transformContext;
  let compacting = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "compaction_start") compacting = true;
    if (event.type === "compaction_end") compacting = false;
  });
  session.agent.transformContext = async (messages, signal) => {
    const original = transform ? await transform(messages, signal) : messages;
    signal?.throwIfAborted();
    if (compacting || taskImages.length === 0) return original;
    let attached = false;
    const projected = original.map(message => {
      if (message.role !== "custom" || message.customType !== "manao_task_images"
          || record(message.details)?.taskId !== taskId) return message;
      attached = true;
      return { ...message, content: [{ type: "text" as const, text: content }, ...taskImages] };
    });
    // Native compaction may remove the marker; the live task still owns its attachments.
    if (!attached) projected.push({ role: "user", content: [{ type: "text", text: content }, ...taskImages], timestamp: Date.now() });
    if (Buffer.byteLength(JSON.stringify(projected), "utf8") > IMAGE_REQUEST_BYTES) throw failure("AI_IMAGE_REQUEST_TOO_LARGE");
    if (projected.reduce((sum, message) => sum + estimateTokens(message), 0) > 786_432) throw failure("AI_IMAGE_CONTEXT_TOO_LARGE");
    return projected;
  };
  return { pendingTokens, dispose() { taskImages.length = 0; unsubscribe(); session.agent.transformContext = transform; } };
}

/** Install once; all bytes exist only in the projected request, never in session state/history. */
export function installImageContext(session: AgentSession, backend: BackendClient, taskId: string,
  now: () => number = Date.now, enabled = true, onFailure?: (code:string)=>void): { dispose(): void; pendingTokens(): Promise<number> } {
  const transform = session.agent.transformContext;
  const stream = session.agent.streamFunction;
  let disposed = false;
  let compacting = false;
  let projected: AttachmentRef[] = [];
  const controller = new AbortController();
  const scopedSignal=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "compaction_start") compacting = true;
    if (event.type === "compaction_end") compacting = false;
  });
  const check = (ref: AttachmentRef) => {
    if (ref.availability === "EXPIRED" || now() >= Date.parse(ref.expiresAt)) throw failure("AI_ATTACHMENT_EXPIRED");
    if (ref.availability !== "READY" || !Number.isFinite(Date.parse(ref.expiresAt))) throw failure("AI_ATTACHMENT_UNAVAILABLE");
  };
  const current = async (id: string, signal?: AbortSignal) => {
    controller.signal.throwIfAborted(); signal?.throwIfAborted();
    const meta = await backend.imageMetadata(taskId, id, scopedSignal(signal));
    controller.signal.throwIfAborted(); signal?.throwIfAborted();
    return meta;
  };
  session.agent.transformContext = async (messages, signal) => {
    try {
    const original = transform ? await transform(messages, signal) : messages;
    if (compacting || disposed) return original;
    if (!enabled) {
      if(original.some(message=>references(message).some(ref=>now()<Date.parse(ref.expiresAt))))throw failure("AI_IMAGE_INPUT_DISABLED");
      return original;
    }
    const page = await backend.imageCatalog(taskId, undefined, scopedSignal(signal));
    const refs = new Map<string, AttachmentRef>();
    for (const message of original) for (const ref of references(message)) refs.set(ref.attachmentId, ref);
    const metadata = new Map<string, AttachmentRef | null>();
    let size = Buffer.byteLength(JSON.stringify(original), "utf8") + Buffer.byteLength(JSON.stringify(page), "utf8");
    for (const id of refs.keys()) {
      try {
        const meta = await current(id, signal);
        if (meta.availability === "EXPIRED" || now() >= Date.parse(meta.expiresAt)) { metadata.set(id, null); continue; }
        check(meta);
        metadata.set(id, meta); size += 4 * Math.ceil(meta.sizeBytes / 3) + 256;
      } catch (error) {
        if (error instanceof BackendHttpError && error.code === "AI_ATTACHMENT_EXPIRED") metadata.set(id, null);
        else throw error;
      }
    }
    if (size > IMAGE_REQUEST_BYTES) throw failure("AI_IMAGE_REQUEST_TOO_LARGE");
    const images = new Map<string, { type: "image"; data: string; mimeType: string }>();
    for (const [id, meta] of metadata) if (meta) {
      const content = await backend.imageContent(taskId, id, scopedSignal(signal));
      check(meta); signal?.throwIfAborted(); controller.signal.throwIfAborted();
      if (content.bytes.byteLength !== meta.sizeBytes) throw failure("AI_ATTACHMENT_UNAVAILABLE");
      images.set(id, { type: "image", data: Buffer.from(content.bytes).toString("base64"), mimeType: meta.mimeType });
    }
    projected = [...metadata.values()].filter((r): r is AttachmentRef => r !== null);
    const emitted = new Set<string>();
    const result = original.map(message => {
      const refs = references(message);
      if (!refs.length) return message;
      const copy = structuredClone(message);
      if (!("content" in copy)) return copy;
      const blocks = typeof copy.content === "string" ? [{ type: "text" as const, text: copy.content }] : [...copy.content];
      for (const ref of refs) {
        const image = images.get(ref.attachmentId);
        if (metadata.get(ref.attachmentId) === null) blocks.push({ type: "text", text: expiredText });
        else if (image && !emitted.has(ref.attachmentId)) { blocks.push(image); emitted.add(ref.attachmentId); }
      }
      return { ...copy, content: blocks } as AgentMessage;
    });
    // One bounded page each round; read_image({cursor}) discovers all later pages.
    if (page.items.length || page.nextCursor) result.push({ role: "user", content: [{ type: "text",
      text: "Current conversation images (use read_image to inspect an attachment or fetch nextCursor):\n" + JSON.stringify(page) }], timestamp: now() });
    const tokens = result.reduce((total, message) => total + estimateTokens(message), 0);
    if (tokens > 786_432) throw failure("AI_IMAGE_CONTEXT_TOO_LARGE");
    return result;
    } catch(error) { if(error instanceof BackendHttpError)onFailure?.(error.code);throw error; }
  };
  session.agent.streamFunction = (model, context, options) => {
    const hasImages = context.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image"));
    if (!hasImages) return stream(model, context, options);
    const refs = [...projected];
    const transport = options?.fetch ?? globalThis.fetch;
    return stream(model, context, { ...options,
      onPayload: async (payload, resolvedModel) => {
        const replaced = await options?.onPayload?.(payload, resolvedModel);
        if (Buffer.byteLength(JSON.stringify(replaced ?? payload), "utf8") > IMAGE_REQUEST_BYTES) { onFailure?.("AI_IMAGE_REQUEST_TOO_LARGE");throw failure("AI_IMAGE_REQUEST_TOO_LARGE"); }
        return replaced;
      },
      fetch: async (input, init) => {
        try {
        controller.signal.throwIfAborted(); options?.signal?.throwIfAborted();
        for (const ref of refs) { check(ref); check(await current(ref.attachmentId, options?.signal)); }
        if (typeof init?.body === "string" && Buffer.byteLength(init.body, "utf8") > IMAGE_REQUEST_BYTES) throw failure("AI_IMAGE_REQUEST_TOO_LARGE");
        // Nothing asynchronous may follow this final deadline sweep before the actual send.
        for(const ref of refs)check(ref);
        return transport(input, init);
        } catch(error) { if(error instanceof BackendHttpError)onFailure?.(error.code);throw error; }
      },
    });
  };
  return {
    async pendingTokens() {
      if(!enabled)return 0;
      const page = await backend.imageCatalog(taskId,undefined,controller.signal);
      const refs = new Map<string, AttachmentRef>();
      for (const message of session.agent.state.messages) for (const ref of references(message)) refs.set(ref.attachmentId, ref);
      // Use Pi's own image estimate without materializing image bytes.
      const imageTokens = estimateTokens({ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: now() });
      return refs.size * imageTokens + Math.ceil(Buffer.byteLength(JSON.stringify(page), "utf8") / 4);
    },
    dispose() { disposed = true; projected = []; controller.abort(); unsubscribe(); session.agent.transformContext = transform; session.agent.streamFunction = stream; },
  };
}
