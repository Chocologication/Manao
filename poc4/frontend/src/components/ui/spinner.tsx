import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      data-testid="spinner"
      className={cn('size-4 animate-spin text-muted-foreground', className)}
      aria-hidden
    />
  );
}
