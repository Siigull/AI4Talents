/*
 * app.js v2 — slim shell for AI4Talents@FIT VUT (minimal QR-entry app).
 *
 * Responsibilities (spec/APP-V2.md):
 *   - view tabs: program / muj / mapa ([data-view] buttons in the topbar;
 *     views are the #program / #muj / #mapa sections, switched instantly
 *     via display none/block — no scroll jumps)
 *   - hash routing: #program / #muj / #mapa (+ #room=, #event=, #floor=
 *     params; #at= / #pos= are handled by position.js)
 *   - glue:
 *       ai4t:open-room (timetable) → switch to the map view + select room
 *       ai4t:room-selected (map)   → keep #room= in the hash
 *       ai4t:pick-changed (timetable) → live count badge on the "Můj program" tab
 *       ai4t:position-set source=qr (position.js) → switch to the map view
 *   - the map lazy-inits when the map view is first shown (AI4TMap.init is
 *     an idempotent guarded call; map.js also self-inits into #map-root)
 *
 * UI copy is Czech; code comments are English. No external dependencies,
 * no console output.
 */
(function () {
  'use strict';

  var VIEWS = ['program', 'muj', 'mapa'];
  var SECTION = { program: '#program', muj: '#muj', mapa: '#mapa' };

  var state = {
    view: null,        // currently visible view id
    mapShown: false    // map view was opened at least once
  };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function reducedMotion() {
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function cssEsc(v) {
    return (window.CSS && typeof CSS.escape === 'function')
      ? CSS.escape(String(v))
      : String(v).replace(/"/g, '\\"');
  }

  /* ------------------------------------------------------------------ */
  /* Injected styles (app-owned UI only)                                 */
  /* ------------------------------------------------------------------ */

  function ensureStyles() {
    if (document.getElementById('ai4t-app-styles')) return;
    var style = document.createElement('style');
    style.id = 'ai4t-app-styles';
    style.textContent = [
      /* One-shot flash for the map room card after ai4t:open-room. */
      '@keyframes ai4t-flash-bg{0%,100%{box-shadow:0 0 0 0 rgba(23,97,204,0);}',
      ' 25%{box-shadow:0 0 0 7px rgba(23,97,204,0.5);}}',
      '.map-info-card.ai4t-flash{animation:ai4t-flash-bg .9s ease-in-out 3;}',
      /* Live count badge on the "Můj program" tab. */
      '.ai4t-view-badge{display:inline-block;min-width:18px;margin-left:6px;',
      ' padding:2px 5px;border-radius:9px;background:var(--blue,#1761cc);',
      ' color:#fff;font:700 11px/1 "IBM Plex Mono",ui-monospace,monospace;',
      ' text-align:center;vertical-align:1px;}',
      '.ai4t-view-badge[hidden]{display:none;}',
      '@media (prefers-reduced-motion:reduce){',
      ' .map-info-card.ai4t-flash{animation:none;',
      '  background-color:rgba(23,97,204,0.14);}}'
    ].join('');
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* Hash parameters (view token + k=v pairs in the URL fragment)        */
  /* ------------------------------------------------------------------ */

  // Supported shapes: '#mapa', '#muj', '#mapa&room=C228', '#room=C228'
  // (view token first, then &-joined params; #at=/#pos= belong to position.js).
  function hashParams() {
    var out = {};
    var raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw) return out;
    raw.split('&').forEach(function (part) {
      var i = part.indexOf('=');
      if (i <= 0) return; // view token (or junk) — not a param
      var key = part.slice(0, i);
      var val = part.slice(i + 1);
      try { val = decodeURIComponent(val); } catch (err) { /* keep raw */ }
      out[key] = val;
    });
    return out;
  }

  function hashView() {
    var raw = String(window.location.hash || '').replace(/^#/, '');
    var first = raw.split('&')[0] || '';
    return VIEWS.indexOf(first) >= 0 ? first : null;
  }

  // Rewrite the fragment: '#<view>&k=v…'. replaceState keeps the history
  // stack clean (view switches must not spam Back).
  function writeHash(params) {
    var p = hashParams();
    Object.keys(params || {}).forEach(function (key) {
      if (params[key] == null) delete p[key];
      else p[key] = params[key];
    });
    var view = state.view && VIEWS.indexOf(state.view) >= 0 ? state.view : 'program';
    var frag = '#' + view + Object.keys(p).map(function (k) {
      return '&' + k + '=' + encodeURIComponent(p[k]);
    }).join('');
    try { history.replaceState(null, '', frag); } catch (err) { /* file:// — ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* View switching                                                      */
  /* ------------------------------------------------------------------ */

  function tabButtons() { return $$('[data-view]'); }

  function syncTabs() {
    tabButtons().forEach(function (btn) {
      var on = btn.getAttribute('data-view') === state.view;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });
  }

  function showMap() {
    // Lazy map init: idempotent (map.js self-init may already have run —
    // init() into the same root is a guarded no-op).
    try {
      if (window.AI4TMap && typeof window.AI4TMap.init === 'function') {
        window.AI4TMap.init('#map-root');
      }
    } catch (err) { /* map failure — the view still switches */ }
    state.mapShown = true;
    // Re-measure label sizes + refresh live tints after becoming visible.
    try {
      if (window.AI4TMap && typeof window.AI4TMap.onShow === 'function') {
        window.AI4TMap.onShow();
      }
    } catch (err) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('ai4t:map-show'));
  }

  function view(name, opts) {
    opts = opts || {};
    if (VIEWS.indexOf(name) < 0) name = 'program';
    var changed = state.view !== name;
    state.view = name;
    VIEWS.forEach(function (v) {
      var el = $(SECTION[v]);
      if (!el) return;
      // sections are marked with the hidden attribute in index.html —
      // toggling only style.display would leave them hidden
      el.hidden = (v !== name);
      el.style.display = (v === name) ? '' : 'none';
    });
    syncTabs();
    if (name === 'mapa' && (changed || opts.forceMap || !state.mapShown)) showMap();
    if (changed && !opts.keepHash) writeHash({});
    return name;
  }

  /* ------------------------------------------------------------------ */
  /* Glue: timetable → map (ai4t:open-room)                              */
  /* ------------------------------------------------------------------ */

  function flashMapCard() {
    setTimeout(function () {
      var card = $('.map-info-card');
      if (!card || card.hidden) return;
      card.classList.remove('ai4t-flash');
      void card.offsetWidth; // restart the CSS animation
      card.classList.add('ai4t-flash');
      setTimeout(function () { card.classList.remove('ai4t-flash'); }, 3000);
    }, 90);
  }

  function openRoom(detail) {
    var roomId = detail && detail.roomId;
    if (!roomId) return;
    view('mapa');
    try {
      if (window.AI4TMap && typeof window.AI4TMap.selectRoom === 'function') {
        window.AI4TMap.selectRoom(roomId);
      }
    } catch (err) { /* map failure — continue with the rest */ }
    flashMapCard();
    writeHash({ room: roomId, event: (detail && detail.eventId) || null });
  }

  document.addEventListener('ai4t:open-room', function (e) {
    openRoom((e && e.detail) || {});
  });

  /* ------------------------------------------------------------------ */
  /* Glue: map events                                                    */
  /* ------------------------------------------------------------------ */

  document.addEventListener('ai4t:room-selected', function (e) {
    var d = (e && e.detail) || {};
    if (d.roomId) writeHash({ room: d.roomId });
  });

  document.addEventListener('ai4t:floor-changed', function (e) {
    var d = (e && e.detail) || {};
    if (d.floor != null) writeHash({ floor: String(d.floor) });
  });

  // QR position links (#at= / #pos= handled by position.js) show the map.
  document.addEventListener('ai4t:position-set', function (e) {
    var d = (e && e.detail) || {};
    if (d.source === 'qr') view('mapa');
  });

  /* ------------------------------------------------------------------ */
  /* Glue: picker badge (Můj program tab)                                 */
  /* ------------------------------------------------------------------ */

  function pickIds(detail) {
    if (detail) {
      var arr = detail.ids || detail.picked || detail.picks || detail.value;
      if (Array.isArray(arr)) return arr;
    }
    try {
      var raw = JSON.parse(window.localStorage.getItem('ai4t-my') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (err) { return []; }
  }

  function updatePickBadge(ids) {
    var tab = $('[data-view="muj"]');
    if (!tab) return;
    var badge = tab.querySelector('.ai4t-view-badge') ||
                tab.querySelector('.tab-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ai4t-view-badge';
      tab.appendChild(badge);
    }
    var n = ids.length;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = n === 0;
  }

  document.addEventListener('ai4t:pick-changed', function (e) {
    updatePickBadge(pickIds(e && e.detail));
  });

  /* ------------------------------------------------------------------ */
  /* Hash deep links                                                     */
  /* ------------------------------------------------------------------ */

  function parseHashes() {
    var p = hashParams();
    var v = hashView();

    if (p.floor != null && window.AI4TMap &&
        typeof window.AI4TMap.setFloor === 'function') {
      try { window.AI4TMap.setFloor(String(parseInt(p.floor, 10))); } catch (err) { /* ignore */ }
    }

    if (p.room) {
      openRoom({ roomId: p.room });
      return;
    }
    if (p.event) {
      var evs = (window.AI4T_DATA && AI4T_DATA.events &&
                 Array.isArray(AI4T_DATA.events.events)) ? AI4T_DATA.events.events : [];
      for (var i = 0; i < evs.length; i++) {
        if (evs[i] && evs[i].id === p.event && evs[i].room) {
          openRoom({ roomId: evs[i].room, eventId: evs[i].id });
          return;
        }
      }
    }

    // Default view: hash view token; a QR location link implies the map.
    view(v || ((p.at != null || p.pos != null) ? 'mapa' : 'program'), { keepHash: true });
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  function wireTabs() {
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      var btn = e.target.closest('button[data-view]'); // sections carry data-view too — tabs only!
      if (!btn) return;
      var name = btn.getAttribute('data-view');
      if (VIEWS.indexOf(name) < 0) return;
      e.preventDefault();
      view(name);
    });
  }

  function init() {
    ensureStyles();
    wireTabs();
    window.addEventListener('hashchange', parseHashes);
    parseHashes();
    updatePickBadge(pickIds());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
