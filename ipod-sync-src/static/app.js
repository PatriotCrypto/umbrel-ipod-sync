/* Wires the sections together: navigation, skins, start-up. */
(() => {
  'use strict';
  const { $, h, prefs } = window.IP;

  const SKINS = [
    { id: 'aqua', name: 'Aqua', note: 'Glossy blue and silver', colors: ['#6bbcff', '#1566d0', '#e9eff8'] },
    { id: 'graphite', name: 'Graphite', note: 'Brushed grey', colors: ['#c4cad3', '#5d6673', '#eef0f3'] },
    { id: 'midnight', name: 'Midnight', note: 'Dark with neon green', colors: ['#27364f', '#0b1220', '#58f07c'] },
    { id: 'sunset', name: 'Sunset', note: 'Warm orange and plum', colors: ['#ffb066', '#d4561a', '#fff1e3'] },
  ];

  function setSkin(id) {
    const skin = SKINS.find((s) => s.id === id) || SKINS[0];
    document.body.dataset.skin = skin.id;
    prefs.set('skin', skin.id);
    document.querySelectorAll('#skin-list button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.skin === skin.id)));
  }

  function buildSkinList() {
    $('#skin-list').replaceChildren(...SKINS.map((s) => h('button', {
      type: 'button', class: 'skin', 'data-skin': s.id, 'aria-pressed': 'false',
      onclick: () => setSkin(s.id),
    }, h('span', { class: 'swatches' }, s.colors.map((c) => h('i', { style: `background:${c}` }))),
    h('strong', {}, s.name), h('small', {}, s.note))));
  }

  const VIEWS = ['now', 'library', 'songs', 'playlists', 'genres', 'dupes'];
  let currentNav = 'now';

  function go(where, options = {}) {
    // "ipod" is the Library screen showing what is on the iPod.
    const view = where === 'ipod' ? 'library' : where;
    currentNav = where;
    if (document.fullscreenElement) document.exitFullscreen();
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    document.body.dataset.view = view;
    document.querySelectorAll('.railbtn[data-go]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.go === where)));
    if (view === 'library') {
      if (options.genre !== undefined) window.IP.lib.setGenre(options.genre);
      window.IP.lib.showTab(where === 'ipod' ? 'ipod' : 'library');
    }
    if (view === 'songs') window.IP.views.showSongs();
    if (view === 'playlists') window.IP.playlists.show();
    if (view === 'genres') window.IP.views.showGenres();
    if (view === 'dupes') window.IP.views.showDupes();
    if (view === 'now') { const v = window.IP.player.viz(); if (v) v.start(); } else { const v = window.IP.player.viz(); if (v) v.stop(); }
    prefs.set('nav', where);
    window.IP.scroller().scrollTop = 0;
  }

  window.IP.nav = { go, current: () => currentNav };

  function init() {
    buildSkinList();
    setSkin(prefs.get('skin', 'aqua'));
    $('#nav-skins').addEventListener('click', () => $('#skins').showModal());
    document.querySelectorAll('.railbtn[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    window.IP.player.init();
    window.IP.lib.init();
    window.IP.views.init();
    window.IP.folders.init();
    window.IP.playlists.init();
    window.IP.rip.init();
    const saved = prefs.get('nav', 'now');
    go(['now', 'library', 'songs', 'playlists', 'genres', 'ipod', 'dupes'].includes(saved) ? saved : 'now');
    // Picking something to play from the iPod shows the visualizer, like a media player would.
  }

  init();
})();
