import { useEffect, useRef } from 'react';
import { createEntryFlowField, type EntryIntro } from './entryFlowField';

export function EntryAtmosphere({ reducedMotion, ready, intro }: { reducedMotion: boolean; ready: boolean; intro: EntryIntro }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const auroraRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const aurora = auroraRef.current;
    if (!scene || !canvas || !aurora) return;
    return createEntryFlowField(canvas, aurora, scene, reducedMotion, intro);
  }, [reducedMotion, intro]);
  return (
    <div ref={sceneRef} className="entry__atmosphere" data-reduced-motion={reducedMotion}
      data-background-version="compute-lab" data-entry-ready={ready} aria-hidden="true">
      <div className="entry__flow-field">
        <div className="entry__flow-fallback" />
        <canvas ref={auroraRef} className="entry__aurora-canvas" />
        <canvas ref={canvasRef} className="entry__flow-canvas" />
      </div>
    </div>
  );
}
