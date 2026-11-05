import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, X, KeyRound, Server } from 'lucide-react';
import { deleteModel, saveModel } from './api';
import { errorText, type ModelInput, type StudioModel } from './types';

const empty = (): ModelInput => ({ id: crypto.randomUUID(), label: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', vision: false, tools: true });
export function ModelSettings({ models, onClose, onSaved }: { models: StudioModel[]; onClose(): void; onSaved(model?: StudioModel): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<ModelInput>(() => models[0] ? { ...models[0], apiKey: '' } : empty());
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => { dialog.current?.close(); }; }, []);
  const update = <K extends keyof ModelInput>(key: K, value: ModelInput[K]) => setInput(old => ({ ...old, [key]: value }));
  const existing = models.some(m => m.id === input.id);
  return <dialog ref={dialog} className="studio-settings" aria-labelledby="studio-model-title" onCancel={event => { if (pending) event.preventDefault(); else onClose(); }}>
    <div className="studio-settings-head"><div><span className="studio-eyebrow">模型连接</span><h2 id="studio-model-title">模型设置</h2></div><button type="button" className="studio-icon" aria-label="关闭模型设置" disabled={pending} onClick={onClose}><X size={18} /></button></div>
    <div className="studio-settings-body"><nav aria-label="已配置的模型">{models.map(model => <button key={model.id} disabled={pending} aria-pressed={input.id === model.id} onClick={() => { setInput({ ...model, apiKey: '' }); setError(''); }}><Server size={16} /><span>{model.label}<small>{model.model}</small></span></button>)}<button disabled={pending} onClick={() => { setInput(empty()); setError(''); }}><Plus size={16} />添加模型</button></nav>
      <form onSubmit={async event => { event.preventDefault(); setPending(true); setError(''); try { const saved = await saveModel(input); setInput({ ...saved, apiKey: '' }); onSaved(saved); } catch (failure) { setError(errorText(failure)); } finally { setPending(false); } }}>
        <p className="studio-muted">使用你自己的 OpenAI 兼容服务，支持 DeepSeek、Qwen 和中转服务。</p>
        <label>显示名称<input required maxLength={80} value={input.label} onChange={e => update('label', e.target.value)} placeholder="例如：我的 DeepSeek" disabled={pending} /></label>
        <label>API 地址<input required type="url" value={input.baseUrl} onChange={e => update('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" disabled={pending} /><small>填写公共 HTTPS 地址，包含服务要求的 /v1 路径。</small></label>
        <label>API 密钥<div className="studio-key-input"><KeyRound size={15} /><input aria-label="API 密钥" type="password" autoComplete="new-password" required={!existing} maxLength={4096} value={input.apiKey} onChange={e => update('apiKey', e.target.value)} placeholder={existing ? '已保存，留空保留原密钥' : '输入 API 密钥'} disabled={pending} /></div><small>密钥加密保存，保存后不会返回浏览器。</small></label>
        <label>模型 ID<input required maxLength={160} value={input.model} onChange={e => update('model', e.target.value)} placeholder="deepseek-chat / qwen-plus" disabled={pending} /></label>
        <div className="studio-model-flags"><label><input type="checkbox" checked={input.tools} onChange={e => update('tools', e.target.checked)} disabled={pending} />支持工具调用</label><label><input type="checkbox" checked={input.vision} onChange={e => update('vision', e.target.checked)} disabled={pending} />支持图片</label></div>
        {error && <p role="alert" className="studio-error">{error}</p>}
        <footer>{existing && <button type="button" className="studio-danger" disabled={pending} onClick={async () => { setPending(true); setError(''); try { await deleteModel(input.id); setInput(empty()); onSaved(); } catch (failure) { setError(errorText(failure)); } finally { setPending(false); } }}><Trash2 size={14} />删除</button>}<button className="studio-primary" disabled={pending}>{pending ? '保存中…' : '保存配置'}</button></footer>
      </form></div>
  </dialog>;
}
