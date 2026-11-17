const vertexSource = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() { vUv = aPosition * .5 + .5; gl_Position = vec4(aPosition, 0., 1.); }
`;

const fragmentSource = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uProgress;
uniform float uQuality;
uniform vec2 uPointer;
uniform float uPointerLight;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
             mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float cloud(vec2 p) {
  float n = 0., weight = .52;
  for (int i = 0; i < 4; i++) { n += noise(p) * weight; p = p * 2.03 + vec2(8.3, 1.7); weight *= .48; }
  return n;
}
void main() {
  float settled = smoothstep(.45, 1., uProgress);
  vec2 uv = (vUv - .5) / mix(.74, 1., smoothstep(0., 1., uProgress)) + .5;
  uv += (uPointer - vec2(.35, .45)) * vec2(.009, .012) * settled;
  float t = uTime;
  vec3 color = vec3(.016, .033, .068);
  vec2 drift = vec2(t * .024, -t * .019);
  float atmosphere = cloud(uv * vec2(3.4, 4.6) + drift);
  float field = exp(-length((uv - vec2(.36, .42)) * vec2(1.2, 1.7)) * 2.1);
  color += vec3(.04, .12, .24) * field * atmosphere;
  for (int i = 0; i < 2; i++) {
    if (uQuality < .5 && i > 0) break;
    float layer = float(i);
    float billow = cloud(vec2(uv.x * 3.4 + layer * 1.7, t * .035 + layer));
    float curve = .12 + uv.x * .77 + .105 * sin(uv.x * 4.7 - t * .18 + layer * .65);
    curve += (billow - .5) * .19 + layer * .058;
    float distance = uv.y - curve;
    float folds = cloud(vec2(uv.x * 17. + t * .09, distance * 8. - t * .04 + layer * 3.));
    float veil = exp(-abs(distance) * (12. + layer * 2.)) * (.3 + folds);
    float edge = exp(-abs(distance + .009) * 125.);
    float filament = pow(.5 + .5 * sin(uv.x * 145. + billow * 16. + layer * 5. + t * .4), 3.);
    vec3 tint = mix(vec3(.08, .23, .7), vec3(.12, .65, .84), folds);
    // Aurora is ambient illumination behind the lab, rather than a dominant ribbon.
    color += tint * veil * (.075 + filament * .035);
    color += vec3(.48, .85, 1.) * edge * (.008 + folds * .018);
    color *= 1. - exp(-abs(distance - .055) * 32.) * .045;
  }
  vec2 pointerDelta = (vUv - uPointer) * vec2(1.5, 1.);
  color += vec3(.08, .25, .35) * exp(-dot(pointerDelta, pointerDelta) * 55.) * uPointerLight;
  float readingArea = (1. - smoothstep(.36, .6, vUv.x)) * smoothstep(.56, .82, vUv.y);
  color *= 1. - readingArea * .58;
  color *= 1. - smoothstep(.64, 1., vUv.x) * .52;
  color *= .72 + .28 * smoothstep(0., .18, vUv.y);
  color += (hash(gl_FragCoord.xy) - .5) * .005;
  gl_FragColor = vec4(color, 1.);
}
`;

/** Optional GPU atmosphere; the owner supplies the single animation clock and Canvas2D fallback. */
export function createEntryAurora(canvas: HTMLCanvasElement, scene: HTMLElement, onChange: () => void) {
  let gl: WebGLRenderingContext | null = null;
  try { gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }); } catch { /* Retain Canvas2D rendering. */ }
  if (!gl) { scene.dataset.auroraRenderer = 'canvas'; return null; }
  const context = gl;
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
  let shaders: WebGLShader[] = [];
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let lost = false, disposed = false;

  function release() {
    if (buffer) context.deleteBuffer(buffer);
    if (program) context.deleteProgram(program);
    shaders.forEach(shader => context.deleteShader(shader));
    program = null; buffer = null; shaders = []; uniforms = {};
  }
  function prepare() {
    release();
    for (const [type, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = context.createShader(type);
      if (!shader) { release(); return false; }
      shaders.push(shader); context.shaderSource(shader, source); context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) { release(); return false; }
    }
    program = context.createProgram();
    if (!program) { release(); return false; }
    shaders.forEach(shader => context.attachShader(program!, shader)); context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) { release(); return false; }
    buffer = context.createBuffer();
    if (!buffer) { release(); return false; }
    context.useProgram(program); context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW);
    const position = context.getAttribLocation(program, 'aPosition');
    context.enableVertexAttribArray(position); context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    for (const name of ['uTime', 'uProgress', 'uQuality', 'uPointer', 'uPointerLight']) uniforms[name] = context.getUniformLocation(program, name);
    return true;
  }
  const available = () => !lost && !disposed && program !== null;
  const updateState = () => { scene.dataset.auroraRenderer = available() ? 'webgl' : 'canvas'; };
  const onLost = (event: Event) => { event.preventDefault(); lost = true; updateState(); onChange(); };
  const onRestored = () => { if (!disposed) { lost = false; prepare(); updateState(); onChange(); } };
  prepare(); updateState();
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return {
    available,
    resize(width: number, height: number, low: boolean) {
      const scale = Math.min(1, Math.sqrt((low ? 230_000 : 480_000) / (width * height)));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    },
    draw(time: number, progress: number, x: number, y: number, light: number, low: boolean) {
      if (!available()) return;
      context.viewport(0, 0, canvas.width, canvas.height); context.useProgram(program);
      context.uniform1f(uniforms.uTime, time); context.uniform1f(uniforms.uProgress, progress);
      context.uniform1f(uniforms.uQuality, low ? 0 : 1); context.uniform2f(uniforms.uPointer, x, 1 - y);
      context.uniform1f(uniforms.uPointerLight, light); context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      disposed = true; release();
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      canvas.width = 1; canvas.height = 1; delete scene.dataset.auroraRenderer;
      // StrictMode and preference changes reuse the canvas; only lose detached contexts.
      queueMicrotask(() => { if (!canvas.isConnected) context.getExtension('WEBGL_lose_context')?.loseContext(); });
    },
  };
}
