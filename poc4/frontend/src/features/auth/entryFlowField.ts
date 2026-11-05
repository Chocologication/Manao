type DeviceHints = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
type Point = { x: number; y: number };
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const ramp = (n: number, a: number, b: number) => { const t = clamp((n - a) / (b - a)); return t * t * (3 - 2 * t); };

/** A full-screen print-run metaphor: source → prepare → execute → evidence. */
export function createEntryFlowField(canvas: HTMLCanvasElement, scene: HTMLElement, reduced: boolean) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  scene.dataset.backgroundState = 'still';
  scene.dataset.backgroundRenderer = context ? 'canvas' : 'static';
  if (!context) return () => { delete scene.dataset.backgroundState; delete scene.dataset.backgroundRenderer; };

  const hints = navigator as DeviceHints;
  let width = 1, height = 1, ratio = 1, frame = 0, last = 0, time = 0;
  let visible = true, disposed = false, lost = false, low = false, adaptiveLow = false, resizing = true, expensiveFrames = 0;
  const rect = (x: number, y: number, w: number, h: number, fill: string | CanvasGradient, alpha = 1) => {
    context.globalAlpha = alpha; context.fillStyle = fill; context.fillRect(x, y, w, h);
  };
  const polygon = (points: Point[], fill: string | CanvasGradient) => {
    context.globalAlpha = 1; context.fillStyle = fill; context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
    context.closePath(); context.fill();
  };
  const line = (a: Point, b: Point, color: string, weight = 1, alpha = 1) => {
    context.globalAlpha = alpha; context.strokeStyle = color; context.lineWidth = weight;
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  };
  const label = (text: string, x: number, y: number, color: string, size = 10, alpha = 1) => {
    context.globalAlpha = alpha; context.fillStyle = color; context.textBaseline = 'middle';
    context.font = `${size}px "Cascadia Code", Consolas, monospace`; context.fillText(text, x, y);
  };
  const resize = () => {
    if (disposed || lost) return;
    const bounds = canvas.getBoundingClientRect(); width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
    low = adaptiveLow || (hints.hardwareConcurrency || 8) <= 4 || (hints.deviceMemory !== undefined && hints.deviceMemory <= 4) || Boolean(hints.connection?.saveData);
    ratio = Math.min(devicePixelRatio || 1, low ? 1 : 1.5, Math.sqrt((low ? 900_000 : 1_650_000) / (width * height)));
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    scene.dataset.backgroundQuality = low ? 'low' : 'high'; scene.dataset.backgroundDpr = ratio.toFixed(2);
    resizing = true;
  };

  const draw = () => {
    // Every transient returns to zero at both ends of the same 18-second clock.
    const t = reduced ? 12 : time % 18;
    const scale = clamp(Math.min(width / 1440, height / 960), .8, 1.6);
    const unfold = ramp(t, 3, 7) * (1 - ramp(t, 14, 18));
    const ink = ramp(t, 0, 3) * (1 - ramp(t, 16, 18));
    const output = ramp(t, 10, 13) * (1 - ramp(t, 15, 18));
    const project = (u: number, v: number, lift = 0): Point => ({
      x: width * (.20 + .86 * u + .14 * v), y: height * (1.025 - .72 * u + .16 * v) - lift,
    });
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.globalCompositeOperation = 'source-over'; context.lineJoin = 'miter';
    rect(0, 0, width, height, '#efeee7');
    polygon([{ x: width * .6, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: width * .31, y: height }], '#e3e4dd');
    for (const x of [width * .034, width * .966]) {
      line({ x, y: height * .13 }, { x, y: height * .94 }, '#b9beb7', .7);
      for (let i = 0; i < 9; i++) { const y = height * (.15 + i * .093); line({ x: x - 4, y }, { x: x + 4, y }, '#959f98', .7); }
    }

    // A diagonal execution bed crosses the entire page, including foreground.
    context.save(); context.shadowColor = '#13274440'; context.shadowOffsetY = 12 * scale; context.shadowBlur = 8 * scale;
    polygon([project(-.15, -.2), project(1.2, -.2), project(1.2, 1.2), project(-.15, 1.2)], '#143349'); context.restore();
    polygon([project(-.15, 1.2), project(1.2, 1.2), project(1.2, 1.2, -18 * scale), project(-.15, 1.2, -18 * scale)], '#0c2639');
    const rows = low ? 7 : 10;
    for (let row = rows - 1; row >= 0; row--) {
      const v = row / rows;
      const lift = unfold * Math.sin((v * .75 + .1) * Math.PI) * height * .12;
      const face = [project(-.1, v, lift), project(1.13, v, lift), project(1.13, v + .072, lift), project(-.1, v + .072, lift)];
      const material = context.createLinearGradient(0, height, width, 0);
      material.addColorStop(0, '#123dae'); material.addColorStop(.44, row % 3 === 0 ? '#1260ef' : '#224de0');
      material.addColorStop(.75, '#5088f5'); material.addColorStop(1, '#b5d3ff');
      polygon([face[2], face[3], project(-.1, v + .072, lift - 11 * scale), project(1.13, v + .072, lift - 11 * scale)], '#102d83');
      polygon(face, material); line(face[0], face[1], '#b3d1ff', .8, .7);
      for (let i = 0; i < (low ? 5 : 10); i++) {
        const u = i / (low ? 5 : 10);
        line(project(u, v + .025, lift), project(u + .035 + (row % 3) * .012, v + .025, lift), '#d5e6ff', 1.4 * scale, .38);
      }
      const progress = ramp(t, 6.4 + row * .13, 10.4 + row * .13);
      const alpha = ramp(t, 6 + row * .13, 7 + row * .13) * (1 - ramp(t, 10.2 + row * .13, 11.2 + row * .13));
      line(project(progress, v, lift), project(progress, v + .072, lift), '#ff8a43', 8 * scale, alpha);
    }

    // Matching Python source/output, labelled as an illustration, not live data.
    context.save(); context.transform(1, -.16, .32, .7, width * .012, height * .72);
    const sw = width * .36, sh = height * .36;
    context.shadowColor = '#23395230'; context.shadowOffsetY = 13 * scale; context.shadowBlur = 8 * scale;
    rect(0, 0, sw, sh, '#faf9f1'); context.shadowColor = 'transparent'; rect(0, 0, 5 * scale, sh, '#e5673d');
    label('01 / SOURCE     main.py', 26 * scale, 22 * scale, '#1a3445', 11 * scale);
    line({ x: 24, y: 40 }, { x: sw - 22, y: 40 }, '#b9c0bc', .8);
    ['values = [3, 1, 4, 1, 5]', 'total = sum(values)', 'print(total)'].forEach((text, i) => {
      const y = (77 + i * 37) * scale;
      label(String(i + 1).padStart(2, '0'), 25 * scale, y, '#8d9893', 11 * scale);
      label(text, 64 * scale, y, '#a4ada4', 16 * scale);
      label(text.slice(0, Math.round(clamp(ink * 4 - i) * text.length)), 64 * scale, y, i === 0 ? '#1344c8' : '#243b43', 16 * scale);
    });
    label('PYTHON / WORKFLOW ILLUSTRATION', 26 * scale, sh - 23 * scale, '#62766c', 9 * scale); context.restore();

    context.save(); context.transform(1, -.16, .32, .7, width * .47, height * (.82 - output * .085));
    const rw = width * .32, rh = height * .30;
    context.shadowColor = '#102b5938'; context.shadowBlur = 8 * scale; context.shadowOffsetY = 15 * scale;
    rect(0, 0, rw, rh, '#faf9f1'); context.shadowColor = 'transparent'; rect(0, 0, rw, 4 * scale, '#e5673d');
    label('03 / RUN EVIDENCE', 24 * scale, 25 * scale, '#223c47', 11 * scale);
    line({ x: 24, y: 44 }, { x: rw - 24, y: 44 }, '#bcc3b9');
    label('stdout', 24 * scale, 70 * scale, '#6b796f', 10 * scale);
    // Cross-fade characters rather than switching abruptly at a threshold.
    label('—', 24 * scale, 112 * scale, '#1646cf', 40 * scale, 1 - output);
    label('14', 24 * scale, 112 * scale, '#1646cf', 40 * scale, output);
    label('main.py → stdout → history', 24 * scale, rh - 30 * scale, '#4e645e', 10 * scale);
    label('exit code 0 / EXAMPLE', rw * .43, 102 * scale, '#1d4c45', 10 * scale, output); context.restore();

    label('02 / EXECUTION', width * .5, height * .67, '#163c91', 10 * scale);
    context.globalAlpha = 1;
    scene.dataset.backgroundStage = t < 3 ? 'SOURCE' : t < 7 ? 'PREPARE' : t < 11 ? 'EXECUTE' : t < 15 ? 'EVIDENCE' : 'RESET';
    scene.dataset.backgroundCycle = String(Math.floor(time / 18)); scene.dataset.backgroundTime = time.toFixed(3);
    resizing = false;
  };
  const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; last = 0; };
  const render = (now: number) => {
    frame = 0;
    if (disposed || reduced || lost || document.hidden || !visible) return;
    if (!last || now - last >= 1000 / (low ? 30 : 60) - .8 || resizing) {
      const delta = last ? (now - last) / 1000 : 0; last = now; time += delta;
      const start = performance.now(); draw(); const cost = performance.now() - start;
      expensiveFrames = cost > 12 || delta > .032 ? expensiveFrames + 1 : Math.max(0, expensiveFrames - 1);
      if (!low && expensiveFrames >= 12) { adaptiveLow = true; resize(); }
    }
    frame = requestAnimationFrame(render);
  };
  const sync = () => {
    stop(); const active = !reduced && !lost && !document.hidden && visible;
    scene.dataset.backgroundState = active ? 'flowing' : 'still';
    if (active && !disposed) frame = requestAnimationFrame(render);
    else if (!disposed && !lost && resizing) draw();
  };
  const onResize = () => { if (!lost) { resize(); if (reduced || document.hidden || !visible) draw(); else sync(); } };
  const onLost = (event: Event) => { event.preventDefault(); lost = true; stop(); scene.dataset.backgroundRenderer = 'static'; scene.dataset.backgroundState = 'still'; };
  const onRestored = () => { lost = false; scene.dataset.backgroundRenderer = 'canvas'; onResize(); sync(); };
  const observer = new ResizeObserver(onResize);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  observer.observe(canvas); intersection.observe(canvas);
  document.addEventListener('visibilitychange', sync); window.addEventListener('resize', onResize, { passive: true });
  canvas.addEventListener('contextlost', onLost); canvas.addEventListener('contextrestored', onRestored);
  resize(); draw(); sync();
  return () => {
    disposed = true; stop(); observer.disconnect(); intersection.disconnect();
    document.removeEventListener('visibilitychange', sync); window.removeEventListener('resize', onResize);
    canvas.removeEventListener('contextlost', onLost); canvas.removeEventListener('contextrestored', onRestored);
    context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = 1; canvas.height = 1;
    for (const key of ['backgroundState', 'backgroundRenderer', 'backgroundQuality', 'backgroundDpr', 'backgroundStage', 'backgroundCycle', 'backgroundTime']) delete scene.dataset[key];
  };
}
