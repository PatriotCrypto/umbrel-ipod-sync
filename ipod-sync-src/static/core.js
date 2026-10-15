/* Shared helpers. Everything the other scripts need lives on window.IP. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const formatBytes = (n) => {
    if (n < 1e6) return `${Math.max(0, Math.round(n / 1e3))} KB`;
    if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
    return `${(n / 1e9).toFixed(1)} GB`;
  };
  const formatTime = (ms) => {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const formatLength = (ms) => {
    const minutes = Math.round((ms || 0) / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.max(1, minutes)} min`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const hueOf = (s) => {
    let n = 7;
    for (const ch of String(s)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return n % 360;
  };

  const prefs = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`ipod.${key}`); return v === null ? fallback : v; }
      catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`ipod.${key}`, String(value)); } catch (_) { /* private mode */ }
    },
  };

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    let data = {};
    try { data = await response.json(); } catch (_) { /* empty body */ }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  // ---------- icons ----------
  const ICONS = {
    play: { d: 'M8 5v14l11-7z' },
    pause: { d: 'M6 5h4v14H6zM14 5h4v14h-4z' },
    prev: { d: 'M6 6h2v12H6zM9.5 12 18 6v12z' },
    next: { d: 'M16 6h2v12h-2zM6 18V6l8.5 6z' },
    stop: { d: 'M6 6h12v12H6z' },
    close: { d: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z' },
    note: { d: 'M10 3v10.6A3.5 3.5 0 1 0 12 17V7h6V3z' },
    volume: { d: 'M4 10v4h4l5 4V6l-5 4zM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12', mixed: true },
    shuffle: { d: 'M4 7h3.6l7 10H20M4 17h3.6l2.2-3.1M13.2 9.1 15 7h5M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5', stroke: true },
    repeat: { d: 'M5 11V9a3 3 0 0 1 3-3h10M15 3l3 3-3 3M19 13v2a3 3 0 0 1-3 3H6M9 21l-3-3 3-3', stroke: true },
    fullscreen: { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', stroke: true },
    chevL: { d: 'M15 5l-7 7 7 7', stroke: true },
    chevR: { d: 'M9 5l7 7-7 7', stroke: true },
    trash: { d: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', stroke: true },
    plus: { d: 'M12 5v14M5 12h14', stroke: true },
  };
  function icon(name) {
    const spec = ICONS[name];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', spec.d);
    if (spec.stroke || spec.mixed) {
      svg.setAttribute('fill', spec.mixed ? 'currentColor' : 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', spec.mixed ? '1.6' : '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
    return svg;
  }

  // Cover art with a coloured placeholder behind it.
  function art(title, coverId, hueSeed) {
    const wrap = h('div', { class: 'art' },
      h('div', { class: 'blank', 'aria-hidden': 'true', style: `--hue:${hueOf(hueSeed || title)}` }, '♪'));
    if (coverId) {
      wrap.append(h('img', {
        alt: '', loading: 'lazy', src: `/api/library/cover/${coverId}`,
        onerror: (e) => e.target.remove(),
      }));
    }
    return wrap;
  }

  // "Nano with camera (5th Gen.)" -> { title: "iPod nano", generation: "5th generation" }
  function deviceName(d) {
    const raw = d.generation || 'iPod';
    const m = /^(.*?)\s*\((\d+)(?:st|nd|rd|th) Gen\.\)$/.exec(raw);
    if (!m) return { title: /^ipod/i.test(raw) ? raw : `iPod ${raw}`, generation: '' };
    let name = m[1].replace(/\s+with camera/i, '');
    if (/^(nano|shuffle|mini|touch|classic)$/i.test(name)) name = name.toLowerCase();
    const n = Number(m[2]);
    const suffix = (n % 100 > 10 && n % 100 < 14) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return { title: `iPod ${name}`, generation: `${n}${suffix} generation` };
  }

  // The page scrolls inside the content pane, not the window.
  const scroller = () => document.querySelector('.stage');
  function nearEnd(el, margin = 600) {
    const pane = scroller();
    if (!el || !pane) return false;
    return el.getBoundingClientRect().top < pane.getBoundingClientRect().bottom + margin;
  }

  window.IP = {
    scroller, nearEnd, $, h, formatBytes, formatTime, formatLength, plural, capitalize, norm, hueOf, prefs, api, toast,
    icon, art, deviceName,
  };
})();
