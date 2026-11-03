// Local browser fixture: production components; all external adapters are intercepted by its spec.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../../src/app/appRuntime';
import { HttpClient, setHttpClient } from '../../src/api/httpClient';
import { AgentTaskPanel } from '../../src/features/ai/AgentTaskPanel';
import { ConversationHistory } from '../../src/features/ai/ConversationHistory';
import { fileKeys } from '../../src/features/files/fileQueries';
import '../../src/features/ai/AgentChat.css';
import '../../src/styles/globals.css';

setHttpClient(new HttpClient({getAccessToken:()=> 'offline-browser-token',onUnauthorized:()=>{throw new Error('Unexpected unauthorized response');}}));
queryClient.setQueryData(fileKeys.revision('image-project'),'0');
function Fixture(){
  const [head,setHead]=useState(2);
  return <QueryClientProvider client={queryClient}><main style={{height:'95vh',maxWidth:1000,margin:'auto'}}>
    <AgentTaskPanel userId="image-owner" projectId="image-project" conversationId="image-conversation" task={null} settledTask={null}
      pollFailed={false} writePending={false} hasActiveRun={false} runAuthorityKnown reloading={false} closePending={false}
      fullHistory onClose={()=>{}} onTaskAccepted={()=>setHead(n=>n+1)}
      conversationHistory={<ConversationHistory userId="image-owner" projectId="image-project" conversationId="image-conversation" headSeq={head}/>}/>
  </main></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
