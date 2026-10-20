import { useState } from 'react';
export function ThinkingBlock({ text, active, incomplete = false, initialChoice, choice, onChoice }: { text: string; active: boolean; incomplete?: boolean; initialChoice?: boolean; choice?: boolean; onChoice?: (open: boolean) => void }) {
  const [selected, setSelected] = useState(initialChoice);
  const open = choice ?? selected ?? active;
  return <details open={open} className="manao-ai-thinking">
    <summary className="manao-ai-thinking-summary" onClick={event => { event.preventDefault(); setSelected(!open); onChoice?.(!open); }}>{active ? '思考中' : '思考过程'}</summary>
    {incomplete ? <div className="manao-ai-message-notice">还有更早内容</div> : null}
    <pre className="manao-ai-thinking-text">{text}</pre>
  </details>;
}
