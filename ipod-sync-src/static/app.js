(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);

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
    const s = Math.round((ms || 0) / 1000);
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
      try { const v = localStorage.getItem(`ipodsync.${key}`); return v === null ? fallback : v; }
      catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`ipodsync.${key}`, String(value)); } catch (_) { /* private mode */ }
    },
  };

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

  // The iPod nano 5G came in nine colours; the UI borrows the one that is plugged in.
  const DEVICE_COLORS = {
    silver: '#aeb4bd', black: '#34373d', purple: '#8a5cc2', blue: '#2f86e0', green: '#3fa356',
    yellow: '#e8b923', orange: '#f0801c', red: '#d6363b', pink: '#e86aa0',
  };
  // Silver, black and yellow make poor button colours, so those keep the default blue.
  const WEAK_ACTION = new Set(['silver', 'black', 'yellow']);
  const DARK_TEXT = new Set(['silver', 'yellow']);

  function applyDeviceColor(color) {
    const root = document.documentElement.style;
    const device = DEVICE_COLORS[color];
    if (device) root.setProperty('--device', device); else root.removeProperty('--device');
    if (device && !WEAK_ACTION.has(color)) root.setProperty('--action', device);
    else root.removeProperty('--action');
    if (device && DARK_TEXT.has(color)) root.setProperty('--on-device', '#1c2b3d');
    else root.removeProperty('--on-device');
  }

  // ---------- state ----------
  const state = {
    tab: 'library', q: '', letter: '',
    view: prefs.get('view', 'new') === 'all' ? 'all' : 'new',
    sort: ['artist', 'album', 'year', 'recent', 'size'].includes(prefs.get('sort', 'artist')) ? prefs.get('sort', 'artist') : 'artist',
    tile: ['1', '2', '3'].includes(prefs.get('tile', '2')) ? prefs.get('tile', '2') : '2',
    albums: [], albumTotal: 0, counts: { all: 0, new: 0, on: 0 }, letters: [],
    loadingAlbums: false, albumSeq: 0,
    ipodTracks: [], ipodAlbums: [], ipodTotal: 0, ipodSeq: 0, revision: '',
    sheet: null,
    selAlbums: new Set(), selTracks: new Set(), selRemove: new Set(),
    info: new Map(),          // album id -> { album, artist } for the selection tray
    trackAlbum: new Map(),    // library track id -> album id, learned when an album is opened
    status: null, plan: null, planError: '', planSeq: 0,
    job: null, finishedJob: null,
    mounting: false, mountError: '',
    settings: null,
  };

  const ipodState = () => (state.status && state.status.ipod) || { state: 'unknown' };
  const device = () => ipodState().device;
  const selectionCount = () => state.selAlbums.size + state.selTracks.size + state.selRemove.size;
  // Without an iPod there is nothing to split into "to add" and "already there".
  const effectiveView = () => (device() ? state.view : 'all');

  function clearSelection() {
    state.selAlbums.clear(); state.selTracks.clear(); state.selRemove.clear();
  }

  // ---------- data loading ----------
  function albumsUrl(extra) {
    const params = new URLSearchParams({
      q: state.q, sort: state.sort, status: effectiveView(), letter: state.letter, ...extra,
    });
    return `/api/library/albums?${params}`;
  }

  function remember(albums) {
    albums.forEach((a) => state.info.set(a.id, { album: a.album, artist: a.artist }));
  }

  async function loadAlbums(reset) {
    if (!reset && state.loadingAlbums) return;
    const seq = reset ? ++state.albumSeq : state.albumSeq;
    state.loadingAlbums = true;
    try {
      const offset = reset ? 0 : state.albums.length;
      const data = await api(albumsUrl({ limit: 120, offset }));
      if (seq !== state.albumSeq) return;
      state.albums = reset ? data.albums : state.albums.concat(data.albums);
      state.albumTotal = data.total;
      state.counts = data.counts;
      state.letters = data.letters;
      remember(data.albums);
    } catch (err) {
      if (seq === state.albumSeq) toast(err.message);
    } finally {
      if (seq === state.albumSeq) state.loadingAlbums = false;
    }
    if (seq === state.albumSeq) { renderToolbar(); renderList(); }
  }

  function groupIpod(tracks) {
    const groups = new Map();
    for (const t of tracks) {
      const artist = t.albumartist || t.artist || 'Unknown artist';
      const album = t.album || 'Unknown album';
      const key = `${norm(artist)}|${norm(album)}`;
      let g = groups.get(key);
      if (!g) {
        g = { id: `ip:${key}`, artist, album, year: t.year || null, tracks: [], size: 0, duration_ms: 0, cover: '' };
        groups.set(key, g);
      }
      g.tracks.push(t);
      g.size += t.size || 0;
      g.duration_ms += t.duration_ms || 0;
      if (!g.cover && t.album_key) g.cover = t.album_key;
    }
    return [...groups.values()].sort((a, b) =>
      norm(a.artist).localeCompare(norm(b.artist)) || norm(a.album).localeCompare(norm(b.album)));
  }

  async function loadIpodTracks() {
    const seq = ++state.ipodSeq;
    let tracks = [], total = 0, revision = '';
    try {
      for (let offset = 0; offset < 20000; offset += 500) {
        const data = await api(`/api/ipod/tracks?q=${encodeURIComponent(state.q)}&limit=500&offset=${offset}` +
                               (offset === 0 ? '&refresh=1' : ''));
        tracks = tracks.concat(data.tracks);
        total = data.total; revision = data.revision;
        if (!data.tracks.length || tracks.length >= total) break;
      }
    } catch (err) { tracks = []; total = 0; }
    if (seq !== state.ipodSeq) return;
    state.ipodTracks = tracks; state.ipodTotal = total; state.ipodAlbums = groupIpod(tracks);
    if (revision) state.revision = revision;
    renderToolbar(); renderList(); renderSheet();
  }

  function reloadList() {
    if (state.tab === 'library') loadAlbums(true); else loadIpodTracks();
  }

  // ---------- plan ----------
  let planTimer = null;
  function planBody() {
    return {
      albums: [...state.selAlbums], tracks: [...state.selTracks],
      remove: [...state.selRemove], revision: state.revision,
    };
  }

  function schedulePlan() {
    clearTimeout(planTimer);
    state.plan = null; state.planError = '';
    state.finishedJob = null;
    renderPod();
    if (!selectionCount()) return;
    planTimer = setTimeout(async () => {
      const seq = ++state.planSeq;
      try {
        const plan = await api('/api/sync/plan', { method: 'POST', body: planBody() });
        if (seq === state.planSeq) { state.plan = plan; state.planError = ''; }
      } catch (err) {
        if (seq === state.planSeq) { state.plan = null; state.planError = err.message; }
      }
      renderPod();
    }, 350);
  }

  async function startSync() {
    const plan = state.plan;
    if (plan && plan.counts.remove) {
      const ok = confirm(`Remove ${plural(plan.counts.remove, 'song')} from the iPod? ` +
                         'The files on your Umbrel are not touched.');
      if (!ok) return;
    }
    try {
      const data = await api('/api/sync/start', { method: 'POST', body: planBody() });
      state.job = data.job; state.finishedJob = null;
      closeSheet();
      renderPod(); renderLcd();
      pollJob();
    } catch (err) { toast(err.message); }
  }

  async function pollJob() {
    try {
      const data = await api('/api/sync/job');
      state.job = data.job;
    } catch (_) { /* keep trying */ }
    if (state.job && state.job.state === 'running') {
      renderPod(); renderLcd();
      setTimeout(pollJob, 1000);
      return;
    }
    if (state.job) {
      state.finishedJob = state.job;
      clearSelection();
      state.plan = null;
      state.job = null;
      closeSheet();
      await refreshStatus();
      reloadList();
    }
    renderPod(); renderLcd();
  }

  // ---------- status polling ----------
  let lastRevision = null;
  let lastScanError = '';
  async function refreshStatus() {
    try {
      state.status = await api('/api/status');
    } catch (err) {
      return;
    }
    const pod = ipodState();
    applyDeviceColor(pod.device && pod.device.color);
    if (state.status.job && state.status.job.state === 'running' && !state.job) {
      state.job = state.status.job;
      pollJob();
    }
    if (pod.state === 'needs_mount' && !state.mounting && !state.mountError) mountIpod();
    if (pod.state !== 'needs_mount') state.mountError = '';
    const revision = pod.device ? pod.device.revision : pod.state;
    if (revision !== lastRevision) {
      lastRevision = revision;
      state.revision = pod.device ? pod.device.revision : '';
      reloadList();
    }
    renderTop();
    renderToolbar();
    renderPod();
  }

  async function mountIpod() {
    state.mounting = true; state.mountError = ''; renderPod();
    try {
      await api('/api/ipod/mount', { method: 'POST' });
    } catch (err) { state.mountError = err.message; }
    state.mounting = false;
    await refreshStatus();
  }

  async function ejectIpod() {
    try {
      await api('/api/ipod/eject', { method: 'POST' });
      clearSelection();
      state.plan = null;
      closeSheet();
      toast('The iPod is safe to unplug.');
    } catch (err) { toast(err.message); }
    await refreshStatus();
  }

  // ---------- selection ----------
  function dropLooseTracks(albumId) {
    for (const [trackId, owner] of state.trackAlbum) {
      if (owner === albumId) state.selTracks.delete(trackId);
    }
  }

  function toggleAlbum(album, on) {
    if (on) { state.selAlbums.add(album.id); dropLooseTracks(album.id); }
    else { state.selAlbums.delete(album.id); dropLooseTracks(album.id); }
    schedulePlan(); renderList(); renderSheet();
  }

  function toggleTrack(album, track, on) {
    const tracks = state.sheet ? state.sheet.tracks : [];
    if (on) {
      state.selTracks.add(track.id);
      if (tracks.every((t) => t.on_ipod || state.selTracks.has(t.id))) {
        tracks.forEach((t) => state.selTracks.delete(t.id));
        state.selAlbums.add(album.id);
      }
    } else if (state.selAlbums.has(album.id)) {
      state.selAlbums.delete(album.id);
      tracks.filter((t) => t.id !== track.id && !t.on_ipod).forEach((t) => state.selTracks.add(t.id));
    } else {
      state.selTracks.delete(track.id);
    }
    schedulePlan(); renderList(); renderSheet();
  }

  // iPod side: an album is "selected" when all of its songs are marked for removal.
  const removeState = (album) => {
    const n = album.tracks.filter((t) => state.selRemove.has(t.id)).length;
    return n === 0 ? 'none' : n === album.tracks.length ? 'all' : 'some';
  };

  function toggleIpodAlbum(album, on) {
    album.tracks.forEach((t) => { if (on) state.selRemove.add(t.id); else state.selRemove.delete(t.id); });
    schedulePlan(); renderList(); renderSheet();
  }

  function toggleIpodTrack(track, on) {
    if (on) state.selRemove.add(track.id); else state.selRemove.delete(track.id);
    schedulePlan(); renderList(); renderSheet();
  }

  async function fetchAlbums(extra) {
    const all = [];
    for (let offset = 0; offset < 100000; offset += 200) {
      const data = await api(albumsUrl({ limit: 200, offset, ...extra }));
      all.push(...data.albums);
      if (all.length >= data.total || !data.albums.length) break;
    }
    remember(all);
    return all;
  }

  async function selectAll() {
    if (selectionCount()) {
      clearSelection();
      schedulePlan(); renderList(); renderSheet(); return;
    }
    try {
      if (state.tab === 'library') {
        (await fetchAlbums({ status: 'new' })).forEach((a) => state.selAlbums.add(a.id));
      } else {
        state.ipodTracks.forEach((t) => state.selRemove.add(t.id));
      }
    } catch (err) { toast(err.message); }
    schedulePlan(); renderList();
  }

  async function selectArtist(artist, on) {
    try {
      if (state.tab === 'library') {
        const params = new URLSearchParams({ artist, status: 'new', limit: 200, sort: 'artist' });
        const data = await api(`/api/library/albums?${params}`);
        remember(data.albums);
        data.albums.forEach((a) => { if (on) state.selAlbums.add(a.id); else state.selAlbums.delete(a.id); dropLooseTracks(a.id); });
      } else {
        state.ipodAlbums.filter((a) => norm(a.artist) === norm(artist)).forEach((a) => {
          a.tracks.forEach((t) => { if (on) state.selRemove.add(t.id); else state.selRemove.delete(t.id); });
        });
      }
    } catch (err) { toast(err.message); }
    schedulePlan(); renderList();
  }

  async function surprise(choice) {
    const d = device();
    if (!d || !ipodState().can_sync) { toast('Connect an iPod first.'); return; }
    const planned = state.plan ? Math.max(0, state.plan.bytes.net) : 0;
    const ceiling = d.free_bytes * 0.92 - planned;
    const budget = choice === 'fill' ? ceiling : Math.min(Number(choice) * 1e9, ceiling);
    if (budget <= 0) { toast('The iPod is already full with this selection.'); return; }
    try {
      const pool = (await fetchAlbums({ status: 'new', q: '', letter: '', sort: 'artist' }))
        .filter((a) => !state.selAlbums.has(a.id));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      let used = 0, picked = 0;
      for (const a of pool) {
        const remaining = a.tracks - a.on_ipod;
        const size = a.on_ipod ? a.size * (remaining / a.tracks) : a.size;
        if (used + size > budget) continue;
        used += size; picked += 1;
        state.selAlbums.add(a.id);
      }
      toast(picked ? `Picked ${plural(picked, 'album')}, about ${formatBytes(used)}. Review them, then sync.`
                   : 'Nothing small enough was left to pick.');
    } catch (err) { toast(err.message); }
    schedulePlan(); renderList();
  }

  // ---------- rendering: title bar ----------
  function renderTop() {
    const lib = state.status && state.status.library;
    if (!lib) return;
    const scan = lib.scan;
    $('#btn-rescan').disabled = scan.running;
    $('#lib-count').textContent = lib.tracks ? `${plural(lib.albums, 'album')} · ${plural(lib.tracks, 'song')}` : '';
    $('#ipod-count').textContent = device() ? plural(device().tracks, 'song') : '';
    if (scan.error && scan.error !== lastScanError) toast(`Scan problem: ${scan.error}`);
    lastScanError = scan.error || '';
    renderLcd();
  }

  function renderLcd() {
    const main = $('#lcd-main'), sub = $('#lcd-sub'), bar = $('#lcd-bar');
    const lib = state.status && state.status.library;
    const st = ipodState();
    let percent = null;
    if (state.job) {
      const job = state.job;
      main.textContent = `${capitalize(job.phase || 'working')}…  ${job.done} of ${job.total}`;
      sub.textContent = job.current || 'Please keep the iPod connected';
      percent = job.total ? (job.done / job.total) * 100 : 0;
    } else if (lib && lib.scan.running) {
      main.textContent = 'Looking through your music…';
      sub.textContent = `${lib.scan.scanned} of ${lib.scan.total} files checked`;
      percent = lib.scan.total ? (lib.scan.scanned / lib.scan.total) * 100 : 0;
    } else if (st.state === 'ready' && st.device) {
      main.textContent = `${deviceName(st.device).title} is ready`;
      sub.textContent = `${plural(st.device.tracks, 'song')} on the iPod · ${lib ? `${plural(lib.albums, 'album')}, ${plural(lib.tracks, 'song')}` : '…'} in your library`;
    } else if (st.state === 'needs_mount') {
      main.textContent = 'iPod found'; sub.textContent = state.mountError ? 'Could not open it' : 'Opening it…';
    } else if (st.state === 'error') {
      main.textContent = 'iPod problem'; sub.textContent = 'See the panel on the right';
    } else if (st.state === 'disconnected') {
      main.textContent = 'No iPod connected';
      sub.textContent = lib && lib.tracks ? `${plural(lib.albums, 'album')}, ${plural(lib.tracks, 'song')} in your library` : 'Plug it into a USB port on your Umbrel';
    } else {
      main.textContent = 'Starting…'; sub.textContent = '';
    }
    bar.hidden = percent === null;
    if (percent !== null) bar.firstElementChild.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  // ---------- rendering: toolbar ----------
  const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

  function renderToolbar() {
    const library = state.tab === 'library';
    const hasDevice = Boolean(device());
    $('#tab-library').setAttribute('aria-selected', String(library));
    $('#tab-ipod').setAttribute('aria-selected', String(!library));

    $('#filter').hidden = !(library && hasDevice);
    const view = effectiveView();
    $('#filter-new').setAttribute('aria-pressed', String(view === 'new'));
    $('#filter-all').setAttribute('aria-pressed', String(view === 'all'));
    $('#filter-new .count').textContent = state.counts.new;
    $('#filter-all .count').textContent = state.counts.all;

    $('#sort-wrap').hidden = !library;
    $('#sort').value = state.sort;
    $('#surprise-wrap').hidden = !(library && hasDevice && ipodState().can_sync);
    $('#tile-size').value = state.tile;
    document.body.dataset.tile = state.tile;

    const btn = $('#btn-select-all');
    btn.textContent = selectionCount() ? 'Clear selection' : (library ? 'Select all' : 'Select all to remove');
    btn.disabled = !hasDevice || !ipodState().can_sync;

    const nav = $('#letters');
    const lettersOn = library && (state.sort === 'artist' || state.sort === 'album') &&
      (state.letters.length > 1 || state.letter);
    nav.hidden = !lettersOn;
    nav.replaceChildren();
    if (lettersOn) {
      LETTERS.forEach((letter) => nav.append(h('button', {
        type: 'button', 'aria-pressed': String(state.letter === letter),
        disabled: !state.letters.includes(letter) && state.letter !== letter,
        onclick: () => { state.letter = state.letter === letter ? '' : letter; loadAlbums(true); },
      }, letter)));
    }
  }

  // ---------- rendering: tiles ----------
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

  function libraryTile(album) {
    const full = album.on_ipod >= album.tracks;
    const partial = album.on_ipod > 0 && !full;
    const selected = state.selAlbums.has(album.id);
    const canPick = Boolean(device()) && ipodState().can_sync && !full;
    const cover = art(album.album, album.id, album.id);
    if (full) cover.append(h('span', { class: 'badge' }, 'On iPod'));
    else if (partial) {
      cover.append(h('span', { class: 'badge part', title: `${album.on_ipod} of ${album.tracks} songs are already on the iPod` },
        `${album.on_ipod}/${album.tracks} on iPod`));
    }
    return h('article', { class: 'tile' + (selected ? ' is-selected' : '') + (full ? ' is-done' : ''), 'data-id': album.id },
      h('label', { class: 'pick', title: full ? 'Already on the iPod' : 'Add to the sync' },
        h('input', {
          type: 'checkbox', checked: selected || full, disabled: !canPick,
          'aria-label': `Select ${album.album}`,
          onchange: (e) => toggleAlbum(album, e.target.checked),
        })),
      h('button', {
        class: 'open', type: 'button', 'aria-label': `Open ${album.album} by ${album.artist}`,
        onclick: () => openSheet('library', album),
      },
      cover,
      h('div', { class: 'meta' },
        h('div', { class: 't', title: album.album }, album.album),
        h('div', { class: 's' }, [album.artist, album.year].filter(Boolean).join(' · ')),
        h('div', { class: 'x' }, `${plural(album.tracks, 'song')} · ${formatBytes(album.size)}`))),
      playFab('library', album));
  }

  function ipodTile(album) {
    const mark = removeState(album);
    return h('article', { class: 'tile' + (mark !== 'none' ? ' is-selected removing' : ''), 'data-id': album.id },
      h('label', { class: 'pick', title: 'Mark for removal from the iPod' },
        h('input', {
          type: 'checkbox', checked: mark === 'all', indeterminate: mark === 'some',
          'aria-label': `Remove ${album.album} from the iPod`,
          onchange: (e) => toggleIpodAlbum(album, e.target.checked),
        })),
      h('button', {
        class: 'open', type: 'button', 'aria-label': `Open ${album.album} by ${album.artist}`,
        onclick: () => openSheet('ipod', album),
      },
      art(album.album, album.cover, album.id),
      h('div', { class: 'meta' },
        h('div', { class: 't', title: album.album }, album.album),
        h('div', { class: 's' }, [album.artist, album.year].filter(Boolean).join(' · ')),
        h('div', { class: 'x' }, `${plural(album.tracks.length, 'song')} · ${formatBytes(album.size)}`))),
      playFab('ipod', album));
  }

  // Tiles under artist headings (or one flat grid when the sort order is not by artist).
  function renderTiles(container, albums, makeTile, grouped, groupAction) {
    if (!grouped) {
      container.append(h('div', { class: 'grid' }, albums.map(makeTile)));
      return;
    }
    let group = null, grid = null;
    const flush = () => {
      if (!group) return;
      const action = groupAction(group);
      container.append(
        h('div', { class: 'group-head' },
          h('h3', { title: group.artist }, group.artist),
          h('span', { class: 'muted' }, plural(group.albums.length, 'album')),
          action ? h('button', { class: 'btn small', type: 'button', onclick: action.run }, action.label) : null),
        grid);
    };
    for (const album of albums) {
      if (!group || norm(group.artist) !== norm(album.artist)) {
        flush();
        group = { artist: album.artist, albums: [] };
        grid = h('div', { class: 'grid' });
      }
      group.albums.push(album);
      grid.append(makeTile(album));
    }
    flush();
  }

  function renderList() {
    const list = $('#list');
    const more = $('#more');
    list.replaceChildren();
    more.replaceChildren();
    const hasDevice = Boolean(device());

    if (state.tab === 'library') {
      const lib = state.status && state.status.library;
      if (!state.albums.length) {
        if (lib && lib.scan.running) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'Looking through your music…'),
            `${lib.scan.scanned} of ${lib.scan.total} files checked.`));
        } else if (state.q) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'No matches'),
            'Try a different artist, album or song name.'));
        } else if (effectiveView() === 'new' && state.counts.all > 0) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'Everything is already on your iPod'),
            'Nothing left to add. Switch to “All” to browse your whole library, or open the “On iPod” tab.'));
        } else if (lib && !lib.music_dir_exists) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'The music folder is not available'),
            'Check that this app has access to your Umbrel’s Downloads folder.'));
        } else if (lib) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'No music found yet'),
            'Add songs anywhere in your Umbrel’s Downloads folder, then choose Rescan library.'));
        }
      }
      renderTiles(list, state.albums, libraryTile, state.sort === 'artist', (group) => {
        if (!hasDevice || !ipodState().can_sync) return null;
        const open = group.albums.filter((a) => a.on_ipod < a.tracks);
        if (!open.length) return null;
        const allOn = open.every((a) => state.selAlbums.has(a.id));
        return { label: allOn ? 'Clear' : 'Select all', run: () => selectArtist(group.artist, !allOn) };
      });
      if (state.albums.length < state.albumTotal) {
        more.append(h('button', { class: 'btn', type: 'button', onclick: () => loadAlbums(false) },
          `Show more (${state.albumTotal - state.albums.length} left)`));
      }
    } else {
      if (!hasDevice) {
        list.append(h('div', { class: 'empty' }, h('strong', {}, 'No iPod connected'),
          'Songs on the iPod appear here once it is plugged in.'));
      } else if (!state.ipodAlbums.length) {
        list.append(h('div', { class: 'empty' }, h('strong', {}, state.q ? 'No matches' : 'No songs on this iPod'),
          state.q ? 'Try a different search.' : 'Choose albums from the Library tab to add some.'));
      }
      renderTiles(list, state.ipodAlbums, ipodTile, true, (group) => {
        if (!ipodState().can_sync) return null;
        const tracks = group.albums.flatMap((a) => a.tracks);
        const allOn = tracks.every((t) => state.selRemove.has(t.id));
        return { label: allOn ? 'Keep all' : 'Remove all', run: () => selectArtist(group.artist, !allOn) };
      });
    }
    renderToolbar();
    setTimeout(maybeLoadMore, 0);
  }

  function maybeLoadMore() {
    if (state.tab !== 'library' || state.loadingAlbums || state.albums.length >= state.albumTotal) return;
    if ($('#more').getBoundingClientRect().top < window.innerHeight + 600) loadAlbums(false);
  }

  // ---------- rendering: album sheet ----------
  function closeSheet() {
    const dlg = $('#sheet');
    if (dlg.open) dlg.close();
    state.sheet = null;
  }

  async function openSheet(kind, album) {
    try {
      let tracks;
      if (kind === 'library') {
        tracks = (await api(`/api/library/albums/${album.id}/tracks`)).tracks;
        tracks.forEach((t) => state.trackAlbum.set(t.id, album.id));
      } else {
        tracks = album.tracks;
      }
      state.sheet = { kind, album, tracks };
      renderSheet();
      const dlg = $('#sheet');
      if (!dlg.open) dlg.showModal();
    } catch (err) { toast(err.message); }
  }

  function renderSheet() {
    if (!state.sheet) return;
    const { kind, album, tracks } = state.sheet;
    const body = $('#sheet-body');
    const canEdit = Boolean(device()) && ipodState().can_sync;
    const duration = kind === 'library' ? album.duration_ms : album.duration_ms;
    const size = album.size;
    const count = kind === 'library' ? album.tracks : album.tracks.length;
    let action, status = null;

    if (kind === 'library') {
      const full = album.on_ipod >= album.tracks;
      const selected = state.selAlbums.has(album.id);
      if (full) status = 'All of this album is on the iPod.';
      else if (album.on_ipod) status = `${album.on_ipod} of ${album.tracks} songs are already on the iPod.`;
      action = h('button', {
        class: 'btn ' + (selected ? '' : 'primary'), type: 'button', disabled: full || !canEdit,
        onclick: () => toggleAlbum(album, !selected),
      }, selected ? 'Remove from sync' : album.on_ipod ? 'Add the rest' : 'Add album to sync');
    } else {
      const mark = removeState(album);
      action = h('button', {
        class: 'btn ' + (mark === 'all' ? '' : 'danger'), type: 'button', disabled: !canEdit,
        onclick: () => toggleIpodAlbum(album, mark !== 'all'),
      }, mark === 'all' ? 'Keep this album' : 'Remove album from iPod');
    }

    const playNum = (k, t) => h('button', {
      class: 'pnum' + (isCurrent(k, t.id) ? ' now' : ''), type: 'button', title: `Play ${t.title}`,
      'aria-label': `Play ${t.title}`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); queueFromSheet(t.id); },
    }, h('span', { class: 'n' }, t.track || ''), icon('play'));

    const rows = tracks.map((t) => {
      if (kind === 'library') {
        const albumSelected = state.selAlbums.has(album.id);
        return h('label', { class: 'track' },
          h('input', {
            type: 'checkbox', disabled: t.on_ipod || !canEdit,
            checked: t.on_ipod || albumSelected || state.selTracks.has(t.id),
            onchange: (e) => toggleTrack(album, t, e.target.checked),
          }),
          playNum(kind, t),
          h('span', { class: 'name', title: t.title }, t.title),
          t.on_ipod ? h('span', { class: 'tag' }, 'On iPod') : h('span', {}),
          h('span', { class: 'time' }, formatTime(t.duration_ms)));
      }
      return h('label', { class: 'track' },
        h('input', {
          type: 'checkbox', disabled: !canEdit, checked: state.selRemove.has(t.id),
          'aria-label': `Remove ${t.title}`,
          onchange: (e) => toggleIpodTrack(t, e.target.checked),
        }),
        playNum(kind, t),
        h('span', { class: 'name', title: t.title }, t.title),
        h('span', { class: 'time' }, formatBytes(t.size)),
        h('span', { class: 'time' }, formatTime(t.duration_ms)));
    });

    const oldList = body.querySelector('.sheet-tracks');
    const keepScroll = oldList ? oldList.scrollTop : 0;
    body.replaceChildren(
      h('div', { class: 'sheet-top' },
        h('div', { class: 'sheet-art' }, art(album.album, kind === 'library' ? album.id : album.cover, album.id)),
        h('div', { class: 'sheet-info' },
          h('h2', { id: 'sheet-title' }, album.album),
          h('div', { class: 'artist' }, album.artist),
          h('div', { class: 'facts' }, [album.year, plural(count, 'song'), formatBytes(size), formatLength(duration)]
            .filter(Boolean).join(' · ')),
          status ? h('div', { class: 'facts' }, status) : null,
          h('div', { class: 'plan-buttons' },
            h('button', { class: 'btn', type: 'button', onclick: () => queueFromSheet() }, '▶ Play album'),
            action)),
        h('button', { class: 'btn small sheet-close', type: 'button', onclick: closeSheet }, 'Close')),
      h('div', { class: 'sheet-tracks' }, rows),
      current() ? h('div', { class: 'sheet-player' },
        h('div', { class: 'pl-title' }, `Now playing: ${current().title}`), transport()) : h('span'));
    const list = body.querySelector('.sheet-tracks');
    if (list) list.scrollTop = keepScroll;
    syncPlayState(); syncProgress();
  }


  // ---------- player ----------
  const audioEl = new Audio();
  audioEl.preload = 'metadata';
  audioEl.volume = Math.min(1, Math.max(0, Number(prefs.get('volume', 1))));
  const player = { queue: [], index: -1, dragging: false };
  const ICONS = {
    play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    prev: 'M6 6h2v12H6zM9.5 12 18 6v12z', next: 'M16 6h2v12h-2zM6 18V6l8.5 6z',
    close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  const current = () => player.queue[player.index] || null;
  const isCurrent = (kind, id) => { const t = current(); return Boolean(t) && t.kind === kind && t.id === id; };
  const audioUrl = (t) => (t.kind === 'ipod' ? `/api/ipod/tracks/${t.id}/audio` : `/api/library/tracks/${t.id}/audio`);

  function playQueue(items, index) {
    if (!items.length) return;
    player.queue = items;
    playIndex(index || 0);
  }

  function playIndex(i) {
    if (i < 0 || i >= player.queue.length) { stopPlayer(); return; }
    player.index = i;
    const t = current();
    audioEl.src = audioUrl(t);
    audioEl.play().catch((err) => {
      if (err && err.name !== 'AbortError') toast('This song could not be played.');
    });
    renderPlayer();
    updateMediaSession(t);
    renderSheet();
  }

  function stopPlayer() {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    player.queue = []; player.index = -1;
    renderPlayer();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    renderSheet();
  }

  const nextTrack = () => { if (player.index < player.queue.length - 1) playIndex(player.index + 1); else stopPlayer(); };
  function prevTrack() {
    if (audioEl.currentTime > 3 || player.index === 0) { audioEl.currentTime = 0; return; }
    playIndex(player.index - 1);
  }
  function togglePlay() {
    if (!current()) return;
    if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.cover ? [{ src: new URL(`/api/library/cover/${t.cover}`, location.href).href, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
    const actions = { play: togglePlay, pause: togglePlay, previoustrack: prevTrack, nexttrack: nextTrack };
    for (const [name, fn] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch (_) { /* unsupported */ }
    }
  }

  // One set of transport controls; the bar and the album sheet each get a copy.
  function transport() {
    return h('div', { class: 'transport' },
      h('button', { class: 'pl-btn', type: 'button', 'aria-label': 'Previous song', onclick: prevTrack }, icon('prev')),
      h('button', { class: 'pl-btn pl-play', type: 'button', 'aria-label': 'Play or pause', onclick: togglePlay }, icon('play')),
      h('button', { class: 'pl-btn', type: 'button', 'aria-label': 'Next song', onclick: nextTrack }, icon('next')),
      h('span', { class: 'pl-cur' }, '0:00'),
      h('input', {
        class: 'pl-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position',
        oninput: (e) => { player.dragging = true; showTimes(Number(e.target.value) / 1000 * trackSeconds()); },
        onchange: (e) => {
          const secs = trackSeconds();
          if (secs) audioEl.currentTime = Number(e.target.value) / 1000 * secs;
          player.dragging = false; syncProgress();
        },
      }),
      h('span', { class: 'pl-dur' }, '0:00'));
  }

  function trackSeconds() {
    const t = current();
    if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) return audioEl.duration;
    return t ? (t.duration_ms || 0) / 1000 : 0;
  }
  function showTimes(pos) {
    document.querySelectorAll('.pl-cur').forEach((el) => { el.textContent = formatTime(pos * 1000); });
    document.querySelectorAll('.pl-dur').forEach((el) => { el.textContent = formatTime(trackSeconds() * 1000); });
  }
  function syncProgress() {
    if (!current()) return;
    const secs = trackSeconds(), pos = audioEl.currentTime || 0;
    if (!player.dragging) {
      document.querySelectorAll('.pl-seek').forEach((el) => { el.value = secs ? Math.round(pos / secs * 1000) : 0; });
      showTimes(pos);
    }
  }
  function syncPlayState() {
    const playing = Boolean(current()) && !audioEl.paused;
    document.querySelectorAll('.pl-play').forEach((b) => {
      b.replaceChildren(icon(playing ? 'pause' : 'play'));
      b.classList.toggle('on', playing);
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
    document.body.classList.toggle('is-playing', playing);
  }

  function renderPlayer() {
    const bar = $('#player');
    const t = current();
    document.body.classList.toggle('has-player', Boolean(t));
    bar.hidden = !t;
    if (!t) { bar.replaceChildren(); syncPlayState(); return; }
    const volume = h('input', {
      class: 'pl-vol', type: 'range', min: 0, max: 100, step: 1, value: Math.round(audioEl.volume * 100),
      'aria-label': 'Volume',
      oninput: (e) => { audioEl.volume = Number(e.target.value) / 100; prefs.set('volume', audioEl.volume); },
    });
    bar.replaceChildren(
      h('div', { class: 'pl-art' }, art(t.album, t.cover, t.cover || t.album)),
      h('div', { class: 'pl-info' },
        h('div', { class: 'pl-title', title: t.title }, t.title),
        h('div', { class: 'pl-sub' }, [t.artist, t.album].filter(Boolean).join(' · ')),
        h('div', { class: 'pl-count' }, `${player.index + 1} of ${player.queue.length}`)),
      transport(),
      h('label', { class: 'pl-volume' }, 'Volume', volume),
      h('button', { class: 'btn small', type: 'button', onclick: stopPlayer, 'aria-label': 'Close the player' }, icon('close')));
    syncPlayState(); syncProgress();
  }

  function queueItem(kind, album, t) {
    return {
      kind, id: t.id, title: t.title, artist: t.artist || album.artist, album: album.album,
      cover: kind === 'library' ? album.id : (t.album_key || album.cover || ''), duration_ms: t.duration_ms || 0,
    };
  }
  function queueFromSheet(startId) {
    const { kind, album, tracks } = state.sheet;
    const items = tracks.map((t) => queueItem(kind, album, t));
    const at = startId === undefined ? 0 : Math.max(0, items.findIndex((i) => i.id === startId));
    playQueue(items, at);
  }
  async function playAlbum(kind, album) {
    try {
      let tracks;
      if (kind === 'library') tracks = (await api(`/api/library/albums/${album.id}/tracks`)).tracks;
      else tracks = album.tracks;
      playQueue(tracks.map((t) => queueItem(kind, album, t)), 0);
    } catch (err) { toast(err.message); }
  }
  function playFab(kind, album) {
    return h('button', {
      class: 'play-fab', type: 'button', title: `Play ${album.album}`, 'aria-label': `Play ${album.album}`,
      onclick: (e) => { e.stopPropagation(); playAlbum(kind, album); },
    }, icon('play'));
  }

  audioEl.addEventListener('play', syncPlayState);
  audioEl.addEventListener('pause', syncPlayState);
  audioEl.addEventListener('timeupdate', syncProgress);
  audioEl.addEventListener('loadedmetadata', syncProgress);
  audioEl.addEventListener('ended', nextTrack);
  audioEl.addEventListener('error', () => {
    if (!current() || !audioEl.getAttribute('src')) return;
    toast(`Can't play "${current().title}".`);
    if (player.index < player.queue.length - 1) playIndex(player.index + 1); else stopPlayer();
  });

  // ---------- rendering: the iPod panel ----------
  function capacityBar() {
    const d = device();
    const total = d.total_bytes || 1;
    const free = d.free_bytes;
    const music = d.music_bytes;
    const other = Math.max(0, total - free - music);
    const net = state.plan ? state.plan.bytes.net : 0;
    const adding = Math.max(0, net);
    const over = state.plan && !state.plan.fits;
    const addShown = Math.min(adding, free);
    const pct = (n) => `${Math.max(0, (n / total) * 100).toFixed(2)}%`;
    const freeAfter = Math.max(0, free - addShown);

    const legend = [
      h('li', {}, h('i', { class: 'swatch seg-music' }), 'Music ', h('b', {}, formatBytes(music))),
    ];
    if (other / total > 0.01) {
      legend.push(h('li', {}, h('i', { class: 'swatch seg-other' }), 'Other ', h('b', {}, formatBytes(other))));
    }
    if (adding) {
      legend.push(h('li', {}, h('i', { class: 'swatch seg-add' }), 'To add ', h('b', {}, formatBytes(adding))));
    } else if (net < 0) {
      legend.push(h('li', {}, 'Frees ', h('b', {}, formatBytes(-net))));
    }
    legend.push(h('li', {}, h('i', { class: 'swatch free' }), 'Free ', h('b', {}, formatBytes(freeAfter))));

    return h('div', { class: 'capacity' },
      h('div', {
        class: 'bar' + (over ? ' over' : ''), role: 'img',
        'aria-label': `${formatBytes(music)} music, ${formatBytes(free)} free of ${formatBytes(total)}`,
      },
      h('span', { class: 'seg-music', style: `width:${pct(music)}` }),
      h('span', { class: 'seg-other', style: `width:${pct(other)}` }),
      h('span', { class: 'seg-add', style: `width:${pct(addShown)}` + (addShown > 0 ? ';min-width:3px' : '') })),
      h('ul', { class: 'legend' }, legend));
  }

  function jobBlock(job) {
    const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
    const phase = capitalize(job.phase || 'working');
    return h('div', { class: 'plan' },
      h('p', {}, h('strong', {}, `${phase}…`), ` ${job.done} of ${job.total}`),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('span', { style: `width:${percent}%` })),
      h('div', { class: 'current' }, job.current || ' '),
      h('div', { class: 'plan-buttons', style: 'margin-top:0.7rem' },
        h('button', {
          class: 'btn', type: 'button', onclick: async () => {
            try { await api('/api/sync/cancel', { method: 'POST' }); toast('Cancelling after the current song…'); }
            catch (err) { toast(err.message); }
          },
        }, 'Cancel')));
  }

  function finishedBlock(job) {
    const ok = job.state === 'done';
    return h('div', { class: 'plan' },
      h('div', { class: 'notice ' + (ok ? 'ok' : 'error') },
        h('strong', {}, ok ? 'Sync finished' : job.state === 'cancelled' ? 'Sync cancelled' : 'Sync did not finish'),
        job.message),
      job.error_count ? h('ul', { class: 'problems' }, job.errors.map((e) => h('li', {}, e))) : null,
      h('div', { class: 'plan-buttons', style: 'margin-top:0.7rem' },
        h('button', { class: 'btn', type: 'button', onclick: () => { state.finishedJob = null; renderPod(); } }, 'Dismiss')));
  }

  function basketBlock() {
    const ids = [...state.selAlbums];
    if (!ids.length && !state.selTracks.size) return null;
    const shown = ids.slice(0, 12);
    return h('div', {},
      h('div', { class: 'basket', 'aria-label': 'Selected albums' },
        shown.map((id) => {
          const info = state.info.get(id) || { album: 'Album', artist: '' };
          return h('button', {
            class: 'thumb', type: 'button', title: `${info.album}: click to remove from the sync`,
            'aria-label': `Remove ${info.album} from the sync`,
            onclick: () => toggleAlbum({ id }, false),
          },
          h('div', { class: 'blank', 'aria-hidden': 'true', style: `--hue:${hueOf(id)}` }, '♪'),
          h('img', { alt: '', src: `/api/library/cover/${id}`, onerror: (e) => e.target.remove() }));
        }),
        ids.length > shown.length ? h('span', { class: 'thumb-more' }, `+${ids.length - shown.length} more`) : null,
        state.selTracks.size ? h('span', { class: 'thumb-more' }, `+ ${plural(state.selTracks.size, 'single song')}`) : null));
  }

  function planBlock() {
    const plan = state.plan;
    if (!selectionCount()) {
      return h('div', { class: 'plan' }, h('p', { class: 'none' },
        state.tab === 'library' ? 'Tick albums (or open one to pick single songs) to put on the iPod.'
          : 'Tick albums or songs to remove them from the iPod.'));
    }
    const clear = h('button', { class: 'btn link', type: 'button', onclick: () => { clearSelection(); schedulePlan(); renderList(); renderSheet(); } }, 'Clear selection');
    if (state.planError) return h('div', { class: 'plan' }, h('div', { class: 'notice error' }, state.planError), h('p', {}, clear));
    if (!plan) return h('div', { class: 'plan' }, basketBlock(), h('p', { class: 'none' }, 'Working out what to copy…'));

    const c = plan.counts;
    const bits = [];
    if (c.add) bits.push(`${plural(c.add, 'song')} to add` + (c.convert ? ` (${c.convert} converted to AAC)` : ''));
    if (c.remove) bits.push(`${plural(c.remove, 'song')} to remove`);
    if (c.already_on_ipod) bits.push(`${c.already_on_ipod} already on the iPod`);
    if (c.skipped) bits.push(`${plural(c.skipped, 'song')} cannot be played on an iPod`);
    const actionable = c.add || c.remove;
    const label = c.add && c.remove ? 'Apply changes' : c.remove ? 'Remove from iPod' : 'Sync now';
    const canSync = ipodState().can_sync && actionable && plan.fits;
    return h('div', { class: 'plan' },
      basketBlock(),
      h('p', {}, bits.length ? bits.join(', ') + '.' : 'Nothing new to copy.'),
      !plan.fits ? h('div', { class: 'notice error' }, h('strong', {}, 'Not enough space'),
        `This needs ${formatBytes(plan.bytes.net)} but only ${formatBytes(plan.bytes.free)} is free. ` +
        'Choose fewer songs or remove some from the iPod.') : null,
      h('div', { class: 'plan-buttons', style: !plan.fits ? 'margin-top:0.7rem' : '' },
        h('button', { class: 'btn primary', type: 'button', disabled: !canSync, onclick: startSync }, label), clear));
  }

  function podShell(title, subtitle, ...body) {
    return [
      h('div', { class: 'pod-head' }, h('h2', {}, title), subtitle ? h('p', { class: 'model' }, subtitle) : null),
      h('div', { class: 'pod-body' }, ...body),
    ];
  }

  function renderPod() {
    const pod = $('#pod');
    pod.replaceChildren();
    const st = ipodState();

    if (st.state === 'unknown') {
      pod.append(...podShell('iPod', '', h('p', { class: 'waiting' }, 'Looking for your iPod…')));
      return;
    }
    if (st.state === 'disconnected') {
      pod.append(...podShell('No iPod connected', '', h('p', { class: 'waiting' },
        'Plug the iPod into a USB port on your Umbrel. This panel updates when it appears.')));
      return;
    }
    if (st.state === 'needs_mount') {
      const body = state.mountError
        ? [h('div', { class: 'notice error' }, h('strong', {}, 'Could not open the iPod'), state.mountError),
          h('div', { class: 'plan-buttons', style: 'margin-top:0.8rem' },
            h('button', { class: 'btn', type: 'button', onclick: () => { state.mountError = ''; mountIpod(); } }, 'Try again'))]
        : [h('p', { class: 'waiting' }, 'Opening it…')];
      pod.append(...podShell('iPod found', '', ...body));
      return;
    }
    if (st.state === 'error') {
      pod.append(...podShell('iPod problem', '', h('div', { class: 'notice error', style: 'margin-top:0' }, st.message)));
      return;
    }

    const d = st.device;
    const name = deviceName(d);
    const subtitle = [name.generation, d.capacity_gb ? `${d.capacity_gb} GB` : null, capitalize(d.color),
      st.filesystem === 'vfat' ? 'Windows format' : st.filesystem && st.filesystem.startsWith('hfs') ? 'Mac format' : null]
      .filter(Boolean).join(' · ');
    const body = [capacityBar()];

    st.problems.forEach((p) => body.push(
      h('div', { class: 'notice' + (p.blocking ? ' error' : '') }, h('strong', {}, p.title), p.detail)));

    if (state.job) body.push(jobBlock(state.job));
    else if (state.finishedJob) body.push(finishedBlock(state.finishedJob));
    else if (st.can_sync) body.push(planBlock());

    body.push(h('div', { class: 'pod-footer' },
      h('span', { class: 'muted small' }, plural(d.tracks, 'song')),
      h('button', { class: 'btn', type: 'button', disabled: Boolean(state.job), onclick: ejectIpod }, 'Eject')));
    pod.append(...podShell(name.title, subtitle, ...body));
  }

  // ---------- settings ----------
  async function openSettings() {
    try {
      state.settings = await api('/api/settings');
      $('#set-bitrate').value = String(state.settings.bitrate);
      $('#set-lossless').checked = state.settings.convert_lossless;
      $('#set-artwork').checked = state.settings.artwork;
      $('#set-force').checked = state.settings.hfs_force_rw;
      await renderBackups();
      $('#settings').showModal();
    } catch (err) { toast(err.message); }
  }

  async function saveSetting(patch) {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: patch });
      schedulePlan();
    } catch (err) { toast(err.message); }
  }

  async function renderBackups() {
    const list = $('#backup-list');
    list.replaceChildren();
    let backups = [];
    try { backups = (await api('/api/backups')).backups; } catch (_) { /* iPod not connected */ }
    if (!backups.length) {
      list.append(h('li', { class: 'muted' }, device() ? 'No backups yet. The first is made at your next sync.'
        : 'Connect the iPod to see its backups.'));
      return;
    }
    backups.forEach((b) => list.append(h('li', {},
      h('span', {}, `${new Date(b.taken * 1000).toLocaleString()} · ${formatBytes(b.size)}`),
      h('button', {
        class: 'btn small', type: 'button', onclick: async () => {
          if (!confirm('Restore this backup of the iPod’s music database?')) return;
          try {
            await api('/api/backups/restore', { method: 'POST', body: { id: b.id } });
            toast('Backup restored.');
            await refreshStatus();
            reloadList();
          } catch (err) { toast(err.message); }
        },
      }, 'Restore'))));
  }

  // ---------- wiring ----------
  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    renderToolbar();
    reloadList();
    schedulePlan();
  }

  function init() {
    $('#tab-library').addEventListener('click', () => switchTab('library'));
    $('#tab-ipod').addEventListener('click', () => switchTab('ipod'));
    let searchTimer = null;
    $('#q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.letter = ''; reloadList(); }, 250);
    });
    $('#filter-new').addEventListener('click', () => { state.view = 'new'; prefs.set('view', 'new'); state.letter = ''; loadAlbums(true); });
    $('#filter-all').addEventListener('click', () => { state.view = 'all'; prefs.set('view', 'all'); state.letter = ''; loadAlbums(true); });
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; prefs.set('sort', state.sort); state.letter = ''; loadAlbums(true); });
    $('#tile-size').addEventListener('input', (e) => {
      state.tile = e.target.value; prefs.set('tile', state.tile);
      document.body.dataset.tile = state.tile;
      setTimeout(maybeLoadMore, 0);
    });
    $('#surprise').addEventListener('change', (e) => {
      const choice = e.target.value;
      e.target.value = '';
      if (choice) surprise(choice);
    });
    $('#btn-select-all').addEventListener('click', selectAll);
    $('#btn-rescan').addEventListener('click', async () => {
      try { await api('/api/library/scan', { method: 'POST' }); await refreshStatus(); }
      catch (err) { toast(err.message); }
    });
    $('#btn-settings').addEventListener('click', openSettings);
    $('#set-bitrate').addEventListener('change', (e) => saveSetting({ bitrate: Number(e.target.value) }));
    $('#set-lossless').addEventListener('change', (e) => saveSetting({ convert_lossless: e.target.checked }));
    $('#set-artwork').addEventListener('change', (e) => saveSetting({ artwork: e.target.checked }));
    $('#set-force').addEventListener('change', (e) => saveSetting({ hfs_force_rw: e.target.checked }));

    const sheet = $('#sheet');
    sheet.addEventListener('close', () => { state.sheet = null; });
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

    window.addEventListener('scroll', maybeLoadMore, { passive: true });
    document.addEventListener('keydown', (e) => {
      const typing = e.target.matches &&
        e.target.matches('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=radio])');
      if (e.key === ' ' && e.target === document.body && current()) { e.preventDefault(); togglePlay(); return; }
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); $('#q').focus(); }
    });

    document.body.dataset.tile = state.tile;
    renderToolbar(); renderPod(); renderList(); renderLcd();
    refreshStatus();
    setInterval(() => { if (!state.job) refreshStatus(); }, 4000);
    // While the library is scanned, show new albums as they appear.
    setInterval(() => {
      const scan = state.status && state.status.library && state.status.library.scan;
      if (scan && scan.running && state.tab === 'library') loadAlbums(true);
    }, 5000);
  }

  init();
})();
