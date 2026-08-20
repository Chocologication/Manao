import { GripVertical } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  onResize: (deltaPercent: number) => void;
  style?: CSSProperties;
}

export function ResizeHandle({ onResize, style }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);

  const handleMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsResizing(true);
    setStartX(e.clientX);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      const parentWidth = handleRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      if (parentWidth <= 0) return;
      const deltaX = e.clientX - startX;
      setStartX(e.clientX);
      onResize((deltaX / parentWidth) * 100);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, startX, onResize]);

  return (
    <div
      ref={handleRef}
      className={cn(
        'group absolute top-0 bottom-0 z-50 flex w-px -translate-x-1/2 shrink-0 cursor-col-resize items-center justify-center bg-border/50 transition-colors hover:bg-accent',
        isResizing && 'bg-accent'
      )}
      style={style}
      onMouseDown={handleMouseDown}
    >
      <GripVertical className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
    </div>
  );
}
