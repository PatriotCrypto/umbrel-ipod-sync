/* The player: audio, queue, transport bar, and the Now Playing screen with its visualizer. */
(() => {
  'use strict';
  const { $, h, formatTime, plural, prefs, toast, icon, art } = window.IP;

  const audioEl = new Audio();
  audioEl.preload = 'metadata';
  const player = { queue: [], index: -1, failRun: 0, shuffle: prefs.get('shuffle', '0') === '1',
                   repeat: ['off', 'all', 'one'].includes(prefs.get('repeat', 'off')) ? prefs.get('repeat', 'off') : 'off',
                   history: [], played: new Set(), dragging: false };
  const listeners = [];
  const emit = () => listeners.forEach((fn) => fn());

  const current = () => player.queue[player.index] || null;
  const isCurrent = (kind, id) => { const t = current(); return Boolean(t) && t.kind === kind && t.id === id; };
  const audioUrl = (t) => (t.kind === 'ipod' ? `/api/ipod/tracks/${t.id}/audio` : `/api/library/tracks/${t.id}/audio`);

  // ---------- audio graph (for the visualizer) ----------
  let ctx = null, analyser = null, gain = null, volume = Math.min(1, Math.max(0, Number(prefs.get('volume', 1))));
  function ensureAudio() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ctx = new Ctx();
      const src = ctx.createMediaElementSource(audioEl);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      gain = ctx.createGain();
      src.connect(analyser); analyser.connect(gain); gain.connect(ctx.destination);
      audioEl.volume = 1; gain.gain.value = volume;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) { ctx = null; analyser = null; gain = null; }
  }
  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    prefs.set('volume', volume);
    if (gain) gain.gain.value = volume; else audioEl.volume = volume;
    document.querySelectorAll('.pl-vol').forEach((el) => { el.value = Math.round(volume * 100); });
  }
  audioEl.volume = volume;

  const source = {
    fill(freq, wave) {
      if (!analyser || !ctx || ctx.state !== 'running') return false;
      analyser.getByteFrequencyData(freq);
      analyser.getByteTimeDomainData(wave);
      return true;
    },
    playing: () => !audioEl.paused && !audioEl.ended && Boolean(current()),
    coverKey: () => { const t = current(); return t ? t.cover : ''; },
  };

  // ---------- queue control ----------
  function playQueue(items, index = 0) {
    if (!items.length) return;
    player.queue = items.slice();
    player.history = []; player.played = new Set();
    playIndex(index, false);
  }

  function enqueue(items, playNextOnly = false) {
    if (!items.length) return;
    if (!player.queue.length) { playQueue(items, 0); return; }
    if (playNextOnly) player.queue.splice(player.index + 1, 0, ...items);
    else player.queue.push(...items);
    renderQueue(); emit();
    toast(playNextOnly ? `${plural(items.length, 'song')} will play next.` : `Added ${plural(items.length, 'song')} to the queue.`);
  }

  function playIndex(i, remember = true) {
    if (i < 0 || i >= player.queue.length) return;
    if (remember && player.index >= 0) player.history.push(player.index);
    player.index = i;
    player.played.add(i);
    const t = current();
    ensureAudio();
    audioEl.src = audioUrl(t);
    audioEl.play().catch((err) => { if (err && err.name !== 'AbortError') toast('This song could not be played.'); });
    updateMediaSession(t);
    syncTrack(); syncPlayState(); syncProgress();
    viz.onTrackChange();
    emit();
  }

  function pickNext(user) {
    const n = player.queue.length;
    if (!n) return -1;
    if (player.repeat === 'one' && !user) return player.index;
    if (player.shuffle && n > 1) {
      let pool = [];
      for (let i = 0; i < n; i++) if (!player.played.has(i) && i !== player.index) pool.push(i);
      if (!pool.length) {
        if (player.repeat !== 'all' && !user) return -1;
        player.played = new Set([player.index]);
        pool = [...Array(n).keys()].filter((i) => i !== player.index);
      }
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (player.index + 1 < n) return player.index + 1;
    return player.repeat === 'all' || (user && n > 1) ? 0 : -1;
  }

  function nextTrack(user = true) {
    const i = pickNext(user);
    if (i < 0) { audioEl.pause(); audioEl.currentTime = 0; syncPlayState(); syncProgress(); return; }
    playIndex(i);
  }
  function prevTrack() {
    if (audioEl.currentTime > 3 || !player.history.length) { audioEl.currentTime = 0; syncProgress(); return; }
    playIndex(player.history.pop(), false);
  }
  function togglePlay() {
    if (!current()) return;
    ensureAudio();
    if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
  }
  function stop() {
    if (!current()) return;
    audioEl.pause(); audioEl.currentTime = 0;
    syncPlayState(); syncProgress();
  }
  function clearQueue() {
    audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load();
    player.queue = []; player.index = -1; player.history = []; player.played = new Set();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    syncTrack(); syncPlayState(); syncProgress(); emit();
  }
  function removeAt(i) {
    if (i === player.index) {
      const more = player.queue.length > 1;
      player.queue.splice(i, 1);
      if (!more) { clearQueue(); return; }
      player.index = Math.min(i, player.queue.length) - 1;
      player.history = []; player.played = new Set();
      nextTrack(true);
    } else {
      player.queue.splice(i, 1);
      if (i < player.index) player.index -= 1;
      player.history = []; player.played = new Set([player.index]);
      renderQueue(); emit();
    }
  }
  function toggleShuffle() {
    player.shuffle = !player.shuffle; prefs.set('shuffle', player.shuffle ? '1' : '0');
    player.played = new Set(player.index >= 0 ? [player.index] : []);
    syncModes();
  }
  function cycleRepeat() {
    player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat]; prefs.set('repeat', player.repeat);
    syncModes();
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.cover ? [{ src: new URL(`/api/library/cover/${t.cover}`, location.href).href, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
    const actions = { play: togglePlay, pause: togglePlay, previoustrack: prevTrack, nexttrack: () => nextTrack(true), stop };
    for (const [name, fn] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch (_) { /* unsupported */ }
    }
  }

  // ---------- the pieces of UI that follow the music ----------
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
    const secs = trackSeconds(), pos = audioEl.currentTime || 0;
    if (!player.dragging) {
      document.querySelectorAll('.pl-seek').forEach((el) => { el.value = secs ? Math.round(pos / secs * 1000) : 0; });
      showTimes(current() ? pos : 0);
    }
    const lcd = $('#np-time');
    if (lcd) lcd.textContent = current() ? `${formatTime(pos * 1000)}` : '0:00';
  }
  function syncPlayState() {
    const playing = Boolean(current()) && !audioEl.paused;
    document.querySelectorAll('.pl-play').forEach((b) => {
      b.replaceChildren(icon(playing ? 'pause' : 'play'));
      b.classList.toggle('on', playing);
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
    document.querySelectorAll('.pl-btn[data-needs-track]').forEach((b) => { b.disabled = !current(); });
    document.body.classList.toggle('is-playing', playing);
  }
  function syncModes() {
    document.querySelectorAll('.pl-shuffle').forEach((b) => b.classList.toggle('on', player.shuffle));
    document.querySelectorAll('.pl-repeat').forEach((b) => {
      b.classList.toggle('on', player.repeat !== 'off');
      b.dataset.mode = player.repeat;
      b.title = { off: 'Repeat: off', all: 'Repeat: all songs', one: 'Repeat: this song' }[player.repeat];
    });
  }

  function syncTrack() {
    const t = current();
    document.title = t ? `${t.title} · ${t.artist || 'uPod'}` : 'uPod';
    const bar = $('#player');
    if (bar) {
      bar.classList.toggle('idle', !t);
      const cover = $('.pl-cover', bar);
      if (cover) cover.replaceChildren(art(t ? t.album : '', t ? t.cover : '', t ? (t.cover || t.album) : 'idle'));
      $('.pl-title', bar).textContent = t ? t.title : 'Nothing playing';
      $('.pl-sub', bar).textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') : 'Pick an album or a song to begin';
    }
    const title = $('#np-title'), sub = $('#np-sub'), album = $('#np-album');
    if (title) {
      title.textContent = t ? t.title : 'uPod';
      sub.textContent = t ? t.artist : 'Press play on any album';
      album.textContent = t ? t.album : '';
    }
    renderQueue();
    syncModes();
  }

  // ---------- transport (the same controls appear in the bar and in the album sheet) ----------
  function transport({ mini = false } = {}) {
    const btn = (cls, label, ico, onclick, needs = true) =>
      h('button', { class: `pl-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick, 'data-needs-track': needs ? '' : null }, icon(ico));
    const seek = h('input', {
      class: 'pl-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position',
      oninput: (e) => { player.dragging = true; showTimes(Number(e.target.value) / 1000 * trackSeconds()); },
      onchange: (e) => {
        const secs = trackSeconds();
        if (secs) audioEl.currentTime = Number(e.target.value) / 1000 * secs;
        player.dragging = false; syncProgress();
      },
    });
    const parts = [
      btn('pl-prev', 'Previous song', 'prev', prevTrack),
      h('button', { class: 'pl-btn pl-play', type: 'button', 'aria-label': 'Play', title: 'Play or pause', onclick: togglePlay, 'data-needs-track': '' }, icon('play')),
      btn('pl-stop', 'Stop', 'stop', stop),
      btn('pl-next', 'Next song', 'next', () => nextTrack(true)),
      h('span', { class: 'pl-cur' }, '0:00'), seek, h('span', { class: 'pl-dur' }, '0:00'),
    ];
    if (!mini) {
      parts.push(
        btn('pl-shuffle', 'Shuffle', 'shuffle', toggleShuffle, false),
        btn('pl-repeat', 'Repeat', 'repeat', cycleRepeat, false),
        h('label', { class: 'pl-volume', title: 'Volume' }, icon('volume'),
          h('input', { class: 'pl-vol', type: 'range', min: 0, max: 100, step: 1, value: Math.round(volume * 100),
            'aria-label': 'Volume', oninput: (e) => setVolume(Number(e.target.value) / 100) })));
    }
    return h('div', { class: 'transport' + (mini ? ' mini' : '') }, ...parts);
  }

  function buildBar() {
    const bar = $('#player');
    bar.replaceChildren(
      h('div', { class: 'pl-cover' }),
      h('div', { class: 'pl-info' }, h('div', { class: 'pl-title' }), h('div', { class: 'pl-sub' })),
      transport());
    syncTrack(); syncPlayState(); syncProgress();
  }

  // ---------- Now Playing screen ----------
  let viz = null, nameTimer = null, idleTimer = null;
  function buildNow() {
    const stage = $('#now-stage');
    const canvas = h('canvas', { id: 'viz', 'aria-label': 'Music visualization' });
    const preset = h('div', { id: 'viz-name', class: 'viz-name' });
    const overlay = h('div', { class: 'np-overlay' },
      h('div', { id: 'np-sub', class: 'np-artist' }),
      h('div', { id: 'np-title', class: 'np-title' }),
      h('div', { id: 'np-album', class: 'np-album' }));
    const lcd = h('div', { class: 'np-lcd', 'aria-hidden': 'true' }, h('span', { id: 'np-time' }, '0:00'));
    const auto = h('button', { class: 'viz-btn', type: 'button', id: 'viz-auto', 'aria-pressed': 'false',
      title: 'Change the visualization every half minute and with each song',
      onclick: () => { viz.setAuto(!viz.auto()); auto.setAttribute('aria-pressed', String(viz.auto())); prefs.set('vizAuto', viz.auto() ? '1' : '0'); } }, 'Auto');
    const full = h('button', { class: 'viz-btn', type: 'button', title: 'Full screen (F)', 'aria-label': 'Full screen',
      onclick: toggleFullscreen }, icon('fullscreen'));
    const controls = h('div', { class: 'viz-controls' },
      h('button', { class: 'viz-btn', type: 'button', 'aria-label': 'Previous visualization', title: 'Previous (←)', onclick: () => viz.prev() }, icon('chevL')),
      h('span', { id: 'viz-label', class: 'viz-label' }),
      h('button', { class: 'viz-btn', type: 'button', 'aria-label': 'Next visualization', title: 'Next (→)', onclick: () => viz.next() }, icon('chevR')),
      auto, full);
    const fsBar = h('div', { class: 'viz-fsbar' }, transport({ mini: true }));
    stage.replaceChildren(canvas, overlay, lcd, preset, controls, fsBar);

    viz = window.IP.Viz.create(canvas, source);
    const saved = Number(prefs.get('vizMode', '0'));
    viz.set(Number.isInteger(saved) ? saved : 0);
    viz.setAuto(prefs.get('vizAuto', '0') === '1');
    auto.setAttribute('aria-pressed', String(viz.auto()));
    const label = (m) => { $('#viz-label').textContent = m.name; };
    label(viz.modes[viz.mode()]);
    viz.onChange((m, i) => {
      label(m); prefs.set('vizMode', i);
      preset.textContent = m.name; preset.classList.add('show');
      clearTimeout(nameTimer); nameTimer = setTimeout(() => preset.classList.remove('show'), 2600);
    });
    canvas.addEventListener('click', () => viz.next());
    canvas.addEventListener('dblclick', toggleFullscreen);
    stage.addEventListener('mousemove', () => {
      stage.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stage.classList.add('idle'), 2800);
    });
    document.addEventListener('fullscreenchange', () => { viz.resize(); stage.classList.toggle('is-full', document.fullscreenElement === stage); });
  }

  function toggleFullscreen() {
    const stage = $('#now-stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => toast('Full screen is not available here.'));
  }

  // A long queue (say 5,000 songs) shows a window of rows around the current song.
  const qView = { start: 0, size: 200 };

  function queueRow(t, i) {
    return h('div', { class: 'qrow' + (i === player.index ? ' now' : ''), 'data-i': i },
      h('button', { class: 'qplay', type: 'button', title: `Play ${t.title}`, onclick: () => playIndex(i) },
        h('span', { class: 'qn' }, i === player.index && !audioEl.paused ? '♪' : i + 1),
        h('span', { class: 'qt' }, t.title),
        h('span', { class: 'qd' }, formatTime(t.duration_ms))),
      h('button', { class: 'qrm', type: 'button', 'aria-label': `Remove ${t.title} from the queue`, onclick: () => removeAt(i) }, icon('close')));
  }

  function renderQueue() {
    const box = $('#queue-list');
    if (!box) return;
    const q = player.queue;
    $('#queue-head').textContent = q.length ? (current() ? current().album || 'Playing' : 'Queue') : 'Nothing queued';
    $('#queue-total').textContent = `Total Time: ${formatTime(q.reduce((s, t) => s + (t.duration_ms || 0), 0))}`;
    $('#queue-count').textContent = q.length ? plural(q.length, 'song') : '';
    $('#queue-clear').hidden = !q.length;
    $('#queue-save').hidden = !q.length;
    box.replaceChildren();
    if (!q.length) {
      box.append(h('p', { class: 'queue-empty' }, 'Press play on an album, or choose songs in the Songs list, and they will line up here.'));
      return;
    }
    // keep the current song inside the window
    if (player.index >= 0 && (player.index < qView.start || player.index >= qView.start + qView.size)) {
      qView.start = Math.max(0, player.index - 30);
    }
    qView.start = Math.min(qView.start, Math.max(0, q.length - 1));
    const end = Math.min(q.length, qView.start + qView.size);
    if (qView.start > 0) {
      box.append(h('button', { class: 'qmore', type: 'button',
        onclick: () => { qView.start = Math.max(0, qView.start - 200); renderQueue(); } }, `▲ ${plural(qView.start, 'earlier song')}`));
    }
    const frag = document.createDocumentFragment();
    for (let i = qView.start; i < end; i++) frag.append(queueRow(q[i], i));
    box.append(frag);
    if (end < q.length) {
      box.append(h('button', { class: 'qmore', type: 'button',
        onclick: () => { qView.size += 200; renderQueue(); } }, `▼ ${plural(q.length - end, 'more song')}`));
    }
    const now = box.querySelector('.qrow.now');
    if (now && now.scrollIntoView) now.scrollIntoView({ block: 'nearest' });
  }

  // Play and pause only change the little note beside the current song.
  function markQueue() {
    const box = $('#queue-list');
    if (!box) return;
    box.querySelectorAll('.qrow').forEach((row) => {
      const i = Number(row.dataset.i);
      const on = i === player.index;
      row.classList.toggle('now', on);
      row.querySelector('.qn').textContent = on && !audioEl.paused ? '♪' : i + 1;
    });
  }

  // ---------- audio element events ----------
  audioEl.addEventListener('playing', () => { player.failRun = 0; });
  audioEl.addEventListener('play', () => { syncPlayState(); markQueue(); });
  audioEl.addEventListener('pause', () => { syncPlayState(); markQueue(); });
  audioEl.addEventListener('timeupdate', syncProgress);
  audioEl.addEventListener('loadedmetadata', syncProgress);
  audioEl.addEventListener('ended', () => nextTrack(false));
  audioEl.addEventListener('error', () => {
    if (!current() || !audioEl.getAttribute('src')) return;
    toast(`Can't play "${current().title}".`);
    if (++player.failRun >= player.queue.length) { player.failRun = 0; audioEl.pause(); syncPlayState(); toast("None of these songs can be played right now."); return; }
    const i = pickNext(true);
    if (i >= 0 && i !== player.index) playIndex(i); else { audioEl.pause(); syncPlayState(); }
  });

  function queueItem(kind, album, t) {
    return {
      kind, id: t.id, title: t.title, artist: t.artist || (album && album.artist) || '',
      album: t.album || (album && album.album) || '',
      cover: t.album_key || (kind === 'library' ? (album && album.id) : (album && album.cover)) || '',
      duration_ms: t.duration_ms || 0,
    };
  }

  function init() {
    buildBar(); buildNow();
    $('#queue-clear').addEventListener('click', clearQueue);
    renderQueue();
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target.matches && e.target.matches('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=radio])');
      if (typing) return;
      const t = e.target;
      if (t.closest && t.closest('dialog, [role=menu]')) return;
      if (t.matches && t.matches('input[type=range]') && e.key.startsWith('Arrow')) return;
      if (t.matches && t.matches('button, a, input[type=checkbox]') && e.key === ' ') return;
      const nowView = document.body.dataset.view === 'now' || document.fullscreenElement;
      if (e.key === ' ' && (e.target === document.body || nowView) && current()) { e.preventDefault(); togglePlay(); }
      else if (nowView && e.key === 'ArrowRight') { e.preventDefault(); viz.next(); }
      else if (nowView && e.key === 'ArrowLeft') { e.preventDefault(); viz.prev(); }
      else if (nowView && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFullscreen(); }
    });
  }

  window.IP.player = {
    init, playQueue, enqueue, playIndex, current, isCurrent, queueItem, transport, togglePlay, nextTrack,
    prevTrack, stop, clearQueue, onChange: (fn) => listeners.push(fn), syncPlayState, syncProgress, syncModes,
    viz: () => viz, state: player, toggleFullscreen,
  };
})();
