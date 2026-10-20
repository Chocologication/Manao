import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, ChevronDown, Copy, LogOut, Monitor, Palette, SlidersHorizontal, UserRound, X, PanelsTopLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/AuthProvider';
import { useEditorPreferences } from '@/features/editor/editorPreferences';
import { useThemePreferences, type ThemePreference } from '@/features/preferences/themePreferences';
import { useMotionPreferences } from '@/features/preferences/motionPreferences';
import { useWorkbenchPreferences } from '@/features/preferences/workbenchPreferences';

const themes: { value: ThemePreference; label: string }[] = [
  { value: 'lab', label: '墨绿实验室' },
  { value: 'graphite', label: '石墨深色' },
  { value: 'light', label: '日间浅色' },
  { value: 'system', label: '跟随系统' },
];

export function AccountPanel({ compact = false, onLogout }: { compact?: boolean; onLogout: () => void }) {
  const { snapshot } = useAuth();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('account');
  const [copyStatus, setCopyStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const panelId = useId();
  const preference = useThemePreferences((state) => state.preference);
  const setPreference = useThemePreferences((state) => state.setPreference);
  const editor = useEditorPreferences();
  const motion = useMotionPreferences();
  const layout = useWorkbenchPreferences();
  const [fontSizeDraft, setFontSizeDraft] = useState<string | null>(null);
  const user = snapshot.status === 'authenticated' ? snapshot.user : null;
  const expiry = snapshot.status === 'authenticated' ? new Date(snapshot.expiresAt) : null;
  const expiryLabel = expiry && Number.isFinite(expiry.getTime()) ? expiry.toLocaleString('zh-CN', { hour12: false }) : null;

  useEffect(() => {
    const element = dialog.current;
    const returnFocus = trigger.current;
    if (!open || !element) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    element.querySelector<HTMLButtonElement>('[aria-label="关闭账户面板"]')?.focus();
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
      else element.removeAttribute('open');
      returnFocus?.focus();
    };
  }, [open]);

  async function copyId() {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.id);
      setCopyStatus('账户 ID 已复制');
    } catch { setCopyStatus('复制失败，请手动选择账户 ID'); }
  }

  function commitFontSize() {
    if (fontSizeDraft?.trim()) editor.update({ fontSize: Number(fontSizeDraft) });
    setFontSizeDraft(null);
  }

  if (!user) return null;
  const tabs = [
    { id: 'account', label: '账户', Icon: UserRound },
    { id: 'appearance', label: '外观', Icon: Palette },
    { id: 'editor', label: '编辑器', Icon: SlidersHorizontal },
    { id: 'layout', label: '布局', Icon: PanelsTopLeft },
  ];

  return <>
    <Button ref={trigger} variant="ghost" size={compact ? 'icon' : 'default'} className="lab-account-trigger" aria-label="账户与偏好" aria-haspopup="dialog" aria-expanded={open} title="账户与偏好" onClick={() => { setCopyStatus(''); setFontSizeDraft(null); setOpen(true); }}>
      <span className="lab-avatar" aria-hidden="true">{Array.from(user.username)[0]?.toUpperCase() ?? 'M'}</span>
      {!compact && <><span className="lab-account-name">{user.username}</span><ChevronDown size={14} /></>}
    </Button>
    {open && createPortal(<dialog ref={dialog} className="lab-account-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false); } }}>
      <header className="lab-account-header"><div><p className="lab-eyebrow">MANAO / ACCOUNT</p><h2 id={titleId}>账户与偏好</h2></div><Button variant="ghost" size="icon" aria-label="关闭账户面板" title="关闭" onClick={() => setOpen(false)}><X /></Button></header>
      <div role="tablist" aria-label="账户设置" className="lab-account-tabs">
        {tabs.map(({ id, label, Icon }, index) => <button key={id} id={`${panelId}-${id}`} role="tab" aria-selected={tab === id} aria-controls={`${panelId}-content`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          setTab(tabs[next].id);
          document.getElementById(`${panelId}-${tabs[next].id}`)?.focus();
        }}><Icon size={16} aria-hidden="true" />{label}</button>)}
      </div>
      <section id={`${panelId}-content`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} tabIndex={0} className="lab-account-content">
        {tab === 'account' && <>
          <div className="lab-account-identity"><span className="lab-avatar" aria-hidden="true">{Array.from(user.username)[0]?.toUpperCase() ?? 'M'}</span><div><h3>{user.username}</h3><span className="lab-account-session"><CheckCheck size={14} />已登录</span></div></div>
          <dl className="lab-account-details"><div><dt>用户名</dt><dd>{user.username}</dd></div><div><dt>账户 ID</dt><dd><code>{user.id}</code><Button variant="ghost" size="icon" aria-label="复制账户 ID" title="复制账户 ID" onClick={() => void copyId()}><Copy /></Button></dd></div><div><dt>认证状态</dt><dd>当前会话已认证</dd></div>{expiryLabel && <div><dt>会话到期</dt><dd><time dateTime={snapshot.status === 'authenticated' ? snapshot.expiresAt : undefined}>{expiryLabel}</time></dd></div>}</dl>
          <p role="status" className="lab-account-feedback">{copyStatus}</p>
        </>}
        {tab === 'appearance' && <>
          <h3>工作台主题</h3>
          <fieldset className="lab-theme-options"><legend className="sr-only">选择工作台主题</legend>{themes.map(({ value, label }) => <label key={value} className="lab-theme-option" data-selected={preference === value}>
            <input type="radio" name={`${panelId}-theme`} value={value} checked={preference === value} onChange={() => setPreference(value)} />
            <span className="lab-theme-swatch" data-swatch={value} aria-hidden="true">{value === 'system' ? <Monitor size={22} /> : <><i /><i /><i /></>}</span>
            <span>{label}</span>{preference === value && <Check size={15} aria-hidden="true" />}
          </label>)}</fieldset>
          <label className="lab-preference-row"><span>界面动态效果</span><input type="checkbox" checked={motion.enabled} onChange={(event) => motion.setEnabled(event.target.checked)} /></label>
          <p className="text-xs text-muted-foreground">系统减少动态效果设置始终优先。</p>
        </>}
        {tab === 'editor' && <>
          <h3>编辑偏好</h3>
          <label className="lab-preference-row"><span>代码字号 <small>px</small></span><input aria-label="代码字号" type="number" min={12} max={24} step={1} value={fontSizeDraft ?? editor.fontSize} onChange={(event) => { setFontSizeDraft(event.currentTarget.value); const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= 12 && value <= 24) editor.update({ fontSize: value }); }} onBlur={commitFontSize} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
          <label className="lab-preference-row"><span>自动换行</span><input type="checkbox" checked={editor.wordWrap} onChange={(event) => editor.update({ wordWrap: event.currentTarget.checked })} /></label>
          <label className="lab-preference-row"><span>代码缩略图 <small>minimap</small></span><input type="checkbox" checked={editor.minimap} onChange={(event) => editor.update({ minimap: event.currentTarget.checked })} /></label>
          <Button variant="outline" size="sm" onClick={() => { setFontSizeDraft(null); editor.update({ fontSize: 14, wordWrap: false, minimap: false }); }}>恢复编辑器默认设置</Button>
        </>}
        {tab === 'layout' && <>
          <h3>工作台布局</h3>
          <label className="lab-preference-row"><span>专注编码模式</span><input type="checkbox" checked={layout.focusMode} onChange={(event) => layout.update({ focusMode: event.target.checked })} /></label>
          <label className="lab-preference-row"><span>显示文件面板</span><input type="checkbox" checked={layout.filesVisible} onChange={(event) => layout.update({ filesVisible: event.target.checked })} /></label>
          <label className="lab-preference-row"><span>显示运行洞察</span><input type="checkbox" checked={layout.insightsVisible} onChange={(event) => layout.update({ insightsVisible: event.target.checked })} /></label>
          <label className="lab-preference-row"><span>文件面板宽度 <small>{layout.fileWidth}px</small></span><input aria-label="文件面板宽度" type="range" min={180} max={340} step={10} value={layout.fileWidth} onChange={(event) => layout.update({ fileWidth: event.currentTarget.valueAsNumber })} /></label>
          <Button variant="outline" size="sm" onClick={layout.reset}><RotateCcw />恢复默认布局</Button>
        </>}
      </section>
      <footer className="lab-account-footer"><Button variant="ghost" size="sm" onClick={() => { setPreference('lab'); editor.update({ fontSize: 14, wordWrap: false, minimap: false }); motion.setEnabled(true); layout.reset(); setFontSizeDraft(null); }}><RotateCcw />恢复全部偏好</Button><Button variant="ghost" onClick={() => { setOpen(false); onLogout(); }}><LogOut />退出登录</Button></footer>
    </dialog>, document.body)}
  </>;
}
