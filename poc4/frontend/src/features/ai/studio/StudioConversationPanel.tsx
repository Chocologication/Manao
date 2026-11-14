import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Clock3, Copy, FileCode2, History, ImagePlus, Maximize2, MessageSquare, Minimize2, Paperclip, Plus, Settings2, Sparkles, Square, Terminal, X } from 'lucide-react';
import { AgentConversationPanel, type AgentConversationPanelProps } from '../AgentConversationPanel';
import { getAgentToolCallResult } from '@/api/agentTaskApi';
import { getMe } from '@/api/authApi';
import { createUuid } from '@/lib/uuid';
import { authSession, connectionRegistry, handleSessionRevoked } from '@/app/appRuntime';
import { ApiRequestError } from '@/api/ApiRequestError';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { getWorkspaceRevision, useWorkspaceRevision } from '@/features/files/fileQueries';
import { reloadWorkspaceAfterTerminalRun } from '@/features/runs/workspaceReload';
import { useAgentLiveOutput } from '../useAgentLiveOutput';
import * as api from './api';
import { errorText, isActive, type Attachment, type Reference, type Turn, type TurnInput } from './types';
import { ModelSettings } from './ModelSettings';
import { StudioMarkdown } from './StudioMarkdown';
import { ReviewChanges } from './ReviewChanges';
import { ToolProgress, ValidationResult } from './ToolProgress';
import './Studio.css';

type Props = AgentConversationPanelProps & { layout: 'main' | 'side'; onLayoutChange(): void };
type Draft = { text: string; mode: 'CHAT' | 'TASK'; policy: 'AUTO' | 'REVIEW'; attachments: Attachment[]; references: Reference[] };
const newDraft = (): Draft => ({ text: '', mode: 'CHAT', policy: 'REVIEW', attachments: [], references: [] });
function read<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } }
function write(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Drafts remain available in memory. */ } }
function readDraft(key: string): Draft {
  const value = read<Partial<Draft>>(key, {});
  if (!value || typeof value.text !== 'string' || !['CHAT', 'TASK'].includes(value.mode ?? '') || !['AUTO', 'REVIEW'].includes(value.policy ?? '')
    || !Array.isArray(value.attachments) || value.attachments.length > 8 || value.attachments.some(a => !a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.mediaType !== 'string' || !Number.isSafeInteger(a.size))
    || !Array.isArray(value.references) || value.references.length > 12 || value.references.some(r => !r || !['file', 'code', 'logs'].includes(r.kind) || typeof r.path !== 'string')) return newDraft();
  return { ...value, text: value.text.slice(0, 24000) } as Draft;
}
function readIntent(key: string): TurnInput | null {
  const value = read<Partial<TurnInput> | null>(key, null);
  return value && typeof value.id === 'string' && typeof value.prompt === 'string' && typeof value.modelId === 'string'
    && typeof value.expectedRevision === 'string' && ['CHAT', 'TASK'].includes(value.mode ?? '') && ['AUTO', 'REVIEW'].includes(value.applyPolicy ?? '')
    && Array.isArray(value.attachmentIds) && Array.isArray(value.references) ? value as TurnInput : null;
}
export function StudioConversationPanel(props: Props) {
  return <ConversationLayout key={JSON.stringify([props.userId, props.projectId])} {...props} />;
}
function ConversationLayout(props: Props) {
  const key = `manao.studio.legacy.${props.userId}.${props.projectId}`;
  const [legacy, setLegacy] = useState(() => read<boolean>(key, false) === true);
  const choose = (value: boolean) => { write(key, value); setLegacy(value); };
  return legacy ? <div className="studio"><button className="studio-configure" onClick={() => choose(false)}>返回新版对话</button><AgentConversationPanel {...props} /></div> : <StudioPanel {...props} onLegacy={() => choose(true)} />;
}

function StudioPanel(props: Props & { onLegacy(): void }) {
  const { userId, projectId } = props; const client = useQueryClient();
  const prefix = `manao.studio.${userId}.${projectId}`;
  const [selected, setSelected] = useState<string | null>(() => { const value = read<unknown>(`${prefix}.selected`, null); return typeof value === 'string' ? value : null; });
  const [activated, setActivated] = useState(!!props.uiActive);
  useEffect(() => { if (props.uiActive) setActivated(true); }, [props.uiActive]);
  const [draft, setDraft] = useState<Draft>(() => readDraft(`${prefix}.draft.${selected ?? 'new'}`));
  const [modelId, setModelId] = useState<string>(() => read(`manao.studio.model.${userId}`, ''));
  const [settings, setSettings] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [search, setSearch] = useState('');
  const [sending, setSending] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState('');
  const [pendingIntent, setPendingIntent] = useState<TurnInput | null>(() => readIntent(`${prefix}.intent.${selected}`));
  const [retryStream, setRetryStream] = useState(0), [connection, setConnection] = useState('');
  const [referenceKind, setReferenceKind] = useState<'code' | 'logs' | null>(null), [referenceText, setReferenceText] = useState('');
  const [nearBottom, setNearBottom] = useState(true), [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const sendGuard = useRef(false), scope = useRef({ alive: true, selected }); scope.current.selected = selected;
  const propsRef = useRef(props); propsRef.current = props;
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; }; }, []);
  const models = useQuery({ queryKey: api.studioKeys.models(userId), queryFn: api.listModels, enabled: activated && !!userId, retry: false });
  const conversations = useQuery({ queryKey: api.studioKeys.conversations(userId, projectId), queryFn: () => api.listConversations(projectId), enabled: activated && !!userId, retry: false });
  const turns = useQuery({ queryKey: api.studioKeys.turns(userId, projectId, selected), queryFn: ({ signal }) => api.listTurns(projectId, selected!, signal), enabled: activated && !!selected && !!userId, retry: false,
    refetchInterval: query => query.state.data?.some(t => isActive(t) || ['APPLYING', 'VALIDATING'].includes(t.application?.state ?? '')) ? 2000 : false });
  const revision = useWorkspaceRevision(projectId);
  const activePath = useWorkspaceSession(s => s.activePath), dirtyCount = useWorkspaceSession(s => s.dirtyPaths.size);
  const active = turns.data?.find(isActive); const model = models.data?.find(m => m.id === modelId) ?? models.data?.[0];
  useEffect(() => { if (model && model.id !== modelId) setModelId(model.id); }, [model, modelId]);
  useEffect(() => write(`manao.studio.model.${userId}`, modelId), [modelId, userId]);
  useEffect(() => write(`${prefix}.draft.${selected ?? 'new'}`, draft), [draft, prefix, selected]);
  const choose = (id: string) => {
    if (sending || uploading) return;
    write(`${prefix}.draft.${selected ?? 'new'}`, draft); write(`${prefix}.selected`, id);
    setDraft(readDraft(`${prefix}.draft.${id}`)); setSelected(id); setPendingIntent(readIntent(`${prefix}.intent.${id}`));
    setError(''); setHistoryOpen(false); setNearBottom(true);
  };
  useEffect(() => { if (!selected && conversations.data?.[0]) choose(conversations.data[0].id); }, [conversations.data]); // The first successful load selects once.
  useEffect(() => {
    if (selected && turns.error instanceof ApiRequestError && turns.error.status === 404) {
      write(`${prefix}.selected`, null); setSelected(null); setPendingIntent(null);
      setError('会话已不可用，草稿已保留；可新建会话继续。');
    }
  }, [selected, turns.error, prefix]);
  const lastTask = useRef('');
  const updateTurn = useCallback((turn: Turn) => {
    if (!scope.current.alive || turn.conversationId !== scope.current.selected) return;
    client.setQueryData<Turn[]>(api.studioKeys.turns(userId, projectId, turn.conversationId), old => {
      const previous = old?.find(t => t.id === turn.id);
      if (previous && previous.version > turn.version) return old;
      return previous ? old!.map(t => t.id === turn.id ? turn : t) : [...old ?? [], turn];
    });
    if (turn.task) { const signature = JSON.stringify(turn.task); if (signature !== lastTask.current) { lastTask.current = signature; propsRef.current.onTaskAccepted(turn.task); } }
  }, [client, userId, projectId]);
  useEffect(() => {
    if (!pendingIntent || !turns.data?.some(t => t.id === pendingIntent.id)) return;
    write(`${prefix}.intent.${selected}`, null); setPendingIntent(null);
  }, [pendingIntent, turns.data, prefix, selected]);
  // One stream per active turn; reconnects reuse the turn id and replace monotonic snapshots.
  useEffect(() => {
    if (!active || active.mode !== 'CHAT') { setConnection(''); return; }
    const controller = new AbortController(), snapshot = authSession.getSnapshot(); let timer: ReturnType<typeof setTimeout>; let attempts = 0;
    const unregister = connectionRegistry.register(() => controller.abort());
    const connect = async () => {
      setConnection(attempts ? '正在重连…' : '正在连接…');
      try {
        const response = await api.openEvents(projectId, active.id, controller.signal);
        setConnection('正在回复');
        await api.consumeEvents(response, turn => { if (turn.id !== active.id || turn.conversationId !== selected) throw new Error('Stream identity mismatch'); updateTurn(turn); }, controller.signal);
        if (!controller.signal.aborted) {
          const latest = await api.getTurn(projectId, active.id); updateTurn(latest);
          if (isActive(latest)) timer = setTimeout(() => { void connect(); }, 700);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        try { await getMe({ suppressUnauthorized: true }); }
        catch (authFailure) { if (authFailure instanceof ApiRequestError && authFailure.status === 401) handleSessionRevoked(snapshot); setConnection('连接中断'); return; }
        if (failure instanceof Error && failure.message === 'AUTH_REVOKED') { handleSessionRevoked(snapshot); return; }
        setConnection('连接中断，已保存收到的内容');
        if (++attempts <= 3) timer = setTimeout(() => { void connect(); }, 800 * 2 ** attempts);
      }
    };
    void connect(); return () => { controller.abort(); unregister(); clearTimeout(timer); };
  }, [active?.id, active?.mode, projectId, selected, retryStream, updateTurn]);
  useEffect(() => {
    const element = scroller.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (element.scrollHeight - element.scrollTop - element.clientHeight < 160 || nearBottom) element.scrollTop = element.scrollHeight; });
    if (element.firstElementChild) observer.observe(element.firstElementChild); return () => observer.disconnect();
  }, [selected, nearBottom]);
  const create = async () => {
    if (creating || sending || uploading) return;
    setCreating(true); setError('');
    try { const conversation = await api.createConversation(projectId, createUuid()); if (!scope.current.alive) return; await client.invalidateQueries({ queryKey: api.studioKeys.conversations(userId, projectId) }); choose(conversation.id); }
    catch (failure) { if (scope.current.alive) setError(errorText(failure)); } finally { if (scope.current.alive) setCreating(false); }
  };
  const updateDraft = (next: Partial<Draft>) => setDraft(old => ({ ...old, ...next }));
  const taskBlocked = props.pollFailed || props.writePending || props.reloading || !props.runAuthorityKnown || !!props.task?.writesLocked || dirtyCount > 0 || revision == null || draft.text.trim().length > 6000;
  const send = async (retry?: TurnInput) => {
    if (sendGuard.current || active || uploading || !retry && (!model || !!pendingIntent || !draft.text.trim()) || !retry && draft.mode === 'TASK' && (taskBlocked || !model?.tools)) return;
    sendGuard.current = true; setSending(true); setError('');
    const mode = retry?.mode ?? draft.mode;
    if (mode === 'TASK') props.onSubmissionPendingChange?.(true);
    let conversationId = selected;
    try {
      if (!conversationId) { const created = await api.createConversation(projectId, createUuid()); conversationId = created.id; scope.current.selected = conversationId; write(`${prefix}.selected`, conversationId); setSelected(conversationId); }
      const input: TurnInput = retry ?? { id: createUuid(), prompt: draft.text.trim(), mode, applyPolicy: draft.policy, modelId: model!.id,
        expectedRevision: getWorkspaceRevision(client, projectId) ?? revision ?? '0', attachmentIds: draft.attachments.map(a => a.id), references: draft.references };
      // Lost responses are reconciled against this exact request, including its original revision.
      sessionStorage.setItem(`${prefix}.intent.${conversationId}`, JSON.stringify(input)); setPendingIntent(input);
      let turn: Turn;
      if (retry) { try { turn = await api.getTurn(projectId, input.id); } catch (failure) { if (!(failure instanceof ApiRequestError) || failure.status !== 404) throw failure; turn = await api.sendTurn(projectId, conversationId, input); } }
      else turn = await api.sendTurn(projectId, conversationId, input);
      if (!scope.current.alive || scope.current.selected !== conversationId) return;
      updateTurn(turn); setDraft(old => ({ ...old, text: '', references: [], attachments: [] })); setPendingIntent(null); write(`${prefix}.intent.${conversationId}`, null);
      void client.invalidateQueries({ queryKey: api.studioKeys.conversations(userId, projectId) }); setNearBottom(true); textarea.current?.focus();
    } catch (failure) {
      if (scope.current.alive) {
        setError(errorText(failure));
        // A definite rejection permits editing. Ambiguous transport outcomes keep the original intent.
        if (failure instanceof ApiRequestError && failure.status >= 400 && failure.status < 500 && failure.body?.code !== 'AI_TASK_MISMATCH') {
          write(`${prefix}.intent.${conversationId}`, null); setPendingIntent(null);
        }
      }
    }
    finally { sendGuard.current = false; if (scope.current.alive) setSending(false); if (mode === 'TASK') propsRef.current.onSubmissionPendingChange?.(false); }
  };
  const upload = async (files: FileList | File[]) => {
    if (uploading || sending) return;
    const list = Array.from(files);
    if (draft.attachments.length + list.length > 8 || list.some(f => f.size > 8 * 1024 * 1024 || f.size === 0) || draft.attachments.reduce((n, f) => n + f.size, 0) + list.reduce((n, f) => n + f.size, 0) > 16 * 1024 * 1024) { setError('最多 8 个附件，单个 8 MiB，总计 16 MiB。'); return; }
    setUploading(true); setError('');
    try {
      for (const file of list) {
        const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = () => reject(new Error('Read failed')); reader.readAsDataURL(file); });
        const saved = await api.uploadAttachment(projectId, { name: file.name, mediaType: file.type, base64 });
        if (scope.current.alive) setDraft(old => ({ ...old, attachments: [...old.attachments, saved] }));
      }
    } catch (failure) { if (scope.current.alive) setError(errorText(failure)); }
    finally { if (scope.current.alive) setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } };
  const history = <div className="studio-history-list"><label><span className="sr-only">搜索会话</span><input placeholder="搜索会话…" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="studio-new-conversation" disabled={creating || sending || uploading} onClick={() => { void create(); }}><Plus size={15} />新建会话</button>{conversations.data?.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(c => <button key={c.id} aria-current={selected === c.id ? 'page' : undefined} disabled={sending || uploading} onClick={() => choose(c.id)}><MessageSquare size={14} /><span>{c.title}<small>{new Date(c.updatedAt).toLocaleDateString('zh-CN')}</small></span></button>)}{conversations.isError && <button onClick={() => { void conversations.refetch(); }}>会话加载失败，重试</button>}</div>;
  return <section className="studio" data-layout={props.layout} aria-label="Manao AI 对话">
    <header className="studio-header"><div className="studio-title"><span className="studio-logo"><Sparkles size={19} /></span><div><strong>Manao AI</strong><span>想法，从这里开始</span></div></div><div className="studio-header-actions"><button className="studio-icon" title="新建会话" aria-label="新建会话" disabled={creating || sending || uploading} onClick={() => { void create(); }}><Plus size={18} /></button><button className="studio-icon" title="会话历史" aria-label="会话历史" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History size={17} /></button><button className="studio-icon" title="模型设置" aria-label="模型设置" onClick={() => setSettings(true)}><Settings2 size={17} /></button><button className="studio-icon" title={props.layout === 'main' ? '切换到右侧面板' : '切换到主区域'} aria-label={props.layout === 'main' ? '切换到右侧面板' : '切换到主区域'} onClick={props.onLayoutChange}>{props.layout === 'main' ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button></div></header>
    {historyOpen && <div className="studio-history-popover" role="region" aria-label="会话历史列表">{history}<button className="studio-configure" onClick={props.onLegacy}>查看旧版会话</button></div>}
    {props.historyTarget && createPortal(history, props.historyTarget)}
    {props.task?.writesLocked && props.task.taskId !== active?.id && <div className="studio-notice">项目任务尚未结束，结束后才能继续修改文件。<button disabled={props.closePending} onClick={props.onClose}>{props.closePending ? '结束中…' : '结束当前任务'}</button></div>}
    <div className="studio-scroll" ref={scroller} tabIndex={0} aria-label="对话消息" onScroll={e => { const el = e.currentTarget; setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="studio-message-list">
      {turns.isPending && selected ? <p className="studio-muted studio-loading">正在加载会话…</p> : turns.isError ? <div role="alert" className="studio-error">会话加载失败。<button onClick={() => { void turns.refetch(); }}>重新加载</button></div> : !turns.data?.length && <div className="studio-welcome"><span className="studio-welcome-icon"><Sparkles size={31} /></span><span className="studio-eyebrow">围绕项目，展开对话</span><h2>从一个想法开始</h2><p>聊一聊思路，或把任务交给我。<br />项目上下文、代码和执行结果，都在同一个对话里。</p><div className="studio-suggestions"><button onClick={() => updateDraft({ mode: 'CHAT', text: '帮我梳理当前项目的结构和主要功能' })}><MessageSquare size={17} /><strong>理解这个项目</strong><span>读取项目，理清结构与思路</span></button><button onClick={() => updateDraft({ mode: 'TASK', text: '检查当前项目，提出可审阅的改进并运行验证' })}><FileCode2 size={17} /><strong>一起完成任务</strong><span>审阅代码变更后再应用</span></button></div></div>}
      {turns.data?.map(turn => <TurnMessage key={turn.id} turn={turn} userId={userId} projectId={projectId} blocked={props.writePending || props.reloading || !props.runAuthorityKnown || props.hasActiveRun || dirtyCount > 0 || !!props.task?.writesLocked && props.task.taskId !== turn.application?.taskId} onUpdate={updateTurn} onBusy={(pending, confirmed) => { propsRef.current.onSubmissionPendingChange?.(pending); if (!pending && confirmed) void reloadWorkspaceAfterTerminalRun({ projectId, queryClient: client }).catch(() => setError('变更已提交，工作区重新加载失败，请刷新页面核对。')); }} onRetry={() => { updateDraft({ text: turn.prompt, mode: turn.mode, policy: turn.applyPolicy, references: turn.references, attachments: turn.attachments ?? [] }); textarea.current?.focus(); }} />)}
    </div></div>
    {!nearBottom && <button className="studio-jump" onClick={() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); setNearBottom(true); }}><ArrowDown size={14} />回到最新消息</button>}
    <div className="studio-composer-wrap">
      {error && <p role="alert" className="studio-error">{error}<button className="studio-icon" aria-label="关闭错误提示" onClick={() => setError('')}><X size={13} /></button></p>}
      {pendingIntent && !active && <div className="studio-notice">上次发送的结果尚未确认。<button disabled={sending} onClick={() => { void send(pendingIntent); }}>检查上次发送结果</button></div>}
      <div className="studio-composer" onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        <div className="studio-composer-top"><div className="studio-mode" role="group" aria-label="对话模式"><button aria-pressed={draft.mode === 'CHAT'} disabled={sending} onClick={() => updateDraft({ mode: 'CHAT' })}><MessageSquare size={14} />聊天</button><button aria-pressed={draft.mode === 'TASK'} disabled={sending} onClick={() => updateDraft({ mode: 'TASK' })}><Terminal size={14} />任务</button></div>{draft.mode === 'TASK' ? <select aria-label="变更应用方式" value={draft.policy} disabled={sending} onChange={e => updateDraft({ policy: e.target.value as Draft['policy'] })}><option value="REVIEW">审阅后应用</option><option value="AUTO">自动应用</option></select> : <span className="studio-read-only">项目只读</span>}</div>
        {(draft.references.length > 0 || draft.attachments.length > 0) && <div className="studio-chips">{draft.references.map((ref, i) => <span key={`${ref.kind}${i}`}><FileCode2 size={12} />{ref.kind === 'code' ? '代码片段' : ref.kind === 'logs' ? '日志片段' : ref.path}<button aria-label={`移除引用 ${ref.path}`} disabled={sending} onClick={() => updateDraft({ references: draft.references.filter((_, n) => i !== n) })}><X size={11} /></button></span>)}{draft.attachments.map(file => <span key={file.id}>{file.mediaType.startsWith('image/') ? <ImagePlus size={12} /> : <Paperclip size={12} />}{file.name}{file.truncated && '（已截断）'}<button disabled={sending || uploading} aria-label={`移除附件 ${file.name}`} onClick={() => updateDraft({ attachments: draft.attachments.filter(f => f.id !== file.id) })}><X size={11} /></button></span>)}</div>}
        <textarea ref={textarea} aria-label="消息输入" placeholder={draft.mode === 'CHAT' ? '聊聊想法，或询问当前项目…' : '描述要完成的任务…'} value={draft.text} maxLength={draft.mode === 'TASK' ? 6000 : 24000} disabled={sending} onChange={e => updateDraft({ text: e.target.value })} onKeyDown={onKeyDown} onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void upload(e.clipboardData.files); } }} />
        <div className="studio-composer-bottom"><div className="studio-composer-tools"><button className="studio-icon" aria-label="上传附件" title="图片、PDF、Word、文本" disabled={uploading || sending} onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button><input ref={fileInput} className="sr-only" type="file" aria-label="选择附件" multiple accept="image/png,image/jpeg,image/webp,.pdf,.docx,.txt,.md,.log,.java,.py,.ts,.tsx,.js,.json,.xml,.yaml,.yml,.csv,.css,.html,.sql" onChange={e => { if (e.target.files) void upload(e.target.files); }} />
          <button className="studio-icon" aria-label="引用当前文件" title="引用当前文件" disabled={!activePath || sending || draft.references.length >= 12} onClick={() => { if (activePath && !draft.references.some(r => r.kind === 'file' && r.path === activePath)) updateDraft({ references: [...draft.references, { kind: 'file', path: activePath }] }); }}><FileCode2 size={17} /></button><button className="studio-icon" aria-label="添加代码引用" title="添加代码引用" disabled={sending || draft.references.length >= 12} onClick={() => { setReferenceKind('code'); setReferenceText(''); }}><span className="studio-code-symbol">{'</>'}</span></button><button className="studio-icon" aria-label="添加日志引用" title="添加日志引用" disabled={sending || draft.references.length >= 12} onClick={() => { setReferenceKind('logs'); setReferenceText(''); }}><Clock3 size={16} /></button>
          <select aria-label="选择模型" value={model?.id ?? ''} onChange={e => setModelId(e.target.value)} disabled={sending || models.isPending}>{!models.data?.length && <option value="">配置模型后开始</option>}{models.data?.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
          {active ? <button className="studio-stop" aria-label="停止生成" disabled={active.state === 'STOPPING'} onClick={() => { setError(''); void api.stopTurn(projectId, active.id).then(updateTurn).catch(f => setError(errorText(f))); }}><Square size={12} fill="currentColor" />{active.state === 'STOPPING' ? '正在停止…' : '停止'}</button> : <button className="studio-send" aria-label="发送消息" title="Enter 发送，Shift + Enter 换行" disabled={sending || uploading || !draft.text.trim() || !model || !!pendingIntent || draft.mode === 'TASK' && (taskBlocked || !model.tools)} onClick={() => { void send(); }}><ArrowUp size={18} /></button>}
        </div>
      </div>
      <div className="studio-composer-hint"><span>{uploading ? '附件上传中…' : active ? connection || (active.state === 'STOPPING' ? '正在停止任务，结束后恢复编辑权限' : '任务正在执行') : draft.mode === 'TASK' && dirtyCount ? '请先保存编辑器中的修改' : draft.mode === 'TASK' ? draft.policy === 'REVIEW' ? '先生成变更方案，经审阅后应用到项目文件' : '任务将直接修改当前项目' : '按需读取项目上下文，不修改文件或执行命令'}</span>{active?.mode === 'CHAT' && connection.includes('中断') ? <button onClick={() => setRetryStream(n => n + 1)}>重连</button> : <span>Enter 发送 · Shift + Enter 换行</span>}</div>
      {!models.isPending && !models.data?.length && <button className="studio-configure" onClick={() => setSettings(true)}>{models.isError ? '模型列表加载失败，打开设置重试' : '添加你的 API 地址、Key 和模型'}</button>}
    </div>
    {settings && <ModelSettings models={models.data ?? []} onClose={() => setSettings(false)} onSaved={saved => { void client.invalidateQueries({ queryKey: api.studioKeys.models(userId) }); if (saved) { setModelId(saved.id); setSettings(false); } }} />}
    {referenceKind && <ReferenceDialog kind={referenceKind} text={referenceText} setText={setReferenceText} onClose={() => setReferenceKind(null)} onAdd={() => { if (referenceText.trim()) updateDraft({ references: [...draft.references, { kind: referenceKind, path: referenceKind === 'code' ? activePath ?? '代码片段' : '日志片段', text: referenceText }] }); setReferenceKind(null); }} />}
  </section>;
}

function ReferenceDialog({ kind, text, setText, onClose, onAdd }: { kind: string; text: string; setText(text: string): void; onClose(): void; onAdd(): void }) {
  const ref = useRef<HTMLDialogElement>(null); useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="studio-reference-dialog" onCancel={onClose}><h2>添加{kind === 'code' ? '代码' : '日志'}引用</h2><textarea aria-label="引用内容" value={text} maxLength={32000} onChange={e => setText(e.target.value)} autoFocus /><footer><button onClick={onClose}>取消</button><button className="studio-primary" disabled={!text.trim()} onClick={onAdd}>添加引用</button></footer></dialog>;
}
function TurnMessage({ turn, userId, projectId, blocked, onUpdate, onBusy, onRetry }: { turn: Turn; userId: string; projectId: string; blocked: boolean; onUpdate(turn: Turn): void; onBusy(pending: boolean, confirmed?: boolean): void; onRetry(): void }) {
  const active = isActive(turn); const [copied, setCopied] = useState(false);
  const live = useAgentLiveOutput({ userId, projectId, conversationId: turn.id, taskId: turn.mode === 'TASK' && active ? turn.id : null, enabled: turn.mode === 'TASK' && active });
  const taskText = live.latest?.current?.blocks.filter(b => b.kind === 'text').map(b => b.text).join('') || turn.task?.progress.filter(p => p.kind === 'message').at(-1)?.text;
  const reply = turn.mode === 'TASK' && active ? taskText || turn.reply : turn.reply;
  const reasoning = turn.reasoning || live.latest?.current?.blocks.filter(b => b.kind === 'thinking').map(b => b.text).join('');
  const lastBuild = turn.task?.progress.filter(p => p.kind === 'tool_end' && p.text.startsWith('build ')).at(-1)?.text.split(' ')[1];
  const build = useQuery({ queryKey: ['studio-build', userId, projectId, turn.id, lastBuild], queryFn: () => getAgentToolCallResult(projectId, turn.id, lastBuild!), enabled: !!lastBuild, retry: false });
  const error = turn.error ? errorText({ body: { code: turn.error } }) : '';
  return <article className="studio-turn" data-turn-id={turn.id}>
    <div className="studio-user"><div className="studio-user-meta"><span>{turn.mode === 'TASK' ? '任务' : '聊天'}</span>{turn.mode === 'TASK' && <span>{turn.applyPolicy === 'REVIEW' ? '审阅后应用' : '自动应用'}</span>}<time>{new Date(turn.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{turn.prompt}</p>{((turn.attachments?.length ?? 0) > 0 || turn.references.length > 0) && <div className="studio-sent-context">{turn.references.map((r, i) => <span key={i}><FileCode2 size={12} />{r.path}</span>)}{turn.attachments?.map(a => <span key={a.id}><Paperclip size={12} />{a.name}</span>)}</div>}</div>
    <div className="studio-assistant"><span className="studio-avatar"><Sparkles size={16} /></span><div className="studio-assistant-body"><div className="studio-assistant-meta"><strong>Manao</strong><span>{active ? turn.state === 'ATTENTION' ? '等待处理' : '正在处理' : turn.state === 'STOPPED' ? '已停止' : turn.state === 'FAILED' ? '未完成' : '已完成'}</span></div>
      {reasoning && <details className="studio-thinking"><summary>思考过程{active ? ' · 进行中' : ''}</summary><p>{reasoning}</p></details>}
      <ToolProgress turn={turn} projectId={projectId} />
      {reply ? <StudioMarkdown text={reply} streaming={active} /> : active ? <div className="studio-generating" role="status"><span /><span /><span /><small>{turn.state === 'STOPPING' ? '正在确认停止…' : '正在准备回复…'}</small></div> : <p className="studio-muted">没有生成回复内容。</p>}
      {turn.files.length > 0 && <ReviewChanges userId={userId} projectId={projectId} turn={turn} blocked={blocked} onUpdate={onUpdate} onBusy={onBusy} />}
      {build.data && <ValidationResult title={turn.applyPolicy === 'REVIEW' ? '应用前验证' : '任务结果验证'} data={build.data.data} />}
      {error && <p className="studio-error" role="alert">{error} <code>{turn.error}</code></p>}
      {!active && <div className="studio-message-actions"><button aria-label="复制回复" onClick={() => { void navigator.clipboard.writeText(reply || '').then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button><button onClick={onRetry}>再次编辑</button></div>}
    </div></div>
  </article>;
}
