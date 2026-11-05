/* ==========================================================================
 * timetable.js — AI4Talents@FIT VUT programme (APP-V2 rewrite)
 *
 * Owns everything inside #program and #muj:
 *   A) Room × time GRID (main design): rows = rooms grouped by floor,
 *      overlapping events stacked in sub-lanes, sticky room labels (left)
 *      + sticky time header (top), vertical NOW line, live block states.
 *   B) SEQUENTIAL list: chronological groups, parallel events adjacent.
 *   C) Můj program picker (localStorage 'ai4t-my'), conflicts flagged.
 *
 * Events emitted on document (contracts used by app.js / map.js):
 *   'ai4t:tick'         { now, nowMin, date, isEventDay, current, next }
 *                      — every 30 s and once after render
 *                      (now = minutes since midnight; current = running
 *                       events, next = upcoming; each event is
 *                       { id, type, title, room, floor, start, end })
 *   'ai4t:pick-changed'{ ids, count }  — picker add/remove
 *   'ai4t:open-room'    { roomId, floor, eventId } — tap a block/row;
 *                      app.js switches to the map and opens the room card
 *
 * Events listened to:
 *   'ai4t:room-selected'{ roomId, floor } — flash matching rows (from map.js)
 *
 * Public API (superset kept for app.js convenience):
 *   window.AI4TTimetable = { getState, refreshNow, emitTick,
 *                            togglePick, isPicked, setView, getView }
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- data --- */

  const DATA = window.AI4T_DATA;
  if (!DATA || !DATA.events || !Array.isArray(DATA.events.events)) {
    console.error('AI4TTimetable: window.AI4T_DATA.events missing — load data.js first');
    window.AI4TTimetable = null;
    return;
  }

  const EV = DATA.events.events.slice();       // keep source order (poiOrder)
  const META = DATA.events.meta || {};

  // Time axis: 8:30 → 16:00 (minutes since midnight).
  const DAY_START = 8 * 60 + 30;                // 510
  const DAY_END = 16 * 60;                      // 960
  const SPAN = DAY_END - DAY_START;             // 450

  const TYPE_COLOR = {
    lecture: 'var(--blue)',
    workshop: 'var(--magenta-deep)',
    zone: 'var(--ink-soft)',
    milestone: 'var(--ink)',
  };

  // Grid rows: floor 1 rooms first, then floor 2 (spec order).
  const ROOM_GROUPS = [
    { floor: '1', label: '1. patro', rooms: ['E112', 'E105', 'E104', 'E103', 'C106', 'A104', 'N105'] },
    { floor: '2', label: '2. patro', rooms: ['C228', 'R212'] },
    { floor: '-2', label: '-2. podlaží', rooms: ['D0207'] },
  ];

  const LANE_H = 58;      // normal event lane height (px) — keep in sync with --lane-h in main.css
  const LANE_SLIM_H = 30; // all-day zone lane height (px)
  const LANE_GAP = 4;     // vertical gap between lanes (px)
  const SLIM_MIN = 240;   // minutes — zones this long render as slim lanes
  const SOON_MIN = 15;    // "starts soon" window (minutes)
  const TICK_MS = 30000; // live refresh cadence
  const LP_MS = 480;      // long-press duration (ms)

  /* ------------------------------------------------------ room index --- */

  const roomInfo = {};    // roomId -> { name, floor, type }
  if (DATA.map && DATA.map.floors) {
    // v1 shape: DATA.map is { floors: { '1': {...}, '2': {...} } }
    Object.keys(DATA.map.floors).forEach(function (f) {
      (DATA.map.floors[f].rooms || []).forEach(function (r) {
        if (!roomInfo[r.id]) roomInfo[r.id] = { name: r.name, floor: f, type: r.type };
      });
    });
  } else if (DATA.map) {
    // v2/raw shape: DATA.map is { '1': {...}, '2': {...} }
    Object.keys(DATA.map).forEach(function (f) {
      (DATA.map[f].rooms || []).forEach(function (r) {
        if (!roomInfo[r.id]) roomInfo[r.id] = { name: r.name, floor: f, type: r.type };
      });
    });
  }

  /* ------------------------------------------------------- events prep --- */

  function toMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  const events = EV.map(function (raw) {
    return {
      id: raw.id,
      type: raw.type || 'zone',
      start: raw.start,
      end: raw.end,
      startMin: toMin(raw.start),
      endMin: toMin(raw.end),
      title: raw.title,
      speaker: raw.speaker || '',
      partner: raw.partner || '',
      room: raw.room,
      floor: String(raw.floor != null ? raw.floor : (roomInfo[raw.room] ? roomInfo[raw.room].floor : '')),
    };
  }).filter(function (e) { return e.startMin != null && e.endMin != null; });

  const byId = {};
  events.forEach(function (e) { byId[e.id] = e; });

  const sorted = events.slice().sort(function (a, b) {
    return a.startMin - b.startMin || a.endMin - b.endMin;
  });

  /* Lane layout per room: greedy first-fit so overlapping events stack.
   * Long all-day zones (stánky, kachna) get a slim lane at the BOTTOM,
   * normal event lanes render above them. */
  function laneLayout(list) {
    const lanes = [];   // [{ slim, endMin }]
    const placed = list.map(function (ev) {
      const slim = (ev.endMin - ev.startMin) >= SLIM_MIN;
      let li = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].endMin <= ev.startMin) { li = i; break; }
      }
      if (li < 0) { lanes.push({ slim: slim, endMin: -1 }); li = lanes.length - 1; }
      lanes[li].endMin = ev.endMin;
      lanes[li].slim = lanes[li].slim && slim;
      return { ev: ev, lane: li };
    });
    // Draw order: normal lanes on top, slim all-day zones at the bottom.
    const order = lanes.map(function (_, i) { return i; })
      .sort(function (a, b) { return (lanes[a].slim ? 1 : 0) - (lanes[b].slim ? 1 : 0); });
    const remap = {};
    order.forEach(function (oldIdx, newIdx) { remap[oldIdx] = newIdx; });
    let y = 0;
    const tops = order.map(function (oldIdx) {
      const h = lanes[oldIdx].slim ? LANE_SLIM_H : LANE_H;
      const top = y;
      y += h + LANE_GAP;
      return { top: top, h: h, slim: lanes[oldIdx].slim };
    });
    const items = placed.map(function (p) {
      return { ev: p.ev, lane: remap[p.lane] };
    });
    return { items: items, lanes: tops, height: Math.max(0, y - LANE_GAP) };
  }

  const layoutByRoom = {};
  ROOM_GROUPS.forEach(function (g) {
    g.rooms.forEach(function (roomId) {
      const list = sorted.filter(function (e) { return e.room === roomId; });
      layoutByRoom[roomId] = laneLayout(list);
    });
  });

  /* ----------------------------------------------------------- helpers --- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pct(min) { return ((min - DAY_START) / SPAN) * 100; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // "9:00–14:00" → "9–14" when both ends are on the hour (for slim lanes).
  function timeRange(ev, short) {
    if (short && ev.startMin % 60 === 0 && ev.endMin % 60 === 0) {
      return ev.start.replace(':00', '') + '–' + ev.end.replace(':00', '');
    }
    return ev.start + '–' + ev.end;
  }

  function roomName(roomId) {
    const r = roomInfo[roomId];
    // Skip generic corridor names that would only confuse ("Chodba").
    return r && r.name && r.name !== 'Chodba' ? r.name : '';
  }

  function subLine(ev) {
    return ev.speaker || ev.partner || roomName(ev.room);
  }

  function pubEvent(ev) {
    return {
      id: ev.id, type: ev.type, title: ev.title, room: ev.room, floor: ev.floor,
      start: ev.start, end: ev.end, speaker: ev.speaker, partner: ev.partner,
    };
  }

  /* ------------------------------------------------------------- state --- */

  const PICK_KEY = 'ai4t-my';

  let picks = [];   // array of event ids
  try {
    const raw = JSON.parse(window.localStorage.getItem(PICK_KEY) || '[]');
    if (Array.isArray(raw)) {
      picks = raw.filter(function (id) { return typeof id === 'string' && byId[id]; });
    }
  } catch (err) { /* private mode etc. — picker just won't persist */ }

  let view = 'grid';   // 'grid' | 'seq'

  function savePicks() {
    try { window.localStorage.setItem(PICK_KEY, JSON.stringify(picks)); } catch (err) { /* ignore */ }
  }

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  /* --------------------------------------------------- day / now state --- */

  function eventDate() {
    // META.date is 'YYYY-MM-DD' (local, Czech event).
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(META.date || '');
    return m ? { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) } : null;
  }

  function dayState() {
    const d = new Date();
    const ed = eventDate();
    const isEventDay = !!(ed && d.getFullYear() === ed.y && d.getMonth() === ed.m && d.getDate() === ed.d);
    const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    return { date: d, isEventDay: isEventDay, minutes: minutes };
  }

  function tickDetail(s) {
    const current = [];
    const next = [];
    sorted.forEach(function (ev) {
      if (!s.isEventDay) return;
      if (ev.startMin <= s.minutes && s.minutes < ev.endMin) {
        current.push(pubEvent(ev));
      } else if (s.minutes < ev.startMin) {
        next.push(pubEvent(ev));
      }
    });
    return {
      now: Math.floor(s.minutes),
      nowMin: s.minutes,
      date: s.date,
      isEventDay: s.isEventDay,
      current: current,
      next: next,
    };
  }

  /* ============================================================ RENDER === */

  const gridRoot = document.getElementById('tt-grid');
  const seqRoot = document.getElementById('tt-seq');
  const mujRoot = document.getElementById('tt-muj');
  const mujBadge = document.getElementById('tab-muj-count');

  if (!gridRoot || !seqRoot || !mujRoot) {
    console.error('AI4TTimetable: missing #tt-grid / #tt-seq / #tt-muj containers');
    window.AI4TTimetable = null;
    return;
  }

  /* ------------------------------------------------------ grid (A) ------ */

  function hoursHTML() {
    let html = '<div class="ttg-corner" aria-hidden="true">místnost</div>';
    html += '<div class="ttg-hours" aria-hidden="true">';
    html += '<span class="ttg-hour is-edge-left" style="left:0%">8:30</span>';
    for (let h = 9; h <= 16; h++) {
      const cls = h === 16 ? 'ttg-hour is-edge-right' : 'ttg-hour';
      html += '<span class="' + cls + '" style="left:' + pct(h * 60).toFixed(3) + '%">' + h + '</span>';
    }
    html += '<span class="ttg-nowlabel" hidden style="left:0%"></span>';
    html += '</div>';
    return html;
  }

  function linesHTML() {
    let html = '';
    for (let h = 9; h <= 16; h++) {
      html += '<div class="ttg-vline" style="left:' + pct(h * 60).toFixed(3) + '%"></div>';
    }
    return html;
  }

  function blockHTML(ev, laneTop, laneH, laneSlim) {
    const left = pct(ev.startMin).toFixed(3);
    const width = (pct(ev.endMin) - pct(ev.startMin)).toFixed(3);
    const style =
      'left:' + left + '%;width:calc(' + width + '% - 2px);' +
      'top:' + (laneTop + 1) + 'px;height:' + (laneH - 2) + 'px;';
    const color = TYPE_COLOR[ev.type] || TYPE_COLOR.zone;
    const wrapCls = 'evt-wrap' + (laneSlim ? ' is-slim' : '');
    return (
      '<div class="' + wrapCls + '" data-ev="' + esc(ev.id) + '" data-room="' + esc(ev.room) + '" style="' + style + '">' +
        '<button type="button" class="evt" style="--evt-color:' + color + '" ' +
          'data-ev="' + esc(ev.id) + '">' +
          '<span class="evt-time">' + esc(ev.start) + '<i class="evt-time-end">–' + esc(ev.end) + '</i></span>' +
          '<span class="evt-title">' + esc(ev.title) + '</span>' +
        '</button>' +
        '<button type="button" class="evt-add" data-ev="' + esc(ev.id) + '" ' +
          'aria-pressed="false" aria-label="Přidat do Můj program">+</button>' +
      '</div>'
    );
  }

  function gridHTML() {
    let html = '<div class="tt-scroll"><div class="ttg-inner">';
    html += '<div class="ttg-head">' + hoursHTML() + '</div>';
    html += '<div class="ttg-body">';
    html += '<div class="ttg-lines">' + linesHTML() + '</div>';

    ROOM_GROUPS.forEach(function (g) {
      html += '<div class="ttg-floor"><span>' + esc(g.label) + '</span></div>';
      g.rooms.forEach(function (roomId) {
        const lay = layoutByRoom[roomId];
        const name = roomName(roomId);
        html += '<div class="ttg-row">';
        html += '<button type="button" class="ttg-label" data-room="' + esc(roomId) + '">';
        html += '<span class="ttg-code">' + esc(roomId) + '</span>';
        if (name) html += '<span class="ttg-name">' + esc(name) + '</span>';
        html += '</button>';
        html += '<div class="ttg-track" style="height:' + lay.height + 'px">';
        lay.items.forEach(function (it) {
          const lane = lay.lanes[it.lane];
          html += blockHTML(it.ev, lane.top, lane.h, lane.slim);
        });
        html += '</div></div>';
      });
    });

    html += '<div class="nowlayer"><div class="nowline" hidden style="left:0%"></div></div>';
    html += '</div></div></div>';
    return html;
  }

  /* --------------------------------------------- sequential rows (B/C) -- */

  function rowHTML(ev, opts) {
    const picked = opts.mode === 'muj' ? true : isPicked(ev.id);
    const conflict = opts.mode === 'muj' && conflicts.has(ev.id);
    const pickLabel = opts.mode === 'muj'
      ? 'Odebrat z Můj program'
      : (picked ? 'Odebrat z Můj program' : 'Přidat do Můj program');
    const pickGlyph = picked ? '×' : '+';
    // fixed row anatomy: clean title, then ONE meta line (room chip first —
    // same x every row), end time at the right. The group header carries
    // the start, so rows only say when they END.
    const rn = roomName(ev.room);
    const who = ev.speaker || ev.partner || '';
    // room name only when it adds information the title doesn't have
    const showRoom = rn && ev.title.toLowerCase().indexOf(rn.toLowerCase().slice(0, 8)) < 0;
    return (
      '<div class="seq-row ev--' + esc(ev.type) + '" data-ev="' + esc(ev.id) + '" data-room="' + esc(ev.room) + '">' +
        '<button type="button" class="seq-hit" data-ev="' + esc(ev.id) + '">' +
          '<span class="seq-body">' +
            '<span class="seq-title">' + esc(ev.title) + '</span>' +
            '<span class="seq-meta">' +
              '<span class="chip">' + esc(ev.room) + '</span>' +
              (conflict ? '<span class="chip is-conflict">Překrývá se</span>' : '') +
              (showRoom ? '<span class="seq-room">' + esc(rn) + '</span>' : '') +
              (who ? '<span class="seq-who">' + esc(who) + '</span>' : '') +
            '</span>' +
          '</span>' +
          '<span class="seq-end">do ' + esc(ev.end) + '</span>' +
        '</button>' +
        '<button type="button" class="seq-pick" data-ev="' + esc(ev.id) + '" ' +
          'aria-pressed="' + (picked ? 'true' : 'false') + '" aria-label="' + esc(pickLabel) + '">' +
          pickGlyph +
        '</button>' +
      '</div>'
    );
  }

  function groupsOf(list) {
    const groups = [];
    let last = null;
    sorted.forEach(function (ev) {   // sorted → chronological grouping
      if (list.indexOf(ev.id) < 0) return;
      if (!last || last.start !== ev.start) {
        last = { start: ev.start, startMin: ev.startMin, events: [] };
        groups.push(last);
      }
      last.events.push(ev);
    });
    return groups;
  }

  function seqHTML(list, mode) {
    if (!list.length) {
      return mode === 'muj'
        ? '<div class="muj-empty"><p>Vyber si program v záložce Program — klepni na akci a přidej si ji.</p>' +
          '<button type="button" class="muj-cta">Zobrazit program</button></div>'
        : '';
    }
    let html = '<div class="seq">';
    groupsOf(list).forEach(function (g) {
      html += '<div class="seq-group">';
      html += '<p class="seq-gh"><span class="seq-time">' + esc(g.start) + '</span>' +
        (g.events.length > 1 ? '<span class="seq-note">souběžně</span>' : '') + '</p>';
      g.events.forEach(function (ev) {
        html += rowHTML(ev, { mode: mode });
      });
      html += '</div>';
    });
    if (mode === 'seq') {
      html += '<p class="seq-foot">16:00 konec programu</p>';
    }
    html += '</div>';
    return html;
  }

  /* ------------------------------------------------------------ render --- */

  function renderGrid() { gridRoot.innerHTML = gridHTML(); }
  function renderSeq() { seqRoot.innerHTML = seqHTML(events.map(function (e) { return e.id; }), 'seq'); }
  function renderMuj() { mujRoot.innerHTML = seqHTML(picks.slice(), 'muj'); }

  /* ------------------------------------------------------- picker (C) ---- */

  function isPicked(id) { return picks.indexOf(id) >= 0; }

  let conflicts = new Set();

  function computeConflicts() {
    conflicts = new Set();
    const list = picks.map(function (id) { return byId[id]; })
      .filter(Boolean)
      .sort(function (a, b) { return a.startMin - b.startMin; });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].startMin >= list[i].endMin) break;
        conflicts.add(list[i].id);
        conflicts.add(list[j].id);
      }
    }
  }

  function updateBadge() {
    if (!mujBadge) return;
    if (picks.length > 0) {
      mujBadge.textContent = String(picks.length);
      mujBadge.hidden = false;
      mujBadge.classList.add('has-picks');
    } else {
      mujBadge.hidden = true;
      mujBadge.classList.remove('has-picks');
    }
  }

  // Refresh picked styling on already-rendered grid + seq + re-render muj.
  function applyPicks() {
    computeConflicts();
    updateBadge();
    renderMuj();

    document.querySelectorAll('#tt-grid .evt-wrap').forEach(function (wrap) {
      const on = isPicked(wrap.getAttribute('data-ev'));
      wrap.classList.toggle('is-picked', on);
      const add = wrap.querySelector('.evt-add');
      if (add) {
        add.textContent = on ? '×' : '+';
        add.setAttribute('aria-pressed', on ? 'true' : 'false');
        add.setAttribute('aria-label', on ? 'Odebrat z Můj program' : 'Přidat do Můj program');
      }
    });

    seqRoot.querySelectorAll('.seq-row').forEach(function (row) {
      const on = isPicked(row.getAttribute('data-ev'));
      row.classList.toggle('is-picked', on);
      const btn = row.querySelector('.seq-pick');
      if (btn) {
        btn.textContent = on ? '×' : '+';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Odebrat z Můj program' : 'Přidat do Můj program');
      }
    });

    emit('ai4t:pick-changed', { ids: picks.slice(), count: picks.length });
  }

  function togglePick(id) {
    const ev = byId[id];
    if (!ev) return;
    const i = picks.indexOf(id);
    if (i >= 0) picks.splice(i, 1); else picks.push(id);
    savePicks();
    applyPicks();
  }

  /* ----------------------------------------------------- view toggling --- */

  const btnGrid = document.getElementById('tt-btn-grid');
  const btnSeq = document.getElementById('tt-btn-seq');

  function setView(v) {
    view = v === 'seq' ? 'seq' : 'grid';
    if (btnGrid && btnSeq) {
      btnGrid.classList.toggle('is-active', view === 'grid');
      btnSeq.classList.toggle('is-active', view === 'seq');
      btnGrid.setAttribute('aria-pressed', view === 'grid' ? 'true' : 'false');
      btnSeq.setAttribute('aria-pressed', view === 'seq' ? 'true' : 'false');
    }
    gridRoot.hidden = view !== 'grid';
    seqRoot.hidden = view !== 'seq';
    refreshNow();   // hidden containers keep stale classes otherwise
  }

  if (btnGrid && btnSeq) {
    btnGrid.addEventListener('click', function () { setView('grid'); });
    btnSeq.addEventListener('click', function () { setView('seq'); });
  }

  /* ------------------------------------------------------- live states --- */

  function setStateClasses() {
    const s = dayState();
    const inDay = s.isEventDay && s.minutes >= DAY_START && s.minutes <= DAY_END;

    // NOW line + header label
    const line = gridRoot.querySelector('.nowline');
    const label = gridRoot.querySelector('.ttg-nowlabel');
    if (line && label) {
      if (inDay) {
        const p = pct(s.minutes).toFixed(3);
        line.style.left = p + '%';
        label.style.left = p + '%';
        label.textContent = pad2(s.date.getHours()) + ':' + pad2(s.date.getMinutes());
        line.hidden = false;
        label.hidden = false;
      } else {
        line.hidden = true;
        label.hidden = true;
      }
    }

    // grid blocks
    gridRoot.querySelectorAll('.evt-wrap').forEach(function (wrap) {
      const ev = byId[wrap.getAttribute('data-ev')];
      const st = liveState(ev, s);
      wrap.classList.toggle('is-now', st === 'now');
      wrap.classList.toggle('is-soon', st === 'soon');
    });

    // sequential rows
    [seqRoot, mujRoot].forEach(function (root) {
      root.querySelectorAll('.seq-row').forEach(function (row) {
        const ev = byId[row.getAttribute('data-ev')];
        const st = liveState(ev, s);
        row.classList.toggle('is-now', st === 'now');
        row.classList.toggle('is-soon', st === 'soon');
      });
    });
  }

  function liveState(ev, s) {
    if (!ev || !s.isEventDay) return '';
    if (ev.startMin <= s.minutes && s.minutes < ev.endMin) return 'now';
    if (s.minutes < ev.startMin && ev.startMin - s.minutes <= SOON_MIN) return 'soon';
    return '';
  }

  function refreshNow() {
    setStateClasses();
    emit('ai4t:tick', tickDetail(dayState()));
  }

  function emitTick() { refreshNow(); }

  /* -------------------------------------------------------- interaction -- */

  function openRoom(roomId, eventId) {
    const ev = eventId ? byId[eventId] : null;
    const floor = ev ? ev.floor : (roomInfo[roomId] ? roomInfo[roomId].floor : null);
    emit('ai4t:open-room', { roomId: roomId, floor: floor, eventId: eventId || null });
  }

  // Long-press on a grid block toggles the picker (touch + mouse).
  const lp = { timer: null, id: null, x: 0, y: 0, fired: false, pointer: 'mouse' };

  function lpCancel() {
    if (lp.timer) { clearTimeout(lp.timer); lp.timer = null; }
    lp.id = null;
  }

  function bindLongPress(root) {
    root.addEventListener('pointerdown', function (e) {
      const btn = e.target.closest ? e.target.closest('.evt') : null;
      lp.pointer = e.pointerType || 'mouse';
      if (!btn) return;
      if (lp.pointer === 'mouse' && e.button !== 0) return;
      lp.id = btn.getAttribute('data-ev');
      lp.x = e.clientX;
      lp.y = e.clientY;
      lp.fired = false;
      lpCancel();
      lp.timer = setTimeout(function () {
        lp.timer = null;
        if (!lp.id) return;
        lp.fired = true;
        togglePick(lp.id);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) { /* ignore */ } }
        lp.id = null;
      }, LP_MS);
    });

    root.addEventListener('pointermove', function (e) {
      if (!lp.timer) return;
      if (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10) lpCancel();
    });

    ['pointerup', 'pointercancel'].forEach(function (t) {
      root.addEventListener(t, lpCancel);
    });

    // Suppress the touch long-press callout / mouse context menu on blocks.
    root.addEventListener('contextmenu', function (e) {
      if (!lp.timer && lp.pointer !== 'touch' && !lp.fired) return;
      if (e.target.closest && e.target.closest('.evt')) e.preventDefault();
    });

    root.addEventListener('scroll', lpCancel, true);
  }

  function bindGrid() {
    // fade at the right edge only while there is more grid to the right
    const scroller = gridRoot.querySelector('.tt-scroll');
    if (scroller) {
      const upd = function () {
        const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
        gridRoot.classList.toggle('at-scroll-end', atEnd);
      };
      scroller.addEventListener('scroll', upd, { passive: true });
      // re-check when the grid is (re)laid out — e.g. shown after the phone
      // default seq view, or on rotation
      if (window.ResizeObserver) new ResizeObserver(upd).observe(scroller);
      upd();
    }
    bindLongPress(gridRoot);

    gridRoot.addEventListener('click', function (e) {
      const add = e.target.closest('.evt-add');
      if (add) { togglePick(add.getAttribute('data-ev')); return; }

      const label = e.target.closest('.ttg-label');
      if (label) { openRoom(label.getAttribute('data-room'), null); return; }

      const btn = e.target.closest('.evt');
      if (btn) {
        if (lp.fired) { lp.fired = false; return; }   // long-press already acted
        openRoom(btn.getAttribute('data-ev') ? byId[btn.getAttribute('data-ev')].room : null,
                 btn.getAttribute('data-ev'));
      }
    });
  }

  function bindSeq(root, mode) {
    if (mode === 'muj') {
      root.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.muj-cta')) {
          var tab = document.getElementById('tab-program');
          if (tab) tab.click();
        }
      });
    }
    root.addEventListener('click', function (e) {
      const pick = e.target.closest('.seq-pick');
      if (pick) { togglePick(pick.getAttribute('data-ev')); return; }

      const hit = e.target.closest('.seq-hit');
      if (hit) {
        const ev = byId[hit.getAttribute('data-ev')];
        if (ev) openRoom(ev.room, ev.id);
      }
    });
  }

  /* ------------------------------------------------- map room-selected --- */

  let flashTimers = [];

  document.addEventListener('ai4t:room-selected', function (e) {
    const roomId = e.detail && e.detail.roomId;
    if (!roomId) return;
    flashTimers.forEach(clearTimeout);
    flashTimers = [];
    const sel = '.evt-wrap[data-room="' + roomId + '"], .seq-row[data-room="' + roomId + '"]';
    document.querySelectorAll(sel).forEach(function (el) {
      el.classList.add('room-flash');
      flashTimers.push(setTimeout(function () { el.classList.remove('room-flash'); }, 1600));
    });
  });

  /* --------------------------------------------------------------- init -- */

  renderGrid();
  renderSeq();
  // phones land on the sequential list — the room×time grid needs width
  setView(window.matchMedia && window.matchMedia('(max-width: 700px)').matches ? 'seq' : 'grid');
  applyPicks();
  bindGrid();
  bindSeq(seqRoot, 'seq');
  bindSeq(mujRoot, 'muj');

  refreshNow();
  // One extra tick shortly after load so late-attaching listeners (app.js)
  // also receive the current state.
  setTimeout(refreshNow, 1200);
  setInterval(refreshNow, TICK_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNow();
  });

  /* -------------------------------------------------------- public API --- */

  window.AI4TTimetable = {
    getState: function () {
      return {
        view: view,
        picks: picks.slice(),
        events: events.map(pubEvent),
      };
    },
    refreshNow: refreshNow,
    emitTick: emitTick,
    togglePick: togglePick,
    isPicked: isPicked,
    setView: setView,
    getView: function () { return view; },
  };
})();
