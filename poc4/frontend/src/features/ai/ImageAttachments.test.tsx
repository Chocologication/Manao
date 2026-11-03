import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentPreview, ImageAttachments, useImageAttachments } from './ImageAttachments';
import { HttpClient, setHttpClient } from '@/api/httpClient';
import type { AttachmentRef } from '@/api/agentAttachmentApi';
import { StrictMode } from 'react';

const ref:AttachmentRef={kind:'manao_image_ref',version:1,attachmentId:'00000000-0000-4000-8000-000000000011',fileName:'screen.png',mimeType:'image/png',sizeBytes:3,sha256:'a'.repeat(64),uploadedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),taskId:'task',availability:'READY'};
const create=vi.fn(()=> 'blob:local-image'),revoke=vi.fn();
beforeEach(()=>{Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});});
afterEach(()=>{cleanup();vi.useRealTimers();setHttpClient(null);vi.clearAllMocks();});
it('keeps the original upload ID after an UPLOADING confirmation and later recovers READY without a second PUT',async()=>{
  let id='',ready=false;
  const transport=vi.fn<typeof fetch>(async(url,init)=>{
    if(init?.method==='PUT'){id=String(url).split('/').at(-1)!;throw new Error('lost ACK');}
    return new Response(JSON.stringify({...ref,attachmentId:id,availability:ready?'READY':'UPLOADING'}),{headers:{'Content-Type':'application/json'}});
  });
  setHttpClient(new HttpClient({getAccessToken:()=> 'token',onUnauthorized:vi.fn(),fetchImpl:transport}));
  const h=renderHook(()=>useImageAttachments('user','project','conversation'));
  act(()=>h.result.current.select([new File(['abc'],'screen.png',{type:'image/png'})]));
  await act(async()=>{await expect(h.result.current.upload()).rejects.toThrow('确认中');});
  ready=true;
  await act(async()=>{await expect(h.result.current.upload()).resolves.toEqual([id]);});
  expect(transport.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1);
});
function Composer(){const images=useImageAttachments('user','project','conversation');return <><ImageAttachments images={images}/><button onClick={()=>void images.upload()}>发送</button></>;}
it('selects a file on the public HTTP origin where crypto.randomUUID is unavailable',()=>{
  const original=globalThis.crypto;
  vi.stubGlobal('crypto',{getRandomValues:original.getRandomValues.bind(original)});
  try {
    render(<Composer/>);
    fireEvent.change(screen.getByLabelText('添加图片'),{target:{files:[new File(['abc'],'http.png',{type:'image/png'})]}});
    expect(screen.getByAltText('http.png')).toBeInTheDocument();
  } finally {vi.unstubAllGlobals();}
});
it('selects multiple files locally, uploads only on send, and confirms a lost upload ACK by original ID',async()=>{
  let id='',puts=0;
  const transport=vi.fn<typeof fetch>(async(url,init)=>{
    if(init?.method==='PUT'){puts++;id=String(url).split('/').at(-1)!;throw new Error('lost ACK');}
    return new Response(JSON.stringify({...ref,attachmentId:id}),{headers:{'Content-Type':'application/json'}});
  });
  setHttpClient(new HttpClient({getAccessToken:()=> 'token',onUnauthorized:vi.fn(),fetchImpl:transport}));
  const view=render(<StrictMode><Composer/></StrictMode>);
  fireEvent.change(screen.getByLabelText('添加图片'),{target:{files:[new File(['abc'],'screen.png',{type:'image/png'})]}});
  expect(screen.getByAltText('screen.png')).toBeInTheDocument();expect(puts).toBe(0);
  fireEvent.click(screen.getByRole('button',{name:'发送'}));
  await waitFor(()=>expect(transport).toHaveBeenCalledTimes(2));expect(puts).toBe(1);
  expect(String(transport.mock.calls[1]?.[0])).toContain(id);
  view.unmount();expect(revoke).toHaveBeenCalledWith('blob:local-image');
});
it('revokes a loaded authorized preview exactly at expiry',async()=>{
  vi.useFakeTimers();
  const expiry=Date.now()+1000;
  const transport=vi.fn<typeof fetch>(async(url)=>String(url).endsWith('/content')?new Response(new Blob(['abc'])):new Response(JSON.stringify({...ref,expiresAt:new Date(expiry).toISOString()}),{headers:{'Content-Type':'application/json'}}));
  setHttpClient(new HttpClient({getAccessToken:()=> 'token',onUnauthorized:vi.fn(),fetchImpl:transport}));
  render(<AttachmentPreview userId="user" projectId="project" conversationId="conversation" attachment={{...ref,expiresAt:new Date(expiry).toISOString()}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(screen.getByAltText('screen.png')).toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
  expect(screen.queryByAltText('screen.png')).not.toBeInTheDocument();
  expect(screen.getByText('图片已失效，请重新上传')).toBeInTheDocument();expect(revoke).toHaveBeenCalled();
});
it('discards a late blob after account scope changes without creating an Object URL',async()=>{
  let release!:(r:Response)=>void;
  const transport=vi.fn<typeof fetch>(async(url)=>String(url).endsWith('/content')?new Promise<Response>(r=>{release=r;}):new Response(JSON.stringify(ref),{headers:{'Content-Type':'application/json'}}));
  setHttpClient(new HttpClient({getAccessToken:()=> 'token',onUnauthorized:vi.fn(),fetchImpl:transport}));
  const view=render(<AttachmentPreview userId="old" projectId="project" conversationId="conversation" attachment={ref}/>);
  await waitFor(()=>expect(transport).toHaveBeenCalledTimes(2));
  view.rerender(<AttachmentPreview userId="new" projectId="project" conversationId="conversation" attachment={{...ref,availability:'EXPIRED'}}/>);
  await act(async()=>release(new Response(new Blob(['old']))));
  expect(create).not.toHaveBeenCalled();expect(screen.queryByAltText('screen.png')).not.toBeInTheDocument();
});
it('expires a preview against server time even when the browser wall clock is one hour behind',async()=>{
  vi.useFakeTimers();
  const serverNow=Date.now()+3600000,expiresAt=new Date(serverNow+1000).toISOString();
  const transport=vi.fn<typeof fetch>(async(url)=>String(url).endsWith('/content')?new Response(new Blob(['abc'])):
    new Response(JSON.stringify({...ref,expiresAt}),{headers:{'Content-Type':'application/json','X-Manao-Now':String(serverNow)}}));
  setHttpClient(new HttpClient({getAccessToken:()=> 'token',onUnauthorized:vi.fn(),fetchImpl:transport}));
  render(<AttachmentPreview userId="user" projectId="project" conversationId="conversation" attachment={{...ref,expiresAt}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(screen.getByAltText('screen.png')).toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
  expect(screen.queryByAltText('screen.png')).not.toBeInTheDocument();
});
