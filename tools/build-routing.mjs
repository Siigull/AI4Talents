#!/usr/bin/env node
// Builds data/routing.json: walkability grids + room anchors + cross-floor links.
//
// Walkable space per floor = union of corridor/stairs/elevator/common polygon cells
//   + full door-line rasterization (doors are the legitimate passage points through walls)
//   + 1-cell dilation of DOOR cells only (bridges cell-centers lying exactly on shared
//     polygon edges — the classic zero-thickness-wall artifact of this SVG).
// Room anchor: walkable cell nearest the room's door midpoint, via BOUNDED BFS.
// Cross-floor links: stairs/elevator rooms matched between adjacent floors by centroid
//   proximity (same stairwell continues vertically at the same x/y).
// Client-side A* (assets/js/routing.js) runs over these grids.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(readFileSync(join(root, 'data', 'map.json'), 'utf8'));

const GRID = 4; // svg units per grid cell (720x1000 -> 180x250 cells)
const W = Math.ceil(720 / GRID), H = Math.ceil(1000 / GRID);
const WALK_TYPES = new Set(['corridor', 'stairs', 'elevator', 'common']);
const FLOORS = ['2', '1', '-1', '-2', '3', '4'];
const FLOOR_ORDER = ['4', '3', '2', '1', '-1', '-2']; // top-down

// ---------- geometry helpers ----------
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
const idx = (gx, gy) => gy * W + gx;
const inB = (gx, gy) => gx >= 0 && gy >= 0 && gx < W && gy < H;

// ---------- build grids ----------
const grids = {}, roomAnchors = {}, stairRooms = {};

for (const f of FLOORS) {
  const grid = new Uint8Array(W * H);
  const polys = [];
  for (const r of map[f].rooms) {
    if (WALK_TYPES.has(r.type)) {
      for (const p of shapeToPolys(r)) polys.push(p);
      if (r.type === 'stairs' || r.type === 'elevator')
        stairRooms[f] = (stairRooms[f] || []).concat([{ id: r.id, c: r.centroid, type: r.type }]);
    }
  }
  for (let gy = 0; gy < H; gy++) {
    const cy = gy * GRID + GRID / 2;
    for (let gx = 0; gx < W; gx++) {
      const cx = gx * GRID + GRID / 2;
      for (const p of polys) if (pointInPoly(cx, cy, p)) { grid[idx(gx, gy)] = 1; break; }
    }
  }
  // rasterize full door lines + dilate door cells by 1 (perpendicular bridge)
  const doorCells = [];
  for (const d of map[f].doors) {
    const len = Math.hypot(d[2] - d[0], d[3] - d[1]);
    const steps = Math.max(1, Math.ceil(len / (GRID / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mx = d[0] + (d[2] - d[0]) * t, my = d[1] + (d[3] - d[1]) * t;
      const gx = Math.floor(mx / GRID), gy = Math.floor(my / GRID);
      if (inB(gx, gy)) doorCells.push([gx, gy]);
    }
  }
  for (const [gx, gy] of doorCells) grid[idx(gx, gy)] = 2; // door cell (mark, then dilate)
  for (const [gx, gy] of doorCells) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (inB(nx, ny) && !grid[idx(nx, ny)]) grid[idx(nx, ny)] = 2;
    }
  }
  grids[f] = grid;

  // room anchors: bounded BFS from the room's entrance door cell
  roomAnchors[f] = {};
  for (const r of map[f].rooms) {
    const target = r.entrance || r.centroid;
    const gx = Math.floor(target[0] / GRID), gy = Math.floor(target[1] / GRID);
    if (inB(gx, gy) && grid[idx(gx, gy)]) { roomAnchors[f][r.id] = [gx, gy]; continue; }
    // ring search outward (bounded, cheap)
    let found = null;
    for (let rad = 1; rad <= 25 && !found; rad++) {
      for (let dy = -rad; dy <= rad && !found; dy++) for (let dx = -rad; dx <= rad && !found; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const nx = gx + dx, ny = gy + dy;
        if (inB(nx, ny) && grid[idx(nx, ny)]) found = [nx, ny];
      }
    }
    if (found) roomAnchors[f][r.id] = found;
  }
}

// ---------- dump grids for fast external debugging ----------
if (process.env.DUMP_GRIDS) {
  const fs = await import('node:fs');
  for (const f of FLOORS) fs.writeFileSync(`/tmp/grid_${f}.bin`, Buffer.from(grids[f]));
  fs.writeFileSync('/tmp/anchors.json', JSON.stringify(roomAnchors));
  console.log('grids dumped');
  process.exit(0);
}

// ---------- connected components diagnostic ----------
const POIS = {
  '1': { C106: 'Registrace', E103: 'Stánky firem', E112: 'Černocký', E105: 'Sekanina', E104: 'Bezpečnost AI', N105: 'Security@FIT' },
  '2': { A218: 'RedHat', C228: 'SolarWinds+SAP', R212: 'Kachna' },
};
function floodComponent(f, start) {
  const g = grids[f];
  const comp = new Uint8Array(W * H);
  const q = [start]; comp[start[1] * W + start[0]] = 1; let head = 0, n = 0;
  while (head < q.length) {
    const [ux, uy] = q[head++]; n++;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nx = ux + dx, ny = uy + dy;
      if (inB(nx, ny) && g[idx(nx, ny)] && !comp[idx(nx, ny)]) { comp[idx(nx, ny)] = 1; q.push([nx, ny]); }
    }
  }
  return { comp, size: n };
}
console.log('--- POI anchors + connectivity (hub C106 floor 1) ---');
const hub = roomAnchors['1']['C106'];
const { comp: hubComp, size: hubSize } = floodComponent('1', hub);
console.log(`C106 component size: ${hubSize}`);
for (const [f, pois] of Object.entries(POIS)) {
  for (const [id, label] of Object.entries(pois)) {
    const a = roomAnchors[f][id];
    if (!a) { console.log(`${id} (${label}): NO ANCHOR`); continue; }
    if (f === '1') {
      console.log(`${id} (${label}): anchor ${a}, inHub=${!!hubComp[idx(a[0], a[1])]}`);
    } else {
      // cross-floor: check if any floor-link endpoint on floor f is reachable, coming from hub
      const { comp: fComp } = floodComponent(f, a);
      console.log(`${id} (${label}): anchor ${a}, floor-${f} component size (from POI): ${fComp.reduce((s, v) => s + v, 0)}`);
    }
  }
}

// ---------- cross-floor links ----------
const floorLinks = [];
for (let i = 0; i < FLOOR_ORDER.length - 1; i++) {
  const fa = FLOOR_ORDER[i], fb = FLOOR_ORDER[i + 1];
  const stairsA = stairRooms[fa] || [], stairsB = stairRooms[fb] || [];
  for (const sa of stairsA) {
    let best = null, bestD = 26 * 26;
    for (const sb of stairsB) {
      const d = (sa.c[0] - sb.c[0]) ** 2 + (sa.c[1] - sb.c[1]) ** 2;
      if (d < bestD) { bestD = d; best = sb; }
    }
    if (best) {
      const ga = roomAnchors[fa][sa.id], gb = roomAnchors[fb][best.id];
      if (ga && gb) floorLinks.push({
        a: { floor: fa, roomId: sa.id, gx: ga[0], gy: ga[1] },
        b: { floor: fb, roomId: best.id, gx: gb[0], gy: gb[1] },
        kind: sa.type === 'elevator' ? 'elevator' : 'stairs',
      });
    }
  }
}

// ---------- island graph + multi-floor routing (final verification) ----------
// islands per floor (connected components) – the client does the same at load time
function islandsOf(f) {
  const g = grids[f];
  const seen = new Uint8Array(W * H);
  const isles = [];
  for (let u = 0; u < W * H; u++) {
    if (!g[u] || seen[u]) continue;
    const q = [u]; seen[u] = 1; const set = new Set([u]);
    while (q.length) {
      const c = q.pop();
      const cx = c % W, cy = (c / W) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!inB(nx, ny)) continue;
        const v = idx(nx, ny);
        if (g[v] && !seen[v]) { seen[v] = 1; q.push(v); set.add(v); }
      }
    }
    isles.push(set);
  }
  return isles;
}
const islesByFloor = {};
for (const f of FLOORS) islesByFloor[f] = islandsOf(f);
const isleOf = (f, cell) => islesByFloor[f].findIndex(s => s.has(cell));

// links keyed by island nodes "floor:isle"
const islandAdj = {}; // node -> [{node, link}]
for (const l of floorLinks) {
  const ia = isleOf(l.a.floor, idx(l.a.gx, l.a.gy));
  const ib = isleOf(l.b.floor, idx(l.b.gx, l.b.gy));
  if (ia < 0 || ib < 0) continue;
  const na = `${l.a.floor}:${ia}`, nb = `${l.b.floor}:${ib}`;
  (islandAdj[na] = islandAdj[na] || []).push({ node: nb, link: l });
  (islandAdj[nb] = islandAdj[nb] || []).push({ node: na, link: l });
}

function astar(f, s, t) {
  const g = grids[f];
  const dist = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const start = idx(s[0], s[1]), target = idx(t[0], t[1]);
  dist[start] = 0;
  const heap = [[0, start]];
  const hpush = (d, i) => { heap.push([d, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const hpop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let l = 2 * c + 1, r = l + 1, m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  let found = false;
  while (heap.length) {
    const [d, u] = hpop();
    if (d > dist[u]) continue;
    if (u === target) { found = true; break; }
    const ux = u % W, uy = (u / W) | 0;
    for (const [dx, dy, w] of [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.4142],[1,-1,1.4142],[-1,1,1.4142],[-1,-1,1.4142]]) {
      const nx = ux + dx, ny = uy + dy;
      if (!inB(nx, ny)) continue;
      const v = idx(nx, ny);
      if (!g[v]) continue;
      if (dx && dy && (!g[idx(ux + dx, uy)] || !g[idx(ux, uy + dy)])) continue;
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; hpush(nd, v); }
    }
  }
  if (!found) return null;
  const path = [];
  let u = target;
  while (u !== -1) { path.push([u % W, (u / W) | 0]); u = prev[u]; }
  return path.reverse();
}

// multi-floor route: BFS over island graph, then A* per floor leg
function routePOI(f1, r1, f2, r2) {
  const a = roomAnchors[f1][r1], b = roomAnchors[f2][r2];
  if (!a || !b) return 'missing anchor';
  const ia = isleOf(f1, idx(a[0], a[1])), ib = isleOf(f2, idx(b[0], b[1]));
  if (f1 === f2 && ia === ib) {
    const p = astar(f1, a, b);
    return p ? `ok direct (${p.length} cells)` : 'FAIL';
  }
  const startNode = `${f1}:${ia}`, endNode = `${f2}:${ib}`;
  // BFS island path
  const prevN = { [startNode]: null };
  const q = [startNode];
  while (q.length && !prevN[endNode]) {
    const u = q.shift();
    for (const { node } of (islandAdj[u] || [])) if (!(node in prevN)) { prevN[node] = u; q.push(node); }
  }
  if (!prevN[endNode]) return 'FAIL: no island path';
  const nodePath = [];
  for (let n = endNode; n; n = prevN[n]) nodePath.push(n);
  nodePath.reverse();
  // walk legs: on each island transition, use the link endpoints, then A* within floors
  let legs = [], total = 0, cur = { floor: f1, cell: a };
  for (let i = 1; i < nodePath.length; i++) {
    const link = islandAdj[nodePath[i - 1]].find(e => e.node === nodePath[i]).link;
    const [fromEnd, toStart] = link.a.floor === cur.floor ? [link.a, link.b] : [link.b, link.a];
    if (fromEnd.floor !== cur.floor) return 'FAIL: leg floor mismatch';
    const p = astar(cur.floor, cur.cell, [fromEnd.gx, fromEnd.gy]);
    if (!p) return `FAIL leg on floor ${cur.floor}`;
    legs.push(`${cur.floor}: ${p.length}c via ${fromEnd.roomId}`);
    total += p.length;
    cur = { floor: toStart.floor, cell: [toStart.gx, toStart.gy] };
  }
  const p = astar(cur.floor, cur.cell, b);
  if (!p) return `FAIL final leg on floor ${cur.floor}`;
  legs.push(`${cur.floor}: ${p.length}c`);
  total += p.length;
  return `ok (${total} cells): ` + legs.join(' | ');
}

console.log('--- route tests from C106 ---');
for (const [f, pois] of Object.entries(POIS)) {
  for (const id of Object.keys(pois)) {
    if (id === 'C106') continue;
    console.log(`C106 → ${id} (f${f}):`, routePOI('1', 'C106', f, id));
  }
}

// ---------- emit ----------
const out = {
  grid: GRID, w: W, h: H,
  floors: FLOORS,
  floorsOrderedTopDown: FLOOR_ORDER,
  grids: Object.fromEntries(FLOORS.map(f => [f, Array.from(grids[f], v => v ? 1 : 0)])),
  anchors: roomAnchors,
  links: floorLinks,
};
writeFileSync(join(root, 'data', 'routing.json'), JSON.stringify(out));
console.log(`routing.json written: grid ${W}x${H}, ${floorLinks.length} floor links`);
