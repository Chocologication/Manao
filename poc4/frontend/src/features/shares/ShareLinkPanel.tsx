import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../../components/ui/button';
import { shareTime } from './RunShareContent';

export type ShareLinkPanelProps = { url: string; expiresAt: string };
export function ShareLinkPanel({ url, expiresAt }: ShareLinkPanelProps) {
  const [feedback, setFeedback] = useState('');
  async function copy() { try { await navigator.clipboard.writeText(url); setFeedback('链接已复制'); } catch { setFeedback('复制失败，请选择链接手动复制'); } }
  return <section aria-label="分享链接与二维码" className="min-w-0 space-y-3">
    <p className="text-sm text-muted-foreground">到期时间：<time dateTime={expiresAt}>{shareTime(expiresAt)}</time></p>
    <label className="block text-sm">分享链接<input aria-label="分享链接" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-sm" /></label>
    <Button type="button" variant="outline" onClick={() => void copy()}>复制链接</Button><p role="status" className="text-sm">{feedback}</p>
    <div className="w-fit max-w-full rounded-xl bg-white p-2"><QRCodeSVG value={url} size={192} marginSize={4} title="运行结果分享二维码" /></div>
  </section>;
}
