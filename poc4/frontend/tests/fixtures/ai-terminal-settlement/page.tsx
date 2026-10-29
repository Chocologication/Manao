import { createRoot } from 'react-dom/client';
import { useEffect,useState } from 'react';
import { QueryClient,QueryClientProvider,useQuery } from '@tanstack/react-query';
import { AgentConversationPanel } from '@/features/ai/AgentConversationPanel';
import { useCurrentAgentTaskQuery,useCloseAgentTaskMutation,usePauseAgentTaskMutation } from '@/features/ai/agentTaskQueries';
import { listDirectory,saveFileContent } from '@/api/fileApi';
import { parseProjectDirectoryPath,parseProjectRelativePath } from '@/features/files/pathPolicy';
import { getAgentTask } from '@/api/agentTaskApi';
import { HttpClient,setHttpClient } from '@/api/httpClient';
import { fileKeys } from '@/features/files/fileQueries';
import { parseWorkspaceRevision } from '@/contracts/file';
import type { AgentTaskSnapshot } from '@/contracts/agentTask';
import { getActiveRun,stopRun } from '@/api/runApi';
import { RunToolbar } from '@/components/runs/RunToolbar';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const project='terminal-project',user='terminal-owner';
let token=sessionStorage.getItem('terminal-local-jwt');
setHttpClient(new HttpClient({getAccessToken:()=>token,onUnauthorized:()=>{token=null;}}));
client.setQueryData(fileKeys.revision(project),parseWorkspaceRevision('7'));
function App(){
  const [logged,setLogged]=useState(Boolean(token));
  const current=useCurrentAgentTaskQuery(project,logged,user);
  const close=useCloseAgentTaskMutation(project);
  const pause=usePauseAgentTaskMutation(project);
  const [body,setBody]=useState('initial saved file'),[revision,setRevision]=useState('7'),[saving,setSaving]=useState(false);
  useEffect(()=>{if(logged)void listDirectory(project,parseProjectDirectoryPath('')).then(tree=>{setRevision(tree.workspaceRevision);client.setQueryData(fileKeys.revision(project),tree.workspaceRevision);});},[logged]);
  const [known,setKnown]=useState<string|null>(sessionStorage.getItem('terminal-task'));
  const [settled,setSettled]=useState<AgentTaskSnapshot|null>(null);
  const active=useQuery({queryKey:['local-run'],queryFn:async()=>(await getActiveRun(project)).run,enabled:logged,refetchInterval:500});
  useEffect(()=>{if(current.data){setKnown(current.data.taskId);sessionStorage.setItem('terminal-task',current.data.taskId);}else if(current.data===null&&known)void getAgentTask(project,known).then(setSettled);},[current.data,known]);
  const login=async()=>{const r=await fetch('/__fixture/login',{method:'POST'});token=(await r.json()).accessToken;sessionStorage.setItem('terminal-local-jwt',token!);setLogged(true);};
  const task=current.data??null;
  const locked=current.isError||Boolean(task?.writesLocked)||active.isError||Boolean(active.data);
  const save=async()=>{setSaving(true);try{const result=await saveFileContent(project,parseProjectRelativePath('pom.xml'),{content:body,expectedWorkspaceRevision:parseWorkspaceRevision(revision)});setRevision(result.workspaceRevision);client.setQueryData(fileKeys.revision(project),result.workspaceRevision);}finally{setSaving(false);}};
  return <main><h1>Local real HTTP settlement fixture</h1><button onClick={login}>重新登录</button><output data-testid="task-state">{task?.state??settled?.state??'FREE'}</output><output data-testid="task-id">{task?.taskId??settled?.taskId??''}</output>
    {logged&&<><AgentConversationPanel uiActive projectId={project} userId={user} task={task} settledTask={settled} pollFailed={current.isError} writePending={saving} hasActiveRun={Boolean(active.data)} runAuthorityKnown={!active.isError} reloading={false} closePending={close.isPending} closeError={close.error?.message} pausePending={pause.isPending} pauseError={pause.error?.message} onPause={()=>{if(task)pause.mutate(task.taskId);}} onTaskAccepted={t=>{setKnown(t.taskId);sessionStorage.setItem('terminal-task',t.taskId);void current.refetch();}} onClose={()=>{if(task)close.mutate(task.taskId);}}/>
    <label>Saved fixture file<textarea aria-label="Saved fixture file" value={body} disabled={locked} onChange={e=>setBody(e.target.value)}/></label><button disabled={locked||saving} onClick={()=>void save()}>Save fixture file</button><output data-testid="saved-revision">{revision}</output>
    <button data-testid="browser-write" disabled={locked} onClick={async()=>{const r=await fetch(`/api/v1/projects/${project}/entries`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({kind:'directory',path:'terminal-proof',expectedWorkspaceRevision:revision})});document.querySelector('#write-result')!.textContent=String(r.status);}}>写入项目</button><output id="write-result"/>
    <RunToolbar run={active.data??null} projectTemplateId="java-spring-boot-web" statusText="Application" nowMs={Date.now()} canStart={!task?.writesLocked} startTitle="Start" startPending={false} canStop={Boolean(active.data)&&!task?.writesLocked} stopBlockedByAgent={Boolean(task?.writesLocked)} stopWaiting={false} stopPending={false} authorityError={active.error?.message??null} startError={null} stopError={null} reloadFailed={false} onStart={()=>{}} onStop={()=>{if(active.data)void stopRun(project,active.data.id).then(()=>active.refetch());}} onRetryAuthority={()=>{void active.refetch();}} onRetryReload={()=>{}}/></>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
