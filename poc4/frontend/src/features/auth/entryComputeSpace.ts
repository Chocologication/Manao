type Point3 = { x: number; y: number; z: number };
type ComputeNode = Point3 & { width: number; height: number; depth: number; floating: boolean; seed: number };
type Frame = {
  width: number; height: number; time: number; camera: number; low: boolean;
  pointerX: number; pointerY: number; pointerLight: number;
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const lanes = [-3.4, -1.9, 1.9, 3.4];
const nodes: ComputeNode[] = Array.from({ length: 24 }, (_, index) => {
  const row = Math.floor(index / lanes.length);
  return {
    x: lanes[index % lanes.length], y: -1.08, z: 4.4 + row * 2.3,
    width: .5, height: .7 + (index % 3) * .18, depth: .55, floating: false, seed: index,
  };
});
const modules: ComputeNode[] = [
  { x: -2.6, y: .15, z: 5.5, width: .95, height: .58, depth: .13, floating: true, seed: 24 },
  { x: .9, y: .9, z: 4.6, width: .8, height: .52, depth: .13, floating: true, seed: 25 },
  { x: 2.5, y: -.1, z: 5.8, width: .85, height: .55, depth: .13, floating: true, seed: 26 },
  { x: -.8, y: .45, z: 8.2, width: .9, height: .52, depth: .13, floating: true, seed: 27 },
];
const orderedNodes = [...nodes, ...modules].sort((a, b) => b.z - a.z);
const routes = [-3.7, -2.5, -1.05, 1.05, 2.5, 3.7].map((x, index) => [
  { x: x * .72, y: -1.14, z: 20 },
  { x: x * .72, y: -1.14, z: 7 + index % 2 },
  { x, y: -1.14, z: 5.2 },
  { x, y: -1.14, z: 1.05 },
]);
const faces = [[0, 1, 2, 3], [3, 2, 6, 7], [1, 5, 6, 2], [0, 3, 7, 4]];

/** Decorative world geometry only: no clocks, DOM access, network or simulated service status. */
export function drawEntryComputeSpace(ctx: CanvasRenderingContext2D, frame: Frame) {
  const { width, height, time, camera, low, pointerX, pointerY, pointerLight } = frame;
  const cx = width * (.37 + (pointerX - .35) * .018), cy = height * .51;
  const focal = Math.min(width * .74, height * .96);
  const distance = (1 - camera) * 8;
  const project = (point: Point3) => {
    const scale = focal / (point.z + distance);
    return { x: cx + point.x * scale, y: cy - point.y * scale, scale };
  };
  const readability = (x: number, y: number) => {
    const nx = x / width, ny = y / height;
    const heading = clamp((.59 - nx) * 12) * clamp((ny - .13) * 20) * clamp((.47 - ny) * 20);
    return (1 - heading * .88) * (1 - clamp((nx - .63) * 7) * .8);
  };
  const path = (points: { x: number; y: number }[]) => {
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  };
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  // Light paths share the same perspective as the modules they connect.
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    const points = route.map(project);
    path(points); ctx.lineWidth = low ? 4 : 7; ctx.strokeStyle = '#3a9dff0b'; ctx.stroke();
    ctx.lineWidth = .9; ctx.strokeStyle = '#69c9ff44'; ctx.stroke();
    const phase = (time * .12 + index * .163) % 1;
    const position = phase * (route.length - 1);
    const segment = Math.min(route.length - 2, Math.floor(position));
    const a = route[segment], b = route[segment + 1], fraction = position - segment;
    const head = project({ x: a.x + (b.x - a.x) * fraction, y: a.y, z: a.z + (b.z - a.z) * fraction });
    const tail = project({ x: a.x + (b.x - a.x) * Math.max(0, fraction - .1), y: a.y, z: a.z + (b.z - a.z) * Math.max(0, fraction - .1) });
    const strength = Math.sin(phase * Math.PI) * readability(head.x, head.y);
    ctx.globalAlpha = strength;
    path([tail, head]); ctx.lineWidth = 2.2; ctx.strokeStyle = '#b8f1ff'; ctx.stroke();
    ctx.fillStyle = '#defaff'; ctx.fillRect(head.x - 1.5, head.y - 1.5, 3, 3);
    ctx.globalAlpha = 1;
  }

  // Repeated frames, seen through one another, establish the scale of the distant lab.
  for (let z = 18; z >= 6; z -= 4) {
    const points = [
      { x: -4.4, y: -1.14, z }, { x: -4.4, y: 1.8, z },
      { x: 4.4, y: 1.8, z }, { x: 4.4, y: -1.14, z },
    ].map(project);
    path(points); ctx.lineWidth = .7; ctx.strokeStyle = '#76c5ff13'; ctx.stroke();
  }

  for (const node of orderedNodes) {
    if (low && !node.floating && node.seed % 2 === 1) continue;
    const lift = node.floating ? Math.sin(time * .45 + node.seed) * .075 : 0;
    const y = node.y + lift;
    const center = project({ x: node.x, y: y + node.height / 2, z: node.z });
    if (center.x < -150 || center.x > width + 150 || center.y < -150 || center.y > height + 150) continue;
    const proximity = clamp(1 - Math.hypot(center.x - pointerX * width, center.y - pointerY * height) / 280) * pointerLight;
    const opacity = clamp(.4 + 1.5 / node.z + proximity * .5) * readability(center.x, center.y);
    const x0 = node.x - node.width / 2, x1 = node.x + node.width / 2;
    const y0 = y, y1 = y + node.height, z0 = node.z, z1 = node.z + node.depth;
    const vertices = [
      { x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 },
      { x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 },
    ].map(project);
    ctx.globalAlpha = opacity;
    for (let face = 0; face < faces.length; face++) {
      if ((face === 2 && node.x >= 0) || (face === 3 && node.x < 0)) continue;
      path(faces[face].map(index => vertices[index])); ctx.closePath();
      ctx.globalAlpha = node.floating ? opacity : .85;
      ctx.fillStyle = face === 1 ? '#163e61' : face === 0 ? '#091c33' : '#0b2845'; ctx.fill();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = face === 1 ? '#80d9ff90' : '#639ccd75'; ctx.lineWidth = .8; ctx.stroke();
    }
    const left = vertices[3].x, top = vertices[3].y;
    const w = node.width * center.scale, h = node.height * center.scale;
    ctx.fillStyle = '#90ddff'; ctx.fillRect(left + w * .12, top + h * .15, w * .12, Math.max(1, center.scale * .012));
    // Rack slots and code-shaped strokes communicate the role without fake status labels.
    for (let row = 0; row < 3; row++) {
      const sy = top + h * (.36 + row * .2);
      ctx.strokeStyle = node.floating ? '#7bcdff85' : '#4782b75a';
      ctx.lineWidth = Math.max(.6, center.scale * .009);
      ctx.beginPath(); ctx.moveTo(left + w * .12, sy);
      ctx.lineTo(left + w * (node.floating ? .52 + (row % 2) * .25 : .83), sy); ctx.stroke();
      if (!node.floating) {
        ctx.fillStyle = '#9be6ff'; ctx.fillRect(left + w * .72, sy - 1, Math.max(1, w * .04), 1.8);
      }
    }
    if (node.floating) {
      const ground = project({ x: node.x, y: -1.14, z: node.z });
      ctx.globalAlpha = opacity * .35;
      ctx.setLineDash([2, 6]); path([vertices[0], ground]); ctx.strokeStyle = '#8ae2ff'; ctx.lineWidth = .7; ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.ellipse(ground.x, ground.y, w * .46, w * .1, 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (proximity > .05) {
      ctx.globalAlpha = proximity * .24;
      ctx.strokeStyle = '#a4ebff'; ctx.lineWidth = 4;
      path([vertices[3], vertices[2]]); ctx.stroke();
    }
  }
  ctx.restore();
}
