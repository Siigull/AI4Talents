// map.js — v2 decluttered live floor map for AI4Talents@FIT (window.AI4TMap).
//
// Renders AI4T_DATA.map floors as SVG. v2 redesign (spec/APP-V2.md):
//   - floor switcher shows floors 1 + 2 only (setFloor still accepts any
//     floor from the data — print pages use that)
//   - every room: neutral white fill + hairline ink stroke (no type colors)
//   - event rooms tinted by LIVE state: upcoming #dbe7fa / now #1761cc /
//     past #ececec, with bold mono room-code labels — the only labels on
//     the map; no sector letters, no pins, no dots, no routes, no legend
//   - pan (drag) + pinch + wheel + double-tap zoom; long-press (350 ms)
//     sets the "I am here" position (blue dot + toast, kept from v1)
//   - default view fits the bbox of the event rooms on the floor (+15 %
//     margin), so the map opens much closer than the whole building
//   - room detail card (code + name + events + optional room photo) opens
//     on room tap and via selectRoom() (the timetable ai4t:open-room flow)
//   - live states refresh on 'ai4t:tick' (emitted by timetable.js) and on
//     view show (ai4t:map-show / onShow())
//
// Depends on data.js only. routing.js is OPTIONAL here — it is used just
// for grid snapping of the long-press position; without it the map still
// works (the position marker falls back to raw svg coordinates).
//
// Print pages set window.AI4T_PRINT_MODE = true BEFORE this script loads
// to get a frozen, chrome-less static render. The empty .route-layer and
// .pos-layer groups (plus their CSS) are kept so print/stand.html can draw
// its own static routes and position marker until the wave-2 print pass.
//
// Public API (kept stable for app.js / position.js / print pages):
//   init(selectorOrElement, opts?)   build the map (idempotent; opts.floor)
//   getFloor() / setFloor(f)         floor switch (emits ai4t:floor-changed)
//   selectRoom(id, opts?)            select + detail card (ai4t:room-selected)
//   clearSelection() / onShow()      deselect / refresh live UI + label sizes
//   setPosition({floor, cell})       blue "I am here" dot (cell needs routing.js)
//   getPosition() / clearPosition()
//   showRoute / clearRoute / zoomToRoom — v1 API kept as no-op stubs so old
//   callers (print pages) do not break before the wave-2 print redesign
//
// Events emitted on document:
//   ai4t:floor-changed {floor}   ai4t:room-selected {roomId, floor}
//   ai4t:position-set {floor, cell, source}  (only for internal sets)

(function () {
  'use strict';

  const DATA = window.AI4T_DATA;
  if (!DATA || !DATA.map) {
    console.error('AI4TMap: window.AI4T_DATA missing — load data.js first');
    window.AI4TMap = null;
    return;
  }
  const RT = window.AI4TRoute || null; // optional — grid snapping only

  // ------------------------------------------------------------- constants --

  const VB_W = 720, VB_H = 1000;
  const UI_FLOORS = ['1', '2']; // switcher shows these two only
  const FLOOR_CAPTION = {
    '1': '1. patro', '2': '2. patro', '3': '3. patro', '4': '4. patro',
    '-1': '-1. podlaží', '-2': '-2. podlaží',
  };
  const FIT_MARGIN = 0.15; // default view: event-room bbox + 15 % margin
  const CLUSTER_D = 300;   // event rooms within this distance form the default-view cluster
  const EVENT_DATE =
    (DATA.events && DATA.events.meta && DATA.events.meta.date) || '2026-11-06';
  const LABEL_PX = 13;     // event room-code label size in on-screen pixels
  // manual label nudges where room centroids are too close (E-wing cluster)
  const LABEL_POS = {
    E103: [458, 130], E112: [531, 105], E105: [452, 68], E104: [452, 192],
  };
  const PRINT = window.AI4T_PRINT_MODE === true;

  // ----------------------------------------------------------------- state --

  const S = {
    root: null, viewport: null, svg: null, world: null,
    floor: '1',
    transform: { k: 1, tx: 0, ty: 0 }, // pan/zoom, reset to the floor fit
    position: null,            // {floor, cell:[gx,gy]|null, x, y}
    selected: null,            // roomId (thicker ink outline)
    cardRoom: null,            // roomId shown in the detail card
    roomIndex: {},             // roomId -> {floor, room}
    eventsByRoom: new Map(),   // roomId -> [event, ...]
    eventRoomsByFloor: {},     // floor -> [roomId, ...] (first-seen order)
    floorEls: null,            // roomId -> {g, label} on the rendered floor
    picks: new Set(),          // event ids picked in "Můj program"
    live: { now: null, isEventDay: null }, // last ai4t:tick (null = unknown)
    pointers: new Map(),       // pointerId -> {x, y}
    drag: null, pinch: null,
    lastTap: { t: 0, x: 0, y: 0 },
    suppressClick: false,
    raf: null, toastTimer: null,
    labelK: null,              // last on-screen scale the labels were sized for
    initialized: false,
  };

  // -------------------------------------------------------------- helpers ---

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  function parseMinutes(hm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
  }

  // Fallback "now" for the first render (before any ai4t:tick arrives) and
  // for print pages that never emit ticks.
  function localDayState() {
    const d = new Date();
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    const isEventDay = iso === EVENT_DATE;
    return { now: isEventDay ? d.getHours() * 60 + d.getMinutes() : null, isEventDay: isEventDay };
  }

  function currentLive() {
    if (typeof S.live.now === 'number' || S.live.isEventDay != null) return S.live;
    return localDayState();
  }

  // -------------------------------------------------------------- geometry --

  function polyD(pts) {
    let d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (let i = 1; i < pts.length; i++) d += 'L' + pts[i][0] + ' ' + pts[i][1];
    return d + 'Z';
  }

  function roomBBox(room) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of room.s) {
      if (s.p) {
        for (const p of s.p) {
          x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
        }
      } else {
        x0 = Math.min(x0, s.r[0]); y0 = Math.min(y0, s.r[1]);
        x1 = Math.max(x1, s.r[0] + s.r[2]); y1 = Math.max(y1, s.r[1] + s.r[3]);
      }
    }
    return [x0, y0, x1, y1];
  }

  function shapeSvg(s, cls) {
    return s.p
      ? `<path class="${cls}" d="${polyD(s.p)}" vector-effect="non-scaling-stroke"/>`
      : `<rect class="${cls}" x="${s.r[0]}" y="${s.r[1]}" width="${s.r[2]}" height="${s.r[3]}" vector-effect="non-scaling-stroke"/>`;
  }

  // ----------------------------------------------------------------- index --

  function buildIndexes() {
    S.roomIndex = {};
    S.eventsByRoom = new Map();
    S.eventRoomsByFloor = {};
    for (const f of Object.keys(DATA.map)) {
      for (const room of DATA.map[f].rooms) {
        if (!S.roomIndex[room.id]) S.roomIndex[room.id] = { floor: f, room: room };
      }
    }
    for (const ev of (DATA.events && DATA.events.events) || []) {
      if (!ev || !ev.room) continue;
      if (!S.eventsByRoom.has(ev.room)) S.eventsByRoom.set(ev.room, []);
      S.eventsByRoom.get(ev.room).push(ev);
      const idx = S.roomIndex[ev.room];
      if (idx) {
        if (!S.eventRoomsByFloor[idx.floor]) S.eventRoomsByFloor[idx.floor] = [];
        if (S.eventRoomsByFloor[idx.floor].indexOf(ev.room) < 0) {
          S.eventRoomsByFloor[idx.floor].push(ev.room);
        }
      }
    }
  }

  function isEventRoom(roomId) { return S.eventsByRoom.has(roomId); }

  // ----------------------------------------------------------- live states --

  // Room state: 'now' | 'up' | 'past' — null for non-event rooms.
  // Priority: any running event wins, then any upcoming one.
  function roomLiveState(roomId) {
    const evs = S.eventsByRoom.get(roomId);
    if (!evs || !evs.length) return null;
    const l = currentLive();
    if (!l.isEventDay || typeof l.now !== 'number') return 'up'; // pre-event: venues only
    let up = false;
    for (const ev of evs) {
      const s = parseMinutes(ev.start), t = parseMinutes(ev.end);
      if (!Number.isFinite(s) || !Number.isFinite(t)) continue;
      if (l.now >= s && l.now < t) return 'now';
      if (l.now < s) up = true;
    }
    return up ? 'up' : 'past';
  }

  function eventState(ev, live) {
    const s = parseMinutes(ev.start), t = parseMinutes(ev.end);
    if (!live.isEventDay || typeof live.now !== 'number' ||
        !Number.isFinite(s) || !Number.isFinite(t)) return 'up';
    if (live.now >= s && live.now < t) return 'now';
    return live.now < s ? 'up' : 'past';
  }

  // ------------------------------------------------------------------- CSS --

  function cssText() {
    return `
#map-root{position:relative;background:#fff;border:1px solid #14120f;border-radius:5px;overflow:hidden;font-family:Inter,system-ui,sans-serif;color:#14120f;}
#map-root *{box-sizing:border-box;}
#map-root .map-floorbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;background:#f6f5f1;border-bottom:2px solid #14120f;}
#map-root .map-floor-caption{font-family:'IBM Plex Mono',monospace;font-size:13px;white-space:nowrap;}
#map-root .map-floorbtns{display:flex;margin-left:auto;border:1px solid #14120f;border-radius:5px;overflow:hidden;}
#map-root .map-floorbtn{font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1;min-height:40px;padding:11px 14px;background:#fff;color:#14120f;border:0;border-right:1px solid #14120f;cursor:pointer;}
#map-root .map-floorbtn:last-child{border-right:0;}
#map-root .map-floorbtn:hover{background:#e8eaea;}
#map-root .map-floorbtn[aria-pressed="true"]{background:#1761cc;color:#fff;}
@media (max-width: 520px) {
  #map-root .map-floorbtn { min-height: 34px; padding: 8px 10px; font-size: 12px; }
  #map-root .map-floor-caption { display: none; }
  #map-root .map-floorbar { gap: 6px; padding: 6px 8px; }
  #map-root .map-outlier-chip { font-size: 11px; padding: 6px 8px; }
}
#map-root .map-viewport{position:relative;width:100%;aspect-ratio:720/1000;max-height:78vh;overflow:hidden;background:#fff;touch-action:none;cursor:grab;outline:none;user-select:none;-webkit-user-select:none;}
#map-root .map-viewport:active{cursor:grabbing;}
#map-root svg{width:100%;height:100%;display:block;}
#map-root .building{fill:#e8eaea;stroke:#14120f;stroke-width:1.5px;}
#map-root .room{fill:#ffffff;stroke:#14120f;stroke-width:1px;}
#map-root .room-g{cursor:pointer;}
#map-root .room-g:hover .room{stroke-width:2px;}
#map-root .room-g.is-selected .room{stroke-width:3.5px;}
#map-root .room-g.st-up .room{fill:#dbe7fa;}
#map-root .room-g.st-now .room{fill:#1761cc;}
#map-root .room-g.st-past .room{fill:#ececec;}
#map-root .ev-label{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:13px;fill:#14120f;stroke:#fff;stroke-width:2.5px;paint-order:stroke;pointer-events:none;text-anchor:middle;dominant-baseline:central;}
#map-root .ev-label.st-now{fill:#fff;}
#map-root .ev-label.st-past{fill:#6f6b64;}
#map-root .pos-core{fill:#1761cc;stroke:#fff;stroke-width:3px;pointer-events:none;}
#map-root .pos-pulse{fill:none;stroke:#1761cc;stroke-width:2px;transform-box:fill-box;transform-origin:center;animation:ai4tPosPulse 2s ease-out infinite;pointer-events:none;}
/* Route + jump styles are kept for print/stand.html, which draws its own
   static routes into the (always empty in the app) .route-layer group. */
#map-root .route-layer{pointer-events:none;}
/* hlavní trasa — the designed main path with numbered stops */
#map-root .mp-line{fill:none;stroke:var(--blue);stroke-width:3.5px;opacity:.85;
  stroke-linecap:round;stroke-linejoin:round;pointer-events:none;}
#map-root .mp-chev{fill:var(--blue);pointer-events:none;}
#map-root .mp-stop{fill:#fff;stroke:var(--blue);stroke-width:2.5px;pointer-events:none;}
#map-root .mp-stop.mp-stop--split{stroke:var(--magenta-deep);}
#map-root .mp-num{font:700 13px 'IBM Plex Mono',monospace;fill:var(--blue);
  stroke:#fff;stroke-width:3px;paint-order:stroke;pointer-events:none;text-anchor:middle;dominant-baseline:central;}
#map-root .mp-stop.mp-stop--split .mp-num{fill:var(--magenta-deep);}
#map-root .mp-split{fill:none;stroke:var(--magenta-deep);stroke-width:2.5px;
  stroke-dasharray:6 5;pointer-events:none;}
#map-root .mp-splabel{font:500 12px 'IBM Plex Mono',monospace;fill:var(--magenta-deep);
  stroke:#fff;stroke-width:3px;paint-order:stroke;pointer-events:none;}
#map-root .route-halo{fill:none;stroke:#ff2fd6;stroke-width:6px;opacity:.4;stroke-linecap:round;stroke-linejoin:round;filter:url(#ai4t-blur);}
#map-root .route-line{fill:none;stroke:#ff2fd6;stroke-width:2px;stroke-linecap:round;stroke-linejoin:round;}
#map-root .route-dot{fill:#ff2fd6;pointer-events:none;}
#map-root .rj-sq{fill:#1761cc;stroke:#fff;stroke-width:1px;}
#map-root .rj-glyph{font-family:'IBM Plex Mono',monospace;font-size:10px;fill:#fff;}
#map-root .rj-label{font-family:'IBM Plex Mono',monospace;font-size:11px;fill:#14120f;stroke:#fff;stroke-width:2px;paint-order:stroke;}
#map-root .map-info-card{position:absolute;left:10px;right:10px;bottom:10px;max-width:420px;margin:0 auto;background:#f6f5f1;color:#14120f;border:2px solid #14120f;border-radius:5px;padding:12px 40px 12px 14px;max-height:60%;overflow-y:auto;z-index:5;}
#map-root .mic-close{position:absolute;top:8px;right:8px;width:32px;height:32px;padding:0;background:#fff;color:#14120f;font-size:18px;line-height:1;border:1px solid #14120f;border-radius:5px;cursor:pointer;}
#map-root .mic-close:hover{background:#e8eaea;}
#map-root .mic-code{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:18px;line-height:1.1;}
#map-root .mic-name{display:block;font-size:13px;color:#6f6b64;margin-top:2px;}
#map-root .mic-photo{display:block;width:100%;max-height:96px;object-fit:cover;border-radius:4px;border:1px solid #14120f;margin-top:10px;}
#map-root .mic-acc{margin-top:6px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:#6f6b64;}
#map-root .mic-events{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}
#map-root .mic-events li{display:flex;gap:10px;align-items:baseline;padding-left:8px;border-left:3px solid transparent;}
#map-root .mic-events li.is-picked{border-left-color:#1761cc;}
#map-root .mic-events li.is-past{opacity:.55;}
#map-root .mic-time{font-family:'IBM Plex Mono',monospace;font-size:13px;white-space:nowrap;}
#map-root .mic-events li.is-now .mic-time{color:#1761cc;font-weight:700;}
#map-root .mic-title{font-size:14px;line-height:1.4;}
#map-root .mic-live{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.4;background:#1761cc;color:#fff;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:1px;}
#map-root .mic-pick{color:#1761cc;font-family:'IBM Plex Mono',monospace;font-weight:700;margin-right:4px;}
#map-root .mic-empty{margin-top:8px;font-size:13px;color:#6f6b64;}
#map-root .map-toast{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:#17161a;color:#f4f2ec;font-family:'IBM Plex Mono',monospace;font-size:13px;padding:8px 14px;border-radius:5px;z-index:7;transition:opacity .2s;opacity:0;}
#map-root .map-toast.is-visible{opacity:1;}
#map-root :focus-visible{outline:3px solid #1761cc;outline-offset:2px;}
@keyframes ai4tPosPulse{0%{transform:scale(1);opacity:.5;}100%{transform:scale(2.2);opacity:0;}}
@media (prefers-reduced-motion:reduce){
  #map-root .pos-pulse{animation:none;opacity:.35;}
}${PRINT ? `
/* print/static mode overrides (AI4T_PRINT_MODE): frozen, chrome-less map */
#map-root .map-viewport{cursor:default;touch-action:auto;max-height:none;}
#map-root .pos-pulse{display:none;}
` : ''}`;
  }

  function injectStyles() {
    if (document.getElementById('ai4t-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai4t-map-styles';
    style.textContent = cssText();
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------ DOM ---

  function buildDOM() {
    // base 1+2; floors hosting events (e.g. a basement room) join the bar
    const extra = Object.keys(S.eventRoomsByFloor)
      .filter((f) => UI_FLOORS.indexOf(f) < 0)
      .sort((a, b) => (Number(a) < Number(b) ? -1 : 1));
    const floors = UI_FLOORS.slice().concat(extra);
    const floorBtns = floors.map((f) =>
      `<button type="button" class="map-floorbtn" data-floor="${f}" aria-pressed="${f === S.floor}">${esc(FLOOR_CAPTION[f] || f)}</button>`).join('');
    S.root.innerHTML = `
      <div class="map-floorbar">
        <div class="map-floorbtns map-ui" role="group" aria-label="Výběr patra">${floorBtns}</div>
      </div>
      <div class="map-viewport" tabindex="0" role="application" aria-label="Mapa fakulty — posun tahem, přiblížení dvěma prsty nebo kolečkem">
        <svg id="map-svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mapa fakulty">
          <defs>
            <filter id="ai4t-blur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.5"/>
            </filter>
          </defs>
          <g id="map-world"></g>
        </svg>
        <div class="map-info-card map-ui" role="group" aria-label="Detail místnosti" hidden></div>
        <div class="map-toast map-ui" role="status" hidden>Poloha nastavena</div>
      </div>`;
    S.viewport = S.root.querySelector('.map-viewport');
    S.svg = S.root.querySelector('#map-svg');
    S.world = S.root.querySelector('#map-world');
    if (PRINT) {
      // Static print render: drop interactive controls (floor buttons, info
      // card, toast). Lookups of these are null-safe elsewhere in map.js.
      S.root.querySelectorAll('.map-floorbtns, .map-info-card, .map-toast')
        .forEach((el) => el.remove());
    } else {
      attachEvents();
    }
  }

  // ---------------------------------------------------------------- render --

  // Rebuild the current floor into #map-world (the svg element is reused;
  // the transform is applied right after).
  function renderFloor() {
    const fl = DATA.map[S.floor];
    if (!fl) return;
    S.floorEls = {};
    const parts = [];
    for (const b of fl.buildings) {
      parts.push(b.pts
        ? `<path class="building" d="${polyD(b.pts)}" vector-effect="non-scaling-stroke"/>`
        : `<rect class="building" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" vector-effect="non-scaling-stroke"/>`);
    }
    for (const r of fl.rooms) {
      const shapes = r.s.map((s) => shapeSvg(s, 'room')).join('');
      parts.push(`<g class="room-g" data-id="${esc(r.id)}"><title>${esc(r.id)} · ${esc(r.name || '')}</title>${shapes}</g>`);
    }
    // Route/position layers stay empty in the app — kept for print pages.
    parts.push('<g class="route-layer"></g>');
    parts.push('<g class="pos-layer"></g>');
    // Bold mono labels for event rooms only.
    for (const id of S.eventRoomsByFloor[S.floor] || []) {
      const idx = S.roomIndex[id];
      if (!idx || !idx.room.c) continue;
      const lp = LABEL_POS[id] || idx.room.c;
      parts.push(`<text class="ev-label" data-room="${esc(id)}" x="${lp[0]}" y="${lp[1]}">${esc(id)}</text>`);
    }
    S.world.innerHTML = parts.join('');
    // Cache room groups/labels of this floor for fast class updates.
    for (const g of S.world.querySelectorAll('.room-g')) {
      const id = g.getAttribute('data-id');
      S.floorEls[id] = { g: g, label: null };
    }
    for (const t of S.world.querySelectorAll('.ev-label')) {
      const id = t.getAttribute('data-room');
      if (S.floorEls[id]) S.floorEls[id].label = t;
    }
    S.svg.setAttribute('aria-label', 'Mapa fakulty — ' + (FLOOR_CAPTION[S.floor] || S.floor));
    applyViewBox();
    applyTransform();
    paintEventRooms();
    paintMainPath();
    drawPosition();
    updateFloorbar();
  }

  function updateFloorbar() {
    S.root.querySelectorAll('.map-floorbtn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-floor') === S.floor));
    });
  }

  // Compose the full class of an event room group + label from live state
  // and selection. Cheap (a handful of rooms per floor).
  // hlavní trasa: draw the designed main path + stops + split stubs on the
  // current floor. Static geometry from AI4T_DATA.mainPath (build tool).
  function paintMainPath() {
    const layer = S.root && S.root.querySelector('.route-layer');
    if (!layer) return;
    layer.querySelectorAll('.mp-line,.mp-chev,.mp-stop,.mp-num,.mp-split,.mp-splabel')
      .forEach((el) => el.remove());
    const MP = window.AI4T_DATA && window.AI4T_DATA.mainPath;
    if (!MP || !MP.legs) return;
    const f = String(S.floor);
    const geo = [];
    const onFloor = (legs, filter) => legs.filter(filter).forEach((l) => geo.push(l));

    const poly = (pts, cls) => {
      if (pts.length < 2) return;
      const d = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      layer.insertAdjacentHTML('beforeend',
        '<polyline class="' + cls + '" points="' + d + '" vector-effect="non-scaling-stroke"/>');
    };
    const chevrons = (pts) => {
      // direction chevrons every ~170 svg units along the path
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]);
        acc += d;
        if (acc >= 170) {
          acc = 0;
          const a = pts[i - 1], b = pts[i];
          const ux = (b[0] - a[0]) / (d || 1), uy = (b[1] - a[1]) / (d || 1);
          const vx = -uy, vy = ux, W = 9, Hw = 4.5;
          const tip = b, L = [b[0] - ux * W + vx * Hw, b[1] - uy * W + vy * Hw],
                R = [b[0] - ux * W - vx * Hw, b[1] - uy * W - vy * Hw];
          layer.insertAdjacentHTML('beforeend', '<polygon class="mp-chev" points="' +
            tip[0].toFixed(1) + ',' + tip[1].toFixed(1) + ' ' +
            L[0].toFixed(1) + ',' + L[1].toFixed(1) + ' ' +
            R[0].toFixed(1) + ',' + R[1].toFixed(1) + '"/>');
        }
      }
    };

    for (const l of MP.legs) {
      if (String(l.floor) !== f) continue;
      poly(l.points, 'mp-line');
      chevrons(l.points);
    }
    // split stubs (from the split point along the branch, first ~140 units)
    for (const key of Object.keys(MP.splits || {})) {
      const sp = MP.splits[key];
      const first = (sp.legs || []).find((l) => String(l.floor) === f);
      if (!first) continue;
      let acc = 0, pts = [first.points[0]];
      for (let i = 1; i < first.points.length && acc < 140; i++) {
        acc += Math.hypot(first.points[i][0] - first.points[i-1][0], first.points[i][1] - first.points[i-1][1]);
        pts.push(first.points[i]);
      }
      poly(pts, 'mp-split');
      const end = pts[pts.length - 1];
      const lx = Math.min(end[0] + 16, VB_W - 40), ly = Math.max(end[1] - 14, 14);
      layer.insertAdjacentHTML('beforeend', '<text class="mp-splabel" x="' +
        lx.toFixed(1) + '" y="' + ly.toFixed(1) + '">' + key.toUpperCase() + '</text>');
    }
    // numbered stops on this floor
    let n = 0;
    for (const s of MP.stops || []) {
      n++;
      if (String(s.floor) !== f) continue;
      const split = s.kind === 'split';
      const evRoom = (S.eventRoomsByFloor[f] || []).indexOf(s.room) >= 0;
      layer.insertAdjacentHTML('beforeend',
        '<g class="mp-stop' + (split ? ' mp-stop--split' : '') + '">' +
        '<circle cx="' + s.at[0] + '" cy="' + s.at[1] + '" r="' + (split ? 10 : 8) + '"/>' +
        '<text class="mp-num" x="' + s.at[0] + '" y="' + s.at[1] + '">' + n + '</text></g>' +
        (s.room && !evRoom
          ? '<text class="mp-splabel" style="fill:var(--blue)" x="' + (s.at[0] + 13) + '" y="' + (s.at[1] + 4) + '">' + s.room + '</text>'
          : ''));
    }
  }

  function paintEventRooms() {
    for (const id of S.eventRoomsByFloor[S.floor] || []) {
      const els = S.floorEls && S.floorEls[id];
      if (!els) continue;
      const st = roomLiveState(id);
      let cls = 'room-g st-' + st;
      if (S.selected === id) cls += ' is-selected';
      els.g.setAttribute('class', cls);
      if (els.label) els.label.setAttribute('class', 'ev-label st-' + st);
    }
    if (S.selected && !isEventRoom(S.selected)) {
      const els = S.floorEls && S.floorEls[S.selected];
      if (els) els.g.setAttribute('class', 'room-g is-selected');
    }
  }

  // Refresh live tints (called on ai4t:tick and on view show) + open card.
  function updateLiveStates() {
    paintEventRooms();
    paintMainPath();
    if (S.cardRoom) {
      const card = S.root.querySelector('.map-info-card');
      if (card && !card.hidden) showInfoCard(S.cardRoom);
    }
  }

  // ----------------------------------------------------- pan / zoom engine --

  function applyTransform() {
    const t = S.transform;
    S.world.setAttribute('transform', `translate(${t.tx} ${t.ty}) scale(${t.k})`);
    // Keep labels at a constant on-screen size: font-size scales inversely
    // to the total on-screen scale (skipped while the map is hidden — the
    // rect is 0 then; onShow() re-applies after the map becomes visible).
    const rect = S.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const vb = S.vb || { w: VB_W, h: VB_H };
    const svgScale = rect.width / vb.w;
    const eff = svgScale * t.k;
    if (!eff || (S.labelK != null && Math.abs(eff - S.labelK) / (S.labelK || 1) <= 0.08)) return;
    S.labelK = eff;
    const px = Math.max(2, LABEL_PX / eff);
    S.world.querySelectorAll('.ev-label').forEach((el) => { el.style.fontSize = px + 'px'; });
    S.world.querySelectorAll('.mp-num').forEach((el) => { el.style.fontSize = Math.max(2, px * 0.85) + 'px'; });
  }

  // Client (page) coords -> viewBox coords, honouring preserveAspectRatio meet.
  function clientToView(cx, cy) {
    const rect = S.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return [0, 0];
    const vb = S.vb || { x: 0, y: 0, w: VB_W, h: VB_H };
    const s = Math.min(rect.width / vb.w, rect.height / vb.h);
    const ox = (rect.width - vb.w * s) / 2;
    const oy = (rect.height - vb.h * s) / 2;
    return [vb.x + (cx - rect.left - ox) / s, vb.y + (cy - rect.top - oy) / s];
  }

  function viewToWorld(v) {
    const t = S.transform;
    return [(v[0] - t.tx) / t.k, (v[1] - t.ty) / t.k];
  }

  // minimum zoom = the whole floor always fits (k=1 is the cropped fit,
  // so the floor needs less than that — depends on how tight the crop is)
  function kMin() {
    const vb = S.vb || { w: VB_W, h: VB_H };
    return Math.min(vb.w / VB_W, vb.h / VB_H) * 0.96;
  }

  function zoomAt(viewPt, factor) {
    const t = S.transform;
    const k2 = clamp(t.k * factor, kMin(), 6);
    const f = k2 / t.k;
    t.tx = viewPt[0] - (viewPt[0] - t.tx) * f;
    t.ty = viewPt[1] - (viewPt[1] - t.ty) * f;
    t.k = k2;
    applyTransform();
  }

  function animateTransform(target, ms) {
    if (reduceMotion() || !ms) {
      S.transform = { k: target.k, tx: target.tx, ty: target.ty };
      applyTransform();
      return;
    }
    if (S.raf) cancelAnimationFrame(S.raf);
    const from = { k: S.transform.k, tx: S.transform.tx, ty: S.transform.ty };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      S.transform.k = from.k + (target.k - from.k) * e;
      S.transform.tx = from.tx + (target.tx - from.tx) * e;
      S.transform.ty = from.ty + (target.ty - from.ty) * e;
      applyTransform();
      if (p < 1) S.raf = requestAnimationFrame(step);
      else S.raf = null;
    };
    S.raf = requestAnimationFrame(step);
  }

  // Default view: crop the viewBox to the LARGEST CLUSTER of event rooms
  // (+ margin) so the map opens close-up with no letterbox dead space.
  // Far-away event rooms (e.g. N105 on floor 1, Kachna on floor 2) become
  // outlier hint chips. Non-event floors (print pages) fall back to the
  // plain 1:1 building view.
  function clusterBBoxFor(floor) {
    const ids = S.eventRoomsByFloor[floor] || [];
    if (!ids.length) return null;
    const centers = ids.map((id) => {
      const idx = S.roomIndex[id];
      return idx ? { id: id, c: idx.room.c } : null;
    }).filter(Boolean);
    // greedy clustering: center distance <= CLUSTER_D joins the biggest seed
    const clusters = [];
    for (const a of centers) {
      let best = null;
      for (const cl of clusters) {
        const d = Math.hypot(a.c[0] - cl.cx, a.c[1] - cl.cy);
        if (d <= CLUSTER_D) { if (!best || cl.ids.length > best.ids.length) best = cl; }
      }
      if (best) {
        best.ids.push(a.id);
        best.cx = (best.cx * (best.ids.length - 1) + a.c[0]) / best.ids.length;
        best.cy = (best.cy * (best.ids.length - 1) + a.c[1]) / best.ids.length;
      } else {
        clusters.push({ ids: [a.id], cx: a.c[0], cy: a.c[1] });
      }
    }
    if (!clusters.length) return null;
    clusters.sort((a, b) => b.ids.length - a.ids.length);
    const main = clusters[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of main.ids) {
      const b = roomBBox(S.roomIndex[id].room);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    // at least 14 svg units of margin — buildings cut by the crop edge
    // read as rendering artifacts
    const mw = Math.max((x1 - x0) * FIT_MARGIN, 14), mh = Math.max((y1 - y0) * FIT_MARGIN, 14);
    x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh);
    x1 = Math.min(VB_W, x1 + mw); y1 = Math.min(VB_H, y1 + mh);
    return {
      vb: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
      outlierIds: clusters.slice(1).flatMap((cl) => cl.ids),
    };
  }

  function applyViewBox() {
    // print pages (AI4T_PRINT_MODE) always show the full floor plan
    if (PRINT) { S.vb = { x: 0, y: 0, w: VB_W, h: VB_H }; S.outliers = []; return; }
    const fit = clusterBBoxFor(S.floor);
    S.vb = fit ? fit.vb : { x: 0, y: 0, w: VB_W, h: VB_H };
    S.outliers = fit ? fit.outlierIds : [];
    // the hlavní trasa is the map's spine — the crop must contain it whole
    const MP = window.AI4T_DATA && window.AI4T_DATA.mainPath;
    if (MP) {
      const f = String(S.floor);
      let x0 = S.vb.x, y0 = S.vb.y, x1 = S.vb.x + S.vb.w, y1 = S.vb.y + S.vb.h;
      const grow = (px, py) => { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); };
      (MP.legs || []).forEach((l) => {
        if (String(l.floor) !== f) return;
        l.points.forEach((p) => grow(p[0], p[1]));
      });
      (MP.stops || []).forEach((s) => { if (String(s.floor) === f) grow(s.at[0], s.at[1]); });
      Object.keys(MP.splits || {}).forEach((k) => {
        const sp = MP.splits[k];
        (sp.legs || []).forEach((l) => {
          if (String(l.floor) !== f) return;
          l.points.slice(0, 8).forEach((p) => grow(p[0], p[1]));
        });
      });
      const mw = (x1 - x0) * 0.06, mh = (y1 - y0) * 0.06;
      S.vb = {
        x: Math.max(0, x0 - mw), y: Math.max(0, y0 - mh),
        w: Math.min(VB_W, x1 + mw) - Math.max(0, x0 - mw),
        h: Math.min(VB_H, y1 + mh) - Math.max(0, y0 - mh),
      };
    }
    S.svg.setAttribute('viewBox', `${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}`);
    const vp = S.root.querySelector('.map-viewport');
    if (vp) vp.style.aspectRatio = String(Math.round(S.vb.w) + ' / ' + Math.round(S.vb.h));
    renderOutlierHints();
  }

  // fitTransformFor stays identity-based: with a cropped viewBox the default
  // transform is plain 1:1 (the crop already frames the cluster).
  function fitTransformFor(floor) {
    return { k: 1, tx: 0, ty: 0 };
  }

  function renderOutlierHints() {
    let chipRow = S.root.querySelector('.map-outliers');
    if (chipRow) chipRow.remove();
    if (!S.outliers || !S.outliers.length) return;
    chipRow = document.createElement('div');
    chipRow.className = 'map-outliers';
    for (const id of S.outliers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-outlier-chip';
      const room = S.roomIndex[id] ? S.roomIndex[id].room : null;
      btn.textContent = (room ? room.name.split(' ')[0] + ' ' + id : id) + ' ↘';
      btn.setAttribute('aria-label', 'Zobrazit ' + id);
      btn.addEventListener('click', () => selectRoom(id, { flash: true }));
      chipRow.appendChild(btn);
    }
    const bar = S.root.querySelector('.map-floorbar');
    (bar ? bar : S.root).appendChild(chipRow);
  }

  // Is the room's bbox fully inside the currently visible world rect?
  function roomVisible(info) {
    const t = S.transform;
    const [x0, y0, x1, y1] = roomBBox(info.room);
    const vx0 = -t.tx / t.k, vy0 = -t.ty / t.k;
    const vx1 = (VB_W - t.tx) / t.k, vy1 = (VB_H - t.ty) / t.k;
    return x0 >= vx0 && y0 >= vy0 && x1 <= vx1 && y1 <= vy1;
  }

  // -------------------------------------------------------------- selection --

  function selectRoom(roomId, opts) {
    opts = opts || {};
    if (!roomId || !/^[A-Za-z0-9.\-]+$/.test(roomId)) return false;
    const info = S.roomIndex[roomId];
    if (!info) { console.warn('AI4TMap.selectRoom: unknown room', roomId); return false; }
    S.selected = roomId;
    if (info.floor !== S.floor) setFloor(info.floor); // also repaints + refits
    else paintEventRooms();
    if (opts.card !== false) showInfoCard(roomId);
    // If the user panned/zoomed the room out of view, ease back to the
    // floor's default fit (which always contains every event room).
    if (opts.zoom !== false && !roomVisible(info)) {
      animateTransform(fitTransformFor(S.floor), 260);
    }
    emit('ai4t:room-selected', { roomId: roomId, floor: info.floor });
    return true;
  }

  function clearSelection() {
    S.selected = null;
    paintEventRooms();
    paintMainPath();
  }

  // ------------------------------------------------------- room detail card --

  function pickedIds() {
    // "Můj program" picks — read directly from the shared localStorage store
    // (timetable.js owns the writing; ai4t:pick-changed triggers a re-read).
    try {
      const raw = JSON.parse(window.localStorage.getItem('ai4t-my') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (err) { return []; }
  }

  function showInfoCard(roomId) {
    const card = S.root.querySelector('.map-info-card');
    const info = S.roomIndex[roomId];
    if (!card || !info) return;
    S.cardRoom = roomId;
    const evs = (S.eventsByRoom.get(roomId) || []).slice().sort((a, b) =>
      (parseMinutes(a.start) || 0) - (parseMinutes(b.start) || 0) ||
      String(a.title).localeCompare(String(b.title), 'cs'));
    const live = currentLive();
    const picks = new Set(pickedIds());
    let body = '';
    if (evs.length) {
      body = '<ul class="mic-events">' + evs.map((ev) => {
        const st = eventState(ev, live);
        const picked = picks.has(ev.id);
        return `<li class="${st === 'now' ? 'is-now ' : ''}${st === 'past' ? 'is-past ' : ''}${picked ? 'is-picked' : ''}">` +
          `<span class="mic-time">${esc(ev.start)}–${esc(ev.end)}</span>` +
          `<span class="mic-title">${picked ? '<span class="mic-pick" title="V mém programu">✓</span>' : ''}${esc(ev.title)}` +
          `${st === 'now' ? '<span class="mic-live">probíhá</span>' : ''}</span></li>`;
      }).join('') + '</ul>';
    } else {
      body = '<div class="mic-empty">V této místnosti neprobíhá program akce.</div>';
    }
    // Optional room photo — assets/img/rooms/<ROOMID>.jpg (dropped in by the
    // organisers); a missing file removes the <img> (no broken icon).
    const photo = `<img class="mic-photo" src="assets/img/rooms/${encodeURIComponent(roomId)}.jpg" alt="Fotografie místnosti ${esc(roomId)}" loading="lazy" onerror="this.remove()">`;
    card.innerHTML =
      `<button type="button" class="mic-close" aria-label="Zavřít detail místnosti">×</button>` +
      `<div class="mic-code">${esc(roomId)}</div>` +
      `<span class="mic-name">${esc(info.room.name || '')} · ${esc(FLOOR_CAPTION[info.floor] || info.floor)}</span>` +
      (info.room.acc ? '<div class="mic-acc">Bezbariérový přístup</div>' : '') +
      photo + body;
    card.hidden = false;
  }

  function hideInfoCard() {
    const card = S.root.querySelector('.map-info-card');
    if (card) card.hidden = true;
    S.cardRoom = null;
  }

  // ------------------------------------------------------------- position --

  function setPosition(pos) {
    if (!pos || pos.floor == null) return;
    const floor = String(pos.floor);
    let cell = Array.isArray(pos.cell) ? [Number(pos.cell[0]), Number(pos.cell[1])] : null;
    let x = Number(pos.x), y = Number(pos.y);
    if (cell && RT && typeof RT.cellToSvg === 'function') {
      const p = RT.cellToSvg(cell);
      if (p) { x = p[0]; y = p[1]; }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    S.position = { floor: floor, cell: cell, x: x, y: y };
    drawPosition();
  }

  function getPosition() {
    if (!S.position) return null;
    const out = { floor: S.position.floor };
    if (S.position.cell) out.cell = S.position.cell.slice();
    else { out.cell = null; out.x = S.position.x; out.y = S.position.y; }
    return out;
  }

  function clearPosition() {
    S.position = null;
    drawPosition();
  }

  function drawPosition() {
    const layer = S.world.querySelector('.pos-layer');
    if (!layer) return;
    if (!S.position || S.position.floor !== S.floor ||
        !Number.isFinite(S.position.x) || !Number.isFinite(S.position.y)) {
      layer.innerHTML = '';
      return;
    }
    layer.innerHTML = `<g class="pos-marker">
  <circle class="pos-pulse" cx="${S.position.x}" cy="${S.position.y}" r="9"/>
  <circle class="pos-core" cx="${S.position.x}" cy="${S.position.y}" r="9"/>
</g>`;
  }

  // Long-press target: snap to a walkable grid cell when routing.js is
  // available; otherwise keep the raw svg point (degraded but functional).
  function pointToPosition(e) {
    const world = viewToWorld(clientToView(e.clientX, e.clientY));
    if (!RT || typeof RT.svgToCell !== 'function' || typeof RT.gridFor !== 'function') {
      return { floor: S.floor, cell: null, x: world[0], y: world[1] };
    }
    const size = (DATA.routing && DATA.routing.w && DATA.routing.h)
      ? DATA.routing : { w: 180, h: 250 };
    const cell = RT.svgToCell(world);
    const gx = cell[0], gy = cell[1];
    if (gx < 0 || gy < 0 || gx >= size.w || gy >= size.h) return null;
    const grid = RT.gridFor(S.floor);
    if (!grid) return null;
    if (grid[gy * size.w + gx]) return { floor: S.floor, cell: [gx, gy] };
    const n = RT.nearestWalkable(S.floor, cell);
    if (n && Math.abs(n[0] - gx) + Math.abs(n[1] - gy) <= 3) return { floor: S.floor, cell: n };
    return null;
  }

  function setUserPosition(res, source) {
    if (res.cell && window.AI4TPos && typeof window.AI4TPos.set === 'function') {
      window.AI4TPos.set({ floor: res.floor, cell: res.cell }, source); // persists + emits
    } else {
      setPosition({ floor: res.floor, cell: res.cell, x: res.x, y: res.y });
      emit('ai4t:position-set', {
        floor: res.floor, cell: res.cell || null, x: res.x, y: res.y, source: source,
      });
    }
    showToast('Poloha nastavena');
  }

  function showToast(text) {
    const toast = S.root.querySelector('.map-toast');
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => { toast.hidden = true; }, 220);
    }, 2000);
  }

  // ------------------------------------------------------------- gestures ---

  function cancelLongPress() {
    if (S.drag && S.drag.lpTimer) {
      clearTimeout(S.drag.lpTimer);
      S.drag.lpTimer = null;
    }
  }

  function onLongPress(e) {
    if (S.pinch || (S.drag && S.drag.moved)) return;
    const res = pointToPosition(e);
    if (!res) return;
    S.suppressClick = true;
    setUserPosition(res, 'longpress');
  }

  // Double-tap zooms IN (v2; the v1 double-tap position set is replaced by
  // the long-press).
  function handleDoubleTap(e) {
    // zoomed in? double-tap resets to the floor fit; otherwise zooms in
    if (S.transform.k > 1.6) animateTransform(fitTransformFor(S.floor), 260);
    else zoomAt(clientToView(e.clientX, e.clientY), 1.9);
    S.suppressClick = true;
  }

  // Tap semantics on the svg (native click is unreliable under pointer
  // capture, so selection uses the pointerdown target instead).
  function handleTap(downTarget) {
    if (!downTarget || !downTarget.closest) return;
    const room = downTarget.closest('.room-g');
    if (room) selectRoom(room.getAttribute('data-id'));
    else hideInfoCard();
  }

  function startPinch() {
    const pts = [...S.pointers.values()];
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    S.pinch = {
      dist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
      midV: clientToView((p1.x + p2.x) / 2, (p1.y + p2.y) / 2),
    };
  }

  function movePinch() {
    const pts = [...S.pointers.values()];
    if (pts.length < 2 || !S.pinch) return;
    const [p1, p2] = pts;
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
    const midV = clientToView((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    const t = S.transform;
    const k2 = clamp(t.k * (dist / S.pinch.dist), kMin(), 6);
    // keep the world point under the old midpoint glued to the new midpoint
    const ux = (S.pinch.midV[0] - t.tx) / t.k;
    const uy = (S.pinch.midV[1] - t.ty) / t.k;
    t.tx = midV[0] - ux * k2;
    t.ty = midV[1] - uy * k2;
    t.k = k2;
    applyTransform();
    S.pinch = { dist: dist, midV: midV };
  }

  function onPointerDown(e) {
    if (e.target.closest && e.target.closest('.map-ui')) return; // overlay controls
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pointers.size === 1) {
      S.drag = {
        moved: false, x: e.clientX, y: e.clientY,
        t0: performance.now(), downTarget: e.target,
        lpTimer: setTimeout(() => onLongPress(e), 350),
      };
      try { S.viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    } else if (S.pointers.size === 2) {
      cancelLongPress();
      S.drag = null;
      startPinch();
    }
  }

  function onPointerMove(e) {
    if (!S.pointers.has(e.pointerId)) return;
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pinch && S.pointers.size >= 2) { movePinch(); return; }
    if (!S.drag) return;
    const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
    if (!S.drag.moved && Math.hypot(dx, dy) > 4) {
      S.drag.moved = true;
      cancelLongPress();
    }
    if (S.drag.moved) {
      const v1 = clientToView(S.drag.x, S.drag.y);
      const v2 = clientToView(e.clientX, e.clientY);
      S.transform.tx += v2[0] - v1[0];
      S.transform.ty += v2[1] - v1[1];
      S.drag.x = e.clientX;
      S.drag.y = e.clientY;
      applyTransform();
    }
  }

  function onPointerUp(e) {
    S.pointers.delete(e.pointerId);
    if (S.pinch) {
      if (S.pointers.size < 2) {
        S.pinch = null;
        if (S.pointers.size === 1) {
          const p = S.pointers.values().next().value;
          S.drag = { moved: true, x: p.x, y: p.y, t0: performance.now(), downTarget: null, lpTimer: null };
        }
      }
      return; // no taps right after a pinch
    }
    if (!S.drag) return;
    cancelLongPress();
    const drag = S.drag;
    S.drag = null;
    const dt = performance.now() - drag.t0;
    if (drag.moved) { S.suppressClick = true; return; }
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (isTouch && dt < 300) {
      const now = performance.now();
      if (now - S.lastTap.t < 320 &&
          Math.hypot(e.clientX - S.lastTap.x, e.clientY - S.lastTap.y) < 40) {
        S.lastTap.t = 0;
        handleDoubleTap(e);
        S.suppressClick = false;
        return;
      }
      S.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    if (!S.suppressClick && dt < 600) handleTap(drag.downTarget);
    S.suppressClick = false;
  }

  function onPointerCancel(e) {
    S.pointers.delete(e.pointerId);
    S.pinch = null;
    S.drag = null;
    cancelLongPress();
  }

  function onWheel(e) {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 100;
    zoomAt(clientToView(e.clientX, e.clientY), Math.exp(-dy * 0.0014));
  }

  function onDblClick(e) {
    // Desktop double-click zooms in at the cursor.
    e.preventDefault();
    zoomAt(clientToView(e.clientX, e.clientY), 1.9);
  }

  function onViewportKey(e) {
    const t = S.transform;
    switch (e.key) {
      case 'ArrowLeft': t.tx += 80; break;
      case 'ArrowRight': t.tx -= 80; break;
      case 'ArrowUp': t.ty += 80; break;
      case 'ArrowDown': t.ty -= 80; break;
      case '+': case '=': zoomAt([VB_W / 2, VB_H / 2], 1.3); return;
      case '-': case '_': zoomAt([VB_W / 2, VB_H / 2], 1 / 1.3); return;
      case 'Escape': hideInfoCard(); return;
      default: return;
    }
    e.preventDefault();
    applyTransform();
  }

  function attachEvents() {
    window.addEventListener('resize', () => { try { applyTransform(); } catch (err) { /* ignore */ } });
    const vp = S.viewport;
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerCancel);
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('dblclick', onDblClick);
    vp.addEventListener('keydown', onViewportKey);
    vp.addEventListener('contextmenu', (e) => {
      if (e.target.closest && e.target.closest('svg')) e.preventDefault();
    });

    // Delegated clicks for the HTML controls inside the map root.
    S.root.addEventListener('click', (e) => {
      if (!e.target.closest) return;
      const fb = e.target.closest('.map-floorbtn');
      if (fb) { setFloor(fb.getAttribute('data-floor')); return; }
      if (e.target.closest('.mic-close')) { hideInfoCard(); clearSelection(); return; }
    });
  }

  // ---------------------------------------------------------------- floor --

  function setFloor(f) {
    const key = String(f);
    if (!DATA.map[key]) { console.warn('AI4TMap.setFloor: unknown floor', f); return false; }
    if (key === S.floor) { updateFloorbar(); return true; }
    S.floor = key;
    S.transform = fitTransformFor(key); // every floor switch re-opens at its default fit
    renderFloor();
    emit('ai4t:floor-changed', { floor: key });
    return true;
  }

  // ------------------------------------------------------------------ init --

  function init(sel, opts) {
    if (S.initialized) return window.AI4TMap;
    opts = opts || {};
    let root = null;
    if (typeof sel === 'string') root = document.querySelector(sel);
    else if (sel && sel.nodeType) root = sel;
    if (!root) root = document.getElementById('map-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'map-root';
      document.body.appendChild(root);
    }
    S.root = root;
    if (opts.floor && DATA.map[String(opts.floor)]) S.floor = String(opts.floor);
    injectStyles();
    buildIndexes();
    buildDOM();
    S.transform = fitTransformFor(S.floor);
    renderFloor();
    if (!PRINT) {
      // Live-state updates from the timetable (ai4t:tick) and view shows.
      document.addEventListener('ai4t:tick', (e) => {
        const d = (e && e.detail) || {};
        S.live = {
          now: typeof d.now === 'number' ? d.now : null,
          isEventDay: d.isEventDay != null ? !!d.isEventDay : null,
        };
        updateLiveStates();
      });
      document.addEventListener('ai4t:map-show', onShow);
      document.addEventListener('ai4t:pick-changed', () => updateLiveStates());
    }
    S.initialized = true;
    return window.AI4TMap;
  }

  // Called by app.js whenever the map tab becomes visible: re-measure label
  // sizes (the map may have been hidden at init) and refresh live tints.
  function onShow() {
    S.labelK = null; // force label re-scaling with the fresh rect
    applyTransform();
    updateLiveStates();
  }

  // Export the public API. showRoute/clearRoute/zoomToRoom are v1 leftovers:
  // the app has no routes in v2 — they stay as harmless no-op stubs until
  // the wave-2 print redesign drops them for good.
  window.AI4TMap = {
    init: init,
    getFloor: () => S.floor,
    setFloor: setFloor,
    selectRoom: selectRoom,
    clearSelection: clearSelection,
    onShow: onShow,
    refresh: onShow,
    setPosition: setPosition,
    getPosition: getPosition,
    clearPosition: clearPosition,
    showRoute: function () { return false; },
    clearRoute: function () {},
    zoomToRoom: function (roomId) { return !!S.roomIndex[roomId]; },
  };

  // Self-init when #map-root already exists (app + standalone use); app.js
  // may call init() again — it is a guarded no-op.
  function autoInit() {
    if (!S.initialized && document.getElementById('map-root')) init('#map-root');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit, { once: true });
  } else {
    autoInit();
  }
})();
