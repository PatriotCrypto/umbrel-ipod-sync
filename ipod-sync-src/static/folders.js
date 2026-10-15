/* Settings → Music folders: choose which folders on the Umbrel make up the library. */
(() => {
  'use strict';
  const { $, h, api, toast, icon } = window.IP;
  let chosen = [];
  let browsing = { path: '', data: null };

  const label = (rel) => (rel === '' ? 'Everything on this Umbrel' : rel.split('/').join('  ›  '));

  async function save(next) {
    try {
      const s = await api('/api/settings', { method: 'PUT', body: { music_folders: next } });
      chosen = s.music_folders;
      renderChosen();
      toast('Music folders saved. Scanning your music…');
      window.IP.lib.refreshStatus();
    } catch (err) { toast(err.message); }
  }

  function renderChosen() {
    const box = $('#music-folders');
    box.replaceChildren(...chosen.map((rel) => h('li', {},
      h('span', { class: 'mf-name', title: rel || '/' }, h('span', { class: 'mf-icon', 'aria-hidden': 'true' }, '📁'), label(rel)),
      h('button', {
        class: 'btn small', type: 'button', disabled: chosen.length < 2,
        title: chosen.length < 2 ? 'Keep at least one folder' : 'Stop using this folder',
        onclick: () => save(chosen.filter((c) => c !== rel)),
      }, 'Remove'))));
  }

  async function browse(path) {
    const list = $('#fp-list');
    list.replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
    try {
      const d = await api(`/api/folders?path=${encodeURIComponent(path)}`);
      browsing = { path: d.path, data: d };
      renderBrowser();
    } catch (err) {
      list.replaceChildren(h('li', { class: 'notice error' }, err.message));
    }
  }

  function renderBrowser() {
    const d = browsing.data;
    // breadcrumbs
    const parts = d.path ? d.path.split('/') : [];
    const crumbs = [h('button', { class: 'crumb', type: 'button', onclick: () => browse('') }, 'Your Umbrel')];
    parts.forEach((p, i) => {
      crumbs.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'));
      crumbs.push(h('button', { class: 'crumb', type: 'button', 'aria-current': String(i === parts.length - 1), onclick: () => browse(parts.slice(0, i + 1).join('/')) }, p));
    });
    $('#fp-crumbs').replaceChildren(...crumbs);

    const list = $('#fp-list');
    list.replaceChildren();
    if (!d.folders.length) list.append(h('li', { class: 'muted fp-empty' }, 'No folders in here.'));
    d.folders.forEach((f) => {
      list.append(h('li', { class: 'fp-row' + (f.covered ? ' covered' : '') },
        h('button', { class: 'fp-open', type: 'button', onclick: () => browse(f.path), title: `Open ${f.name}` },
          h('span', { class: 'mf-icon', 'aria-hidden': 'true' }, '📁'), h('span', { class: 'fp-name' }, f.name),
          f.music ? h('span', { class: 'fp-music', title: 'Has music files' }, '♪') : null),
        f.covered ? h('span', { class: 'fp-state' }, f.selected ? 'In use' : 'Included')
          : h('button', { class: 'btn small', type: 'button', onclick: () => addFolder(f.path) }, 'Use')));
    });
    $('#fp-hint').textContent = d.music_here ? 'This folder has music files in it.' : '';
    const use = $('#fp-use');
    use.disabled = d.covered;
    use.textContent = d.covered ? 'Already included' : (d.path ? `Use “${d.name}”` : 'Use everything');
  }

  async function addFolder(path) {
    if (chosen.includes(path)) return;
    await save([...chosen, path]);
    $('#folder-picker').close();
  }

  function render(settings) {
    chosen = (settings && settings.music_folders) || [''];
    renderChosen();
  }

  function init() {
    $('#fp-add').addEventListener('click', () => { $('#folder-picker').showModal(); browse(''); });
    $('#fp-use').addEventListener('click', () => addFolder(browsing.path));
    $('#fp-cancel').addEventListener('click', () => $('#folder-picker').close());
  }

  window.IP.folders = { init, render };
})();
