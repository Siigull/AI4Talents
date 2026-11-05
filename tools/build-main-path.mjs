#!/usr/bin/env node
// Builds data/main-path.json — the "hlavní trasa" (main path).
//
// Hand-designed route (user spec), geometry computed with the corridor
// router (hub Dijkstra picks the nearest stairwells):
//   E103 → C107 (registrace, path enters the room's start)
//        → C106 → (C110 stairs) → C228
//        → D106 stairs on floor 2  [SPLIT → D0207, descends the D-wing]
//        → A218 (second story of A)
//        → (bridge) → N-split [SPLIT → N105]
//        → R212 (Kachna)
//
// The stored geometry is static (svg points per floor leg) — the main path
// is a designed artifact, not a runtime route.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

globalThis.window = {};
require('../assets/js/data.js');
require('../assets/js/routing.js');
const RT = window.AI4TRoute;
const D = window.AI4T_DATA;

const legsToGeo = (route, note) => {
  if (!route) throw new Error('route failed: ' + note);
  return route.legs.map((l) => ({
    floor: l.floor,
    stairs: l.stairs ? { roomId: l.stairs.roomId, kind: l.stairs.kind } : null,
    points: l.points.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]),
  }));
};

const D106_F2 = { floor: '2', cell: [158, 93] }; // D-wing stairwell, floor 2

// --- main segments ---------------------------------------------------------
const legs = [];
legs.push(...legsToGeo(RT.corridorPath({ roomId: 'E103' }, { roomId: 'C107' }), 'E103→C107'));
legs.push(...legsToGeo(RT.corridorPath({ roomId: 'C107' }, { roomId: 'C106' }), 'C107→C106'));
legs.push(...legsToGeo(RT.corridorPath({ roomId: 'C106' }, { roomId: 'C228' }), 'C106→C228'));
legs.push(...legsToGeo(RT.corridorPath({ roomId: 'C228' }, D106_F2), 'C228→D106'));
legs.push(...legsToGeo(RT.corridorPath(D106_F2, { roomId: 'A218' }), 'D106→A218'));
const toKachna = RT.corridorPath({ roomId: 'A218' }, { roomId: 'R212' });
legs.push(...legsToGeo(toKachna, 'A218→R212'));

// --- N split: last shared point between A218→R212 and A218→N105 ------------
const bN = RT.corridorPath({ roomId: 'A218' }, { roomId: 'N105' });
const main = toKachna.legs[0].points, branch = bN.legs[0].points;
let splitIdx = 0;
for (let i = 0; i < main.length; i++) {
  for (let j = 0; j < branch.length; j++) {
    if (Math.hypot(main[i][0] - branch[j][0], main[i][1] - branch[j][1]) < 6) { splitIdx = j; break; }
  }
}
// the branch starts walking at the split point; its geometry = shared prefix
// trimmed. The split point itself sits ON the main path (index of the match).
let mainSplitIdx = 0;
for (let i = 0; i < main.length; i++) {
  if (Math.hypot(main[i][0] - branch[splitIdx][0], main[i][1] - branch[splitIdx][1]) < 6) { mainSplitIdx = i; break; }
}

// split stop = the main-path point; branch legs = branch tail + later legs
const splitPt = main[mainSplitIdx];
const branchTail = branch.slice(splitIdx);
const nLegs = [];
if (branchTail.length > 1) {
  nLegs.push({ floor: '2', stairs: bN.legs[0].stairs, points: branchTail.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]) });
}
for (let li = 1; li < bN.legs.length; li++) nLegs.push(...legsToGeo({ legs: [bN.legs[li]] }, 'n' + li));

// --- D split branch ---------------------------------------------------------
const dLegs = legsToGeo(RT.corridorPath(D106_F2, { roomId: 'D0207' }), 'D106→D0207');

// --- stops ------------------------------------------------------------------
const stops = [
  { id: 'e103', room: 'E103', label: 'E103 · stánky, prohlídky', kind: 'start' },
  { id: 'c107', room: 'C107', label: 'C107 · REGISTRACE', kind: 'reg' },
  { id: 'c106', room: 'C106', label: 'C106', kind: 'way' },
  { id: 'c228', room: 'C228', label: 'C228 · workshopy', kind: 'way' },
  { id: 'd106', room: 'D106', label: 'D106 · rozcestí', kind: 'split', split: 'd0207',
    floor: '2', at: [614, 373] }, // pinned: the split is at the F2 stairwell
  { id: 'a218', room: 'A218', label: 'A218 · 2. patro A', kind: 'way' },
  { id: 'nsplit', at: [+splitPt[0].toFixed(1), +splitPt[1].toFixed(1)], floor: '2', label: 'rozcestí · most', kind: 'split', split: 'n105' },
  { id: 'kachna', room: 'R212', label: 'R212 · Kachna', kind: 'end' },
];
// position each room stop at its door anchor (svg coords)
for (const s of stops) {
  if (s.room && !s.at) {
    let floor = null;
    for (const f of Object.keys(D.map)) {
      if (D.map[f].rooms.some((r) => r.id === s.room)) { floor = f; break; }
    }
    const a = RT.anchorOf(s.room, floor);
    const svg = RT.cellToSvg([a.gx, a.gy]);
    s.at = [+svg[0].toFixed(1), +svg[1].toFixed(1)];
    s.floor = floor;
  }
}

const out = {
  id: 'hlavni-trasa',
  title: 'Hlavní trasa',
  note: 'E103 → registrace → C106 → schodiště → C228 → rozcestí D → A218 → most → Kachna. Obousměrná.',
  stops,
  legs,
  splits: {
    d0207: {
      target: 'D0207', floor: '-2',
      label: 'D0207 · workshop RedHat', hint: '-2. podlaží, sjezd schodištěm D',
      at: stops.find((s) => s.id === 'd106').at, legs: dLegs,
    },
    n105: {
      target: 'N105', floor: '1',
      label: 'N105 · workshop Security@FIT', hint: '1. patro, schodiště N',
      at: [+splitPt[0].toFixed(1), +splitPt[1].toFixed(1)], legs: nLegs,
    },
  },
};

writeFileSync(new URL('../data/main-path.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('main-path.json written:',
  stops.length, 'stops,', legs.length, 'main legs,',
  dLegs.length, 'D-split legs,', nLegs.length, 'N-split legs');
console.log('floors on main:', [...new Set(legs.map((l) => l.floor))].join(','));
console.log('N split at:', splitPt.map(Math.round), '→ N105 via', nLegs.map((l) => l.floor + (l.stairs ? '(' + l.stairs.roomId + ')' : '')).join('→'));
