import { test } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { createTaskServer } from '../src/server.js';
import { scriptedSessionFactory, MODEL_CONFIG } from './scripted-session.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { BackendClient,ProgressChain } from '../src/backend-client.js';

// Launched only by the dedicated local Playwright setup. No external provider is configured.
test.skipIf(process.env.MANAO_TERMINAL_LOCAL_HARNESS !== 'true')('serve the actual worker and Pi SDK for loopback HTTP/browser verification', async () => {
  const token = process.env.MANAO_AI_WORKER_TOKEN!;
  let modelCalls = 0, starts = 0, terminalPosts = 0, dropped = 0;
  let waitModel = false, holdTerminal = false, dropAck = false, gap37 = false, toolCount=1;
  let externalFetches=0;
  let readCurrent=false, unknownStatus=false;
  let modelWaiting=false;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=((input: string|URL|Request,init?:RequestInit)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
    if(url.hostname!=='127.0.0.1'){externalFetches++;throw Error('External network forbidden in local scripted verification');}
    return originalFetch(input,init);
  }) as typeof fetch;
  let release: (() => void) | null = null;
  let lastProgressAccepted=0,gapDrops=0;
  let originalTask='',instance='';
  const scratchDir=mkdtempSync(join(process.env.MANAO_TERMINAL_SCRATCH_ROOT!,'worker-'));
  const paths={scratchDir,agentDir:join(scratchDir,'agent'),sessionDir:join(scratchDir,'sessions')};
  mkdirSync(paths.agentDir,{recursive:true});mkdirSync(paths.sessionDir,{recursive:true});
  // Production validates the provider capability before creating a session. The injected
  // SDK stream below is the only model execution path; this placeholder never calls it.
  const scriptedModel={...MODEL_CONFIG,provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-chat'};
  let handle: ReturnType<typeof createTaskServer>;
  const boot = async () => {
    const bootId=randomUUID();
    instance=`local-${bootId}`;
    handle=createTaskServer({ port:18989, workerToken:token, backendBaseUrl:'http://127.0.0.1:18992',
      backendToken:process.env.MANAO_AI_INTERNAL_TOKEN!, instanceId:instance,bootId,model:scriptedModel,paths,
      budgets:{wallClockSeconds:1800,toolCalls:180,builds:20} }, {
      createManualSession: async options => {
        if(gap37){
          const prelude=new ProgressChain(new BackendClient({baseUrl:'http://127.0.0.1:18992',token:process.env.MANAO_AI_INTERNAL_TOKEN!,instanceId:instance,epoch:1}),originalTask);
          for(let seq=1;seq<=38;seq++)prelude.send('message',`transport prelude ${seq}`);
          await prelude.drain();
        }
        let step=0;return scriptedSessionFactory([], () => {modelCalls++;}, async (_context,_session,signal) => {
        const current=step++;
        if(waitModel && current>=toolCount) { modelWaiting=true; await new Promise<void>(resolve => {release=resolve;signal?.addEventListener('abort',resolve,{once:true});}); modelWaiting=false; }
        if(signal?.aborted)return {stopReason:'aborted'};
        if(current<toolCount){await new Promise(r=>setTimeout(r,25));return {toolCalls:[readCurrent
          ? {id:`read-${current}`,name:'read_file',args:{path:'pom.xml'}}
          : {id:`list-${current}`,name:'list_files',args:{directory:''}}]};}
        return {text:'本地 scripted provider 已完成。'};
      })(options);},
    });
    await new Promise<void>((resolve,reject) => {handle.server.once('error',reject);handle.server.listen(18989,'127.0.0.1',resolve);});
  };
  await boot();
  const forward=(req: import('node:http').IncomingMessage,res: import('node:http').ServerResponse,port:number) => {
    const outgoing=httpRequest({host:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},incoming=>{
      if(port===18991 && req.url?.endsWith('/terminal') && req.method==='POST' && dropAck){
        dropAck=false;dropped++;incoming.resume();incoming.on('end',()=>res.destroy());return;
      }
      res.writeHead(incoming.statusCode??500,incoming.headers);incoming.pipe(res);
    });
    outgoing.on('error',()=>{res.writeHead(502);res.end('{"code":"TEST_TRANSPORT_UNAVAILABLE"}');});
    req.pipe(outgoing);
  };
  const proxy=createServer(async(req,res)=>{
    if(req.url?.startsWith('/__control')){
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/__control/delivery'){
        const taskId=url.searchParams.get('taskId');
        if(!taskId||!/^[0-9a-f-]{36}$/.test(taskId)){res.writeHead(422);res.end('{}');return;}
        const response=await fetch(`http://127.0.0.1:18989/tasks/${taskId}`,{headers:{'x-manao-worker-token':token}});
        if(!response.ok){res.writeHead(response.status);res.end('{}');return;}
        const status=await response.json() as {taskId:string;executionState:string;terminalDelivery:{state:string;reportId:string|null;reportSha256:string|null;report:{state:string}|null}};
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({taskId:status.taskId,executionState:status.executionState,deliveryState:status.terminalDelivery.state,reportId:status.terminalDelivery.reportId,reportSha256:status.terminalDelivery.reportSha256,reportedOutcome:status.terminalDelivery.report?.state??null,activeTaskId:handle.activeTaskId()}));return;
      }
      if(url.pathname==='/__control/mode'){
        waitModel=url.searchParams.get('wait')==='true';holdTerminal=url.searchParams.get('terminal')==='true';dropAck=url.searchParams.get('dropAck')==='true';gap37=url.searchParams.get('gap37')==='true';toolCount=1;
        readCurrent=url.searchParams.get('readCurrent')==='true';unknownStatus=url.searchParams.get('unknown')==='true';
      }
      if(url.pathname==='/__control/release'){waitModel=false;release?.();release=null;holdTerminal=false;}
      if(url.pathname==='/__control/finish-model'){waitModel=false;release?.();release=null;}
      if(url.pathname==='/__control/reboot'){await handle.close();await boot();}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({modelCalls,starts,terminalPosts,dropped,externalFetches,gapDrops,lastProgressAccepted,modelWaiting,activeTaskId:handle.activeTaskId()}));return;
    }
    if(unknownStatus && req.method==='GET' && (req.url==='/status'||req.url?.startsWith('/tasks/'))){res.writeHead(503);res.end('{}');return;}
    if(req.method==='POST' && req.url?.endsWith('/start')){starts++;lastProgressAccepted=0;originalTask=req.url.split('/')[2]!;}
    forward(req,res,18989);
  });
  const callback=createServer((req,res)=>{
    if(req.method==='POST' && req.url?.endsWith('/terminal')){
      terminalPosts++;
      if(holdTerminal){res.writeHead(503);res.end('{"code":"TEST_RETRY"}');return;}
    }
    if(req.method==='POST' && req.url?.endsWith('/progress') && gap37){
      // Drop seq37 at the transport, then enforce the real backend's gap handling.
      const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
        const body=Buffer.concat(chunks);const item=JSON.parse(body.toString());
        if(item.seq===37){gapDrops++;res.writeHead(503);res.end('{}');return;}
        const out=httpRequest({host:'127.0.0.1',port:18991,path:req.url,method:req.method,headers:req.headers},incoming=>{if(incoming.statusCode===200)lastProgressAccepted=Math.max(lastProgressAccepted,item.seq);res.writeHead(incoming.statusCode??500,incoming.headers);incoming.pipe(res);});
        out.on('error',()=>{res.writeHead(502);res.end('{}');});out.end(body);
      });return;
    }
    forward(req,res,18991);
  });
  await Promise.all([new Promise<void>(r=>proxy.listen(18990,'127.0.0.1',r)),new Promise<void>(r=>callback.listen(18992,'127.0.0.1',r))]);
  process.stdout.write('TERMINAL_WORKER_READY loopback scripted provider\n');
  await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  await handle.close();proxy.close();callback.close();globalThis.fetch=originalFetch;
},600_000);
