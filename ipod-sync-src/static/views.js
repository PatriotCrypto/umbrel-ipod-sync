/* Songs, Genres and Duplicates screens. */
(() => {
  'use strict';
  const { $, h, formatBytes, formatTime, formatLength, plural, norm, prefs, api, toast, icon, art } = window.IP;
  const P = window.IP.player;

  const toItem = (t) => P.queueItem('library', { album: t.album, artist: t.artist }, t);

  // =========================== Songs ===========================
  const songs = { q: '', genre: '', sort: prefs.get('songSort', 'artist'), items: [], total: 0, seq: 0,
                  loading: false, loaded: false, gen: -1, byId: new Map() };
  const PAGE = 250;

  function songsParams(extra) {
    return new URLSearchParams({ q: songs.q, genre: songs.genre, sort: songs.sort, ...extra });
  }

  async function loadSongs(reset) {
    if (!reset && songs.loading) return;
    const seq = reset ? ++songs.seq : songs.seq;
    songs.loading = true;
    if (reset) renderSongs();            // show the loading skeleton straight away
    let fresh = [];
    try {
      const offset = reset ? 0 : songs.items.length;
      const data = await api(`/api/library/tracks?${songsParams({ limit: PAGE, offset })}`);
      if (seq !== songs.seq) return;
      fresh = data.tracks;
      songs.items = reset ? fresh : songs.items.concat(fresh);
      fresh.forEach((t) => songs.byId.set(t.id, t));
      songs.total = data.total; songs.loaded = true; songs.gen = window.IP.lib.generation();
    } catch (err) { if (seq === songs.seq) toast(err.message); }
    finally { if (seq === songs.seq) songs.loading = false; }
    if (seq !== songs.seq) return;
    if (reset) renderSongs(); else appendSongs(fresh);
  }

  async function playSongs(startId, shuffle) {
    try {
      const data = await api(`/api/library/tracks?${songsParams({ limit: 5000, offset: 0 })}`);
      let items = data.tracks.map(toItem);
      if (!items.length) { toast('No songs to play.'); return; }
      let at = Math.max(0, items.findIndex((i) => i.id === startId));
      if (shuffle) {
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
        at = 0;
      }
      P.playQueue(items, at);
      if (data.total > items.length) toast(`Playing the first ${items.length} of ${data.total} songs.`);
    } catch (err) { toast(err.message); }
  }

  // Every song the list shows (respecting search and genre) goes in the iPod basket.
  async function addAllSongs() {
    try {
      const ids = [];
      for (let offset = 0; offset < 100000; offset += 5000) {
        const data = await api(`/api/library/tracks?${songsParams({ limit: 5000, offset })}`);
        data.tracks.forEach((t) => ids.push(t.id));
        if (ids.length >= data.total || !data.tracks.length) break;
      }
      if (!ids.length) { toast('No songs to add.'); return; }
      window.IP.lib.selectTracks(ids);
    } catch (err) { toast(err.message); }
  }

  function songRow(t) {
    return h('div', { class: 'songrow' + (P.isCurrent('library', t.id) ? ' now' : ''), role: 'row', 'data-id': t.id },
      h('button', { class: 'rowplay', type: 'button', 'data-act': 'play', title: `Play ${t.title}`, 'aria-label': `Play ${t.title}` }, icon('play')),
      h('span', { class: 'c-title', title: t.title }, t.title),
      h('span', { class: 'c-artist', title: t.artist }, t.artist),
      h('span', { class: 'c-album', title: t.album }, t.album),
      h('button', { class: 'chip', type: 'button', 'data-act': 'genre', title: `Only ${t.genre}` }, t.genre),
      h('span', { class: 'r' }, formatTime(t.duration_ms)),
      h('button', { class: 'rowadd', type: 'button', 'data-act': 'menu', title: 'Add to queue or a playlist', 'aria-label': `Add ${t.title} to the queue or a playlist`, 'aria-haspopup': 'menu' }, icon('plus')));
  }

  function songsClick(e) {
    const row = e.target.closest('.songrow[data-id]');
    if (!row) return;
    const t = songs.byId.get(Number(row.dataset.id));
    const act = e.target.closest('[data-act]');
    if (!t || !act) return;
    if (act.dataset.act === 'play') playSongs(t.id, false);
    else if (act.dataset.act === 'genre') { songs.genre = t.genre; syncSongControls(); loadSongs(true); }
    else if (act.dataset.act === 'menu') window.IP.playlists.menu(act, { ids: [t.id], items: () => [toItem(t)], label: t.title });
  }

  function moreButton() {
    return h('div', { class: 'more' }, h('button', { class: 'btn', type: 'button', onclick: () => loadSongs(false) },
      `Show more (${songs.total - songs.items.length} left)`));
  }

  function renderSongs() {
    const box = $('#songs-list');
    $('#songs-count').textContent = songs.loaded ? plural(songs.total, 'song') : '';
    box.replaceChildren();
    if (songs.loading && !songs.items.length) {
      box.append(h('div', { class: 'songtable skeleton', 'aria-busy': 'true', 'aria-label': 'Loading songs' },
        Array.from({ length: 12 }, () => h('div', { class: 'songrow' }, h('span', {}), h('span', { class: 'bar-s' }), h('span', { class: 'bar-s' }), h('span', { class: 'bar-s' })))));
      return;
    }
    if (songs.loaded && !songs.items.length) {
      box.append(h('div', { class: 'empty' }, h('strong', {}, songs.q || songs.genre ? 'No matches' : 'No music found yet'),
        songs.q || songs.genre ? 'Try a different search or genre.' : 'Add songs to a music folder on your Umbrel, or choose other folders in Settings.'));
      return;
    }
    const table = h('div', { class: 'songtable', role: 'table' },
      h('div', { class: 'songrow headrow', role: 'row' },
        h('span', {}), h('span', {}, 'Title'), h('span', {}, 'Artist'), h('span', {}, 'Album'), h('span', {}, 'Genre'), h('span', { class: 'r' }, 'Time'), h('span', {})));
    table.append(...songs.items.map(songRow));
    table.addEventListener('click', songsClick);
    table.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.songrow[data-id]');
      if (row && !e.target.closest('button')) playSongs(Number(row.dataset.id), false);
    });
    box.append(table);
    if (songs.items.length < songs.total) box.append(moreButton());
  }

  // "Show more" adds rows to the table instead of rebuilding it.
  function appendSongs(fresh) {
    const table = $('#songs-list .songtable');
    if (!table) { renderSongs(); return; }
    table.append(...fresh.map(songRow));
    $('#songs-list .more')?.remove();
    if (songs.items.length < songs.total) $('#songs-list').append(moreButton());
  }

  // Playing something only changes which row is highlighted.
  function markNow() {
    document.querySelectorAll('#songs-list .songrow[data-id]').forEach((row) => {
      row.classList.toggle('now', P.isCurrent('library', Number(row.dataset.id)));
    });
  }

  function syncSongControls() {
    $('#songs-genre').value = songs.genre;
    $('#songs-sort').value = songs.sort;
  }

  // The genre list is the same everywhere and only changes when the library does.
  const genreCache = { gen: -1, list: null, pending: null };
  async function genreList() {
    const gen = window.IP.lib.generation();
    if (genreCache.list && genreCache.gen === gen) return genreCache.list;
    if (!genreCache.pending) {
      genreCache.pending = api('/api/library/genres').then((r) => {
        genreCache.list = r.genres; genreCache.gen = gen; return r.genres;
      }).finally(() => { genreCache.pending = null; });
    }
    return genreCache.pending;
  }

  async function fillGenreSelect(select, current) {
    try {
      const genres = await genreList();
      select.replaceChildren(h('option', { value: '' }, 'All genres'),
        ...genres.map((g) => h('option', { value: g.name }, `${g.name} (${g.tracks})`)));
      select.value = current;
    } catch (_) { /* optional */ }
  }

  // =========================== Genres ===========================
  async function renderGenres() {
    const box = $('#genres-list');
    let genres = [];
    try { genres = await genreList(); } catch (err) { toast(err.message); }
    box.replaceChildren();
    $('#genres-count').textContent = genres.length ? plural(genres.length, 'genre') : '';
    if (!genres.length) {
      box.append(h('div', { class: 'empty' }, h('strong', {}, 'No music found yet'), 'Genres appear here once your library has been scanned.'));
      return;
    }
    box.append(h('div', { class: 'grid genres' }, genres.map((g) => {
      const covers = h('div', { class: 'collage c' + Math.min(4, Math.max(1, g.covers.length)) },
        g.covers.slice(0, 4).map((k) => art(g.name, k, k)));
      if (!g.covers.length) covers.append(art(g.name, '', g.name));
      const playGenre = async (shuffle) => {
        try {
          const data = await api(`/api/library/tracks?${new URLSearchParams({ genre: g.name, sort: 'artist', limit: 5000 })}`);
          const items = data.tracks.map(toItem);
          if (shuffle) for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
          P.playQueue(items, 0);
        } catch (err) { toast(err.message); }
      };
      return h('article', { class: 'tile genre-tile' },
        h('button', { class: 'open', type: 'button', 'aria-label': `Browse ${g.name}`, onclick: () => window.IP.nav.go('library', { genre: g.name }) },
          h('div', { class: 'collage-wrap', style: `--hue:${window.IP.hueOf(g.name)}` }, covers, h('div', { class: 'genre-name' }, g.name)),
          h('div', { class: 'meta' },
            h('div', { class: 's' }, `${plural(g.album_count, 'album')} · ${plural(g.tracks, 'song')}`),
            h('div', { class: 'x' }, `${formatLength(g.duration_ms)} · ${formatBytes(g.size)}`))),
        h('button', { class: 'play-fab', type: 'button', title: `Play ${g.name}`, 'aria-label': `Play ${g.name}`, onclick: () => playGenre(false) }, icon('play')),
        h('button', { class: 'btn small shuffle-btn', type: 'button', onclick: () => playGenre(true) }, 'Shuffle'));
    })));
  }

  // =========================== Duplicates ===========================
  const dupes = { result: null, selected: new Set(), shown: 40, busy: false, message: '' };

  async function refreshTrash() {
    try {
      const data = await api('/api/library/duplicates');
      return data.trash;
    } catch (_) { return null; }
  }

  async function scanDupes() {
    dupes.busy = true; dupes.message = ''; renderDupes();
    try {
      const data = await api('/api/library/duplicates');
      dupes.result = data;
      dupes.selected = new Set();
      data.groups.forEach((g) => g.items.forEach((it) => { if (!it.keep) dupes.selected.add(it.id); }));
      dupes.shown = 40;
    } catch (err) { toast(err.message); }
    dupes.busy = false; renderDupes();
  }

  function toggleDupe(group, item, on) {
    if (on) {
      dupes.selected.add(item.id);
      if (group.items.every((it) => dupes.selected.has(it.id))) dupes.selected.delete(group.items[0].id);   // one copy always stays
    } else dupes.selected.delete(item.id);
    renderDupes();
  }

  async function deleteDupes() {
    const ids = [...dupes.selected];
    if (!ids.length) return;
    let bytes = 0;
    dupes.result.groups.forEach((g) => g.items.forEach((it) => { if (dupes.selected.has(it.id)) bytes += it.size; }));
    if (!confirm(`Move ${plural(ids.length, 'duplicate file')} (${formatBytes(bytes)}) to the trash?\n\n` +
                 'One copy of every song stays in your library. Nothing is erased until you empty the trash, and you can restore everything from here.')) return;
    dupes.busy = true; renderDupes();
    try {
      const out = await api('/api/library/duplicates/delete', { method: 'POST', body: { ids } });
      dupes.message = `Moved ${plural(out.moved, 'file')} (${formatBytes(out.bytes)}) to the trash.` +
        (out.failed.length ? ` ${out.failed.length} could not be moved.` : '');
      dupes.result = null;
      window.IP.lib.libraryChanged();
      const again = await api('/api/library/duplicates');
      dupes.result = again;
      dupes.selected = new Set();
      again.groups.forEach((g) => g.items.forEach((it) => { if (!it.keep) dupes.selected.add(it.id); }));
    } catch (err) { toast(err.message); }
    dupes.busy = false; renderDupes();
  }

  async function restoreTrash() {
    try {
      const out = await api('/api/library/trash/restore', { method: 'POST' });
      dupes.message = `Put ${plural(out.restored, 'file')} back in your library.` + (out.left_in_trash ? ` ${out.left_in_trash} stayed in the trash because a file with that name already exists.` : '');
      setTimeout(() => { window.IP.lib.libraryChanged(); scanDupes(); }, 1200);
    } catch (err) { toast(err.message); }
    renderDupes();
  }

  async function emptyTrash() {
    const t = dupes.result && dupes.result.trash;
    if (!confirm(`Permanently erase ${plural(t ? t.files : 0, 'file')} (${formatBytes(t ? t.bytes : 0)}) from the trash? This cannot be undone.`)) return;
    try {
      const out = await api('/api/library/trash/empty', { method: 'POST', body: { confirm: true } });
      dupes.message = `Erased ${plural(out.emptied.files, 'file')}, freeing ${formatBytes(out.emptied.bytes)}.`;
      if (dupes.result) dupes.result.trash = out.trash;
    } catch (err) { toast(err.message); }
    renderDupes();
  }

  function dupItem(group, it) {
    const checked = dupes.selected.has(it.id);
    const fmt = [it.codec ? it.codec.toUpperCase() : '', it.bitrate ? `${it.bitrate} kbps` : ''].filter(Boolean).join(' ');
    return h('label', { class: 'dupitem' + (it.keep ? ' keep' : '') + (checked ? ' marked' : '') },
      h('input', { type: 'checkbox', checked, 'aria-label': `Delete this copy of ${group.title} from ${it.album}`, onchange: (e) => toggleDupe(group, it, e.target.checked) }),
      h('span', { class: 'd-album', title: it.album }, it.album || 'Unknown album'),
      h('span', { class: 'd-path', title: it.path }, it.path),
      h('span', { class: 'd-fmt' }, fmt),
      h('span', { class: 'd-size' }, `${formatBytes(it.size)} · ${formatTime(it.duration_ms)}`),
      it.keep ? h('span', { class: 'tag' }, 'Best copy') : h('span', {}),
      h('button', { class: 'rowplay', type: 'button', title: 'Listen', 'aria-label': `Listen to this copy of ${group.title}`,
        onclick: (e) => { e.preventDefault(); P.playQueue([{ kind: 'library', id: it.id, title: group.title, artist: group.artist, album: it.album, cover: it.album_key, duration_ms: it.duration_ms }], 0); } }, icon('play')));
  }

  function renderDupes() {
    const box = $('#dupes-body');
    box.replaceChildren();
    const r = dupes.result;
    const scanBtn = h('button', { class: 'btn primary big', type: 'button', disabled: dupes.busy, onclick: scanDupes },
      dupes.busy ? 'Working…' : r ? 'Scan again' : 'Scan for duplicates');
    box.append(h('div', { class: 'dupe-hero' },
      h('div', {}, h('h2', {}, 'Duplicate finder'),
        h('p', { class: 'muted' }, 'Finds songs with the same title and artist, such as songs that appear on more than one album. You choose what goes; one copy of every song always stays.')),
      scanBtn));
    if (dupes.message) box.append(h('div', { class: 'notice ok' }, dupes.message));
    if (r && !r.can_delete) box.append(h('div', { class: 'notice error' }, h('strong', {}, 'The music folder is read-only'), 'Update the app to its latest version, then scan again.'));
    if (r && r.trash && r.trash.files) {
      box.append(h('div', { class: 'trashbar' },
        h('span', {}, icon('trash'), ` Trash: ${plural(r.trash.files, 'file')} · ${formatBytes(r.trash.bytes)}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', onclick: restoreTrash }, 'Restore all'),
        h('button', { class: 'btn small danger', type: 'button', onclick: emptyTrash }, 'Empty trash')));
    }
    if (!r) { if (!dupes.busy) box.append(h('div', { class: 'empty' }, h('strong', {}, 'Ready when you are'), 'Press “Scan for duplicates”. Nothing is changed by scanning.')); return; }
    if (!r.groups.length) { box.append(h('div', { class: 'empty' }, h('strong', {}, 'No duplicates found'), 'Every song in your library appears only once.')); return; }

    const n = dupes.selected.size;
    let selBytes = 0;
    r.groups.forEach((g) => g.items.forEach((it) => { if (dupes.selected.has(it.id)) selBytes += it.size; }));
    box.append(h('div', { class: 'dupe-summary' },
      h('div', {}, h('strong', {}, plural(r.groups.length, 'song')), ` appear more than once, ${plural(r.files, 'extra copy', 'extra copies')} using ${formatBytes(r.bytes)}.`),
      h('div', { class: 'dupe-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { dupes.selected = new Set(); r.groups.forEach((g) => g.items.forEach((it) => { if (!it.keep) dupes.selected.add(it.id); })); renderDupes(); } }, 'Select all extra copies'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { dupes.selected = new Set(); renderDupes(); } }, 'Select none'),
        h('button', { class: 'btn danger', type: 'button', disabled: !n || !r.can_delete || dupes.busy, onclick: deleteDupes },
          n ? `Delete ${plural(n, 'selected copy', 'selected copies')} (${formatBytes(selBytes)})` : 'Nothing selected'))));
    const list = h('div', { class: 'dupelist' });
    r.groups.slice(0, dupes.shown).forEach((g) => list.append(h('section', { class: 'dupegroup' },
      h('header', {}, h('strong', {}, g.title), h('span', { class: 'muted' }, ` by ${g.artist}`), h('span', { class: 'count' }, `${g.items.length} copies`)),
      g.items.map((it) => dupItem(g, it)))));
    box.append(list);
    if (r.groups.length > dupes.shown) {
      box.append(h('div', { class: 'more' }, h('button', { class: 'btn', type: 'button', onclick: () => { dupes.shown += 60; renderDupes(); } },
        `Show more (${r.groups.length - dupes.shown} left)`)));
    }
  }

  // =========================== wiring ===========================
  function init() {
    let timer = null;
    $('#songs-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { songs.q = e.target.value.trim(); loadSongs(true); }, 250); });
    $('#songs-genre').addEventListener('change', (e) => { songs.genre = e.target.value; loadSongs(true); });
    $('#songs-sort').addEventListener('change', (e) => { songs.sort = e.target.value; prefs.set('songSort', songs.sort); loadSongs(true); });
    $('#songs-play').addEventListener('click', () => playSongs(undefined, false));
    $('#songs-shuffle').addEventListener('click', () => playSongs(undefined, true));
    $('#songs-add').addEventListener('click', addAllSongs);
    P.onChange(() => { if (document.body.dataset.view === 'songs') markNow(); });
    window.IP.scroller().addEventListener('scroll', () => {
      if (document.body.dataset.view !== 'songs' || songs.loading || songs.items.length >= songs.total) return;
      if (window.IP.nearEnd($('#songs-list .more'), 500)) loadSongs(false);
    }, { passive: true });
    window.addEventListener('ipod:library-changed', () => {
      songs.loaded = false;
      if (document.body.dataset.view === 'songs') loadSongs(true);
    });
    syncSongControls();
  }

  window.IP.views = {
    init,
    showSongs() {
      fillGenreSelect($('#songs-genre'), songs.genre); syncSongControls();
      if (!songs.loaded || songs.gen !== window.IP.lib.generation()) loadSongs(true); else markNow();
    },
    showGenres: renderGenres,
    showDupes() { renderDupes(); refreshTrash().then((trash) => { if (trash && trash.files && !dupes.result) { dupes.result = null; } }); },
    setSongsGenre(name) { songs.genre = name || ''; },
  };
})();
