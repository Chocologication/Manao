import { JAVA_ENVIRONMENT } from "./environment-fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(()=>vi.unstubAllGlobals());
import { SessionManager, SettingsManager, createAgentSession, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createPiSession } from "../src/pi-session.js";
import { BackendHttpError, ProgressChain, type BackendClient } from "../src/backend-client.js";
import { MODEL_CONFIG, privateDirs, scriptedSessionFactory } from "./scripted-session.js";

const image = { kind: "manao_image_ref", version: 1, attachmentId: "00000000-0000-4000-8000-000000000011",
  fileName: "sample.png", mimeType: "image/png", sizeBytes: 3, sha256: "a".repeat(64),
  uploadedAt: "2026-11-02T00:00:00Z", expiresAt: "2026-11-03T00:00:00Z", taskId: "task", availability: "READY" };
describe("image context through real Pi session", () => {
  it("projects server user references into image blocks without persisting bytes", async () => {
    const manager = SessionManager.inMemory("manao-project", { id: "conversation" });
    manager.appendCustomMessageEntry("manao_user_request", "inspect", true, { taskId: "task", attachments: [image] });
    const entries = structuredClone(manager.getEntries());
    const order:string[]=[];
    const backend = {
      readContext: vi.fn(async () => ({ header: manager.getHeader(), headSeq: entries.length,
        entries: entries.map((entry, i) => ({ seq: i + 1, sourceTaskId: "task", writerId: "task", entry })), nextAfterSeq: null })),
      appendContext: vi.fn(async (_id, batch) => { entries.push(...structuredClone(batch.entries)); return { headSeq: entries.length }; }),
      imageCatalog: vi.fn(async () => ({ kind: "image_catalog", items: [image], nextCursor: null })),
      imageMetadata: vi.fn(async () => {order.push("metadata");return image;}),
      imageContent: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" })),
      progress: vi.fn(async () => ({ accepted: true })),
    } as unknown as BackendClient;
    let seen = "";
    const task = await createPiSession({ environment: JAVA_ENVIRONMENT, model: { ...MODEL_CONFIG, imageInput: true }, paths: privateDirs(), backend,
      taskId: "task", conversationId: "conversation", progress: new ProgressChain(backend, "task"),
      deps: { now: () => Date.parse("2026-11-02T01:00:00Z"), createSession: async options => {
        const made=scriptedSessionFactory([{ text: "saw image" }], context => {order.push("provider");seen=JSON.stringify(context);})(options);
        const previous=made.session.agent.transformContext;
        made.session.agent.transformContext=async(messages,signal)=>{order.push("previous");return previous?await previous(messages,signal):messages;};
        return made;
      } } });
    const result = await task.run({ prompt: "inspect", workspaceRevision: "0" });
    expect(result.state).toBe("COMPLETED");
    expect(seen).toContain('"type":"image"');
    expect(seen).toContain("AQID");
    expect(JSON.stringify(entries)).not.toContain("AQID");
    expect(order[0]).toBe("previous");expect(order.at(-1)).toBe("provider");
    task.dispose();
  });
});

function backendHistory(manager: SessionManager) {
  const entries = structuredClone(manager.getEntries());
  const backend = {
    readContext: vi.fn(async (_id: string, after = 0) => ({header:manager.getHeader(),headSeq:entries.length,
      entries:entries.slice(after).map((entry,i)=>({seq:after+i+1,sourceTaskId:"task",writerId:"task",entry})),nextAfterSeq:null})),
    appendContext: vi.fn(async (_id: string,batch:{entries:SessionEntry[]})=>{entries.push(...structuredClone(batch.entries));return {headSeq:entries.length};}),
    imageCatalog:vi.fn(async()=>({kind:"image_catalog",items:[image],nextCursor:null})),
    imageMetadata:vi.fn(async()=>image),
    imageContent:vi.fn(async()=>({bytes:new Uint8Array([1,2,3]),mimeType:"image/png"})),
    invoke:vi.fn(async (_id: string,request:{toolCallId:string;args:Record<string,unknown>})=>({toolCallId:request.toolCallId,workspaceRevision:"0",
      data:request.args.attachmentId?{kind:"image_reference",image}:{kind:"image_catalog",items:[image],nextCursor:null},truncated:false})),
    progress:vi.fn(async()=>({accepted:true})),
  };
  return {backend,entries};
}
function sse(content: string,tool = false) {
  const delta=tool?{tool_calls:[{index:0,id:"read-original",type:"function",function:{name:"read_image",arguments:JSON.stringify({attachmentId:image.attachmentId})}}]}:{content};
  return new Response("data: "+JSON.stringify({id:"offline",object:"chat.completion.chunk",created:1,model:"scripted-1",choices:[{index:0,delta,finish_reason:null}]})
    +"\n\ndata: "+JSON.stringify({id:"offline",object:"chat.completion.chunk",created:1,model:"scripted-1",choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}]})
    +"\n\ndata: [DONE]\n\n",{status:200,headers:{"Content-Type":"text/event-stream"}});
}
it("uses the production session and ModelRuntime request path with only network fetch substituted",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","inspect",true,{taskId:"task",attachments:[image]});
  const fixture=backendHistory(manager),payloads:string[]=[];
  vi.stubGlobal("fetch",async(_input:RequestInfo|URL,init?:RequestInit)=>{payloads.push(String(init?.body));return sse("actual runtime received image");});
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z")}});
  const result=await task.run({prompt:"inspect",workspaceRevision:"0"});
  expect(result.state,JSON.stringify(result)).toBe("COMPLETED");
  expect(payloads).toHaveLength(1);expect(payloads[0]).toContain("data:image/png;base64,AQID");
  expect(JSON.stringify(fixture.entries)).not.toContain("AQID");task.dispose();
});
it("sends real image_url payload, compacts without binary reads, then restores and rereads via read_image",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","original image",true,{taskId:"task",attachments:[image]});
  for(let n=0;n<5;n++) {
    manager.appendMessage({role:"user",content:"later text "+n+"x".repeat(1000),timestamp:n+1});
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"previous reply "+n}],api:"openai-completions",provider:"manao-test",model:"scripted-1",stopReason:"stop",
      usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:n+1});
  }
  const fixture=backendHistory(manager), requests: string[]=[];
  let session!:AgentSession;
  let phase:"first"|"compact"|"reread"="first", rereadRound=0;
  const transport:typeof fetch=async(_input,init)=>{
    requests.push(String(init?.body));
    return sse(phase==="compact"?"Conversation summary without image details":"offline answer",phase==="reread"&&rereadRound++===0);
  };
  vi.stubGlobal("fetch",transport);
  const options={environment: JAVA_ENVIRONMENT, model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),backend:fixture.backend as unknown as BackendClient,
    taskId:"task",conversationId:"conversation",progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),settingsManager:SettingsManager.inMemory({compaction:{enabled:true,keepRecentTokens:20,reserveTokens:100}}),
      createSession:async(options:Parameters<typeof createAgentSession>[0])=>{
        const created=await createAgentSession(options);session=created.session;
        session.agent.streamFunction=(model,context,opts)=>streamSimple(model,context,{...opts,apiKey:"offline-test-key",fetch:opts?.fetch??transport});
        return created;
      }}};
  const first=await createPiSession(options);
  const outcome=await first.run({prompt:"inspect",workspaceRevision:"0"});
  expect(outcome.state,JSON.stringify(outcome)).toBe("COMPLETED");
  expect(requests[0]).toContain("image_url");
  expect(requests[0]).toContain("data:image/png;base64,AQID");
  // Restore into a fresh worker, then call the real Pi compact implementation before its prompt.
  first.dispose();
  phase="compact";
  const restored=await createPiSession({ environment: JAVA_ENVIRONMENT,...options,paths:privateDirs()});
  const before=fixture.backend.imageContent.mock.calls.length;
  await session.compact();
  for(let n=0;n<3;n++)session.sessionManager.appendMessage({role:"user",content:"another saved turn "+n+"x".repeat(1000),timestamp:n+20});
  await session.compact();
  expect(fixture.backend.imageContent.mock.calls.length).toBe(before);
  expect(JSON.stringify(session.sessionManager.buildSessionContext().messages)).not.toContain("manao_image_ref");
  phase="reread";
  expect((await restored.run({prompt:"inspect another detail",workspaceRevision:"0"})).state).toBe("COMPLETED");
  expect(fixture.backend.invoke.mock.calls.at(-1)?.[1].args).toEqual({attachmentId:image.attachmentId});
  expect(requests.at(-1)).toContain("data:image/png;base64,AQID");
  expect(JSON.stringify(fixture.entries)).not.toContain("AQID");
  expect(fixture.entries.filter(entry=>entry.type==="compaction")).toHaveLength(2);
  expect(requests.filter(body=>body.includes("Conversation summary")).length).toBeGreaterThan(0);
  restored.dispose();
});
it.each(["missing","unavailable","corrupt"])("fails explicitly for %s live originals instead of continuing as text",async(mode)=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","inspect",true,{taskId:"task",attachments:[image]});
  const fixture=backendHistory(manager);let providerCalls=0;
  if(mode==="corrupt")fixture.backend.imageContent.mockResolvedValue({bytes:new Uint8Array([1]),mimeType:"image/png"});
  else fixture.backend.imageMetadata.mockRejectedValue(new BackendHttpError(mode==="missing"?404:503,mode==="missing"?"AI_ATTACHMENT_NOT_FOUND":"AI_ATTACHMENT_UNAVAILABLE","safe image error"));
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),createSession:async options=>scriptedSessionFactory([{text:"must not answer"}],()=>{providerCalls++;})(options)}});
  const result=await task.run({prompt:"inspect",workspaceRevision:"0"});
  expect(result.state).toBe("FAILED");expect(result.failureCode).toBe(mode==="missing"?"AI_ATTACHMENT_NOT_FOUND":"AI_ATTACHMENT_UNAVAILABLE");
  expect(providerCalls).toBe(0);task.dispose();
});
it("aborts a pending binary read and never enters the provider after stop",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","inspect",true,{taskId:"task",attachments:[image]});
  const fixture=backendHistory(manager);let providerCalls=0,observed:AbortSignal|undefined,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  fixture.backend.imageContent.mockImplementation(async(_task,_id,signal)=>new Promise((resolve,reject)=>{
    observed=signal;started();signal?.addEventListener("abort",()=>reject(signal.reason),{once:true});
  }));
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),createSession:async options=>scriptedSessionFactory([{text:"must not answer"}],()=>{providerCalls++;})(options)}});
  const running=task.run({prompt:"inspect",workspaceRevision:"0"});await entered;task.stop();
  expect((await running).state).toBe("FAILED");expect(observed?.aborted).toBe(true);expect(providerCalls).toBe(0);task.dispose();
});

it("rejects cumulative legal uploads before reading any binary and never silently drops images",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  const refs=Array.from({length:4},(_,n)=>({...image,attachmentId:"00000000-0000-4000-8000-"+String(n+20).padStart(12,"0"),sizeBytes:10_000_000}));
  manager.appendCustomMessageEntry("manao_user_request","all four",true,{taskId:"task",attachments:refs});
  const fixture=backendHistory(manager);
  fixture.backend.imageMetadata.mockImplementation(async(_task,id)=>refs.find(ref=>ref.attachmentId===id)!);
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),createSession:async options=>scriptedSessionFactory([{text:"should not answer"}])(options)}});
  const result=await task.run({prompt:"all",workspaceRevision:"0"});
  expect(result.state).toBe("FAILED");
  expect(result.failureCode).toBe("AI_IMAGE_REQUEST_TOO_LARGE");
  expect(fixture.backend.imageContent).not.toHaveBeenCalled();
  task.dispose();
});

it("rechecks an old successful read_image receipt after expiry and does not resend bytes",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:"old",name:"read_image",arguments:{attachmentId:image.attachmentId}}],
    api:"openai-completions",provider:"manao-test",model:"scripted-1",stopReason:"toolUse",timestamp:1,
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  manager.appendMessage({role:"toolResult",toolCallId:"old",toolName:"read_image",
    content:[{type:"text",text:JSON.stringify({kind:"image_reference",image})}],
    details:{data:{kind:"image_reference",image}},isError:false,timestamp:1});
  const fixture=backendHistory(manager);
  fixture.backend.imageMetadata.mockResolvedValue({...image,availability:"EXPIRED"});
  let seen="";
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-03T00:00:00Z"),createSession:async options=>scriptedSessionFactory([{text:"expired"}],context=>{seen=JSON.stringify(context);})(options)}});
  expect((await task.run({prompt:"again",workspaceRevision:"0"})).state).toBe("COMPLETED");
  expect(seen).not.toContain('"type":"image"');
  expect(seen).toContain("图片已失效，请重新上传");
  expect(fixture.backend.imageMetadata).toHaveBeenCalledWith("task",image.attachmentId,expect.anything());
  expect(fixture.backend.imageContent).not.toHaveBeenCalled();
  task.dispose();
});
it("counts projected images before automatic native compaction and never reads them for the summary",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendMessage({role:"user",content:"earlier separate turn "+"y".repeat(100_000),timestamp:0});
  manager.appendMessage({role:"user",content:"old history "+"x".repeat(100_000),timestamp:1});
  manager.appendMessage({role:"assistant",content:[{type:"text",text:"old response"}],api:"openai-completions",provider:"manao-test",model:"scripted-1",stopReason:"stop",timestamp:2,
    usage:{input:775_000,output:0,cacheRead:0,cacheWrite:0,totalTokens:775_000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  manager.appendMessage({role:"user",content:"recent separate turn",timestamp:3});
  manager.appendMessage({role:"assistant",content:[{type:"text",text:"recent response"}],api:"openai-completions",provider:"manao-test",model:"scripted-1",stopReason:"stop",timestamp:4,
    usage:{input:775_000,output:0,cacheRead:0,cacheWrite:0,totalTokens:775_000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const refs=Array.from({length:10},(_,n)=>({...image,attachmentId:"00000000-0000-4000-8000-"+String(n+50).padStart(12,"0")}));
  manager.appendCustomMessageEntry("manao_user_request","inspect all current images",true,{taskId:"task",attachments:refs});
  const fixture=backendHistory(manager),requests:{summary:boolean;content:string}[]=[];
  fixture.backend.imageMetadata.mockImplementation(async(_task,id)=>refs.find(ref=>ref.attachmentId===id)!);
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),
      createSession:async options=>scriptedSessionFactory([], (context,session)=>{requests.push({summary:session.isCompacting,content:JSON.stringify(context)});
        if(session.isCompacting)expect(fixture.backend.imageContent).not.toHaveBeenCalled();
      },(_context,session)=>({text:session.isCompacting?"native summary":"images received"}))(options)}});
  const result=await task.run({prompt:"inspect",workspaceRevision:"0"});
  expect(result.state,JSON.stringify(result)).toBe("COMPLETED");
  expect(requests[0]?.summary).toBe(true);
  expect(requests.filter(request=>request.summary).every(request=>!request.content.includes('"type":"image"'))).toBe(true);
  expect(requests.at(-1)?.content).toContain('"type":"image"');
  expect(fixture.backend.imageContent).toHaveBeenCalledTimes(10);
  task.dispose();
});

it("provider retries cannot resend the encoded image payload after the deadline",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","inspect",true,{taskId:"task",attachments:[image]});
  const fixture=backendHistory(manager);
  let now=Date.parse("2026-11-02T23:59:59Z"), sent=0;
  const transport:typeof fetch=async()=>{
    sent++; now=Date.parse("2026-11-03T00:00:00Z");
    return new Response('{"error":{"message":"retry"}}',{status:503,headers:{"Content-Type":"application/json","retry-after":"0"}});
  };
  vi.stubGlobal("fetch",transport);
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>now,settingsManager:SettingsManager.inMemory({retry:{enabled:false}}),
      createSession:async options=>{const created=await createAgentSession(options);created.session.agent.streamFunction=(model,context,opts)=>streamSimple(model,context,{...opts,maxRetries:1,apiKey:"offline-test-key",fetch:opts?.fetch??transport});return created;}}});
  const result=await task.run({prompt:"inspect",workspaceRevision:"0"});
  expect(result.state).toBe("FAILED");
  expect(sent).toBe(1);
  expect(result.failureCode).toBe("AI_ATTACHMENT_EXPIRED");
  task.dispose();
});
it("refuses active image references explicitly after model image capability is disabled",async()=>{
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","old image",true,{taskId:"task",attachments:[image]});
  const fixture=backendHistory(manager);
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:false},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>Date.parse("2026-11-02T01:00:00Z"),createSession:async options=>scriptedSessionFactory([{text:"should not claim to see image"}])(options)}});
  const result=await task.run({prompt:"look again",workspaceRevision:"0"});
  expect(result.state).toBe("FAILED");expect(result.failureCode).toBe("AI_IMAGE_INPUT_DISABLED");
  expect(fixture.backend.imageContent).not.toHaveBeenCalled();task.dispose();
});
it("rechecks all deadlines after the last asynchronous authorization before a multi-image send",async()=>{
  const second={...image,attachmentId:"00000000-0000-4000-8000-000000000012",expiresAt:"2026-11-03T01:00:00Z"};
  const manager=SessionManager.inMemory("manao-project",{id:"conversation"});
  manager.appendCustomMessageEntry("manao_user_request","two images",true,{taskId:"task",attachments:[image,second]});
  const fixture=backendHistory(manager);let now=Date.parse("2026-11-02T23:59:59Z"),secondReads=0,sent=0;
  fixture.backend.imageMetadata.mockImplementation(async(_task,id)=>{
    if(id===second.attachmentId){if(++secondReads===2)now=Date.parse("2026-11-03T00:00:00Z");return second;}return image;
  });
  const transport:typeof fetch=async()=>{sent++;return sse("should not receive expired first image");};
  vi.stubGlobal("fetch",transport);
  const task=await createPiSession({ environment: JAVA_ENVIRONMENT,model:{...MODEL_CONFIG,imageInput:true},paths:privateDirs(),taskId:"task",conversationId:"conversation",
    backend:fixture.backend as unknown as BackendClient,progress:new ProgressChain(fixture.backend as unknown as BackendClient,"task"),
    deps:{now:()=>now,settingsManager:SettingsManager.inMemory({retry:{enabled:false}}),
      createSession:async options=>{const created=await createAgentSession(options);created.session.agent.streamFunction=(model,context,opts)=>streamSimple(model,context,{...opts,apiKey:"offline-test-key",fetch:opts?.fetch??transport});return created;}}});
  const result=await task.run({prompt:"inspect",workspaceRevision:"0"});
  expect(sent).toBe(0);expect(result.state).toBe("FAILED");task.dispose();
});
