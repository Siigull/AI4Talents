#!/usr/bin/env node
// Extracts clean map data from the scraped FIT floor-plan SVGs (data/source/fit_floor_*.svg)
// into data/map.json used by the site and the print pages.
//
// Output schema per floor:
//   { viewBox: [w,h], buildings: [{id, letter, points|rect, labelPos}], rooms: [...],
//     doors: [[x1,y1,x2,y2], ...] }
// Room: { id, name, type, accessible, shapes: [{kind:'poly', pts:[[x,y]..]} | {kind:'rect', x,y,w,h}],
//         label?: string, labelPos?: [x,y], centroid: [x,y], entrance: [x,y] }
// The "entrance" of a room = midpoint of the door segment closest to its centroid (used for path endpoints).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'data', 'source');
const FLOORS = ['2', '1', '-1', '-2', '3', '4']; // UI order: top floors first

const num = (s) => parseFloat(s);

function parsePoints(str) {
  const flat = str.trim().split(/[\s,]+/).map(Number);
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return pts;
}

function centroidOf(pts) {
  // polygon centroid via shoelace; falls back to vertex average for degenerate shapes
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    return [sx / pts.length, sy / pts.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

function extract(floor) {
  const svg = readFileSync(join(SRC, `fit_floor_${floor}.svg`), 'utf8');
  const out = { viewBox: [720, 1000], buildings: [], rooms: [], doors: [] };

  // --- buildings ---
  const bsec = svg.match(/<g id="buildings"[\s\S]*?(?=<g id="rooms")/);
  if (bsec) {
    for (const m of bsec[0].matchAll(/<polygon class="building" id="building-([a-z]+)" points="([^"]+)"\/?>/g)) {
      out.buildings.push({ id: m[1], kind: 'poly', pts: parsePoints(m[2]) });
    }
    for (const m of bsec[0].matchAll(/<rect class="building" id="building-([a-z]+)" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"\/?>/g)) {
      out.buildings.push({ id: m[1], kind: 'rect', x: num(m[2]), y: num(m[3]), w: num(m[4]), h: num(m[5]) });
    }
    for (const m of bsec[0].matchAll(/<text class="building" x="(-?[\d.]+)" y="(-?[\d.]+)" id="text-([a-z]+)">([A-Z])<\/text>/g)) {
      const b = out.buildings.find((b) => b.id === m[3]);
      if (b) b.letter = m[4];
    }
  }

  // --- doors ---
  const dsec = svg.match(/<g id=['"]doors['"][\s\S]*?<\/g>/);
  if (dsec) {
    for (const m of dsec[0].matchAll(/<line[^>]*x1=['"](-?[\d.]+)['"] y1=['"](-?[\d.]+)['"] x2=['"](-?[\d.]+)['"] y2=['"](-?[\d.]+)['"]/g)) {
      out.doors.push([num(m[1]), num(m[2]), num(m[3]), num(m[4])]);
    }
  }

  // --- rooms ---
  const rsec = svg.match(/<g id="rooms">([\s\S]*?)\n    <g id=['"]doors/);
  if (rsec) {
    for (const g of rsec[1].matchAll(/<g onclick[\s\S]*?<\/g>/g)) {
      const block = g[0];
      const idm = block.match(/<title>([^<]+)<\/title>/);
      if (!idm) continue;
      const title = idm[1].trim();
      const sp = title.indexOf(' ');
      const id = sp > 0 ? title.slice(0, sp) : title;
      const name = sp > 0 ? title.slice(sp + 1) : '';
      const type = (block.match(/class=['"]room [a-z-]+['"]/) || ['', ''])[0]?.replace(/class=['"]room /, '').replace(/['"]/, '') || 'other';
      const accessible = /data-accessible/.test(block);
      const shapes = [];
      let label = null, labelPos = null;
      for (const s of block.matchAll(/<(polygon|rect)([^>]*)\/>/g)) {
        const attrs = s[2];
        const sid = (attrs.match(/id=['"]([^'"]+)['"]/) || [])[1] || '';
        if (!sid.startsWith(id)) continue; // skip e.g. sub-shapes of other ids
        if (s[1] === 'polygon') {
          const pts = parsePoints((attrs.match(/points=['"]([^'"]+)['"]/) || [])[1] || '');
          if (pts.length) shapes.push({ kind: 'poly', pts });
        } else {
          const x = num((attrs.match(/x=['"](-?[\d.]+)['"]/) || [])[1]);
          const y = num((attrs.match(/y=['"](-?[\d.]+)['"]/) || [])[1]);
          const w = num((attrs.match(/width=['"](-?[\d.]+)['"]/) || [])[1]);
          const h = num((attrs.match(/height=['"](-?[\d.]+)['"]/) || [])[1]);
          if (!Number.isNaN(x)) shapes.push({ kind: 'rect', x, y, w, h });
        }
      }
      const lm = block.match(/<text class=['"]room-label['"][^>]*x=['"](-?[\d.]+)['"] y=['"](-?[\d.]+)['"][^>]*>([^<]*)<\/text>/);
      if (lm) { label = lm[3]; labelPos = [num(lm[1]), num(lm[2])]; }
      if (!shapes.length) continue;
      // centroid over all shapes (weighted by vertex count – good enough for routing)
      let ptsAll = [];
      for (const s of shapes) {
        if (s.kind === 'poly') ptsAll = ptsAll.concat(s.pts);
        else ptsAll.push([s.x + s.w / 2, s.y + s.h / 2]);
      }
      const centroid = centroidOf(ptsAll);
      // room entrance: midpoint of nearest door line to centroid
      let best = null, bestD = Infinity;
      for (const d of out.doors) {
        const mx = (d[0] + d[2]) / 2, my = (d[1] + d[3]) / 2;
        const dist = (mx - centroid[0]) ** 2 + (my - centroid[1]) ** 2;
        if (dist < bestD) { bestD = dist; best = [mx, my]; }
      }
      out.rooms.push({
        id, name, type, accessible,
        shapes, label: label || null, labelPos,
        centroid: [Math.round(centroid[0] * 10) / 10, Math.round(centroid[1] * 10) / 10],
        entrance: best,
      });
    }
  }
  return out;
}

mkdirSync(join(root, 'data'), { recursive: true });
const all = {};
for (const f of FLOORS) all[f] = extract(f);
writeFileSync(join(root, 'data', 'map.json'), JSON.stringify(all));
const total = Object.values(all).reduce((s, fl) => s + fl.rooms.length, 0);
console.log(`OK: ${FLOORS.length} floors, ${total} rooms, doors per floor:`, Object.fromEntries(FLOORS.map(f => [f, all[f].doors.length])));
// sanity: key event rooms present?
const need = { '1': ['E112', 'E105', 'E104', 'N105'], '2': ['A218', 'C228', 'R212'], '-2': ['D0207'] };
for (const [f, ids] of Object.entries(need)) {
  for (const id of ids) {
    const r = all[f].rooms.find(r => r.id === id);
    console.log(`floor ${f} ${id}: ${r ? r.name + ' entrance=' + JSON.stringify(r.entrance) : 'MISSING!'}`);
  }
}
