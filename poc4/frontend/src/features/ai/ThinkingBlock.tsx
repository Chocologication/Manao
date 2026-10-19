export function ThinkingBlock({ text, active, incomplete = false }: { text: string; active: boolean; incomplete?: boolean }) {
  return <details className="min-w-0 rounded border p-2 text-muted-foreground">
    <summary className="cursor-pointer text-xs">{active ? '思考中' : '思考过程'}</summary>
    {incomplete ? <div className="mt-2 text-xs">还有更早内容</div> : null}
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
  </details>;
}
