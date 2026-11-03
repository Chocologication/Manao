import { test,expect } from '@playwright/test';
test('production composer and history keep authorized previews through refresh then revoke at 24h',async({page})=>{
  const t0=Date.parse('2026-11-02T00:00:00Z');
  let now=t0,uploadId='',putCount=0,submitted:Record<string,unknown>|null=null;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSpkAAAAASUVORK5CYII=','base64');
  const image=()=>({kind:'manao_image_ref',version:1,attachmentId:uploadId,fileName:'sample.png',mimeType:'image/png',sizeBytes:png.length,
    sha256:'a'.repeat(64),uploadedAt:new Date(t0).toISOString(),expiresAt:new Date(t0+86400000).toISOString(),taskId:'image-task',availability:now>=t0+86400000?'EXPIRED':'READY'});
  const snapshot=(taskId:string)=>({taskId,conversationId:'image-conversation',state:'COMPLETED',workspaceRevision:'0',writesLocked:false,progress:[],changedPaths:[],summary:'已有回复保留',failureCode:null,reasoningEffort:'high'});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    expect(request.headers()['authorization']).toBe('Bearer offline-browser-token');
    if(path.endsWith('/ai-capabilities'))return route.fulfill({json:{imageInput:true}});
    if(path.includes('/attachments/')){
      if(request.method()==='PUT'){putCount++;uploadId=path.split('/').at(-1)!;expect(request.headers()['content-type']).toContain('multipart/form-data');return route.fulfill({json:image(),headers:{'X-Manao-Now':String(now)}});}
      if(path.endsWith('/content'))return now>=t0+86400000?route.fulfill({status:410,json:{code:'AI_ATTACHMENT_EXPIRED',message:'expired',traceId:'offline'}}):route.fulfill({body:png,contentType:'image/png',headers:{'Cache-Control':'private, no-store'}});
      return route.fulfill({json:image(),headers:{'X-Manao-Now':String(now)}});
    }
    if(path.endsWith('/tasks')&&request.method()==='POST'){submitted=request.postDataJSON();return route.fulfill({json:snapshot(String(submitted!.taskId))});}
    if(path.endsWith('/entries'))return route.fulfill({json:{items:uploadId?[
      {seq:1,taskId:'image-task',kind:'user',text:'请分析上传的图片',toolCallId:null,textOffset:0,contentIndex:0,modelTruncated:false,attachments:[image()]},
      {seq:2,taskId:'image-task',kind:'assistant',text:'已有回复保留',toolCallId:null,textOffset:0,contentIndex:0,modelTruncated:false,attachments:[]},
    ]:[],nextBeforeSeq:null,nextBeforeOffset:null}});
    if(path.includes('/agent-tasks/'))return route.fulfill({json:snapshot('image-task')});
    throw new Error('Unexpected offline browser request: '+path);
  });
  await page.clock.install({time:new Date(t0)});
  await page.goto('/tests/ui/ai-image-input.html');
  await page.getByLabel('添加图片').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:png});
  await expect(page.getByAltText('sample.png')).toBeVisible();expect(putCount).toBe(0);
  await page.getByRole('button',{name:'Start task',exact:true}).click();
  await expect.poll(()=>submitted).not.toBeNull();
  expect(submitted).toMatchObject({prompt:'请分析上传的图片',attachmentIds:[uploadId]});expect(putCount).toBe(1);
  await expect(page.getByRole('region',{name:'会话历史'}).getByAltText('sample.png')).toBeVisible();
  await page.reload();
  const preview=page.getByRole('region',{name:'会话历史'}).getByAltText('sample.png');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('naturalWidth',1);
  now=t0+86400000;
  await page.clock.fastForward(86400001);
  await expect(page.getByAltText('sample.png')).toHaveCount(0);
  await expect(page.getByText('图片已失效，请重新上传')).toBeVisible();
  await expect(page.getByText('已有回复保留')).toBeVisible();
  const expiredStatus=await page.evaluate(async id=>(await fetch('/api/v1/projects/image-project/conversations/image-conversation/attachments/'+id+'/content',{headers:{Authorization:'Bearer offline-browser-token'}})).status,uploadId);
  expect(expiredStatus).toBe(410);
  await page.reload();
  await expect(page.getByText('图片已失效，请重新上传')).toBeVisible();
  expect(putCount).toBe(1);
});
