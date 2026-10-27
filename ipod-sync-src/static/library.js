(() => {
  'use strict';
  const { $, h, formatBytes, formatTime, formatLength, plural, capitalize, norm, hueOf, prefs, api, toast, art, icon, deviceName } = window.IP;
  const P = window.IP.player;


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
    if (device && DARK_TEXT.has(color)) root.setProperty('--on-device', '#1c2b3d');
    else root.removeProperty('--on-device');
  }

  // ---------- state ----------
  const state = {
    tab: 'library', q: '', letter: '', genre: '',
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
      q: state.q, sort: state.sort, status: effectiveView(), letter: state.letter, genre: state.genre, ...extra,
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
  let seenGeneration = -1, scanPoll = null;
  async function refreshStatus() {
    try {
      state.status = await api('/api/status');
    } catch (err) {
      return;
    }
    const lib = state.status.library;
    if (lib && lib.generation !== undefined && lib.generation !== seenGeneration) {
      const first = seenGeneration === -1;
      seenGeneration = lib.generation;
      if (!first) {            // songs were added, removed or re-sorted: refresh whatever is showing
        loadGenres();
        if (state.tab === 'library') loadAlbums(true);
        window.dispatchEvent(new CustomEvent('ipod:library-changed'));
      }
    }
    if (lib && lib.scan && lib.scan.running && !scanPoll) {   // follow a scan closely
      scanPoll = setTimeout(() => { scanPoll = null; refreshStatus(); }, 1500);
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

  // Pick loose songs (a playlist, say) to copy to the iPod, then show the iPod panel.
  function selectTracks(ids) {
    ids.forEach((id) => state.selTracks.add(id));
    window.IP.nav.go('ipod');
    schedulePlan(); renderList(); renderPod();
    if (!device()) toast('Plug in your iPod to copy these songs.');
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
    const put = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
    put('#nav-lib-count', lib.tracks ? String(lib.albums) : '');
    put('#nav-songs-count', lib.tracks ? String(lib.tracks) : '');
    put('#nav-ipod-count', device() ? String(device().tracks) : '');
    const dot = $('#nav-ipod');
    if (dot) dot.classList.toggle('connected', Boolean(device()));
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
    } else if (st.state === 'ejected') {
      main.textContent = 'Safe to unplug'; sub.textContent = 'The iPod has been ejected';
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
    const heading = $('#lib-heading');
    if (heading) heading.textContent = library ? 'Library' : (device() ? deviceName(device()).title : 'iPod');
    const genreWrap = $('#genre-wrap');
    if (genreWrap) genreWrap.hidden = !library;
    const genreSel = $('#genre');
    if (genreSel) genreSel.value = state.genre;

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


  // ---------- playing from the library ----------
  function sheetItems() {
    const { kind, album, tracks } = state.sheet;
    return tracks.map((t) => P.queueItem(kind, album, t));
  }
  function queueFromSheet(startId) {
    const items = sheetItems();
    const at = startId === undefined ? 0 : Math.max(0, items.findIndex((i) => i.id === startId));
    P.playQueue(items, at);
  }
  async function albumItems(kind, album) {
    const tracks = kind === 'library' ? (await api(`/api/library/albums/${album.id}/tracks`)).tracks : album.tracks;
    return tracks.map((t) => P.queueItem(kind, album, t));
  }
  async function playAlbum(kind, album) {
    try { P.playQueue(await albumItems(kind, album), 0); } catch (err) { toast(err.message); }
  }
  function playFab(kind, album) {
    return h('button', {
      class: 'play-fab', type: 'button', title: `Play ${album.album}`, 'aria-label': `Play ${album.album}`,
      onclick: (e) => { e.stopPropagation(); playAlbum(kind, album); },
    }, icon('play'));
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
            'Check that your music folders still exist (Settings → Music folders).'));
        } else if (lib) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'No music found yet'),
            'Add songs to your music folder, or choose other folders in Settings → Music folders, then press Rescan library.'));
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
    if (document.body.dataset.view === 'library' && window.IP.nearEnd($('#more'), 600)) loadAlbums(false);
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
      class: 'pnum' + (P.isCurrent(k, t.id) ? ' now' : ''), type: 'button', title: `Play ${t.title}`,
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
            h('button', { class: 'btn', type: 'button', onclick: () => P.enqueue(sheetItems()) }, 'Add to queue'),
            kind === 'library' ? h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu',
              onclick: (e) => window.IP.playlists.menu(e.currentTarget, { ids: () => state.sheet.tracks.map((t) => t.id), label: album.album }) },
              'Add to playlist') : null,
            action)),
        h('button', { class: 'btn small sheet-close', type: 'button', onclick: closeSheet }, 'Close')),
      h('div', { class: 'sheet-tracks' }, rows),
      P.current() ? h('div', { class: 'sheet-player' },
        h('div', { class: 'pl-title' }, `Now playing: ${P.current().title}`), P.transport({ mini: true })) : h('span'));
    const list = body.querySelector('.sheet-tracks');
    if (list) list.scrollTop = keepScroll;
    P.syncPlayState(); P.syncProgress();
  }



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
    if (st.state === 'ejected') {
      pod.append(...podShell('Safe to unplug', '',
        h('p', { class: 'waiting' }, 'The iPod has been ejected. Unplug it whenever you like.'),
        h('div', { class: 'plan-buttons', style: 'margin-top:0.8rem' },
          h('button', { class: 'btn', type: 'button', onclick: mountIpod }, 'Open it again'))));
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
      window.IP.folders.render(state.settings);
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

  // ---------- genres (for the filter) ----------
  async function loadGenres() {
    const sel = $('#genre');
    if (!sel) return;
    try {
      const { genres } = await api('/api/library/genres');
      sel.replaceChildren(h('option', { value: '' }, 'All genres'),
        ...genres.map((g) => h('option', { value: g.name }, `${g.name} (${g.album_count})`)));
      if (state.genre && !genres.some((g) => g.name === state.genre)) state.genre = '';
      sel.value = state.genre;
    } catch (_) { /* the list still works without it */ }
  }

  function setGenre(name) {
    state.genre = name || ''; state.letter = '';
    const sel = $('#genre'); if (sel) sel.value = state.genre;
    if (state.tab === 'library') loadAlbums(true);
  }

  // ---------- wiring ----------
  function showTab(tab) {
    if (state.tab !== tab) { state.tab = tab; renderToolbar(); reloadList(); schedulePlan(); }
    else { renderToolbar(); renderList(); }
  }

  function init() {
    let searchTimer = null;
    $('#q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.letter = ''; reloadList(); }, 250);
    });
    $('#filter-new').addEventListener('click', () => { state.view = 'new'; prefs.set('view', 'new'); state.letter = ''; loadAlbums(true); });
    $('#filter-all').addEventListener('click', () => { state.view = 'all'; prefs.set('view', 'all'); state.letter = ''; loadAlbums(true); });
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; prefs.set('sort', state.sort); state.letter = ''; loadAlbums(true); });
    $('#genre').addEventListener('change', (e) => setGenre(e.target.value));
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
    P.onChange(() => renderSheet());

    window.IP.scroller().addEventListener('scroll', maybeLoadMore, { passive: true });
    document.addEventListener('keydown', (e) => {
      const typing = e.target.matches &&
        e.target.matches('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=radio])');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        const box = $('#q');
        if (box && box.offsetParent !== null) { e.preventDefault(); box.focus(); }
      }
    });

    document.body.dataset.tile = state.tile;
    renderToolbar(); renderPod(); renderList(); renderLcd();
    loadGenres();
    refreshStatus();
    setInterval(() => { if (!state.job) refreshStatus(); }, 4000);
  }

  window.IP.lib = {
    init, showTab, setGenre, openSettings, selectTracks, generation: () => ((state.status && state.status.library) || {}).generation || 0, refreshStatus, reloadList, loadGenres,
    tab: () => state.tab, libraryChanged: () => { loadGenres(); if (state.tab === 'library') loadAlbums(true); refreshStatus(); },
  };
})();
