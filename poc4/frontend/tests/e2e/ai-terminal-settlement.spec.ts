import { test,expect,type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { readFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
const backend='http://127.0.0.1:18991';
const worker='http://127.0.0.1:18990';
const api=backend+'/api/v1/projects/terminal-project';
async function auth(request:APIRequestContext,owner='terminal-owner'){const r=await request.post(`${backend}/__fixture/login?owner=${owner}`);return {Authorization:`Bearer ${(await r.json()).accessToken}`};}
async function row(request:APIRequestContext,id:string){return (await request.get(`${backend}/__fixture/rows/${id}`)).json();}
async function stats(request:APIRequestContext){return (await request.get(`${worker}/__control/stats`)).json();}
async function delivery(request:APIRequestContext,id:string){const response=await request.get(`${worker}/__control/delivery?taskId=${id}`);expect(response.ok()).toBe(true);return response.json();}
async function mode(request:APIRequestContext,query=''){await request.post(`${worker}/__control/mode?${query}`);}
async function submit(request:APIRequestContext){const id=randomUUID();const response=await request.post(api+'/agent-tasks',{headers:await auth(request),data:{taskId:id,prompt:'local deterministic task',expectedWorkspaceRevision:'7',reasoningEffort:'off'}});expect(response.ok(),await response.text()).toBe(true);return id;}
async function completed(request:APIRequestContext,id:string){await expect.poll(async()=>{const r=await row(request,id);return r.state==='FAILED'?`FAILED:${r.failure_code}`:r.state;},{timeout:25_000}).toBe('COMPLETED');}
async function receipted(request:APIRequestContext,id:string){await expect.poll(async()=>(await row(request,id)).receipts).toBe(1);}
async function release(request:APIRequestContext){await request.post(`${worker}/__control/release`);await request.post(`${backend}/__fixture/gate/release`);await request.post(`${backend}/__fixture/reconcile?enabled=true`);}
test.afterEach(async({request})=>{
  await release(request);const headers=await auth(request);
  const current=await request.get(api+'/agent-tasks/current',{headers});
  if(current.ok()){const task=await current.json();await request.post(api+`/agent-tasks/${task.taskId}/close`,{headers});
    const active=await (await request.get(api+'/runs/active',{headers})).json();
    if(active.run)for(let attempt=0;attempt<10;attempt++){await request.post(`${backend}/__fixture/job-stopped/${active.run.id}`);await request.post(`${backend}/__fixture/tick/${task.taskId}`);if((await request.get(api+'/agent-tasks/current',{headers})).status()===404)break;}
  }
  await expect.poll(async()=>(await request.get(api+'/agent-tasks/current',{headers})).status()).toBe(404);
  await expect.poll(async()=>(await stats(request)).activeTaskId,{timeout:15_000}).toBeNull();
});
test.afterAll(async()=>{
  const dir=resolve(process.env.MANAO_AI_LOCAL_EVIDENCE_DIR ?? resolve(import.meta.dirname,'../../../../.superpowers/sdd/2026-10-25-ai-terminal-settlement-implementation-plan'));
  for(const name of ['http-backend','http-backend-rebuilt','scripted-worker','scripted-worker-rebuilt']){
    const path=resolve(dir,`task-8-${name}.log`);if(!existsSync(path))continue;const text=readFileSync(path,'utf8');
    expect(text).not.toMatch(/local deterministic task|browser second deterministic task|本地 scripted provider 已完成|x-manao-worker-token|Authorization: Bearer|MANAO_DB_PASSWORD|apiKey|test-only-key/i);
    for(const line of text.split(/\r?\n/).filter(l=>l.startsWith('[terminal-delivery] '))){const record=JSON.parse(line.slice('[terminal-delivery] '.length));expect(Object.keys(record).sort()).toEqual(['attempt','code','elapsed','epoch','kind','nextRetryAt','reportId','status','taskId'].sort());}
  }
});
test('real HTTP worker Pi SDK terminal receipt settles once without model replay',async({request,page})=>{
  const login=await request.post(`${backend}/__fixture/login`);expect(login.ok()).toBe(true);
  const {accessToken}=await login.json();const headers={Authorization:`Bearer ${accessToken}`};
  const id=randomUUID();
  const start=await request.post(`${backend}/api/v1/projects/terminal-project/agent-tasks`,{headers,data:{taskId:id,prompt:'本地确定性验收',expectedWorkspaceRevision:'7',reasoningEffort:'off'}});
  expect(start.ok()).toBe(true);
  await expect.poll(async()=>{const row=await (await request.get(`${backend}/__fixture/rows/${id}`)).json();return row.state==='FAILED'?`FAILED:${row.failure_code}`:row.state;}).toBe('COMPLETED');
  const row=await (await request.get(`${backend}/__fixture/rows/${id}`)).json();expect(row.receipts).toBe(1);expect(row.calls).toBe(1);
  const stats=await (await request.get(`${worker}/__control/stats`)).json();expect(stats.starts).toBe(1);expect(stats.modelCalls).toBe(2);
  await page.goto('/tests/fixtures/ai-terminal-settlement/index.html');await page.getByRole('button',{name:'重新登录'}).click();
  await expect(page.getByRole('heading',{name:'Local real HTTP settlement fixture'})).toBeVisible();
});

test('A gate contention stores one receipt independently and background reconciliation unlocks',async({request})=>{
  const before=await stats(request);await mode(request,'wait=true');const id=await submit(request);
  await expect.poll(async()=>(await row(request,id)).calls).toBe(1);
  await request.post(`${backend}/__fixture/gate/hold`);await request.post(`${worker}/__control/release`);
  await receipted(request,id);expect((await row(request,id)).state).toBe('NEEDS_ATTENTION');
  const locked=await request.post(api+'/entries',{headers:await auth(request),data:{kind:'directory',path:'gate-write',expectedWorkspaceRevision:'7'}});expect(locked.status()).toBe(409);
  await request.post(`${backend}/__fixture/gate/release`);await completed(request,id);
  const after=await stats(request);expect(after.starts-before.starts).toBe(1);expect(after.modelCalls-before.modelCalls).toBe(2);expect(after.externalFetches).toBe(0);
});
test('C lost ACK redelivers the same report without a second model or tool',async({request})=>{
  const before=await stats(request);await mode(request,'dropAck=true');const id=await submit(request);await completed(request,id);await expect.poll(async()=>(await stats(request)).dropped-before.dropped).toBe(1);
  const saved=await row(request,id);await expect.poll(async()=>(await stats(request)).terminalPosts-before.terminalPosts).toBeGreaterThanOrEqual(2);
  const after=await row(request,id);expect(after.terminal_report_id).toBe(saved.terminal_report_id);expect(after.terminal_report_sha256).toBe(saved.terminal_report_sha256);expect(after.receipts).toBe(1);expect(after.calls).toBe(1);
  const counts=await stats(request);expect(counts.starts-before.starts).toBe(1);expect(counts.modelCalls-before.modelCalls).toBe(2);
});
test('B progress37 stays missing while independent terminal is persisted and settled',async({request})=>{
  await request.post(`${backend}/__fixture/reconcile?enabled=false`);await mode(request,'gap37=true');const id=await submit(request);await receipted(request,id);await request.post(`${backend}/__fixture/tick/${id}`);await completed(request,id);const r=await row(request,id);
  expect(r.receipts).toBe(1);expect(r.calls).toBe(1);const progress=JSON.parse(r.progress_json);expect(progress.lastSeq).toBe(36);expect(progress.items.some((p:{seq:number})=>p.seq===36)).toBe(true);expect(progress.items.some((p:{seq:number})=>p.seq===37)).toBe(false);expect((await stats(request)).gapDrops).toBeGreaterThan(0);
});
test('D backend process rebuild resumes a persisted receipt without browser or replay',async({request})=>{
  const before=await stats(request);await mode(request,'wait=true');const id=await submit(request);await expect.poll(async()=>(await row(request,id)).calls).toBe(1);
  await request.post(`${backend}/__fixture/gate/hold`);await request.post(`${worker}/__control/release`);await receipted(request,id);const saved=await row(request,id);expect(saved.state).toBe('NEEDS_ATTENTION');
  await new Promise<void>((resolve,reject)=>{const socket=connect(18993,'127.0.0.1');socket.once('connect',()=>socket.end());socket.once('close',()=>resolve());socket.once('error',reject);});
  await expect.poll(async()=>{try{return (await request.get(`${backend}/__fixture/ready`)).ok();}catch{return false;}},{timeout:45_000}).toBe(true);await completed(request,id);
  expect((await row(request,id)).terminal_report_id).toBe(saved.terminal_report_id);expect((await stats(request)).modelCalls).toBe(before.modelCalls+2);expect((await stats(request)).starts).toBe(before.starts+1);
});
test('E legacy Worker reboot before receipt preserves occupancy until durable deadline close',async({request})=>{
  await request.post(`${backend}/__fixture/reconcile?enabled=false`);await mode(request,'terminal=true');const id=await submit(request);
  await expect.poll(async()=>(await row(request,id)).calls).toBe(1);await expect.poll(async()=>(await stats(request)).terminalPosts).toBeGreaterThan(0);expect((await row(request,id)).receipts).toBe(0);
  await request.post(`${backend}/__fixture/legacy-task/${id}`);
  await new Promise<void>((resolve,reject)=>{const socket=connect(18994,'127.0.0.1');socket.once('connect',()=>socket.end());socket.once('close',()=>resolve());socket.once('error',reject);});
  await expect.poll(async()=>{try{return (await request.get(`${worker}/__control/stats`)).ok();}catch{return false;}},{timeout:30_000}).toBe(true);
  await request.post(`${backend}/__fixture/tick/${id}`);expect((await row(request,id)).state).toBe('RUNNING');
  await request.post(`${backend}/__fixture/clock?advance=1801`);await request.post(`${backend}/__fixture/tick/${id}`);
  expect((await row(request,id)).state).toBe('RUNNING');expect((await row(request,id)).close_reason_code).toBeNull();
  await request.post(api+`/agent-tasks/${id}/close`,{headers:await auth(request)});
  await expect.poll(async()=>(await row(request,id)).state).toBe('FAILED');expect((await row(request,id)).close_reason_code).toBe('AI_CLOSED');expect((await row(request,id)).receipts).toBe(0);
});
test('I owner close waits for actual Run observation and late completion cannot reverse it',async({request,page})=>{
  await request.post(`${backend}/__fixture/reconcile?enabled=false`);const before=await stats(request);await mode(request,'wait=true&terminal=true');const id=await submit(request);await expect.poll(async()=>(await row(request,id)).calls).toBe(1);
  const seeded=await request.post(`${backend}/__fixture/ready-run/${id}`);expect(seeded.ok(),await seeded.text()).toBe(true);const {runId}=await seeded.json();
  await request.post(`${worker}/__control/finish-model`);await expect.poll(async()=>(await stats(request)).terminalPosts).toBeGreaterThan(before.terminalPosts);expect((await row(request,id)).receipts).toBe(0);
  await page.goto('/tests/fixtures/ai-terminal-settlement/index.html');await page.getByRole('button',{name:'重新登录'}).click();
  await expect(page.getByTestId('browser-write')).toBeDisabled();
  await page.getByRole('button',{name:'End task'}).click();await expect(page.getByRole('status',{name:'Task settlement'})).toBeVisible();
  await expect(page.getByTestId('browser-write')).toBeDisabled();expect((await row(request,id)).state).toBe('NEEDS_ATTENTION');
  await expect.poll(async()=>{await request.post(`${backend}/__fixture/job-stopped/${runId}`);const run=await (await request.get(api+`/runs/${runId}`,{headers:await auth(request)})).json();return run.state;},{timeout:25_000}).toBe('CANCELLED');await request.post(`${backend}/__fixture/tick/${id}`);
  await expect.poll(async()=>(await row(request,id)).state).toBe('FAILED');await expect(page.getByTestId('browser-write')).toBeEnabled();
  await page.reload();await page.getByRole('button',{name:'重新登录'}).click();await expect(page.getByTestId('task-state')).toHaveText('FAILED');
  const foreign=await request.get(api+`/agent-tasks/${id}`,{headers:await auth(request,'foreign-owner')});expect(foreign.status()).toBe(404);
  const saved=await row(request,id);const frozen=await delivery(request,id);
  expect(frozen).toMatchObject({taskId:id,executionState:'COMPLETED',deliveryState:'PENDING',reportedOutcome:'COMPLETED'});expect(frozen.reportId).toMatch(/^[0-9a-f]{64}$/);expect(frozen.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  await release(request);
  await expect.poll(async()=>{const current=await delivery(request,id);return {taskId:current.taskId,reportId:current.reportId,reportSha256:current.reportSha256,deliveryState:current.deliveryState,activeTaskId:current.activeTaskId};},{timeout:15_000}).toEqual({taskId:id,reportId:frozen.reportId,reportSha256:frozen.reportSha256,deliveryState:'CLOSING',activeTaskId:null});
  const accepted=await delivery(request,id);expect(accepted).toMatchObject({executionState:'COMPLETED',reportedOutcome:'COMPLETED'});
  await request.post(`${backend}/__fixture/tick/${id}`);const after=await row(request,id);
  expect(after).toMatchObject({state:'FAILED',failure_code:saved.failure_code,close_reason_code:saved.close_reason_code,receipts:1,calls:saved.calls,terminal_report_id:frozen.reportId,terminal_report_sha256:frozen.reportSha256});
  const counts=await stats(request);expect(counts.starts-before.starts).toBe(1);expect(counts.modelCalls-before.modelCalls).toBe(2);expect(counts.externalFetches).toBe(0);expect(counts.terminalPosts).toBeGreaterThan(before.terminalPosts);
  await page.reload();await page.getByRole('button',{name:'重新登录'}).click();await expect(page.getByTestId('task-state')).toHaveText('FAILED');
});
test('H and N browser completion preserves READY Run then new task and write resume',async({request,page})=>{
  await mode(request,'wait=true');const id=await submit(request);await expect.poll(async()=>(await row(request,id)).calls).toBe(1);const {runId}=await (await request.post(`${backend}/__fixture/ready-run/${id}`)).json();
  await page.goto('/tests/fixtures/ai-terminal-settlement/index.html');await page.getByRole('button',{name:'重新登录'}).click();await expect(page.getByTestId('browser-write')).toBeDisabled();
  await request.post(`${worker}/__control/release`);await completed(request,id);await expect(page.getByTestId('browser-write')).toBeDisabled();
  const run=await (await request.get(api+`/runs/${runId}`,{headers:await auth(request)})).json();expect(run.state).toBe('RUNNING');expect(run.firstReadyAt).toBeTruthy();
  await page.getByRole('button',{name:'新建会话'}).click();await expect(page.getByRole('heading',{name:'新会话'})).toBeVisible();await page.getByRole('button',{name:/推理强度/}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByLabel('Task goal').fill('browser second deterministic task');await expect(page.getByLabel('Task goal')).toHaveValue('browser second deterministic task');
  const taskResponse=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/tasks'));await page.getByRole('button',{name:'Start task'}).click();const response=await taskResponse;expect(response.ok(),await response.text()).toBe(true);
  await expect.poll(async()=>page.evaluate(()=>sessionStorage.getItem('terminal-task'))).not.toBe(id);
  const second=(await page.evaluate(()=>sessionStorage.getItem('terminal-task')))!;await completed(request,second);
  await expect(page.getByRole('button',{name:'Stop run'})).toBeEnabled();
  await page.getByRole('button',{name:'Stop run'}).click();await expect.poll(async()=>{await request.post(`${backend}/__fixture/job-stopped/${runId}`);return (await (await request.get(api+`/runs/${runId}`,{headers:await auth(request)})).json()).state;}).toBe('CANCELLED');
  await page.getByTestId('browser-write').click();await expect(page.locator('#write-result')).toHaveText('201');
  await page.reload();await page.getByRole('button',{name:'重新登录'}).click();await expect(page.getByTestId('task-state')).toHaveText('COMPLETED');
});
