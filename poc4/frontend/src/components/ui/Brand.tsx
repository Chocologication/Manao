import { Terminal } from 'lucide-react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="lab-brand">
      <span className="lab-brand-mark"><Terminal size={19} aria-hidden="true" /></span>
      {!compact && <span>Manao<span className="lab-brand-caption">云端代码实验室</span></span>}
    </span>
  );
}
