import { getHttpClient } from './httpClient';
import { ApiRequestError } from './ApiRequestError';

export const MAX_IMAGE_BYTES = 10_000_000;
export type AttachmentRef = {
  kind: 'manao_image_ref'; version: 1; attachmentId: string; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; uploadedAt: string; expiresAt: string; taskId: string | null; availability: string;
};
const deadlines=new WeakMap<AttachmentRef,number>();
export function imageRemainingMs(ref:AttachmentRef) {
  return (deadlines.get(ref)??(performance.now()+Date.parse(ref.expiresAt)-Date.now()))-performance.now();
}
async function metadataRequest(url:string,options:Parameters<ReturnType<typeof getHttpClient>['request']>[1]) {
  const began=performance.now();let serverNow:number|null=null;
  const payload=await getHttpClient().request(url,{...options,onResponse:response=>{
    const value=response.headers.get('X-Manao-Now');if(value!==null&&Number.isFinite(Number(value)))serverNow=Number(value);
  }});
  const ref=parseAttachment(payload);
  if(serverNow!==null)deadlines.set(ref,began+Date.parse(ref.expiresAt)-serverNow);
  return ref;
}
export function parseAttachment(value: unknown): AttachmentRef {
  if (!value || typeof value !== 'object') throw new Error('Malformed image reference');
  const ref = value as AttachmentRef;
  if (ref.kind !== 'manao_image_ref' || ref.version !== 1
      || !['attachmentId','fileName','mimeType','sha256','uploadedAt','expiresAt','availability'].every(k => typeof (ref as unknown as Record<string,unknown>)[k] === 'string')
      || !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0 || ref.sizeBytes > MAX_IMAGE_BYTES
      || !Number.isFinite(Date.parse(ref.expiresAt))) throw new Error('Malformed image reference');
  return ref;
}
export function attachmentUrl(project: string,conversation: string,id: string) {
  return '/api/v1/projects/'+encodeURIComponent(project)+'/conversations/'+encodeURIComponent(conversation)+'/attachments/'+encodeURIComponent(id);
}
export async function confirmAttachment(project: string,conversation: string,id: string,signal?: AbortSignal) {
  return metadataRequest(attachmentUrl(project,conversation,id),{signal});
}
export async function uploadAttachment(project: string,conversation: string,id: string,file: File,signal: AbortSignal) {
  if(file.size>MAX_IMAGE_BYTES)throw new Error('每张图片不得超过 10 MB');
  const form=new FormData();form.append('file',file);
  let result:AttachmentRef;
  try {
    result=await metadataRequest(attachmentUrl(project,conversation,id),{method:'PUT',body:form,signal});
  } catch(error) {
    signal.throwIfAborted();
    // A lost response is confirmed by the original ID. Unknown state never creates a new upload.
    if(error instanceof ApiRequestError && error.status>=400 && error.status<500)throw error;
    try {result=await confirmAttachment(project,conversation,id,signal);} catch {throw error;}
  }
  if(result.availability==='READY')return result;
  if(result.availability==='EXPIRED')throw new Error('图片已失效，请重新上传');
  throw new Error('图片上传确认中，请重试');
}
export function imageCapabilities(project: string,signal: AbortSignal) {
  return getHttpClient().request<{imageInput:boolean}>('/api/v1/projects/'+encodeURIComponent(project)+'/ai-capabilities',{signal});
}
