#!/usr/bin/env node
// Debug: render floor walkable grid + flood fill from C106 as ASCII to find disconnections.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(readFileSync(join(root, 'data', 'map.json'), 'utf8'));
const GRID = 4;
const W = Math.ceil(720 / GRID), H = Math.ceil(1000 / GRID);
const WALK_TYPES = new Set(['corridor', 'stairs', 'elevator', 'common']);

function shapeToPolys(r) {
  return r.shapes.map(s => s.kind === 'poly' ? s.pts
    : [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]]);
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const f = '1';
const grid = new Uint8Array(W * H);
const polys = [];
for (const r of map[f].rooms) if (WALK_TYPES.has(r.type)) for (const p of shapeToPolys(r)) polys.push(p);
for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
  const cx = gx * GRID + GRID / 2, cy = gy * GRID + GRID / 2;
  for (const p of polys) if (pointInPoly(cx, cy, p)) { grid[gy * W + gx] = 1; break; }
}
const doors = map[f].doors.map(d => [(d[0] + d[2]) / 2, (d[1] + d[3]) / 2]);
for (const [mx, my] of doors) grid[Math.floor(my / GRID) * W + Math.floor(mx / GRID)] = 1;

// flood fill from C106 centroid cell (find nearest walkable)
function nearestWalkable(x, y) {
  let gx = Math.floor(x / GRID), gy = Math.floor(y / GRID);
  if (grid[gy * W + gx]) return [gx, gy];
  for (let r = 1; r < 30; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = gx + dx, ny = gy + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && grid[ny * W + nx]) return [nx, ny];
    }
  }
  return null;
}
const c106 = map[f].rooms.find(r => r.id === 'C106');
const start = nearestWalkable(c106.centroid[0], c106.centroid[1]);
console.log('C106 anchor:', start, 'total walkable:', grid.reduce((s, v) => s + v, 0));

// BFS flood
const seen = new Uint8Array(W * H);
const q = [start[1] * W + start[0]]; seen[q[0]] = 1;
while (q.length) {
  const u = q.pop();
  const ux = u % W, uy = Math.floor(u / W);
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const nx = ux + dx, ny = uy + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const ni = ny * W + nx;
    if (grid[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni); }
  }
}
console.log('reachable from C106:', seen.reduce((s, v) => s + v, 0));

// ASCII render downsampled 2x (each char = 8x8 svg units), area y 20..320, x 200..720 (C+E buildings)
const POI = { E103: null, E112: null, E105: null, E104: null };
for (const id of Object.keys(POI)) {
  const r = map[f].rooms.find(r => r.id === id);
  POI[id] = nearestWalkable(r.centroid[0], r.centroid[1]);
}
let out = '';
for (let by = 4; by < 40; by++) {       // block rows (y = by*8)
  for (let bx = 25; bx < 90; bx++) {    // block cols (x = bx*8)
    let w = 0, r = 0;
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
      const gx = bx * 2 + cx, gy = by * 2 + cy;
      if (gx < W && gy < H) {
        if (grid[gy * W + gx]) w++;
        if (seen[gy * W + gx]) r++;
      }
    }
    out += r > 0 ? (w === r ? '#' : '+') : (w ? '.' : ' ');
  }
  out += '\n';
}
console.log(out);
console.log('#=reachable walkable, .=walkable unreachable, +=mixed');
console.log('POI anchors:', POI);
