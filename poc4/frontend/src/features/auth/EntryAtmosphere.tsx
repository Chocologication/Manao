import { useEffect, useRef } from 'react';
import { createEntryFlowField } from './entryFlowField';

export function EntryAtmosphere({ reducedMotion }: { reducedMotion: boolean }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    if (!scene || !canvas) return;
    return createEntryFlowField(canvas, scene, reducedMotion);
  }, [reducedMotion]);
  return (
    <div ref={sceneRef} className="entry__atmosphere" data-reduced-motion={reducedMotion}
      data-background-version="execution-atlas" aria-hidden="true">
      <div className="entry__flow-field">
        <div className="entry__flow-fallback" />
        <canvas ref={canvasRef} className="entry__flow-canvas" />
      </div>
      <div className="entry__instrument">
        <span>项目运行流程</span>
        <span>源码 → 运行 → 记录</span>
        <small>码瑙工作流 · 动态示意</small>
      </div>
    </div>
  );
}
