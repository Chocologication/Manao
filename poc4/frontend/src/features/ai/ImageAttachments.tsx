import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError } from '@/api/ApiRequestError';
import { getHttpClient } from '@/api/httpClient';
import { generateAgentTaskId } from '@/api/agentTaskApi';
import { attachmentUrl, confirmAttachment, imageRemainingMs, MAX_IMAGE_BYTES, uploadAttachment, type AttachmentRef } from '@/api/agentAttachmentApi';

type LocalImage = { id: string; file: File; url: string; attempted: boolean; uploaded?: AttachmentRef };
/** One scope owns every File, upload ID, AbortController and Object URL; none are persisted in browser storage. */
export function useImageAttachments(user: string,project: string,conversation?: string) {
  const bag=useMemo(()=>({active:true,controller:new AbortController(),items:[] as LocalImage[]}),[user,project,conversation]);
  const [,render]=useState(0),[error,setError]=useState<string|null>(null);
  const refresh=()=>{if(bag.active)render(n=>n+1);};
  useEffect(()=>{bag.active=true;if(bag.controller.signal.aborted)bag.controller=new AbortController();setError(null);return()=>{bag.active=false;bag.controller.abort();for(const item of bag.items)URL.revokeObjectURL(item.url);bag.items=[];};},[bag]);
  const clear=()=>{for(const item of bag.items)URL.revokeObjectURL(item.url);bag.items=[];refresh();};
  return {
    items:bag.items,error,clear,get signal(){return bag.controller.signal;},
    select(files: Iterable<File>){
      for(const file of files){if(file.size>MAX_IMAGE_BYTES){setError('每张图片不得超过 10 MB');continue;}bag.items.push({id:generateAgentTaskId(),file,url:URL.createObjectURL(file),attempted:false});}
      refresh();
    },
    remove(id:string){const item=bag.items.find(i=>i.id===id);if(item)URL.revokeObjectURL(item.url);bag.items=bag.items.filter(i=>i.id!==id);refresh();},
    async upload(){
      if(!conversation)throw new Error('Images require a conversation');
      const result:string[]=[];
      for(const item of bag.items){
        bag.controller.signal.throwIfAborted();
        if(!item.uploaded&&item.attempted){
          try{const confirmed=await confirmAttachment(project,conversation,item.id,bag.controller.signal);if(confirmed.availability==='READY')item.uploaded=confirmed;else if(confirmed.availability==='EXPIRED')throw new Error('图片已失效，请重新上传');}
          catch(error){if(!(error instanceof ApiRequestError&&error.status===404))throw error;}
        }
        if(!item.uploaded){item.attempted=true;item.uploaded=await uploadAttachment(project,conversation,item.id,item.file,bag.controller.signal);}
        bag.controller.signal.throwIfAborted();if(!bag.active)throw new Error('Image scope changed');
        if(item.uploaded.availability!=='READY'||imageRemainingMs(item.uploaded)<=0)throw new Error('图片已失效，请重新上传');
        result.push(item.id);refresh();
      }
      return result;
    },
  };
}
export function ImageAttachments({images,disabled=false}:{images:ReturnType<typeof useImageAttachments>;disabled?:boolean}) {
  return <div className="manao-ai-images" aria-label="图片附件" onPaste={event=>{if(!disabled&&event.clipboardData.files.length){event.preventDefault();images.select(event.clipboardData.files);}}}
    onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(!disabled)images.select(event.dataTransfer.files);}}>
    <label>添加图片<input aria-label="添加图片" type="file" accept="image/*" multiple disabled={disabled} onChange={event=>{if(event.target.files)images.select(event.target.files);event.target.value='';}} /></label>
    <span>每张最多 10 MB；上传起 24 小时后失效。可粘贴或拖放图片。</span>
    {images.items.map(item=><div key={item.id}><LocalPreview item={item}/><button type="button" disabled={disabled} onClick={()=>images.remove(item.id)}>移除 {item.file.name}</button></div>)}
    {images.error?<p role="alert">{images.error}</p>:null}
  </div>;
}
function LocalPreview({item}:{item:LocalImage}) {
  const [,refresh]=useState(0);
  useEffect(()=>{if(!item.uploaded)return;const timer=setTimeout(()=>{URL.revokeObjectURL(item.url);refresh(n=>n+1);},Math.max(0,imageRemainingMs(item.uploaded)));return()=>clearTimeout(timer);},[item.url,item.uploaded?.expiresAt]);
  return item.uploaded&&imageRemainingMs(item.uploaded)<=0?<span>图片已失效，请重新上传</span>:<img src={item.url} alt={item.file.name}/>;
}
export function AttachmentPreview(props:{userId:string;projectId:string;conversationId:string;attachment:AttachmentRef}) {
  return <ScopedPreview key={JSON.stringify([props.userId,props.projectId,props.conversationId,props.attachment.attachmentId])} {...props}/>;
}
function ScopedPreview({projectId,conversationId,attachment}:{userId:string;projectId:string;conversationId:string;attachment:AttachmentRef}) {
  const [url,setUrl]=useState<string|null>(null),[status,setStatus]=useState('加载图片');
  const loadedMeta=useRef(attachment);
  useEffect(()=>{
    const controller=new AbortController();let active=true,currentUrl:string|null=null,generation=0,timer:ReturnType<typeof setTimeout>|undefined;
    const release=()=>{if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl=null;}if(active)setUrl(null);};
    const expired=()=>{release();if(active)setStatus('图片已失效，请重新上传');};
    const load=async()=>{
      const own=++generation;release();
      if(attachment.availability==='EXPIRED'){expired();return;}
      try{
        const meta=await confirmAttachment(projectId,conversationId,attachment.attachmentId,controller.signal);
        if(!active||own!==generation)return;
        if(meta.availability==='EXPIRED'||imageRemainingMs(meta)<=0){expired();return;}
        if(meta.availability!=='READY'){setStatus('图片暂不可用');return;}
        loadedMeta.current=meta;clearTimeout(timer);
        timer=setTimeout(()=>{generation++;expired();},Math.max(0,imageRemainingMs(meta)));
        const {blob}=await getHttpClient().requestBlob(attachmentUrl(projectId,conversationId,attachment.attachmentId)+'/content',{signal:controller.signal});
        if(!active||own!==generation)return;
        if(imageRemainingMs(meta)<=0){expired();return;}
        currentUrl=URL.createObjectURL(blob);setUrl(currentUrl);setStatus('');
      }catch(error){if(active&&!controller.signal.aborted){if(error instanceof ApiRequestError&&error.status===410)expired();else setStatus('图片暂不可用');}}
    };
    void load();
    const visible=()=>{if(document.visibilityState==='visible')void load();};
    document.addEventListener('visibilitychange',visible);
    return()=>{active=false;generation++;controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);release();};
  },[projectId,conversationId,attachment.attachmentId,attachment.expiresAt,attachment.availability]);
  return <figure className="manao-ai-image-preview">{url?<img src={url} alt={attachment.fileName} onLoad={()=>{if(imageRemainingMs(loadedMeta.current)<=0){URL.revokeObjectURL(url);setUrl(null);setStatus('图片已失效，请重新上传');}}}/>:<span>{status}</span>}<figcaption>{attachment.fileName}</figcaption></figure>;
}
