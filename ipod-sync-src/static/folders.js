/* Settings → Music folders: choose which folders on the Umbrel make up the library. */
(() => {
  'use strict';
  const { $, h, api, toast, icon } = window.IP;
  let chosen = [];
  let missing = [];
  let browsing = { path: '', data: null };

  const label = (rel) => (rel === '' ? 'Everything on this Umbrel' : rel.split('/').join('  ›  '));

  async function save(next) {
    try {
      const s = await api('/api/settings', { method: 'PUT', body: { music_folders: next } });
      chosen = s.music_folders;
      missing = s.missing_folders || [];
      renderChosen();
      toast('Music folders saved. Scanning your music…');
      window.IP.lib.refreshStatus();
      return true;
    } catch (err) {
      // A toast would sit behind the open dialog, so say it inside the dialog too.
      const hint = $('#fp-hint');
      if (hint && $('#folder-picker').open) { hint.textContent = err.message; hint.classList.add('error'); }
      else toast(err.message);
      return false;
    }
  }

  function renderChosen() {
    const box = $('#music-folders');
    box.replaceChildren(...chosen.map((rel) => h('li', {},
      h('span', { class: 'mf-name', title: rel || '/' }, h('span', { class: 'mf-icon', 'aria-hidden': 'true' }, '📁'), label(rel),
        missing.includes(rel) ? h('span', { class: 'mf-missing' }, 'not found right now') : null),
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
        f.selected ? h('span', { class: 'fp-state' }, 'In use')
          : h('button', {
            class: 'btn small', type: 'button',
            title: f.covered ? 'Use this folder instead of the ones chosen now' : `Add ${f.name}`,
            onclick: () => (f.covered ? onlyFolder(f.path) : addFolder(f.path)),
          }, f.covered ? 'Use only this' : 'Use')));
    });
    $('#fp-hint').classList.remove('error');
    $('#fp-hint').textContent = d.music_here ? 'This folder has music files in it.' : '';
    const use = $('#fp-use');
    const already = chosen.length === 1 && chosen[0] === d.path;
    use.disabled = already;
    use.textContent = already ? 'Already in use'
      : d.covered ? (d.path ? `Use only “${d.name}”` : 'Use everything')
        : (d.path ? `Use “${d.name}”` : 'Use everything');
  }

  async function addFolder(path) {
    if (chosen.includes(path)) return;
    if (await save([...chosen, path])) $('#folder-picker').close();
  }

  // Narrowing down: use this folder instead of the ones already chosen. Without it, someone
  // whose library is set to the whole Umbrel could never pick a smaller folder.
  async function onlyFolder(path) {
    if (await save([path])) $('#folder-picker').close();
  }

  function render(settings) {
    missing = (settings && settings.missing_folders) || [];
    chosen = (settings && settings.music_folders) || [''];
    renderChosen();
  }

  function init() {
    $('#fp-add').addEventListener('click', () => { $('#folder-picker').showModal(); browse(''); });
    $('#fp-use').addEventListener('click', () => {
      const d = browsing.data;
      (d && d.covered ? onlyFolder : addFolder)(browsing.path);
    });
    $('#fp-cancel').addEventListener('click', () => $('#folder-picker').close());
  }

  window.IP.folders = { init, render };
})();
