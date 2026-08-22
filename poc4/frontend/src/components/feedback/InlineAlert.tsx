import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function InlineAlert({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p role="alert" className={cn('text-sm text-destructive', className)}>
      {children}
    </p>
  );
}
