/*
 * AI4TPos — user positioning module for AI4Talents@FIT VUT (v2 trim).
 *
 * Exposes window.AI4TPos:
 *   get()            → {floor, cell:[gx,gy]} | null   (memory + localStorage 'ai4t-pos')
 *   set(pos, source) → persist, update map marker, emit 'ai4t:position-set'
 *   clear()          → drop position (memory, storage, map marker)
 *   fromRoom(id)     → "I'm standing in room X" (room walkable anchor)
 *   pois()           → named POI registry for QR links ({id, label, room})
 *
 * The v2 app has no GPS assist UI anymore (the #info section is gone); the
 * module now only serves the QR location links and the map long-press.
 *
 * QR deep links handled here (kept in the URL so they survive reload):
 *   #at=<poiId|eventId|roomId>   e.g. #at=kachna, #at=C106
 *   #pos=<floor>,<gx>,<gy>       raw variant for print stand posters
 *
 * UI copy is Czech; code comments are English. No external dependencies.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ai4t-pos';

  // Named POIs usable in #at= QR links (id → room).
  var NAMED_POIS = [
    { id: 'vstup', label: 'Vstup — hlavní vchod (A101)', room: 'A101' },
    { id: 'registrace', label: 'Registrace — C107', room: 'C107' },
    { id: 'stanky', label: 'Stánky firem — E103', room: 'E103' },
    { id: 'kachna', label: 'Kachna — R212', room: 'R212' }
  ];

  var current = null; // {floor, cell:[gx,gy]}

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function eventsList() {
    var d = window.AI4T_DATA;
    return (d && d.events && Array.isArray(d.events.events)) ? d.events.events : [];
  }

  function persist(pos) {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ floor: pos.floor, gx: pos.cell[0], gy: pos.cell[1] })
      );
    } catch (err) { /* storage unavailable (private mode) — memory only */ }
  }

  function restore() {
    if (current) return { floor: current.floor, cell: current.cell.slice() };
    var saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      saved = null;
    }
    if (saved && saved.floor != null && Number.isFinite(saved.gx) && Number.isFinite(saved.gy)) {
      current = { floor: String(saved.floor), cell: [Math.round(saved.gx), Math.round(saved.gy)] };
    }
    return current ? { floor: current.floor, cell: current.cell.slice() } : null;
  }

  function emitPositionSet(detail) {
    try {
      document.dispatchEvent(new CustomEvent('ai4t:position-set', { detail: detail }));
    } catch (err) { /* very old engines — ignore */ }
  }

  // Call an AI4TMap method if it exists; stay silent when the map is not ready.
  function mapCall(method, arg) {
    var m = window.AI4TMap;
    if (m && typeof m[method] === 'function') {
      try { return m[method](arg); } catch (err) { return undefined; }
    }
    return undefined;
  }

  function parseHashParams() {
    var out = {};
    var raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw || raw.indexOf('=') < 0) return out;
    raw.split('&').forEach(function (part) {
      var i = part.indexOf('=');
      if (i <= 0) return;
      var key = part.slice(0, i);
      var val = part.slice(i + 1);
      try { val = decodeURIComponent(val); } catch (err) { /* keep raw */ }
      out[key] = val;
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  var AI4TPos = {

    /** Current position {floor, cell:[gx,gy]} or null. */
    get: function () {
      return restore();
    },

    /**
     * Set position. pos = {floor, cell:[gx,gy]} (or {floor, gx, gy}).
     * Persists to localStorage, updates the map marker and emits
     * 'ai4t:position-set' with detail {floor, cell, source}.
     */
    set: function (pos, source) {
      if (!pos || pos.floor == null) return null;
      var cell = Array.isArray(pos.cell) ? pos.cell : [pos.gx, pos.gy];
      if (!Array.isArray(cell) || cell.length !== 2 ||
          !Number.isFinite(cell[0]) || !Number.isFinite(cell[1])) {
        return null;
      }
      var norm = { floor: String(pos.floor), cell: [Math.round(cell[0]), Math.round(cell[1])] };
      current = norm;
      persist(norm);
      mapCall('setPosition', { floor: norm.floor, cell: norm.cell });
      emitPositionSet({ floor: norm.floor, cell: norm.cell, source: source || 'manual' });
      return { floor: norm.floor, cell: norm.cell.slice() };
    },

    /** Drop the stored position everywhere. */
    clear: function () {
      current = null;
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
      mapCall('clearPosition', undefined);
    },

    /** "I'm at E112" — position at the room's walkable anchor. */
    fromRoom: function (roomId, source) {
      if (!roomId || !window.AI4TRoute || typeof window.AI4TRoute.anchorOf !== 'function') {
        return null;
      }
      var a = window.AI4TRoute.anchorOf(roomId);
      if (!a) return null;
      return AI4TPos.set({ floor: a.floor, cell: [a.gx, a.gy] }, source || 'room');
    },

    /** Named POI registry for QR links: [{id, label, room}]. */
    pois: function () {
      var list = NAMED_POIS.map(function (p) {
        return { id: p.id, label: p.label, room: p.room };
      });
      // All event rooms by room id (deduped across parallel events).
      var seen = {};
      eventsList().forEach(function (ev) {
        if (ev && ev.room && !seen[ev.room]) {
          seen[ev.room] = true;
          list.push({ id: ev.room, label: ev.room + ' — ' + (ev.title || ev.room), room: ev.room });
        }
      });
      return list;
    }
  };

  /* ------------------------------------------------------------------ */
  /* QR hash handling                                                    */
  /* ------------------------------------------------------------------ */

  // Resolve a #at= value to a room id: named POI → event id → room id.
  function resolveAtValue(value) {
    if (!value) return null;
    var id = String(value).trim();
    if (!id) return null;
    for (var i = 0; i < NAMED_POIS.length; i++) {
      if (NAMED_POIS[i].id === id) return NAMED_POIS[i].room;
    }
    var evs = eventsList();
    for (var j = 0; j < evs.length; j++) {
      if (evs[j] && evs[j].id === id && evs[j].room) return evs[j].room;
    }
    if (window.AI4TRoute && typeof window.AI4TRoute.anchorOf === 'function') {
      if (window.AI4TRoute.anchorOf(id)) return id;
      var upper = id.toUpperCase();
      if (upper !== id && window.AI4TRoute.anchorOf(upper)) return upper;
    }
    return null;
  }

  function routingSize() {
    var r = window.AI4T_DATA && window.AI4T_DATA.routing;
    return (r && Number.isFinite(r.w) && Number.isFinite(r.h)) ? r : null;
  }

  // Apply #at= / #pos= once everything (including the map) is initialised.
  // The hash is intentionally kept in the URL so a reload re-applies the
  // QR location ("maintain hash").
  function applyQrHash() {
    var params = parseHashParams();

    // Raw variant: #pos=<floor>,<gx>,<gy> (print stand posters).
    if (params.pos) {
      var parts = String(params.pos).split(',');
      if (parts.length === 3) {
        var floor = parseInt(parts[0], 10);
        var gx = parseInt(parts[1], 10);
        var gy = parseInt(parts[2], 10);
        var size = routingSize();
        var inBounds = size
          ? (gx >= 0 && gy >= 0 && gx < size.w && gy < size.h)
          : (gx >= 0 && gy >= 0);
        if (Number.isFinite(floor) && Number.isFinite(gx) && Number.isFinite(gy) && inBounds) {
          var cell = [gx, gy];
          // Snap to the nearest walkable cell if the encoded point is blocked.
          if (window.AI4TRoute &&
              typeof window.AI4TRoute.gridFor === 'function' &&
              typeof window.AI4TRoute.nearestWalkable === 'function' && size) {
            var grid = window.AI4TRoute.gridFor(String(floor));
            if (grid && grid[gy * size.w + gx] === 0) {
              var snap = window.AI4TRoute.nearestWalkable(String(floor), cell);
              if (snap) cell = snap;
            }
          }
          return !!AI4TPos.set({ floor: String(floor), cell: cell }, 'qr');
        }
      }
    }

    // Friendly variant: #at=<poiId|eventId|roomId>.
    if (params.at) {
      var room = resolveAtValue(params.at);
      if (room) return !!AI4TPos.fromRoom(room, 'qr');
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  // Keep external position updates (e.g. map tap-to-set) in sync with the
  // stored position. Never re-emits, so there is no event loop.
  document.addEventListener('ai4t:position-set', function (e) {
    var d = (e && e.detail) || {};
    if (d.floor == null || !Array.isArray(d.cell)) return;
    current = {
      floor: String(d.floor),
      cell: [Math.round(d.cell[0]), Math.round(d.cell[1])]
    };
    persist(current);
  });

  // Apply QR location hashes after the whole page (incl. AI4TMap.init from
  // app.js) is ready. The hash stays in the URL on purpose.
  if (document.readyState === 'complete') {
    applyQrHash();
  } else {
    window.addEventListener('load', applyQrHash, { once: true });
  }

  window.AI4TPos = AI4TPos;
})();
