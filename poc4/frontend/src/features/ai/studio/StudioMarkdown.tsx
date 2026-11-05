import { Children, isValidElement, memo, useDeferredValue, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import '../AssistantMarkdown.css';

function plain(node: ReactNode): string { return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? plain(child.props.children) : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join(''); }
function CodeBlock({ children, streaming }: { children?: ReactNode; streaming: boolean }) {
  const [copied, setCopied] = useState(false); const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const child = Children.toArray(children).find(isValidElement) as React.ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = child?.props.className?.match(/language-([^ ]+)/)?.[1] ?? 'text'; const text = plain(children).replace(/\n$/, '');
  return <div className="studio-code"><div className="studio-code-head"><span>{language}</span><button type="button" aria-label="复制代码" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600); }).catch(() => setCopied(false)); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div>
    {language === 'mermaid' && !streaming ? <MermaidDiagram text={text} /> : <pre>{children}</pre>}
  </div>;
}
function MermaidDiagram({ text }: { text: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, ''); const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    if (text.length > 16000) return;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 16000, maxEdges: 200, theme: 'neutral', flowchart: { htmlLabels: false } });
      const result = await mermaid.render(`manaoDiagram${id}`, text);
      if (alive) setSvg(DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image'], FORBID_ATTR: ['href', 'xlink:href'] }));
    }).catch(() => { if (alive) setSvg(''); });
    return () => { alive = false; };
  }, [text, id]);
  return svg ? <div className="studio-diagram" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre><code>{text}</code></pre>;
}
export const StudioMarkdown = memo(function StudioMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const deferred = useDeferredValue(text);
  return <div className="ai-markdown studio-markdown"><Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000 }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={{
    pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
    table: ({ children }) => <div className="ai-markdown-table"><table>{children}</table></div>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="studio-muted">[图片：{alt || '外部图片'}]</span>,
  }}>{deferred}</Markdown></div>;
});
