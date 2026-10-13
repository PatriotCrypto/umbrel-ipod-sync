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
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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

  function applyDeviceColor(color) {
    const root = document.documentElement.style;
    const device = DEVICE_COLORS[color];
    if (device) root.setProperty('--device', device); else root.removeProperty('--device');
    if (device && !WEAK_ACTION.has(color)) root.setProperty('--action', device);
    else root.removeProperty('--action');
  }

  // ---------- state ----------
  const state = {
    tab: 'library', q: '',
    albums: [], albumTotal: 0, loadingAlbums: false,
    ipodTracks: [], ipodTotal: 0, revision: '',
    expanded: new Map(),
    selAlbums: new Set(), selTracks: new Set(), selRemove: new Set(),
    status: null, plan: null, planError: '', planSeq: 0,
    job: null, finishedJob: null,
    mounting: false, mountError: '',
    settings: null,
  };

  const ipodState = () => (state.status && state.status.ipod) || { state: 'unknown' };
  const device = () => ipodState().device;
  const selectionCount = () => state.selAlbums.size + state.selTracks.size + state.selRemove.size;

  // ---------- data loading ----------
  async function loadAlbums(reset) {
    if (state.loadingAlbums) return;
    state.loadingAlbums = true;
    try {
      const offset = reset ? 0 : state.albums.length;
      const data = await api(`/api/library/albums?q=${encodeURIComponent(state.q)}&limit=60&offset=${offset}`);
      state.albums = reset ? data.albums : state.albums.concat(data.albums);
      state.albumTotal = data.total;
    } catch (err) { toast(err.message); }
    state.loadingAlbums = false;
    renderList();
  }

  async function loadIpodTracks() {
    try {
      const data = await api(`/api/ipod/tracks?q=${encodeURIComponent(state.q)}&limit=200&refresh=1`);
      state.ipodTracks = data.tracks;
      state.ipodTotal = data.total;
      state.revision = data.revision;
    } catch (err) { state.ipodTracks = []; state.ipodTotal = 0; }
    renderList();
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
    if (!selectionCount()) { renderPod(); return; }
    renderPod();
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
      renderPod();
      pollJob();
    } catch (err) { toast(err.message); }
  }

  async function pollJob() {
    try {
      const data = await api('/api/sync/job');
      state.job = data.job;
    } catch (_) { /* keep trying */ }
    if (state.job && state.job.state === 'running') {
      renderPod();
      setTimeout(pollJob, 1000);
      return;
    }
    if (state.job) {
      state.finishedJob = state.job;
      state.selAlbums.clear(); state.selTracks.clear(); state.selRemove.clear();
      state.plan = null; state.expanded.clear();
      state.job = null;
      await refreshStatus();
      reloadList();
    }
    renderPod();
  }

  // ---------- status polling ----------
  let lastRevision = null;
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
      if (state.tab === 'ipod') loadIpodTracks(); else renderList();
      if (state.tab === 'library') loadAlbums(true);
    }
    renderTop();
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
      state.selAlbums.clear(); state.selTracks.clear(); state.selRemove.clear();
      state.plan = null;
      toast('The iPod is safe to unplug.');
    } catch (err) { toast(err.message); }
    await refreshStatus();
  }

  // ---------- selection ----------
  function toggleAlbum(album, on) {
    if (on) { state.selAlbums.add(album.id); }
    else {
      state.selAlbums.delete(album.id);
      const tracks = state.expanded.get(album.id) || [];
      tracks.forEach((t) => state.selTracks.delete(t.id));
    }
    schedulePlan(); renderList();
  }

  function toggleTrack(album, track, on) {
    const tracks = state.expanded.get(album.id) || [];
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
    schedulePlan(); renderList();
  }

  async function toggleExpand(album) {
    if (state.expanded.has(album.id)) state.expanded.delete(album.id);
    else {
      try {
        const data = await api(`/api/library/albums/${album.id}/tracks`);
        state.expanded.set(album.id, data.tracks);
      } catch (err) { toast(err.message); return; }
    }
    renderList();
  }

  async function selectAll() {
    if (selectionCount()) {
      state.selAlbums.clear(); state.selTracks.clear(); state.selRemove.clear();
      schedulePlan(); renderList(); return;
    }
    try {
      if (state.tab === 'library') {
        for (let offset = 0; offset < state.albumTotal; offset += 200) {
          const data = await api(`/api/library/albums?q=${encodeURIComponent(state.q)}&limit=200&offset=${offset}`);
          data.albums.filter((a) => a.on_ipod < a.tracks).forEach((a) => state.selAlbums.add(a.id));
        }
      } else {
        for (let offset = 0; offset < state.ipodTotal; offset += 500) {
          const data = await api(`/api/ipod/tracks?q=${encodeURIComponent(state.q)}&limit=500&offset=${offset}`);
          data.tracks.forEach((t) => state.selRemove.add(t.id));
        }
      }
    } catch (err) { toast(err.message); }
    schedulePlan(); renderList();
  }

  // ---------- rendering: top bar and list ----------
  function renderTop() {
    const lib = state.status && state.status.library;
    if (!lib) return;
    const scan = lib.scan;
    $('#scan-state').textContent = scan.running
      ? `Scanning ${scan.scanned} of ${scan.total}…` : '';
    $('#btn-rescan').disabled = scan.running;
    $('#lib-count').textContent = lib.tracks ? plural(lib.albums, 'album') : '';
    $('#ipod-count').textContent = device() ? plural(device().tracks, 'song') : '';
    if (scan.error) toast(`Scan problem: ${scan.error}`);
  }

  function albumRow(album) {
    const full = album.on_ipod >= album.tracks;
    const selected = state.selAlbums.has(album.id);
    const expanded = state.expanded.has(album.id);
    const partial = album.on_ipod > 0 && !full;
    const row = h('div', { class: 'row' + (selected ? ' is-selected' : ''), role: 'listitem' },
      h('input', {
        type: 'checkbox', checked: selected || full, disabled: full || !device(),
        'aria-label': `Select ${album.album}`,
        onchange: (e) => toggleAlbum(album, e.target.checked),
      }),
      h('img', {
        class: 'cover', alt: '', loading: 'lazy', src: `/api/library/cover/${album.id}`,
        onerror: (e) => {
          const blank = h('div', { class: 'cover blank', 'aria-hidden': 'true' }, '♪');
          e.target.replaceWith(blank);
        },
      }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title' }, album.album),
        h('div', { class: 'sub' }, [album.artist, album.year].filter(Boolean).join(' · '))),
      h('div', { class: 'side' },
        full ? h('span', { class: 'state' }, 'On iPod')
          : partial ? h('span', { class: 'state' }, `${album.on_ipod} of ${album.tracks} on iPod`) : null,
        `${plural(album.tracks, 'song')} · ${formatBytes(album.size)} `,
        h('button', {
          class: 'expand', type: 'button', 'aria-expanded': String(expanded),
          'aria-label': `${expanded ? 'Hide' : 'Show'} songs in ${album.album}`,
          onclick: () => toggleExpand(album),
        }, expanded ? '▾' : '▸')));
    const nodes = [row];
    if (expanded) {
      nodes.push(h('div', { class: 'tracks' }, state.expanded.get(album.id).map((t) =>
        h('label', { class: 'track' },
          h('input', {
            type: 'checkbox', disabled: t.on_ipod || !device(),
            checked: t.on_ipod || selected || state.selTracks.has(t.id),
            onchange: (e) => toggleTrack(album, t, e.target.checked),
          }),
          h('span', { class: 'num' }, t.track || ''),
          h('span', { class: 'title' }, t.title, t.on_ipod ? '  · on iPod' : ''),
          h('span', { class: 'time' }, formatTime(t.duration_ms))))));
    }
    return nodes;
  }

  function ipodRow(track) {
    const selected = state.selRemove.has(track.id);
    return h('div', { class: 'row' + (selected ? ' is-selected' : ''), role: 'listitem' },
      h('input', {
        type: 'checkbox', checked: selected, 'aria-label': `Select ${track.title} to remove`,
        onchange: (e) => {
          if (e.target.checked) state.selRemove.add(track.id); else state.selRemove.delete(track.id);
          schedulePlan(); renderList();
        },
      }),
      h('div', { class: 'cover blank', 'aria-hidden': 'true' }, '♪'),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title' }, track.title),
        h('div', { class: 'sub' }, [track.artist, track.album].filter(Boolean).join(' · '))),
      h('div', { class: 'side' }, `${formatTime(track.duration_ms)} · ${formatBytes(track.size)}`));
  }

  function renderList() {
    const list = $('#list');
    const more = $('#more');
    list.replaceChildren();
    more.replaceChildren();
    $('#tab-library').setAttribute('aria-selected', String(state.tab === 'library'));
    $('#tab-ipod').setAttribute('aria-selected', String(state.tab === 'ipod'));
    $('#btn-select-all').textContent = selectionCount() ? 'Clear selection' : 'Select all';
    $('#btn-select-all').disabled = state.tab === 'ipod' ? !device() : !device();
    list.setAttribute('role', 'list');

    if (state.tab === 'library') {
      const lib = state.status && state.status.library;
      if (!state.albums.length) {
        if (lib && lib.scan.running) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'Looking through your music…'),
            `${lib.scan.scanned} of ${lib.scan.total} files checked.`));
        } else if (state.q) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'No matches'),
            'Try a different artist, album or song name.'));
        } else if (lib && !lib.music_dir_exists) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'The music folder is not available'),
            'Check that this app has access to your Umbrel’s Downloads folder.'));
        } else if (lib) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'No music found yet'),
            'Add songs anywhere in your Umbrel’s Downloads folder, then choose Rescan library.'));
        }
      }
      state.albums.forEach((a) => list.append(...albumRow(a)));
      if (state.albums.length < state.albumTotal) {
        more.append(h('button', { type: 'button', onclick: () => loadAlbums(false) },
          `Show more (${state.albumTotal - state.albums.length} left)`));
      }
    } else {
      if (!device()) {
        list.append(h('div', { class: 'empty' }, h('strong', {}, 'No iPod connected'),
          'Songs on the iPod appear here once it is plugged in.'));
      } else if (!state.ipodTracks.length) {
        list.append(h('div', { class: 'empty' }, h('strong', {}, state.q ? 'No matches' : 'No songs on this iPod'),
          state.q ? 'Try a different search.' : 'Choose songs from the Library tab to add some.'));
      }
      state.ipodTracks.forEach((t) => list.append(ipodRow(t)));
      if (state.ipodTracks.length < state.ipodTotal) {
        more.append(h('p', { class: 'muted small' },
          `Showing ${state.ipodTracks.length} of ${state.ipodTotal}. Search to narrow the list.`));
      }
    }
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
    legend.push(h('li', {}, h('i', { class: 'swatch', style: 'background:var(--raised);border:1px solid var(--line)' }),
      'Free ', h('b', {}, formatBytes(freeAfter))));

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
      h('div', { class: 'current' }, job.current || ' '),
      h('div', { class: 'plan-buttons', style: 'margin-top:0.7rem' },
        h('button', {
          type: 'button', onclick: async () => {
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
        h('button', { type: 'button', onclick: () => { state.finishedJob = null; renderPod(); } }, 'Dismiss')));
  }

  function planBlock() {
    const plan = state.plan;
    if (!selectionCount()) {
      return h('div', { class: 'plan' }, h('p', { class: 'none' },
        state.tab === 'library' ? 'Choose albums or songs to put on the iPod.'
          : 'Tick songs to remove them from the iPod.'));
    }
    if (state.planError) return h('div', { class: 'plan' }, h('div', { class: 'notice error' }, state.planError));
    if (!plan) return h('div', { class: 'plan' }, h('p', { class: 'none' }, 'Working out what to copy…'));

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
      h('p', {}, bits.length ? bits.join(', ') + '.' : 'Nothing new to copy.'),
      !plan.fits ? h('div', { class: 'notice error' }, h('strong', {}, 'Not enough space'),
        `This needs ${formatBytes(plan.bytes.net)} but only ${formatBytes(plan.bytes.free)} is free. ` +
        'Choose fewer songs or remove some from the iPod.') : null,
      h('div', { class: 'plan-buttons' },
        h('button', { class: 'primary', type: 'button', disabled: !canSync, onclick: startSync }, label)));
  }

  function renderPod() {
    const pod = $('#pod');
    pod.replaceChildren();
    const st = ipodState();

    if (st.state === 'unknown') {
      pod.append(h('p', { class: 'waiting' }, 'Looking for your iPod…'));
      return;
    }
    if (st.state === 'disconnected') {
      pod.append(h('h2', {}, 'No iPod connected'), h('p', { class: 'waiting' },
        'Plug the iPod into a USB port on your Umbrel. This panel updates when it appears.'));
      return;
    }
    if (st.state === 'needs_mount') {
      pod.append(h('h2', {}, 'iPod found'));
      if (state.mountError) {
        pod.append(h('div', { class: 'notice error' }, h('strong', {}, 'Could not open the iPod'), state.mountError),
          h('div', { class: 'plan-buttons', style: 'margin-top:0.8rem' },
            h('button', { type: 'button', onclick: () => { state.mountError = ''; mountIpod(); } }, 'Try again')));
      } else {
        pod.append(h('p', { class: 'waiting' }, 'Opening it…'));
      }
      return;
    }
    if (st.state === 'error') {
      pod.append(h('h2', {}, 'iPod problem'), h('div', { class: 'notice error' }, st.message));
      return;
    }

    const d = st.device;
    const name = deviceName(d);
    pod.append(
      h('h2', {}, name.title),
      h('p', { class: 'model' }, [name.generation, d.capacity_gb ? `${d.capacity_gb} GB` : null, capitalize(d.color),
        st.filesystem === 'vfat' ? 'Windows format' : st.filesystem && st.filesystem.startsWith('hfs') ? 'Mac format' : null]
        .filter(Boolean).join(' · ')),
      capacityBar());

    st.problems.forEach((p) => pod.append(
      h('div', { class: 'notice' + (p.blocking ? ' error' : '') }, h('strong', {}, p.title), p.detail)));

    if (state.job) pod.append(jobBlock(state.job));
    else if (state.finishedJob) pod.append(finishedBlock(state.finishedJob));
    else if (st.can_sync) pod.append(planBlock());

    pod.append(h('div', { class: 'pod-footer' },
      h('span', { class: 'muted small' }, plural(d.tracks, 'song')),
      h('button', { type: 'button', disabled: Boolean(state.job), onclick: ejectIpod }, 'Eject')));
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
        type: 'button', onclick: async () => {
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
  function init() {
    $('#tab-library').addEventListener('click', () => { state.tab = 'library'; reloadList(); schedulePlan(); });
    $('#tab-ipod').addEventListener('click', () => { state.tab = 'ipod'; reloadList(); schedulePlan(); });
    let searchTimer = null;
    $('#q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); reloadList(); }, 250);
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

    renderPod(); renderList();
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
