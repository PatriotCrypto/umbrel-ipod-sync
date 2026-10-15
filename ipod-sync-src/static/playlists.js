/* Playlists: the Playlists screen, the "add to playlist" menu and the small dialogs they share. */
(() => {
  'use strict';
  const { $, h, plural, formatLength, formatTime, api, toast, icon, art } = window.IP;
  const P = window.IP.player;
  const toItem = (t) => P.queueItem('library', null, t);

  // ---------- a small question box (name prompt / confirmation) ----------
  function ask({ title, message = '', input = false, value = '', ok = 'OK', danger = false }) {
    const dlg = $('#ask');
    $('#ask-title').textContent = title;
    $('#ask-msg').textContent = message;
    $('#ask-msg').hidden = !message;
    const field = $('#ask-input');
    field.hidden = !input; field.required = input; field.value = value;
    const okBtn = $('#ask-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger); okBtn.classList.toggle('primary', !danger);
    return new Promise((resolve) => {
      const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue === 'ok' ? (input ? field.value.trim() : true) : null); };
      dlg.returnValue = '';
      dlg.addEventListener('close', done);
      $('#ask-cancel').onclick = () => dlg.close('cancel');
      dlg.showModal();
      if (input) { field.focus(); field.select(); } else okBtn.focus();
    });
  }

  // ---------- data ----------
  const lists = { items: [], loaded: false, selected: Number(window.IP.prefs.get('playlist', '0')) || 0, detail: null };

  async function loadLists() {
    try {
      lists.items = (await api('/api/playlists')).playlists;
      lists.loaded = true;
    } catch (err) { toast(err.message); }
    const n = $('#nav-playlists-count');
    if (n) n.textContent = lists.items.length ? String(lists.items.length) : '';
    return lists.items;
  }

  const meta = (p) => [plural(p.tracks, 'song'), p.tracks ? formatLength(p.duration_ms) : ''].filter(Boolean).join(' · ');

  // ---------- add-to-playlist menu ----------
  let openMenuEl = null;
  function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.el.remove();
    document.removeEventListener('pointerdown', openMenuEl.onDown, true);
    document.removeEventListener('keydown', openMenuEl.onKey, true);
    window.removeEventListener('resize', closeMenu);
    window.IP.scroller().removeEventListener('scroll', closeMenu);
    const anchor = openMenuEl.anchor;
    openMenuEl = null;
    if (anchor && document.contains(anchor)) anchor.setAttribute('aria-expanded', 'false');
  }

  /* menu(anchor, { ids, items, label }): `ids` are library song ids (or a function returning
     them), `items` optionally returns queue items so "Add to queue" is offered too. */
  function menu(anchor, opts) {
    closeMenu();
    const pop = h('div', { class: 'menu-pop', role: 'menu', 'aria-label': 'Add to…' });
    const getIds = async () => (typeof opts.ids === 'function' ? await opts.ids() : opts.ids) || [];
    const add = async (id) => {
      closeMenu();
      try {
        const ids = await getIds();
        const r = await api(`/api/playlists/${id}/tracks`, { method: 'POST', body: { track_ids: ids } });
        const p = lists.items.find((x) => x.id === id);
        toast(r.added ? `Added ${plural(r.added, 'song')} to “${p ? p.name : 'playlist'}”.` + (r.skipped ? ` ${r.skipped} already there.` : '')
          : 'Those songs are already in that playlist.');
        await loadLists();
        if (document.body.dataset.view === 'playlists') showPlaylists(true);
      } catch (err) { toast(err.message); }
    };
    const create = async () => {
      closeMenu();
      const name = await ask({ title: 'New playlist', message: 'Give your playlist a name.', input: true, value: opts.label || '', ok: 'Create' });
      if (!name) return;
      try {
        const ids = await getIds();
        const made = await api('/api/playlists', { method: 'POST', body: { name, track_ids: ids } });
        toast(`Created “${made.name}” with ${plural(made.added, 'song')}.`);
        lists.selected = made.id; window.IP.prefs.set('playlist', made.id);
        await loadLists();
        if (document.body.dataset.view === 'playlists') showPlaylists(true);
      } catch (err) { toast(err.message); }
    };
    const item = (label, onclick, cls = '') => h('button', { class: `menu-item ${cls}`, type: 'button', role: 'menuitem', onclick }, label);
    const render = () => {
      pop.replaceChildren();
      if (opts.items) pop.append(item('Add to queue', () => { closeMenu(); P.enqueue(opts.items()); }));
      pop.append(h('div', { class: 'menu-head' }, 'Add to playlist'), item('＋ New playlist…', create, 'strong'));
      const box = h('div', { class: 'menu-lists' });
      lists.items.forEach((p) => box.append(item(h('span', { class: 'mi-name' }, p.name), () => add(p.id))));
      if (!lists.items.length) box.append(h('div', { class: 'menu-empty' }, 'No playlists yet'));
      pop.append(box);
    };
    render();
    document.body.append(pop);
    anchor.setAttribute('aria-expanded', 'true');
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth, ht = pop.offsetHeight;
      let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      let top = r.bottom + 6;
      if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 6);
      pop.style.left = `${left}px`; pop.style.top = `${top}px`;
    };
    place();
    const onDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...pop.querySelectorAll('.menu-item')];
        const at = items.indexOf(document.activeElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.IP.scroller().addEventListener('scroll', closeMenu, { passive: true });
    openMenuEl = { el: pop, anchor, onDown, onKey };
    pop.querySelector('.menu-item').focus();
    loadLists().then(() => { if (openMenuEl && openMenuEl.el === pop) { render(); place(); } });
  }

  // ---------- the Playlists screen ----------
  const collage = (covers, name) => {
    const n = Math.min(4, Math.max(1, covers.length));
    return h('div', { class: `collage c${n} mini` }, (covers.length ? covers : ['']).slice(0, 4).map((c) => art(name, c || null, c || name)));
  };

  function renderCards() {
    const box = $('#pl-list');
    box.replaceChildren();
    if (!lists.items.length) {
      box.append(h('p', { class: 'muted small plist-hint' }, 'No playlists yet.'));
      return;
    }
    lists.items.forEach((p) => box.append(h('button', {
      class: 'plist-card', type: 'button', 'aria-current': String(p.id === lists.selected),
      onclick: () => { lists.selected = p.id; window.IP.prefs.set('playlist', p.id); renderCards(); loadDetail(); },
    }, collage(p.covers, p.name), h('span', { class: 'pc-text' }, h('strong', {}, p.name), h('small', {}, meta(p) || 'Empty')))));
  }

  async function loadDetail() {
    const box = $('#pl-detail');
    if (!lists.selected || !lists.items.some((p) => p.id === lists.selected)) {
      lists.selected = lists.items.length ? lists.items[0].id : 0;
    }
    if (!lists.selected) {
      lists.detail = null;
      box.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Make your first playlist'),
        'Press “New playlist”, or use the + next to any song or album, or save what is playing from Now Playing.'));
      return;
    }
    const want = lists.selected;
    try {
      const d = await api(`/api/playlists/${want}`);
      if (want !== lists.selected) return;
      lists.detail = d;
      renderDetail();
    } catch (err) { toast(err.message); }
  }

  const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  async function arrange(order) {
    const d = lists.detail;
    try {
      await api(`/api/playlists/${d.id}/arrange`, { method: 'POST', body: { order } });
      await loadLists(); renderCards();
      await loadDetail();
    } catch (err) { toast(err.message); }
  }

  function renderDetail() {
    const d = lists.detail, box = $('#pl-detail');
    const tracks = d.tracks;
    const covers = [...new Set(tracks.map((t) => t.album_key))].slice(0, 4);
    const play = (shuffle, at = 0) => {
      if (!tracks.length) { toast('This playlist is empty.'); return; }
      P.playQueue(shuffle ? shuffled(tracks.map(toItem)) : tracks.map(toItem), at);
    };
    const head = h('div', { class: 'plist-head' },
      h('div', { class: 'plist-art' }, collage(covers, d.name)),
      h('div', { class: 'plist-info' },
        h('h2', {}, d.name),
        h('div', { class: 'muted' }, [plural(tracks.length, 'song'), tracks.length ? formatLength(d.duration_ms) : ''].filter(Boolean).join(' · ')),
        d.missing ? h('div', { class: 'notice' }, `${plural(d.missing, 'song')} can’t be found right now (a folder or drive may be unavailable). They stay in the playlist and come back when the files do.`) : null,
        h('div', { class: 'plan-buttons' },
          h('button', { class: 'btn primary', type: 'button', disabled: !tracks.length, onclick: () => play(false) }, '▶ Play'),
          h('button', { class: 'btn', type: 'button', disabled: !tracks.length, onclick: () => play(true) }, 'Shuffle'),
          h('button', { class: 'btn', type: 'button', disabled: !tracks.length, onclick: () => P.enqueue(tracks.map(toItem)) }, 'Add to queue'),
          h('button', { class: 'btn', type: 'button', disabled: !tracks.length, title: 'Pick these songs to copy to your iPod',
            onclick: () => { window.IP.lib.selectTracks(tracks.map((t) => t.id)); } }, 'Copy to iPod'),
          h('button', { class: 'btn', type: 'button', onclick: renamePlaylist }, 'Rename'),
          h('button', { class: 'btn danger', type: 'button', onclick: deletePlaylist }, 'Delete'))));

    const table = h('div', { class: 'songtable pltable', role: 'table' },
      h('div', { class: 'songrow headrow', role: 'row' },
        h('span', {}), h('span', {}, 'Title'), h('span', {}, 'Artist'), h('span', {}, 'Album'), h('span', {}, 'Order'), h('span', { class: 'r' }, 'Time'), h('span', {})));
    const order = tracks.map((t) => t.pos);
    tracks.forEach((t, i) => {
      const move = (to) => { const o = order.slice(); [o[i], o[to]] = [o[to], o[i]]; arrange(o); };
      const row = h('div', { class: 'songrow' + (P.isCurrent('library', t.id) ? ' now' : ''), role: 'row', draggable: 'true', 'data-id': t.id, 'data-i': i },
        h('button', { class: 'rowplay', type: 'button', title: `Play ${t.title}`, 'aria-label': `Play ${t.title}`, onclick: () => play(false, i) }, icon('play')),
        h('span', { class: 'c-title', title: t.title }, t.title),
        h('span', { class: 'c-artist', title: t.artist }, t.artist),
        h('span', { class: 'c-album', title: t.album }, t.album),
        h('span', { class: 'mv' },
          h('button', { class: 'mvbtn', type: 'button', disabled: i === 0, 'aria-label': `Move ${t.title} up`, title: 'Move up', onclick: () => move(i - 1) }, '▲'),
          h('button', { class: 'mvbtn', type: 'button', disabled: i === tracks.length - 1, 'aria-label': `Move ${t.title} down`, title: 'Move down', onclick: () => move(i + 1) }, '▼')),
        h('span', { class: 'r' }, formatTime(t.duration_ms)),
        h('button', { class: 'rowadd rowdel', type: 'button', title: 'Remove from playlist', 'aria-label': `Remove ${t.title} from the playlist`,
          onclick: () => arrange(order.filter((_, k) => k !== i)) }, icon('close')));
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); table.querySelectorAll('.over').forEach((r) => r.classList.remove('over')); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('over'); });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isInteger(from) || from === i) return;
        const o = order.slice(); const [m] = o.splice(from, 1); o.splice(i, 0, m); arrange(o);
      });
      table.append(row);
    });
    box.replaceChildren(head, tracks.length ? table : h('div', { class: 'empty' }, h('strong', {}, 'Nothing here yet'),
      'Use the + next to any song or album to add it to this playlist.'));
  }

  async function renamePlaylist() {
    const d = lists.detail;
    const name = await ask({ title: 'Rename playlist', input: true, value: d.name, ok: 'Rename' });
    if (!name || name === d.name) return;
    try { await api(`/api/playlists/${d.id}`, { method: 'PUT', body: { name } }); await loadLists(); renderCards(); await loadDetail(); }
    catch (err) { toast(err.message); }
  }

  async function deletePlaylist() {
    const d = lists.detail;
    const yes = await ask({ title: `Delete “${d.name}”?`, message: 'The playlist goes away. Your songs are not touched.', ok: 'Delete playlist', danger: true });
    if (!yes) return;
    try {
      await api(`/api/playlists/${d.id}`, { method: 'DELETE' });
      lists.selected = 0; await loadLists(); renderCards(); await loadDetail();
    } catch (err) { toast(err.message); }
  }

  async function newPlaylist() {
    const name = await ask({ title: 'New playlist', message: 'Give your playlist a name.', input: true, ok: 'Create' });
    if (!name) return;
    try {
      const made = await api('/api/playlists', { method: 'POST', body: { name, track_ids: [] } });
      lists.selected = made.id; window.IP.prefs.set('playlist', made.id);
      await loadLists(); renderCards(); await loadDetail();
    } catch (err) { toast(err.message); }
  }

  async function saveQueue() {
    const q = (P.state.queue || []).filter((t) => t.kind === 'library');
    if (!q.length) { toast('Nothing from your library is queued.'); return; }
    const cur = P.current();
    const name = await ask({ title: 'Save as playlist', message: `${plural(q.length, 'song')} from the queue.`, input: true,
      value: cur && cur.album ? cur.album : 'My playlist', ok: 'Save' });
    if (!name) return;
    try {
      const made = await api('/api/playlists', { method: 'POST', body: { name, track_ids: q.map((t) => t.id) } });
      toast(`Saved “${made.name}” (${plural(made.added, 'song')}).`);
      lists.selected = made.id; window.IP.prefs.set('playlist', made.id);
      await loadLists();
    } catch (err) { toast(err.message); }
  }

  async function showPlaylists(keep) {
    if (!keep || !lists.loaded) await loadLists();
    renderCards();
    await loadDetail();
  }

  function init() {
    $('#pl-new').addEventListener('click', newPlaylist);
    $('#queue-save').addEventListener('click', saveQueue);
    P.onChange(() => {
      if (document.body.dataset.view !== 'playlists') return;
      document.querySelectorAll('#pl-detail .songrow[data-id]').forEach((r) => r.classList.toggle('now', P.isCurrent('library', Number(r.dataset.id))));
    });
    window.addEventListener('ipod:library-changed', () => { lists.loaded = false; });
    loadLists();
  }

  window.IP.playlists = { init, show: showPlaylists, menu, ask, saveQueue };
})();
