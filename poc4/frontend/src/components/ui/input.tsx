import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const inputVariants = cva(
  'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] text-base shadow-xs outline-none transition-shadow placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:h-8 sm:text-sm',
);

function Input({
  className,
  type,
  ...props
}: React.ComponentProps<'input'> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ className }))}
      {...props}
    />
  );
}

export { Input, inputVariants };
