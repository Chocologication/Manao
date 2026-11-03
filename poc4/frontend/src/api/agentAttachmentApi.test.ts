import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from './httpClient';

afterEach(()=>setHttpClient(null));
it('sends multipart bytes through authenticated HTTP without JSON encoding or explicit boundary',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
  const client=new HttpClient({getAccessToken:()=> 'test-token',onUnauthorized:vi.fn(),fetchImpl:transport});
  const form=new FormData();form.append('file',new File([new Uint8Array([1,2,3])],'image.png',{type:'image/png'}));
  await client.request('/api/v1/projects/p/conversations/c/attachments/a',{method:'PUT',body:form});
  const init=transport.mock.calls[0]?.[1] as RequestInit;
  expect(init.body).toBe(form);
  expect(new Headers(init.headers).get('Content-Type')).toBeNull();
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
});
