import { createEntryAurora } from './entryAurora';
import { drawEntryComputeSpace } from './entryComputeSpace';

export type EntryIntro = { progress: number };
type DeviceHints = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const wrap = (value: number, range: number) => ((value % range) + range) % range;
const codes = ['const idea = await create();', 'public class Hello { }', 'print("Hello, Manao")', 'type Workspace = { ... }'];

/** One clock drives both renderers. Camera travel never changes the ambient animation rate. */
export function createEntryFlowField(
  canvas: HTMLCanvasElement, auroraCanvas: HTMLCanvasElement, scene: HTMLElement, reduced: boolean, intro: EntryIntro,
) {
  let context: CanvasRenderingContext2D | null = null;
  try { context = canvas.getContext('2d', { alpha: true, desynchronized: true }); } catch { /* CSS stays visible when canvas is unavailable. */ }
  scene.dataset.backgroundState = 'still';
  scene.dataset.backgroundRenderer = context ? 'canvas' : 'static';
  if (!context) return () => { delete scene.dataset.backgroundState; delete scene.dataset.backgroundRenderer; };
  const ctx = context;
  const hints = navigator as DeviceHints;
  let width = 1, height = 1, ratio = 1, frame = 0, last = 0, time = 0, previousFrame = 0;
  let visible = true, disposed = false, lost = false, low = false, adaptiveLow = false, expensiveFrames = 0;
  let bounds = canvas.getBoundingClientRect();
  const pointer = { x: .35, y: .55, targetX: .35, targetY: .55, light: 0, active: false };
  const aurora = createEntryAurora(auroraCanvas, scene, () => { if (!disposed && !lost) draw(); });
  // Stable positions prevent flashes on resize and quality changes.
  const stars = Array.from({ length: 260 }, (_, i) => ({
    angle: i * 2.399963, radius: .15 + ((i * 73) % 101) / 101,
    depth: ((i * 31) % 127) / 127 * 4.4, size: i % 7 === 0 ? 1.4 : .7,
  }));
  const nodes = Array.from({ length: 18 }, (_, i) => ({ x: .05 + ((i * 37) % 76) / 100, y: .12 + ((i * 23) % 76) / 100 }));
  const line = (x: number, y: number, x2: number, y2: number, color: string, weight = 1) => {
    ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
  };
  const readingMask = (x: number, y: number) => {
    const nx = x / width, ny = y / height;
    const heading = clamp((.58 - nx) * 12) * clamp((ny - .13) * 20) * clamp((.47 - ny) * 20);
    return (1 - heading * .8) * (1 - clamp((nx - .62) * 7) * .8);
  };
  const resize = () => {
    if (disposed || lost) return;
    bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
    low = adaptiveLow || (hints.hardwareConcurrency || 8) <= 4 || (hints.deviceMemory !== undefined && hints.deviceMemory <= 4) || Boolean(hints.connection?.saveData);
    ratio = Math.min(devicePixelRatio || 1, low ? 1 : 1.5, Math.sqrt((low ? 900_000 : 1_650_000) / (width * height)));
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    aurora?.resize(width, height, low);
    scene.dataset.backgroundQuality = low ? 'low' : 'high';
    scene.dataset.backgroundDpr = ratio.toFixed(2);
    scene.dataset.particleCount = String(low ? 85 : 260);
  };
  const drawFallback = () => {
    for (let layer = 0; layer < 2; layer++) {
      const offset = layer * height * .055;
      const pulse = Math.sin(time * .16 + layer * .6);
      const gradient = ctx.createLinearGradient(0, height, width * .88, 0);
      gradient.addColorStop(0, '#205dff00'); gradient.addColorStop(.3, '#296dff10');
      gradient.addColorStop(.51, layer % 2 ? '#97f5ff12' : '#687cff14');
      gradient.addColorStop(.7, '#27b9df0a'); gradient.addColorStop(1, '#6885ff00');
      ctx.strokeStyle = gradient; ctx.lineWidth = 50 + layer * 24;
      ctx.beginPath(); ctx.moveTo(-width * .12, height * .94 + offset);
      ctx.bezierCurveTo(width * .06, height * (.1 + pulse * .09) + offset, width * .44, height * (.9 - pulse * .05) - offset, width * .88, -height * .2);
      ctx.stroke();
      ctx.lineWidth = .7; ctx.strokeStyle = '#7899ff0c'; ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const x = width * (.18 + i * .24 + Math.sin(time * .08 + i) * .04);
      const y = height * (.72 - i * .18 + Math.cos(time * .12 + i) * .06);
      const radius = width * .3;
      const cloud = ctx.createRadialGradient(x, y, 0, x, y, radius);
      cloud.addColorStop(0, i % 2 ? '#5880d520' : '#53c7ff20'); cloud.addColorStop(1, '#17294500');
      ctx.fillStyle = cloud; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  };
  function draw() {
    const progress = reduced ? 1 : clamp(intro.progress);
    const camera = 1 - Math.pow(1 - progress, 3);
    const travel = camera * 4.2;
    const cx = width * (.37 + (pointer.x - .35) * .018), cy = height * .53;
    aurora?.draw(time, progress, pointer.x, pointer.y, pointer.light, low);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'screen';
    if (!aurora?.available()) drawFallback();
    // Perspective floor converges underneath the scene instead of behind the form.
    const horizon = height * .65;
    for (let i = -7; i <= 8; i++) line(cx, horizon, cx + i * width * .14, height * 1.2, '#6898e612', .7);
    for (let i = 0; i < 8; i++) {
      const depth = wrap(i / 8 + time * .018 + camera * .3, 1);
      const y = horizon + depth * depth * height * .45;
      line(0, y, width * .7, y, `rgba(104,152,230,${depth * .09})`, .7);
    }
    drawEntryComputeSpace(ctx, {
      width, height, time, camera, low, pointerX: pointer.x, pointerY: pointer.y, pointerLight: pointer.light,
    });
    for (let i = 0; i < (low ? 85 : stars.length); i++) {
      const star = stars[i];
      const z = .35 + wrap(star.depth - travel - time * .22, 4.4);
      const scale = 1.2 / z;
      const x = cx + Math.cos(star.angle) * width * star.radius * .6 * scale;
      const y = cy + Math.sin(star.angle) * height * star.radius * .65 * scale;
      if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
      const alpha = clamp((z - .35) * 3) * clamp((4.75 - z) * 2) * readingMask(x, y) * .65;
      ctx.fillStyle = `rgba(169,216,255,${alpha})`;
      ctx.beginPath(); ctx.arc(x, y, star.size * clamp(scale, .4, 2.5), 0, Math.PI * 2); ctx.fill();
      const trail = (.012 + .025 * Math.pow(1 - progress, 2)) * scale;
      line(x, y, x - (x - cx) * trail, y - (y - cy) * trail, `rgba(140,207,255,${alpha * .65})`, .8);
    }
    // Three depth bands move at different rates, with near text larger and brighter.
    for (let i = 0; i < (low ? 9 : 15); i++) {
      const layer = i % 3;
      const depth = 3.6 - layer * 1.1 + (1 - camera) * 2.8;
      const scale = 1.3 / depth;
      const phase = wrap(i * .213 + time * (.007 + layer * .006), 1);
      const x = cx + (phase * 2 - 1) * width * scale;
      const y = cy + (((i * .271) % 1) * 2 - 1) * height * scale;
      const alpha = Math.sin(phase * Math.PI) * (.14 + layer * .075) * readingMask(x, y);
      ctx.font = `${Math.min(22, 7 + 12 * scale)}px Consolas, monospace`;
      ctx.fillStyle = `rgba(141,209,250,${alpha})`;
      ctx.fillText(codes[i % codes.length], x, y);
      line(x, y + 7 * scale, x + (75 + layer * 22) * scale, y + 7 * scale, `rgba(109,185,255,${alpha * .5})`);
    }
    const px = pointer.x * width, py = pointer.y * height;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], x = node.x * width, y = node.y * height;
      const proximity = clamp(1 - Math.hypot(x - px, y - py) / 300) * pointer.light;
      const next = nodes[(i + 1) % nodes.length];
      if (Math.hypot(next.x - node.x, next.y - node.y) < .45) {
        line(x, y, next.x * width, next.y * height, `rgba(112,185,255,${.035 + proximity * .4})`);
        const phase = wrap(time * .16 + i * .17, 1);
        const tx = x + (next.x * width - x) * phase, ty = y + (next.y * height - y) * phase;
        ctx.fillStyle = `rgba(160,231,255,${.12 + proximity * .6})`; ctx.fillRect(tx - 1, ty - 1, 2, 2);
      }
      if (proximity > 0) {
        line(x, y, px, py, `rgba(139,230,255,${proximity * .25})`);
        ctx.strokeStyle = `rgba(138,225,255,${proximity * .35})`; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.arc(x, y, 5 + proximity * 5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = `rgba(164,231,255,${.18 + proximity * .82})`;
      ctx.beginPath(); ctx.arc(x, y, 1.4 + proximity * 2.5, 0, Math.PI * 2); ctx.fill();
    }
    if (pointer.light > .001) {
      const glow = ctx.createRadialGradient(px, py, 0, px, py, 260);
      glow.addColorStop(0, `rgba(137,217,255,${pointer.light * .12})`); glow.addColorStop(1, '#89d9ff00');
      ctx.fillStyle = glow; ctx.fillRect(px - 260, py - 260, 520, 520);
    }
    ctx.globalCompositeOperation = 'source-over';
    scene.dataset.backgroundTime = time.toFixed(3);
    scene.dataset.backgroundCamera = camera.toFixed(4);
    scene.dataset.pointerLight = pointer.light.toFixed(3);
  }
  const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; last = 0; previousFrame = 0; };
  const render = (now: number) => {
    frame = 0;
    if (disposed || reduced || lost || document.hidden || !visible) return;
    const interval = previousFrame ? now - previousFrame : 16; previousFrame = now;
    if (!last || now - last >= 1000 / (low ? 30 : 60) - 1) {
      const delta = last ? Math.min((now - last) / 1000, .1) : 0; last = now;
      const ease = 1 - Math.exp(-delta * 5);
      pointer.x += (pointer.targetX - pointer.x) * ease; pointer.y += (pointer.targetY - pointer.y) * ease;
      pointer.light += ((pointer.active ? 1 : 0) - pointer.light) * ease;
      time += delta;
      const start = performance.now(); draw();
      expensiveFrames = performance.now() - start > 12 || interval > 34 ? expensiveFrames + 1 : Math.max(0, expensiveFrames - 1);
      if (!low && expensiveFrames >= 24) { adaptiveLow = true; resize(); }
    }
    frame = requestAnimationFrame(render);
  };
  const sync = () => {
    stop();
    const active = !reduced && !lost && !document.hidden && visible;
    scene.dataset.backgroundState = active ? 'flowing' : 'still';
    if (active && !disposed) frame = requestAnimationFrame(render);
  };
  const onResize = () => { if (!lost) { resize(); draw(); sync(); } };
  const onMove = (event: PointerEvent) => {
    if (reduced || document.hidden || event.pointerType === 'touch') return;
    pointer.targetX = clamp((event.clientX - bounds.left) / width);
    pointer.targetY = clamp((event.clientY - bounds.top) / height);
    pointer.active = true;
  };
  const onLeave = () => { pointer.active = false; pointer.targetX = .35; pointer.targetY = .55; };
  const onLost = (event: Event) => { event.preventDefault(); lost = true; stop(); scene.dataset.backgroundRenderer = 'static'; scene.dataset.backgroundState = 'still'; };
  const onRestored = () => { lost = false; scene.dataset.backgroundRenderer = 'canvas'; onResize(); };
  const observer = new ResizeObserver(onResize);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  const area = scene.closest('main')!;
  observer.observe(canvas); intersection.observe(canvas);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', onResize, { passive: true });
  area.addEventListener('pointermove', onMove, { passive: true }); area.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextlost', onLost); canvas.addEventListener('contextrestored', onRestored);
  resize(); draw(); sync();
  return () => {
    disposed = true; stop(); observer.disconnect(); intersection.disconnect(); aurora?.dispose();
    document.removeEventListener('visibilitychange', sync); window.removeEventListener('resize', onResize);
    area.removeEventListener('pointermove', onMove); area.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('contextlost', onLost); canvas.removeEventListener('contextrestored', onRestored);
    ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.width = 1; canvas.height = 1;
    for (const key of ['backgroundState', 'backgroundRenderer', 'backgroundQuality', 'backgroundDpr', 'backgroundTime', 'backgroundCamera', 'particleCount', 'pointerLight', 'auroraRenderer']) delete scene.dataset[key];
  };
}
