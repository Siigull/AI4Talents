// print.js — shared print helpers for AI4Talents@FIT print pages (window.AI4TPrint).
// Loaded by print/*.html AFTER data.js (+ routing.js / map.js where needed).
//
// PRINT V2 (spec/PRINT-V2.md): the mini-map renders the SAME decluttered
// style as the app v2 map: neutral white rooms + hairline ink strokes, event
// rooms #dbe7fa tint + bold mono room-code labels, subject room yellow.
// NO room-type colors, NO sector letters, NO pins/dots, NO legend.
//
// Provides:
//   AI4TPrint.esc(s)                 HTML-escape
//   AI4TPrint.fmtDate(iso)           "2026-11-06" -> "6 . 11 . 2026"
//   AI4TPrint.floorLabel(f)          "2" -> "2. patro", "-1" -> "-1. podlaží"
//   AI4TPrint.timeRange(ev)          "9:00 — 10:00"
//   AI4TPrint.roomIndex()            { roomId -> {floor, room} } over all floors
//   AI4TPrint.findRoom(id)           single lookup (case-insensitive)
//   AI4TPrint.allEvents()            events sorted by start time, then title
//   AI4TPrint.eventsForRoom(id)     events filtered to one room (sorted)
//   AI4TPrint.eventRooms()           unique event rooms [{roomId, floor, room}]
//   AI4TPrint.typeKick(ev)           CZ kicker: "PŘEDNÁŠKA" | "WORKSHOP" | ...
//   AI4TPrint.qrBlock(sizeMm, cap)   real QR (assets/img/qr.svg) + caption
//   AI4TPrint.footerStrip()          footer strip (HTML string)
//   AI4TPrint.miniMap(opts)          static SVG mini-map — v2 style (below)
//   AI4TPrint.programGrid(opts)      static room×time grid HTML (A3 poster)
//   AI4TPrint.routeToPolyline(a, b)  best-effort route points via AI4TRoute
//
// miniMap(opts) renders a STATIC, non-interactive SVG from AI4T_DATA.map:
//   floor    '1' | '2' | ...                        (required)
//   subject  roomId                                yellow fill + 3px stroke
//   crosshair roomId                                blue crosshair marker
//   events   true (default) — tint event rooms on this floor + bold labels
//   crop     { rooms:[ids], margin }                bbox of rooms + margin
//            { cluster: roomId, margin }            app-v2 style cluster crop
//            (largest event-room cluster around the seed room)
//   aspect   w/h — expand the crop to this aspect so the SVG FILLS its box
//   boxMm    rendered box width in mm — used to size labels to ~labelPx
//   labelPx  target on-screen label size (default 13 px)
//   labelSize svg units — explicit override (skips the boxMm computation)
// Returns an <svg> element, or null when the floor/rooms are unknown.

(function () {
  'use strict';

  var DATA = window.AI4T_DATA;
  if (!DATA || !DATA.map) {
    console.error('AI4TPrint: window.AI4T_DATA missing — load data.js first');
    window.AI4TPrint = null;
    return;
  }

  var VB_W = 720, VB_H = 1000;
  var CLUSTER_D = 300;       // event rooms within this distance form a cluster
  var CLUSTER_MARGIN = 0.15;  // cluster crop margin (fraction of bbox)
  var MIN_CROP = 280;        // min crop size (svg units) so an ISOLATED subject
                              // room (N105, R212) still shows corridor context
  // manual label nudges where room centroids are too close (E-wing cluster;
  // kept in sync with map.js)
  var LABEL_POS = {
    E103: [458, 130], E112: [531, 105], E105: [452, 68], E104: [452, 192],
  };

  // ------------------------------------------------------------- helpers ---

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // "2026-11-06" -> "6 . 11 . 2026"
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    return Number(m[3]) + ' . ' + Number(m[2]) + ' . ' + m[1];
  }

  function floorLabel(f) {
    f = String(f);
    return f.charAt(0) === '-' ? f + '. podlaží' : f + '. patro';
  }

  function toMin(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }

  function timeRange(ev) {
    return ev.start + ' — ' + ev.end;
  }

  // --------------------------------------------------------- data lookups ---

  var _roomIndex = null;

  function roomIndex() {
    if (_roomIndex) return _roomIndex;
    _roomIndex = {};
    var floors = Object.keys(DATA.map);
    for (var i = 0; i < floors.length; i++) {
      var rooms = DATA.map[floors[i]].rooms || [];
      for (var j = 0; j < rooms.length; j++) {
        var r = rooms[j];
        if (!_roomIndex[r.id]) _roomIndex[r.id] = { floor: floors[i], room: r };
      }
    }
    return _roomIndex;
  }

  function findRoom(id) {
    if (!id) return null;
    var idx = roomIndex();
    if (idx[id]) return idx[id];
    var up = String(id).toUpperCase();
    var keys = Object.keys(idx);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toUpperCase() === up) return idx[keys[i]];
    }
    return null;
  }

  function sortEvents(list) {
    return list.slice().sort(function (a, b) {
      var d = toMin(a.start) - toMin(b.start);
      if (d) return d;
      d = toMin(a.end) - toMin(b.end);
      if (d) return d;
      return String(a.title).localeCompare(String(b.title), 'cs');
    });
  }

  function allEvents() {
    var evs = (DATA.events && DATA.events.events) || [];
    return sortEvents(evs);
  }

  function eventsForRoom(roomId) {
    var want = String(roomId).toUpperCase();
    return allEvents().filter(function (ev) {
      return String(ev.room).toUpperCase() === want;
    });
  }

  function eventRooms() {
    var out = [];
    var seen = {};
    var evs = allEvents();
    for (var i = 0; i < evs.length; i++) {
      var id = evs[i].room;
      if (seen[id]) continue;
      seen[id] = true;
      var info = findRoom(id);
      if (info) out.push({ roomId: id, floor: info.floor, room: info.room });
    }
    return out;
  }

  function typeKick(ev) {
    switch (ev.type) {
      case 'lecture': return 'PŘEDNÁŠKA';
      case 'workshop': return 'WORKSHOP';
      case 'zone': return 'PRŮBĚŽNĚ';
      default: return 'INFO';
    }
  }

  // ------------------------------------------------------ shared DOM bits ---

  // QR: real code → https://siigull.github.io/AI4Talents/
  // (assets/img/qr.svg, version 5-Q, 4-module quiet zone baked in;
  // regenerate with: npx -y --package qrcode qrcode "<url>" -e Q -t svg -w 660)
  function qrBlock(sizeMm, caption) {
    var s = Number(sizeMm) || 30;
    var h =
      '<div class="qr-slot" style="width:' + s + 'mm;height:' + s + 'mm">' +
        '<img class="qr-img" src="../assets/img/qr.svg" width="' + s + '" height="' + s + '"' +
          ' alt="QR kód: program a mapa na siigull.github.io/AI4Talents"/>' +
      '</div>';
    if (caption) h += '<p class="qr-cap">' + esc(caption) + '</p>';
    return h;
  }

  // Footer strip on every page: event left, example URL right (mono).
  function footerStrip() {
    var meta = DATA.events && DATA.events.meta ? DATA.events.meta : {};
    var left = esc(meta.name || 'AI4Talents@FIT VUT') + ' · ' + esc(fmtDate(meta.date || '2026-11-06'));
    return '<footer class="pfooter">' +
      '<span>' + left + '</span>' +
      '<span class="pf-url">ai4talents.fit.vut.cz</span>' +
    '</footer>';
  }

  // ------------------------------------------------------------ geometry ---

  function polyD(pts) {
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 1; i < pts.length; i++) d += 'L' + pts[i][0] + ' ' + pts[i][1];
    return d + 'Z';
  }

  function shapeSvg(s, cls) {
    return s.p
      ? '<path class="' + cls + '" d="' + polyD(s.p) + '" vector-effect="non-scaling-stroke"/>'
      : '<rect class="' + cls + '" x="' + s.r[0] + '" y="' + s.r[1] +
        '" width="' + s.r[2] + '" height="' + s.r[3] + '" vector-effect="non-scaling-stroke"/>';
  }

  function roomShapes(room, cls) {
    var out = '';
    for (var i = 0; i < room.s.length; i++) out += shapeSvg(room.s[i], cls);
    return out;
  }

  function roomBBox(room) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < room.s.length; i++) {
      var s = room.s[i];
      if (s.p) {
        for (var j = 0; j < s.p.length; j++) {
          if (s.p[j][0] < x0) x0 = s.p[j][0];
          if (s.p[j][1] < y0) y0 = s.p[j][1];
          if (s.p[j][0] > x1) x1 = s.p[j][0];
          if (s.p[j][1] > y1) y1 = s.p[j][1];
        }
      } else {
        if (s.r[0] < x0) x0 = s.r[0];
        if (s.r[1] < y0) y0 = s.r[1];
        if (s.r[0] + s.r[2] > x1) x1 = s.r[0] + s.r[2];
        if (s.r[1] + s.r[3] > y1) y1 = s.r[1] + s.r[3];
      }
    }
    return [x0, y0, x1, y1];
  }

  // Expand a bbox in place so its width/height matches `aspect` (centered).
  function expandToAspect(b, aspect) {
    if (!aspect || !(aspect > 0)) return b;
    var w = b[2] - b[0], h = b[3] - b[1];
    if (w / h > aspect) {          // too wide -> grow height
      var nh = w / aspect, dy = (nh - h) / 2;
      b[1] -= dy; b[3] += dy;
    } else {                       // too tall -> grow width
      var nw = h * aspect, dx = (nw - w) / 2;
      b[0] -= dx; b[2] += dx;
    }
    return b;
  }

  // Expand a bbox in place (centered) so both dimensions are >= `min` svg
  // units — keeps a tight crop around an isolated room from becoming a
  // meaningless zoomed-in sliver with no corridor context.
  function growToMin(b, min) {
    var w = b[2] - b[0], h = b[3] - b[1];
    if (w < min) { var dx = (min - w) / 2; b[0] -= dx; b[2] += dx; }
    if (h < min) { var dy = (min - h) / 2; b[1] -= dy; b[3] += dy; }
    return b;
  }

  function clampBBox(b) {
    var x0 = Math.max(0, b[0]), y0 = Math.max(0, b[1]);
    var x1 = Math.min(VB_W, b[2]), y1 = Math.min(VB_H, b[3]);
    if (x1 - x0 < 10) { x0 = 0; x1 = VB_W; }
    if (y1 - y0 < 10) { y0 = 0; y1 = VB_H; }
    return [x0, y0, x1, y1];
  }

  // viewBox [x, y, w, h] from a bbox — clampBBox returns x0/y0/x1/y1, the
  // svg viewBox needs x/y/w/h. (v1 bug: the bbox was used directly as a
  // viewBox, which exploded the aspect on tight crops — N105/R212 doors.)
  function viewBoxFromBBox(b) {
    var cb = clampBBox(b);
    return [cb[0], cb[1], cb[2] - cb[0], cb[3] - cb[1]];
  }

  // --------------------------------------------------------------- route ---

  // Best-effort static route (svg-space polyline) between two room ids.
  // Returns null when AI4TRoute is missing or no path exists — callers must
  // treat routes as decoration, never as required content.
  function routeToPolyline(fromRoomId, toRoomId) {
    var RT = window.AI4TRoute;
    if (!RT || typeof RT.route !== 'function') return null;
    try {
      var r = RT.route(fromRoomId, toRoomId);
      if (!r || !r.legs || !r.legs.length) return null;
      var pts = [];
      for (var i = 0; i < r.legs.length; i++) {
        var lp = r.legs[i].points || [];
        for (var j = 0; j < lp.length; j++) {
          var last = pts[pts.length - 1];
          if (!last || last[0] !== lp[j][0] || last[1] !== lp[j][1]) pts.push(lp[j]);
        }
      }
      return pts.length > 1 ? pts : null;
    } catch (err) {
      return null;
    }
  }

  // ------------------------------------------------------------- miniMap ---

  function miniMap(o) {
    o = o || {};
    var floor = String(o.floor != null ? o.floor : '1');
    var fl = DATA.map[floor];
    if (!fl) return null;
    var idx = roomIndex();

    var subject = o.subject ? idx[o.subject] : null;
    var cross = o.crosshair ? idx[o.crosshair] : null;
    var showEvents = o.events !== false;

    // Event rooms on this floor (first-seen order from the event list).
    var evIds = [];
    if (showEvents) {
      eventRooms().forEach(function (p) {
        if (p.floor === floor && evIds.indexOf(p.roomId) < 0) evIds.push(p.roomId);
      });
    }

    // ---- viewBox: whole floor / rooms bbox / app-style cluster crop -------
    var vb = [0, 0, VB_W, VB_H];
    if (o.crop) {
      var b = null;
      if (o.crop.cluster) {
        // Seed a cluster at the given room, then greedily join every event
        // room within CLUSTER_D of the running centroid (app v2 logic).
        var seed = idx[o.crop.cluster] || subject;
        if (seed) {
          var members = [seed.room];
          var ids = evIds.slice();
          if (subject && ids.indexOf(subject.room.id) < 0) ids.push(subject.room.id);
          var grew = true;
          while (grew) {
            grew = false;
            var cx = 0, cy = 0;
            members.forEach(function (m) { cx += m.c[0]; cy += m.c[1]; });
            cx /= members.length; cy /= members.length;
            for (var i = 0; i < ids.length; i++) {
              var info = idx[ids[i]];
              if (!info) continue;
              if (members.indexOf(info.room) >= 0) continue;
              if (Math.hypot(info.room.c[0] - cx, info.room.c[1] - cy) <= CLUSTER_D) {
                members.push(info.room);
                grew = true;
              }
            }
          }
          var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          members.forEach(function (m) {
            var mb = roomBBox(m);
            x0 = Math.min(x0, mb[0]); y0 = Math.min(y0, mb[1]);
            x1 = Math.max(x1, mb[2]); y1 = Math.max(y1, mb[3]);
          });
          var mw = (x1 - x0) * CLUSTER_MARGIN, mh = (y1 - y0) * CLUSTER_MARGIN;
          b = [x0 - mw, y0 - mh, x1 + mw, y1 + mh];
          // an isolated room (cluster of one) still gets corridor context
          growToMin(b, MIN_CROP);
        }
      } else if (o.crop.rooms && o.crop.rooms.length) {
        var margin = o.crop.margin != null ? o.crop.margin : 60;
        var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        o.crop.rooms.forEach(function (id) {
          var info = idx[id];
          if (!info) return;
          var rb = roomBBox(info.room);
          bx0 = Math.min(bx0, rb[0]); by0 = Math.min(by0, rb[1]);
          bx1 = Math.max(bx1, rb[2]); by1 = Math.max(by1, rb[3]);
        });
        if (bx0 !== Infinity) {
          b = [bx0 - margin, by0 - margin, bx1 + margin, by1 + margin];
          growToMin(b, MIN_CROP);
        }
      }
      if (b) {
        expandToAspect(b, o.aspect);
        vb = viewBoxFromBBox(b);
      }
    }
    var vw = vb[2] - vb[0], vh = vb[3] - vb[1];

    // ---- label size: bold mono event-room codes at ~labelPx on screen ----
    var labelSize;
    if (o.labelSize != null) {
      labelSize = o.labelSize;
    } else {
      var boxPx = o.boxMm ? o.boxMm * 96 / 25.4 : vw; // no box info -> 1:1
      var scale = boxPx / vw;                          // px per svg unit
      labelSize = Math.max(6, (o.labelPx || 13) / (scale || 1));
    }

    var parts = [];

    // buildings (app v2: light gray base so the white rooms read as rooms)
    for (var i = 0; i < fl.buildings.length; i++) {
      var bl = fl.buildings[i];
      parts.push(bl.pts
        ? '<path class="pm-building" d="' + polyD(bl.pts) + '" vector-effect="non-scaling-stroke"/>'
        : '<rect class="pm-building" x="' + bl.x + '" y="' + bl.y +
          '" width="' + bl.w + '" height="' + bl.h + '" vector-effect="non-scaling-stroke"/>');
    }

    // neutral rooms: white fill, hairline ink stroke (NO type colors)
    for (var r = 0; r < fl.rooms.length; r++) {
      parts.push(roomShapes(fl.rooms[r], 'pm-room'));
    }

    // event rooms: blue tint + 2px ink stroke (drawn over the neutral base)
    for (var e = 0; e < evIds.length; e++) {
      var er = idx[evIds[e]];
      if (er) parts.push(roomShapes(er.room, 'pm-room pm-room--ev'));
    }

    // subject room: yellow + 3px stroke (the page's subject)
    if (subject) parts.push(roomShapes(subject.room, 'pm-room pm-room--subj'));

    // bold mono labels for event rooms only (app v2 rule)
    for (var l = 0; l < evIds.length; l++) {
      var lr = idx[evIds[l]];
      if (!lr || !lr.room.c) continue;
      var lp = LABEL_POS[evIds[l]] || lr.room.c;
      var isSubj = subject && subject.room.id === evIds[l];
      // evLabels:false = overview mode (door posters): only the subject room
      // gets a code label — tinted rooms stay anonymous, caption explains.
      if (!isSubj && o.evLabels === false) continue;
      if (isSubj) {
        // the poster's whole point: room code big, BELOW the crosshair pin,
        // uniformly on every poster (inside the room bottom, or just under
        // the room when the map has space below)
        var sb = roomBBox(subject.room);
        var rH = sb[3] - sb[1], rW = sb[2] - sb[0];
        var codeW = evIds[l].length * 0.72; // approx glyph width in font units
        var sSize = Math.max(labelSize * 2.2, rH * 0.34, 13);
        sSize = Math.min(sSize, rH * 0.5, (rW / codeW) * 1.15); // must fit the room
        sSize = Math.max(sSize, 10);
        var yLab = sb[3] + sSize * 0.55;
        if (yLab > VB_H - sSize * 0.3) yLab = sb[3] - sSize * 0.38; // near frame edge
        // small room: the code can't be big inside — call it out BELOW the
        // room instead (halo keeps it readable over neighbouring rooms)
        if (sSize < 20) {
          sSize = 22;
          yLab = sb[3] + 15;
          if (yLab > VB_H - 8) yLab = sb[1] - 13; // no space below -> above
        }
        parts.push('<text class="pm-evlabel pm-evlabel--subj" x="' + ((sb[0] + sb[2]) / 2) +
          '" y="' + yLab.toFixed(1) + '" font-size="' + sSize.toFixed(1) + '">' + esc(evIds[l]) + '</text>');
      } else {
        parts.push('<text class="pm-evlabel" x="' + lp[0] + '" y="' + lp[1] +
          '" font-size="' + labelSize.toFixed(1) + '">' + esc(evIds[l]) + '</text>');
      }
    }

    // YOU-ARE-HERE crosshair on the subject room (door posters keep it)
    if (cross && cross.room.c) {
      var cb = roomBBox(cross.room);
      var ccx = cross.room.c[0], ccy = cross.room.c[1];
      // short rooms: lift the pin into the top part — the subject label
      // lives in the bottom half, clear of the crosshair arms
      if (subject && cross.room.id === subject.room.id && (cb[3] - cb[1]) < 90) {
        ccy = cb[1] + (cb[3] - cb[1]) * 0.3;
      }
      var arm = Math.min(Math.max(labelSize * 2.6, 14), Math.max(12, (cb[3] - cb[1]) * 0.42));
      parts.push(
        '<g class="pm-xh">' +
        '<line class="pm-xh-line" x1="' + (ccx - arm) + '" y1="' + ccy + '" x2="' + (ccx + arm) + '" y2="' + ccy + '"/>' +
        '<line class="pm-xh-line" x1="' + ccx + '" y1="' + (ccy - arm) + '" x2="' + ccx + '" y2="' + (ccy + arm) + '"/>' +
        '<circle class="pm-xh-ring" cx="' + ccx + '" cy="' + ccy + '" r="' + (labelSize * 1.15) + '"/>' +
        '<circle class="pm-xh-dot" cx="' + ccx + '" cy="' + ccy + '" r="' + (labelSize * 0.6) + '"/>' +
        '</g>');
    }

    var wrap = document.createElement('div');
    wrap.innerHTML = '<svg class="pm-svg" viewBox="' + vb.join(' ') +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mapa — ' +
      esc(floorLabel(floor)) + '">' + parts.join('') + '</svg>';
    return wrap.firstElementChild;
  }

  // ------------------------------------------------- static program grid ---
  // Room × time grid (the app v2 timetable, static): rows = rooms grouped by
  // floor, blocks positioned by % of the 8:30–16:00 axis, overlapping events
  // stacked in sub-lanes, long zones (≥ 240 min) as slim title-first lanes.
  // Returns an HTML string; the page styles it (.pg-* classes).

  var GRID_DAY_START = 8 * 60 + 30;   // 8:30
  var GRID_DAY_END = 16 * 60;         // 16:00
  var GRID_SPAN = GRID_DAY_END - GRID_DAY_START;
  var GRID_GROUPS = [
    { label: '1. patro', rooms: ['E112', 'E105', 'E104', 'E103', 'C106', 'N105'] },
    { label: '2. patro', rooms: ['A218', 'C228', 'R212'] },
  ];
  var GRID_TYPE_COLOR = {
    lecture: '#1761cc', workshop: '#c21f9f', zone: '#6f6b64', milestone: '#14120f',
  };
  var GRID_SLIM_MIN = 240;            // minutes — zones this long go slim

  function gridPct(min) { return ((min - GRID_DAY_START) / GRID_SPAN) * 100; }

  // Greedy first-fit lane layout (port of timetable.js laneLayout); heights
  // are expressed in the page's unit (mm) via laneH/slimH/gap params.
  function gridLaneLayout(list, laneH, slimH, gap) {
    var lanes = [];                    // [{ slim, endMin }]
    var placed = list.map(function (w) {
      var slim = (w.endMin - w.startMin) >= GRID_SLIM_MIN;
      var li = -1;
      for (var i = 0; i < lanes.length; i++) {
        if (lanes[i].endMin <= w.startMin) { li = i; break; }
      }
      if (li < 0) { lanes.push({ slim: slim, endMin: -1 }); li = lanes.length - 1; }
      lanes[li].endMin = w.endMin;
      lanes[li].slim = lanes[li].slim && slim;
      return { ev: w.ev, lane: li, startMin: w.startMin, endMin: w.endMin };
    });
    // Draw order: normal lanes on top, slim all-day zones at the bottom.
    var order = lanes.map(function (_, i) { return i; })
      .sort(function (a, b) { return (lanes[a].slim ? 1 : 0) - (lanes[b].slim ? 1 : 0); });
    var remap = {};
    order.forEach(function (oldIdx, newIdx) { remap[oldIdx] = newIdx; });
    var y = 0;
    var tops = order.map(function (oldIdx) {
      var h = lanes[oldIdx].slim ? slimH : laneH;
      var top = y;
      y += h + gap;
      return { top: top, h: h, slim: lanes[oldIdx].slim };
    });
    return {
      items: placed.map(function (p) { return { ev: p.ev, lane: remap[p.lane], startMin: p.startMin, endMin: p.endMin }; }),
      lanes: tops,
      height: Math.max(0, y - gap),
    };
  }

  function programGrid(opts) {
    opts = opts || {};
    var laneH = opts.laneH != null ? opts.laneH : 24;   // mm
    var slimH = opts.slimH != null ? opts.slimH : 11;   // mm
    var gap = opts.gap != null ? opts.gap : 1.6;        // mm
    var evs = allEvents().map(function (ev) {
      return {
        ev: ev, startMin: toMin(ev.start), endMin: toMin(ev.end),
      };
    }).filter(function (e) { return e.startMin && e.endMin; })
      .sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });

    function blockHTML(item, lane) {
      var ev = item.ev;
      var left = gridPct(item.startMin).toFixed(3);
      var width = (gridPct(item.endMin) - gridPct(item.startMin)).toFixed(3);
      var color = GRID_TYPE_COLOR[ev.type] || GRID_TYPE_COLOR.zone;
      var cls = 'pg-evt' + (lane.slim ? ' is-slim' : '');
      var style = 'left:' + left + '%;width:calc(' + width + '% - 1.5mm);top:' +
        lane.top.toFixed(1) + 'mm;height:' + lane.h.toFixed(1) + 'mm;--evt-color:' + color;
      var who = ev.speaker || ev.partner || '';
      var short = (item.endMin - item.startMin) <= 45;
      return '<div class="' + cls + '" style="' + style + '">' +
        '<span class="pg-time">' + esc(ev.start) + (short ? '' : '–' + esc(ev.end)) + '</span>' +
        '<span class="pg-title">' + esc(ev.title) + '</span>' +
        (who ? '<span class="pg-who">' + esc(who) + '</span>' : '') +
        '</div>';
    }

    var h = '<div class="pg"><div class="pg-head">' +
      '<div class="pg-corner">místnost \\ čas</div><div class="pg-hours">';
    h += '<span class="pg-hour is-edge-left" style="left:0%">8:30</span>';
    for (var hr = 9; hr <= 16; hr++) {
      var hcls = hr === 16 ? 'pg-hour is-edge-right' : 'pg-hour';
      h += '<span class="' + hcls + '" style="left:' + gridPct(hr * 60).toFixed(3) + '%">' + hr + ':00</span>';
    }
    h += '</div></div><div class="pg-body"><div class="pg-lines">';
    for (var hl = 9; hl <= 16; hl++) {
      h += '<div class="pg-vline" style="left:' + gridPct(hl * 60).toFixed(3) + '%"></div>';
    }
    h += '</div>';

    GRID_GROUPS.forEach(function (g) {
      h += '<div class="pg-floor"><span>' + esc(g.label) + '</span></div>';
      g.rooms.forEach(function (roomId) {
        var list = evs.filter(function (e) { return e.ev.room === roomId; });
        var lay = gridLaneLayout(list, laneH, slimH, gap);
        var info = findRoom(roomId);
        var name = info && info.room.name && info.room.name !== 'Chodba' ? info.room.name : '';
        h += '<div class="pg-row">' +
          '<div class="pg-label"><span class="pg-code">' + esc(roomId) + '</span>' +
            (name ? '<span class="pg-name">' + esc(name) + '</span>' : '') +
          '</div>' +
          '<div class="pg-track" style="height:' + lay.height.toFixed(1) + 'mm">';
        lay.items.forEach(function (it) {
          h += blockHTML(it, lay.lanes[it.lane]);
        });
        h += '</div></div>';
      });
    });

    h += '</div></div>';
    return h;
  }

  // ---------------------------------------------------------------- export --

  window.AI4TPrint = {
    esc: esc,
    fmtDate: fmtDate,
    floorLabel: floorLabel,
    toMin: toMin,
    timeRange: timeRange,
    roomIndex: roomIndex,
    findRoom: findRoom,
    allEvents: allEvents,
    eventsForRoom: eventsForRoom,
    eventRooms: eventRooms,
    typeKick: typeKick,
    qrBlock: qrBlock,
    footerStrip: footerStrip,
    miniMap: miniMap,
    programGrid: programGrid,
    routeToPolyline: routeToPolyline,
  };
})();
