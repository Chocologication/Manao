import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync,writeFileSync,existsSync, mkdirSync, createWriteStream,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
const root=resolve(import.meta.dirname,'../../../../..');
const evidence=resolve(process.env.MANAO_AI_LOCAL_EVIDENCE_DIR ?? resolve(root,'.superpowers/sdd/2026-10-25-ai-terminal-settlement-implementation-plan'));
export default async function setup(){
  for(const port of [18989,18990,18991,18992,18993,18994])await new Promise<void>((ok,no)=>{const s=createServer();s.once('error',no);s.listen(port,'127.0.0.1',()=>s.close(()=>ok()));});
  const env:NodeJS.ProcessEnv={};
  for(const key of Object.keys(process.env))if(/^(PATH|JAVA_HOME|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PNPM_HOME)$/i.test(key))env[key]=process.env[key];
  env.MANAO_DB_USERNAME=process.env.MANAO_TERMINAL_TEST_DB_USERNAME;
  env.MANAO_DB_PASSWORD=process.env.MANAO_TERMINAL_TEST_DB_PASSWORD;
  if(!env.MANAO_DB_USERNAME || env.MANAO_DB_PASSWORD === undefined)throw Error('Explicit local terminal test MySQL credentials required');
  const schema='manao_stage6_terminal_'+randomUUID().replaceAll('-','');
  const scratch=mkdtempSync(resolve(tmpdir(),'manao-terminal-local-'));
  env.MANAO_TERMINAL_SCRATCH_ROOT=scratch;
  env.MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/'+schema;
  env.MANAO_AI_INTERNAL_TOKEN=randomUUID();env.MANAO_AI_WORKER_TOKEN=randomUUID();env.MANAO_JWT_SECRET=randomUUID()+randomUUID();env.MANAO_TERMINAL_LOCAL_HARNESS='true';
  // The controlled test environment never inherits model or Kubernetes configuration.
  for(const key of Object.keys(env))if(/KUBECONFIG|MANAO_AI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|MANAO_AI_BASE_URL/.test(key))delete env[key];
  mkdirSync(evidence,{recursive:true});
  const cp=[resolve(root,'poc4/backend/target/test-classes'),resolve(root,'poc4/backend/target/classes'),readFileSync(resolve(root,'poc4/backend/target/terminal-local-classpath.txt'),'utf8').trim()].join(';');
  const processes:ChildProcess[]=[];
  const launch=(name:string,cmd:string,args:string[],cwd=root)=>{
    const p=spawn(cmd,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const log=createWriteStream(resolve(evidence,`task-8-${name}.log`));p.stdout!.pipe(log);p.stderr!.pipe(log);processes.push(p);return p;
  };
  try { execFileSync('java',['-cp',cp,'com.manao.poc4.persistence.LocalDisposableSchema','create',schema],{cwd:root,env,stdio:'ignore',windowsHide:true}); }
  catch { rmSync(scratch,{recursive:true}); throw Error('Loopback disposable schema creation failed; verify test-account privileges'); }
  let backend:ChildProcess;
  try{
    backend=launch('http-backend','java',['-cp',cp,'com.manao.poc4.ai.TerminalSettlementLocalServer']);
    const ready=async(url:string,process?:ChildProcess)=>{const until=Date.now()+45_000;while(Date.now()<until){if(process?.exitCode!==null&&process?.exitCode!==undefined)throw Error('Owned fixture exited before readiness; inspect sanitized local log');try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Local fixture did not become ready');};
    await ready('http://127.0.0.1:18991/__fixture/ready',backend);
    let worker=launch('scripted-worker','cmd.exe',['/d','/s','/c','pnpm exec vitest run test/local-terminal-harness.test.ts'],resolve(root,'poc4/pi-worker'));
    await ready('http://127.0.0.1:18990/__control/stats',worker);
    // Browser cases can rebuild the actual Java backend without exposing a production route.
    const restart=createServer(socket=>{socket.end();backend.kill();backend.once('exit',()=>{backend=launch('http-backend-rebuilt','java',['-cp',cp,'com.manao.poc4.ai.TerminalSettlementLocalServer']);});});
    await new Promise<void>(r=>restart.listen(18993,'127.0.0.1',r));
    const workerRestart=createServer(socket=>{socket.end();execFileSync('taskkill',['/PID',String(worker.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});worker=launch('scripted-worker-rebuilt','cmd.exe',['/d','/s','/c','pnpm exec vitest run test/local-terminal-harness.test.ts'],resolve(root,'poc4/pi-worker'));});
    await new Promise<void>(r=>workerRestart.listen(18994,'127.0.0.1',r));
    return async()=>{restart.close();workerRestart.close();for(const p of processes.reverse()){try{if(p.exitCode===null&&p.signalCode===null&&!p.killed){if(process.platform==='win32')execFileSync('taskkill',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else p.kill();}
      if(p.exitCode===null&&p.signalCode===null)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned process exit unconfirmed')),3000);p.once('exit',()=>{clearTimeout(timer);resolve();});});
    }catch(error){console.error('Owned process teardown failed',p.pid);}}
      execFileSync('java',['-cp',cp,'com.manao.poc4.persistence.LocalDisposableSchema','drop',schema],{cwd:root,env,stdio:'ignore',windowsHide:true});
      rmSync(scratch,{recursive:true});
      writeFileSync(resolve(evidence,'cleanup.json'),JSON.stringify({schema,dropped:true,scratch,scratchRemoved:!existsSync(scratch),pids:processes.map(p=>p.pid),processesExited:processes.every(p=>p.exitCode!==null||p.signalCode!==null)},null,2),'utf8');
      console.log('Dropped owned local terminal schema '+schema);};
  }catch(error){for(const p of processes)try{if(p.pid)execFileSync('taskkill',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}
    execFileSync('java',['-cp',cp,'com.manao.poc4.persistence.LocalDisposableSchema','drop',schema],{cwd:root,env,stdio:'ignore',windowsHide:true});rmSync(scratch,{recursive:true});throw error;}
}
