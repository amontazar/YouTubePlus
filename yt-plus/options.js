(() => {
  'use strict';

  const KEYS = { folders: 'ytFolders_v1', map: 'ytChannelFolderMap_v1', ui: 'ytUI_v1' };
  const STORE = chrome.storage?.sync ?? chrome.storage?.local;

  const els = {
    folderList: document.getElementById('folderList'),
    addFolder: document.getElementById('addFolder'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    resetBtn: document.getElementById('resetBtn'),
    jsonBox: document.getElementById('jsonBox'),
    status: document.getElementById('status')
  };

  let folders = [];
  let map = {};

  function uid() { return 'f_' + Math.random().toString(16).slice(2) + Date.now().toString(16); }
  function sanitizeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#999999'; }

  function setStatus(msg, kind) {
    els.status.textContent = msg;
    els.status.className = 'tiny ' + (kind || '');
    if (msg) setTimeout(() => { if (els.status.textContent === msg) els.status.textContent = ''; }, 2500);
  }

  function render() {
    els.folderList.innerHTML = '';
    if (!folders.length) {
      const p = document.createElement('div');
      p.className = 'tiny';
      p.textContent = 'No folders yet. Click “Add folder”.';
      els.folderList.appendChild(p);
      return;
    }

    for (const f of folders) {
      const row = document.createElement('div');
      row.className = 'row';

      const name = document.createElement('input');
      name.type = 'text';
      name.value = f.name;
      name.placeholder = 'Folder name';

      const color = document.createElement('input');
      color.type = 'color';
      color.value = sanitizeColor(f.color);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Delete';

      name.addEventListener('input', () => { f.name = name.value.trim() || 'Untitled'; saveFolders(); });
      color.addEventListener('input', () => { f.color = sanitizeColor(color.value); saveFolders(); });

      del.addEventListener('click', async () => {
        const id = f.id;
        folders = folders.filter(x => x.id !== id);

        for (const k of Object.keys(map)) {
          const arr = map[k] || [];
          const next = arr.filter(fid => fid !== id);
          if (next.length) map[k] = Array.from(new Set(next));
          else delete map[k];
        }

        await STORE.set({ [KEYS.folders]: folders, [KEYS.map]: map });
        setStatus('Deleted folder.', 'ok');
        render();
      });

      row.appendChild(name);
      row.appendChild(color);
      row.appendChild(del);
      els.folderList.appendChild(row);
    }
  }

  let saveTimer = null;
  function saveFolders() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await STORE.set({ [KEYS.folders]: folders });
      setStatus('Saved.', 'ok');
    }, 200);
  }

  async function load() {
    const res = await STORE.get([KEYS.folders, KEYS.map]);
    folders = Array.isArray(res[KEYS.folders]) ? res[KEYS.folders] : [];
    map = res[KEYS.map] && typeof res[KEYS.map] === 'object' ? res[KEYS.map] : {};
    render();
  }

  els.addFolder.addEventListener('click', async () => {
    folders.push({ id: uid(), name: 'New folder', color: '#3ea6ff' });
    await STORE.set({ [KEYS.folders]: folders });
    setStatus('Added folder.', 'ok');
    render();
  });

  els.exportBtn.addEventListener('click', async () => {
    const res = await STORE.get([KEYS.folders, KEYS.map, KEYS.ui]);
    const payload = { folders: res[KEYS.folders] || [], map: res[KEYS.map] || {}, ui: res[KEYS.ui] || {} };
    els.jsonBox.value = JSON.stringify(payload, null, 2);
    try { await navigator.clipboard.writeText(els.jsonBox.value); setStatus('Exported + copied to clipboard.', 'ok'); }
    catch { setStatus('Exported. (Clipboard blocked by browser)', ''); }
  });

  els.importBtn.addEventListener('click', async () => {
    try {
      const obj = JSON.parse(els.jsonBox.value.trim());
      if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON object.');
      if (!Array.isArray(obj.folders)) throw new Error('Missing "folders" array.');
      if (!obj.map || typeof obj.map !== 'object') throw new Error('Missing "map" object.');

      folders = obj.folders.map(f => ({
        id: String(f.id || uid()),
        name: String(f.name || 'Untitled'),
        color: sanitizeColor(String(f.color || '#999999'))
      }));

      map = {};
      for (const [k, v] of Object.entries(obj.map)) {
        if (!Array.isArray(v)) continue;
        map[String(k)] = Array.from(new Set(v.map(x => String(x)).filter(Boolean)));
      }

      await STORE.set({
        [KEYS.folders]: folders,
        [KEYS.map]: map,
        [KEYS.ui]: obj.ui && typeof obj.ui === 'object' ? obj.ui : {}
      });

      setStatus('Imported.', 'ok');
      render();
    } catch (e) {
      setStatus('Import failed: ' + (e?.message || String(e)), 'err');
    }
  });

  els.resetBtn.addEventListener('click', async () => {
    const ok = confirm('Reset all folders and channel assignments? This cannot be undone.');
    if (!ok) return;

    await STORE.set({ [KEYS.folders]: [], [KEYS.map]: {}, [KEYS.ui]: { filterFolderId: 'ALL' } });
    setStatus('Reset complete.', 'ok');
    await load();
  });

  load().catch(err => setStatus('Load failed: ' + err.message, 'err'));
})();
