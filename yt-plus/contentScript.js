(() => {
  'use strict';

  const KEYS = { folders: 'ytFolders_v1', map: 'ytChannelFolderMap_v1', ui: 'ytUI_v1' };
  const STORE = chrome.storage?.sync ?? chrome.storage?.local;

  const state = {
    folders: /** @type {Array<{id:string,name:string,color:string}>} */ ([]),
    map: /** @type {Record<string, string[]>} */ ({}),
    ui: /** @type {{filterFolderId?: string}} */ ({ filterFolderId: 'ALL' }),
    lastHref: location.href,
    dragChannelKey: null,
    dragChannelKeys: null
  };

  function uid() { return 'f_' + Math.random().toString(16).slice(2) + Date.now().toString(16); }
function canonicalizeChannelKey(href) {
    try {
      const u = new URL(href, location.origin);
      u.hash = '';
      u.search = '';

      let path = (u.pathname || '').replace(/\/+$/, '');

      // /channel/UC...
      let m = path.match(/^\/channel\/(UC[a-zA-Z0-9_-]{10,})/);
      if (m) return `https://www.youtube.com/channel/${m[1]}`;

      // /@handle
      m = path.match(/^\/@[^\/?#]+/);
      if (m) return `https://www.youtube.com${m[0]}`;

      // /c/name
      m = path.match(/^\/c\/[^\/?#]+/);
      if (m) return `https://www.youtube.com${m[0]}`;

      // /user/name
      m = path.match(/^\/user\/[^\/?#]+/);
      if (m) return `https://www.youtube.com${m[0]}`;

      return null;
    } catch {
      return null;
    }
  }

  function normalizeChannelHref(href) {
    // Normalize ANY channel-ish URL into our canonical key
    const c = canonicalizeChannelKey(href);
    if (c) return c;

    // Fallback to old behavior (still forces www.youtube.com)
    try {
      const u = new URL(href, location.origin);
      const path = (u.pathname || '').replace(/\/+$/, '');
      return `https://www.youtube.com${path}`;
    } catch { return href; }
  }

  function migrateMapToCanonical() {
    if (!state.map || typeof state.map !== 'object') return false;

    const next = {};
    let changed = false;

    for (const [k, v] of Object.entries(state.map)) {
      const ck = canonicalizeChannelKey(k) || k;
      const ids = Array.isArray(v) ? v.filter(Boolean) : [];
      if (!ids.length) { changed = true; continue; }

      const prev = next[ck] || [];
      const merged = Array.from(new Set(prev.concat(ids)));
      next[ck] = merged;

      if (ck !== k) changed = true;
    }

    if (changed) state.map = next;
    return changed;
  }
  function keyFromChannelId(channelId) {
    const id = (channelId || '').trim();
    if (!/^UC[a-zA-Z0-9_-]{10,}$/.test(id)) return null;
    return `https://www.youtube.com/channel/${id}`;
  }

  function extractChannelIdFromText(s) {
    if (!s) return null;
    const m = String(s).match(/UC[a-zA-Z0-9_-]{10,}/);
    return m ? m[0] : null;
  }

  function extractChannelKeysFromElement(rootEl) {
    /** @type {string[]} */
    const keys = [];

    // 1) Prefer UC channel id if present in attributes
    const attrsToCheck = [
      'channel-external-id',
      'data-channel-external-id',
      'data-channel-id',
      'channel-id',
      'data-channel',
      'data-channel-externalid'
    ];
    for (const attr of attrsToCheck) {
      const v = rootEl?.getAttribute?.(attr);
      const id = extractChannelIdFromText(v);
      const k = keyFromChannelId(id);
      if (k) keys.push(k);
    }

    // 2) Try descendants for those attributes too (YouTube often sets them on inner nodes)
    try {
      const any = rootEl?.querySelectorAll?.('[channel-external-id],[data-channel-external-id],[data-channel-id],[channel-id]');
      if (any && any.length) {
        for (const el of any) {
          for (const attr of attrsToCheck) {
            const v = el.getAttribute(attr);
            const id = extractChannelIdFromText(v);
            const k = keyFromChannelId(id);
            if (k) keys.push(k);
          }
        }
      }
    } catch {}

    // 3) Collect channel anchors (handle / channel / c / user)
    try {
      const links = rootEl?.querySelectorAll?.('a[href^="/channel/"], a[href^="/@"], a[href^="/c/"], a[href^="/user/"]');
      if (links && links.length) {
        for (const a of links) {
          const href = a.getAttribute('href');
          if (!href) continue;
          // if it's a /channel/UC... link, also convert to canonical channel-id key
          if (href.startsWith('/channel/')) {
            const id = extractChannelIdFromText(href);
            const k = keyFromChannelId(id);
            if (k) keys.push(k);
          }
          keys.push(normalizeChannelHref(href));
        }
      }
    } catch {}

    // 4) De-dupe + pick primary
    const uniq = Array.from(new Set(keys.filter(Boolean)));
    const primary = uniq.find(k => k.includes('/channel/UC')) || uniq[0] || null;
    return { primary, keys: uniq };
  }

  function unionFolderIdsForKeys(keys) {
    const out = new Set();
    for (const k of keys || []) {
      for (const id of getFolderIdsForChannel(k)) out.add(id);
    }
    return Array.from(out);
  }

  function setFolderIdsForAllKeys(keys, ids) {
    for (const k of keys || []) setFolderIdsForChannel(k, ids);
  }

  function toggleFolderForAllKeys(keys, folderId, enabled) {
    for (const k of keys || []) toggleChannelFolder(k, folderId, enabled);
  }

  function channelHasFolderAny(keys, folderId) {
    for (const k of keys || []) if (channelHasFolder(k, folderId)) return true;
    return false;
  }

  // Save mapping immediately (debounce can get skipped during rapid SPA navigation)
  function saveMapNow() {
    try { STORE.set({ [KEYS.map]: state.map }); } catch {}
  }

  function saveUiNow() {
    try { STORE.set({ [KEYS.ui]: state.ui }); } catch {}
  }


  const isChannelsManagerPage = () => location.pathname.startsWith('/feed/channels');
  const isSubscriptionsFeedPage = () => location.pathname.startsWith('/feed/subscriptions');

  const folderById = (id) => state.folders.find(f => f.id === id) || null;
function getFolderIdsForChannel(channelKey) {
    const ck = canonicalizeChannelKey(channelKey) || channelKey;
    const arr = state.map[ck] || state.map[channelKey];
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  }
function setFolderIdsForChannel(channelKey, ids) {
    const ck = canonicalizeChannelKey(channelKey) || channelKey;
    const uniq = Array.from(new Set((ids || []).filter(Boolean)));
    if (!uniq.length) delete state.map[ck];
    else state.map[ck] = uniq;
    if (ck !== channelKey) delete state.map[channelKey]; // avoid stale aliases
  }

  function toggleChannelFolder(channelKey, folderId, enabled) {
    const ids = new Set(getFolderIdsForChannel(channelKey));
    if (enabled) ids.add(folderId);
    else ids.delete(folderId);
    setFolderIdsForChannel(channelKey, Array.from(ids));
  }

  const channelHasFolder = (channelKey, folderId) => getFolderIdsForChannel(channelKey).includes(folderId);

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const saveStateDebounced = debounce(async () => {
    await STORE.set({ [KEYS.folders]: state.folders, [KEYS.map]: state.map, [KEYS.ui]: state.ui });
  }, 200);

  async function loadState() {
    const res = await STORE.get([KEYS.folders, KEYS.map, KEYS.ui]);
    state.folders = Array.isArray(res[KEYS.folders]) ? res[KEYS.folders] : [];
    state.map = res[KEYS.map] && typeof res[KEYS.map] === 'object' ? res[KEYS.map] : {};

    // Normalize stored keys so /feed/channels and /feed/subscriptions match.
    const migrated = migrateMapToCanonical();
    if (migrated) { try { await STORE.set({ [KEYS.map]: state.map }); } catch {} }
    state.ui = res[KEYS.ui] && typeof res[KEYS.ui] === 'object' ? res[KEYS.ui] : { filterFolderId: 'ALL' };

    if (state.folders.length === 0) {
      state.folders = [
        { id: uid(), name: 'Tech', color: '#3ea6ff' },
        { id: uid(), name: 'News', color: '#ff4e45' },
        { id: uid(), name: 'Music', color: '#7c4dff' }
      ];
      await STORE.set({ [KEYS.folders]: state.folders });
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'sync' && areaName !== 'local') return;
    if (changes[KEYS.folders]) state.folders = changes[KEYS.folders].newValue || [];
    if (changes[KEYS.map]) state.map = changes[KEYS.map].newValue || {};
    if (changes[KEYS.ui]) state.ui = changes[KEYS.ui].newValue || state.ui;

    scheduleSidebarRefresh(true);
    if (isChannelsManagerPage()) scheduleChannelsRefresh(true);
    if (isSubscriptionsFeedPage()) scheduleSubsRefresh(true);
  }

  function ensureOnceMarker(el, marker) {
    const key = `ytf_${marker}`;
    if (el.dataset[key]) return false;
    el.dataset[key] = '1';
    return true;
  }

  // Click bug fix helpers
  function stopNav(e) { e.stopPropagation(); }
  function stopNavHard(e) { e.preventDefault(); e.stopPropagation(); }

  
  async function openOptions() {
    // Prefer direct API (works even if service worker is asleep)
    try {
      if (chrome?.runtime?.openOptionsPage) {
        await new Promise((resolve, reject) => {
          try {
            chrome.runtime.openOptionsPage(() => {
              const err = chrome.runtime.lastError;
              if (err) reject(err);
              else resolve(true);
            });
          } catch (e) { reject(e); }
        });
        return;
      }
    } catch {}

    // Fallback: ask background service worker
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      if (res && res.ok) return;
    } catch {}

    // Last resort: open options.html directly
    try {
      window.open(chrome.runtime.getURL('options.html'), '_blank');
    } catch {}
  }

  // ---------------- Targeted DOM helpers ----------------
  function findBrowsePrimary(subtype) {
    return (
      document.querySelector(`ytd-browse[page-subtype="${subtype}"] #primary`) ||
      document.querySelector('ytd-browse #primary') ||
      null
    );
  }

  function findBrowseContents(subtype) {
    return (
      document.querySelector(`ytd-browse[page-subtype="${subtype}"] #contents`) ||
      document.querySelector(`ytd-browse[page-subtype="${subtype}"] #primary #contents`) ||
      document.querySelector(`ytd-browse[page-subtype="${subtype}"] #primary`) ||
      null
    );
  }

  // ---------------- Counts ----------------
  function computeFolderCountsFromMap() {
    const counts = {};
    for (const f of state.folders) counts[f.id] = 0;

    const keys = Object.keys(state.map);
    for (const k of keys) {
      const ids = getFolderIdsForChannel(k);
      for (const id of ids) {
        if (counts[id] == null) counts[id] = 0;
        counts[id] += 1;
      }
    }
    counts['ALL'] = keys.length;
    counts['UNASSIGNED'] = 0;
    return counts;
  }

  function updateBarCounts(barEl, domUnassignedCount = null) {
    if (!barEl) return;
    const counts = computeFolderCountsFromMap();
    if (typeof domUnassignedCount === 'number') counts['UNASSIGNED'] = domUnassignedCount;

    for (const btn of barEl.querySelectorAll('button.ytf-folder-btn')) {
      const id = btn.dataset.folderId;
      if (!id) continue;
      const labelSpan = btn.querySelector('span:last-child');
      if (!labelSpan) continue;

      const base = btn.dataset.baseLabel || labelSpan.textContent || '';
      btn.dataset.baseLabel = base.replace(/\s*\(\d+\)\s*$/, '');

      const n = counts[id];
      if (typeof n === 'number' && n >= 0) labelSpan.textContent = `${btn.dataset.baseLabel} (${n})`;
    }
  }

  // ---------------- Sidebar injection (keepalive) ----------------
  let sidebarTimer = null;

  function findGuideInsertionPoint() {
    const guide = document.querySelector('ytd-guide-renderer');
    if (!guide) return null;

    const subsLink = guide.querySelector('a[href="/feed/subscriptions"]');
    if (subsLink) {
      const section = subsLink.closest('ytd-guide-section-renderer');
      if (section && section.parentElement) return { parent: section.parentElement, after: section };
    }
    const sections = guide.querySelector('#sections');
    if (sections) return { parent: sections, after: null };
    return null;
  }

  function makeGuideItem(label, color, folderId) {
    const item = document.createElement('div');
    item.className = 'ytf-guide-item';
    item.dataset.folderId = folderId;

    const dot = document.createElement('span');
    dot.className = 'ytf-dot';
    dot.style.background = color || '#999999';

    const text = document.createElement('span');
    text.textContent = label;

    item.appendChild(dot);
    item.appendChild(text);

    item.addEventListener('click', (e) => {
      stopNavHard(e);
      if (folderId === 'MANAGE') { openOptions(); return; }

      state.ui.filterFolderId = folderId;
      saveUiNow();

      if (!isSubscriptionsFeedPage()) location.href = 'https://www.youtube.com/feed/subscriptions';
      else {
        subs.activeId = folderId;
        refreshFolderButtonsPressedState();
        scheduleApplySubsFilter();
      }
    }, true);

    // Drag & drop channels onto sidebar folders
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      item.classList.add('ytf-drop-target-hover');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, true);
    item.addEventListener('dragleave', () => item.classList.remove('ytf-drop-target-hover'), true);
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('ytf-drop-target-hover');

      let keys = state.dragChannelKeys;
      if (!keys && e.dataTransfer) {
        try {
          const raw = e.dataTransfer.getData('application/ytf-keys');
          if (raw) keys = JSON.parse(raw);
        } catch {}
      }
      const key = state.dragChannelKey || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : null);
      if (!keys && key) keys = [key];
      if (!keys || !keys.length) return;

      if (folderId === 'ALL') return;
      if (folderId === 'UNASSIGNED') setFolderIdsForAllKeys(keys, []);
      else if (folderId !== 'MANAGE') toggleFolderForAllKeys(keys, folderId, true);

      saveMapNow();
      scheduleChannelsRefresh(false);
      scheduleSubsRefresh(false);
    }, true);

    item.addEventListener('pointerdown', stopNav, true);
    item.addEventListener('mousedown', stopNav, true);

    return item;
  }

  function buildGuideFolders(isMini = false) {
    const wrap = document.createElement('div');
    wrap.id = isMini ? 'ytf-mini-guide-folders' : 'ytf-guide-folders';

    if (!isMini) {
      const title = document.createElement('div');
      title.className = 'ytf-guide-title';
      title.textContent = 'Folders';
      wrap.appendChild(title);
    }

    wrap.appendChild(makeGuideItem('All', '#999999', 'ALL'));
    wrap.appendChild(makeGuideItem('Unassigned', '#777777', 'UNASSIGNED'));
    for (const f of state.folders) wrap.appendChild(makeGuideItem(f.name, f.color, f.id));
    wrap.appendChild(makeGuideItem(isMini ? 'Manage…' : 'Manage folders…', '#999999', 'MANAGE'));

    wrap.addEventListener('pointerdown', stopNav, true);
    wrap.addEventListener('mousedown', stopNav, true);
    wrap.addEventListener('click', stopNav, true);

    return wrap;
  }

  function refreshSidebarFolders() {
    const existing = document.getElementById('ytf-guide-folders');
    if (existing) existing.remove();

    const point = findGuideInsertionPoint();
    if (!point) return;

    const node = buildGuideFolders(false);
    if (point.after) point.after.insertAdjacentElement('afterend', node);
    else point.parent.appendChild(node);
  }

  function refreshMiniGuideFolders() {
    const existing = document.getElementById('ytf-mini-guide-folders');
    if (existing) existing.remove();

    const miniGuide = document.querySelector('ytd-mini-guide-renderer');
    if (!miniGuide) return;

    miniGuide.appendChild(buildGuideFolders(true));
  }

  function scheduleSidebarRefresh(force = false) {
    if (sidebarTimer && !force) return;
    if (sidebarTimer) clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => {
      sidebarTimer = null;
      refreshSidebarFolders();
      refreshMiniGuideFolders();
    }, 300);
  }

  function startSidebarKeepAlive() {
    setInterval(() => {
      if (!document.getElementById('ytf-guide-folders')) refreshSidebarFolders();
      if (!document.getElementById('ytf-mini-guide-folders')) refreshMiniGuideFolders();
    }, 2500);
  }

  // ---------------- /feed/channels: drag/drop + multi-folder ----------------
  
  function findChannelKeyInRenderer(rendererEl) {
    const info = extractChannelKeysFromElement(rendererEl);
    return info.primary;
  }

  function buildFolderPills(channelKeys) {
    const pillWrap = document.createElement('span');
    const ids = unionFolderIdsForKeys(channelKeys);

    if (!ids.length) {
      const empty = document.createElement('span');
      empty.className = 'ytf-small';
      empty.textContent = 'No folder';
      pillWrap.appendChild(empty);
      return pillWrap;
    }

    const folders = ids.map(folderById).filter(Boolean);
    const show = folders.slice(0, 2);
    const extra = folders.length - show.length;

    for (const f of show) {
      const pill = document.createElement('span');
      pill.className = 'ytf-pill-tag';

      const dot = document.createElement('span');
      dot.className = 'ytf-dot';
      dot.style.background = f.color || '#999999';

      const txt = document.createElement('span');
      txt.className = 'ytf-small';
      txt.textContent = f.name;

      const x = document.createElement('button');
      x.className = 'ytf-x';
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove from folder';
      x.addEventListener('click', (e) => {
        stopNavHard(e);
        toggleFolderForAllKeys(channelKeys, f.id, false);
        saveMapNow();
        scheduleChannelsRefresh(false);
      }, true);

      pill.appendChild(dot);
      pill.appendChild(txt);
      pill.appendChild(x);
      pillWrap.appendChild(pill);
    }

    if (extra > 0) {
      const pill = document.createElement('span');
      pill.className = 'ytf-pill-tag';
      const txt = document.createElement('span');
      txt.className = 'ytf-small';
      txt.textContent = `+${extra}`;
      pill.appendChild(txt);
      pillWrap.appendChild(pill);
    }

    return pillWrap;
  }

  function buildEditPopover(channelKeys) {
    const pop = document.createElement('span');
    pop.className = 'ytf-popover';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytf-edit-btn';
    btn.textContent = 'Edit';
    pop.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'ytf-popover-panel';
    panel.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'ytf-popover-title';
    title.textContent = 'Assign folders';
    panel.appendChild(title);

    for (const f of state.folders) {
      const row = document.createElement('label');
      row.className = 'ytf-check';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = channelHasFolderAny(channelKeys, f.id);

      const dot = document.createElement('span');
      dot.className = 'ytf-dot';
      dot.style.background = f.color || '#999999';

      const txt = document.createElement('span');
      txt.textContent = f.name;

      cb.addEventListener('click', stopNav, true);
      cb.addEventListener('change', (e) => {
        stopNav(e);
        toggleFolderForAllKeys(channelKeys, f.id, cb.checked);
        saveMapNow();
        scheduleChannelsRefresh(false);
        scheduleSidebarRefresh(false);
      }, true);

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(txt);
      panel.appendChild(row);
    }

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'ytf-link-btn';
    manage.textContent = 'Manage folders';
    manage.style.marginTop = '8px';
    manage.addEventListener('click', async (e) => { stopNavHard(e); await openOptions(); }, true);
    panel.appendChild(manage);

    pop.appendChild(panel);

    btn.addEventListener('click', (e) => {
      stopNavHard(e);
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }, true);

    pop.addEventListener('pointerdown', stopNav, true);
    pop.addEventListener('mousedown', stopNav, true);
    pop.addEventListener('click', stopNav, true);

    const onDoc = (e) => { if (!pop.contains(e.target)) panel.style.display = 'none'; };
    document.addEventListener('click', onDoc, true);

    return pop;
  }

  function injectAssignUI(rendererEl) {
    if (!ensureOnceMarker(rendererEl, 'assigned_ui_v27')) return;

    const info = extractChannelKeysFromElement(rendererEl);
    const channelKey = info.primary;
    const channelKeys = info.keys;
    if (!channelKey || !channelKeys.length) return;

    // store keys for other handlers (debuggable)
    try { rendererEl.dataset.ytfChannelKeys = JSON.stringify(channelKeys); } catch {}

    rendererEl.setAttribute('draggable', 'true');
    rendererEl.addEventListener('dragstart', (e) => {
      state.dragChannelKey = channelKey;
      state.dragChannelKeys = channelKeys;
      try {
        e.dataTransfer.setData('text/plain', channelKey);
        e.dataTransfer.setData('application/ytf-keys', JSON.stringify(channelKeys));
        e.dataTransfer.effectAllowed = 'copy';
      } catch {}
    }, true);
    rendererEl.addEventListener('dragend', () => { state.dragChannelKey = null; state.dragChannelKeys = null; }, true);

    const wrap = document.createElement('span');
    wrap.className = 'ytf-assign-wrap';

    wrap.addEventListener('pointerdown', stopNav, true);
    wrap.addEventListener('mousedown', stopNav, true);
    wrap.addEventListener('click', stopNav, true);

    wrap.appendChild(buildFolderPills(channelKeys));
    wrap.appendChild(buildEditPopover(channelKeys));

    const titleTarget =
      rendererEl.querySelector('#channel-title') ||
      rendererEl.querySelector('ytd-channel-name') ||
      rendererEl.querySelector('#metadata') ||
      rendererEl;

    titleTarget.appendChild(wrap);
  }

  function estimateUnassignedFromDOM() {
    if (!isChannelsManagerPage()) return null;
    const renderers = document.querySelectorAll('ytd-channel-renderer, ytd-grid-channel-renderer');
    let unassigned = 0;
    for (const r of renderers) {
      const info = extractChannelKeysFromElement(r);
      if (!info.primary || !info.keys.length) continue;
      const ids = unionFolderIdsForKeys(info.keys);
      if (!ids.length) unassigned += 1;
    }
    return unassigned;
  }

  
  function ensureChannelDropBar() {
    // Fixed overlay bar so YouTube rehydration can't wipe it.
    if (document.getElementById('ytf-channel-drop-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'ytf-channel-drop-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'YT folders bar');

    // inject style once (uses YouTube theme variables)
    if (!document.getElementById('ytf-fixedbar-style')) {
      const st = document.createElement('style');
      st.id = 'ytf-fixedbar-style';
      st.textContent = `        :root { --ytf-channelbar-offset: 0px; }
        #ytf-channel-drop-bar{
          position: fixed;
          top: var(--ytd-masthead-height, 56px);
          left: 0;
          right: 0;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px 10px;
          background: var(--yt-spec-base-background, #0f0f0f);
          color: var(--yt-spec-text-primary, #fff);
          border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
          box-shadow: 0 2px 10px rgba(0,0,0,.15);
          backdrop-filter: blur(6px);
        }
        /* YouTube puts the "All subscriptions" header in #header, not inside #primary.
           Offset BOTH so the fixed bar never overlaps titles/filters. */
        ytd-browse[page-subtype="channels"] #header{
          margin-top: var(--ytf-channelbar-offset) !important;
        }
        ytd-browse[page-subtype="channels"] #primary,
        ytd-browse[page-subtype="channels"] #primary-inner{
          padding-top: var(--ytf-channelbar-offset) !important;
        }
        @media (max-width: 520px){
          #ytf-channel-drop-bar{ padding: 6px 8px; gap: 6px; }
        }`;
      (document.head || document.documentElement).appendChild(st);
    }

    const hint = document.createElement('span');
    hint.className = 'ytf-drop-hint ytf-small';
    hint.textContent = 'Drag a channel onto a folder:';
    bar.appendChild(hint);

    for (const f of state.folders) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytf-folder-btn';
      btn.dataset.folderId = f.id;
      btn.dataset.baseLabel = f.name;

      const dot = document.createElement('span');
      dot.className = 'ytf-dot';
      dot.style.background = f.color || '#999999';

      const label = document.createElement('span');
      label.textContent = f.name;

      btn.appendChild(dot);
      btn.appendChild(label);

      btn.addEventListener('dragover', (e) => { e.preventDefault(); btn.classList.add('ytf-drop-target-hover'); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }, true);
      btn.addEventListener('dragleave', () => btn.classList.remove('ytf-drop-target-hover'), true);
      btn.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        btn.classList.remove('ytf-drop-target-hover');
        let keys = state.dragChannelKeys;
        if (!keys && e.dataTransfer) {
          try {
            const raw = e.dataTransfer.getData('application/ytf-keys');
            if (raw) keys = JSON.parse(raw);
          } catch {}
        }
        const key = state.dragChannelKey || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : null);
        if (!keys && key) keys = [key];
        if (!keys || !keys.length) return;
        toggleFolderForAllKeys(keys, f.id, true);
        saveMapNow();
        scheduleChannelsRefresh(false);
        scheduleSidebarRefresh(false);
        updateBarCounts(bar, estimateUnassignedFromDOM());
      }, true);

      btn.addEventListener('click', stopNavHard, true);
      bar.appendChild(btn);
    }

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'ytf-link-btn';
    manageBtn.textContent = 'Manage folders';
    manageBtn.style.marginLeft = '8px';
    manageBtn.addEventListener('click', async (e) => { stopNavHard(e); await openOptions(); }, true);
    bar.appendChild(manageBtn);

    bar.addEventListener('pointerdown', stopNav, true);
    bar.addEventListener('mousedown', stopNav, true);

    document.body.appendChild(bar);

    // set offset to prevent covering page header controls
    requestAnimationFrame(() => {
      const h = Math.ceil((bar.getBoundingClientRect().height || 0) + 6);
      document.documentElement.style.setProperty('--ytf-channelbar-offset', `${h}px`);
      updateBarCounts(bar, estimateUnassignedFromDOM());
    });
  }

  let channelsObserver = null;
  let channelsRefreshTimer = null;

  function refreshChannelsManagerUI(forceRebuildBar = false) {
    // Don't remove the bar unless we can immediately rebuild it.
    const primary = findBrowsePrimary('channels');
    const existingBar = document.getElementById('ytf-channel-drop-bar');

    const barNeedsRebuild = forceRebuildBar ||
      (!!existingBar && existingBar.querySelectorAll('button.ytf-folder-btn').length !== state.folders.length) ||
      (!existingBar);

    if (barNeedsRebuild && primary) {
      if (existingBar) existingBar.remove();
      ensureChannelDropBar();
    } else if (!existingBar) {
      // if primary not ready, leave it and keepalive will add it
    } else {
      updateBarCounts(existingBar, estimateUnassignedFromDOM());
    }

    const renderers = document.querySelectorAll('ytd-channel-renderer, ytd-grid-channel-renderer');
    for (const r of renderers) {
      for (const x of r.querySelectorAll('.ytf-assign-wrap')) x.remove();
      delete r.dataset['ytf_assigned_ui_v23'];
      injectAssignUI(r);
    }

    const bar = document.getElementById('ytf-channel-drop-bar');
    if (bar) updateBarCounts(bar, estimateUnassignedFromDOM());
  }

  function scheduleChannelsRefresh(forceRebuildBar = false) {
    if (!isChannelsManagerPage()) return;
    if (channelsRefreshTimer) return;
    channelsRefreshTimer = setTimeout(() => {
      channelsRefreshTimer = null;
      refreshChannelsManagerUI(forceRebuildBar);
    }, 220);
  }

  function enhanceChannelsManagerPage() {
    ensureChannelDropBar();

    const container = findBrowseContents('channels') || document.body;

    const tryInit = () => {
      const renderers = document.querySelectorAll('ytd-channel-renderer, ytd-grid-channel-renderer');
      if (!renderers.length) return false;
      for (const r of renderers) injectAssignUI(r);
      return true;
    };

    tryInit();

    if (channelsObserver) channelsObserver.disconnect();
    channelsObserver = new MutationObserver(() => scheduleChannelsRefresh(false));
    channelsObserver.observe(container, { childList: true, subtree: true });
  }

  function startBarsKeepAlive() {
    setInterval(() => {
      if (isChannelsManagerPage()) {
        if (!document.getElementById('ytf-channel-drop-bar')) ensureChannelDropBar();
      }
      if (isSubscriptionsFeedPage()) {
        if (!document.getElementById('ytf-folder-bar')) ensureFolderBar();
      }
    }, 1200);
  }

  // ---------------- /feed/subscriptions: filter + counts (debounced) ----------------
  const subs = { barEl: null, activeId: 'ALL', observer: null };
  let subsRefreshTimer = null;
  let subsApplyTimer = null;

  function createFolderButton(folderId, name, color, pressed) {
    const btn = document.createElement('button');
    btn.className = 'ytf-folder-btn';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    btn.dataset.folderId = folderId;
    btn.dataset.baseLabel = name;

    const dot = document.createElement('span');
    dot.className = 'ytf-dot';
    dot.style.background = color || '#999999';

    const label = document.createElement('span');
    label.textContent = name;

    btn.appendChild(dot);
    btn.appendChild(label);
    return btn;
  }

  function ensureFolderBar() {
    if (document.getElementById('ytf-folder-bar')) return;

    const primary = findBrowsePrimary('subscriptions');
    if (!primary) return;

    const bar = document.createElement('div');
    bar.id = 'ytf-folder-bar';

    const label = document.createElement('span');
    label.className = 'ytf-small';
    label.textContent = 'Folders:';
    bar.appendChild(label);

    bar.appendChild(createFolderButton('ALL', 'All', '#999999', subs.activeId === 'ALL'));
    bar.appendChild(createFolderButton('UNASSIGNED', 'Unassigned', '#777777', subs.activeId === 'UNASSIGNED'));
    for (const f of state.folders) bar.appendChild(createFolderButton(f.id, f.name, f.color, subs.activeId === f.id));

    const manage = document.createElement('button');
    manage.className = 'ytf-link-btn';
    manage.type = 'button';
    manage.textContent = 'Manage';
    manage.style.marginLeft = '8px';
    manage.addEventListener('click', async (e) => { stopNavHard(e); await openOptions(); }, true);
    bar.appendChild(manage);

    bar.addEventListener('click', (e) => {
      const b = e.target?.closest?.('button.ytf-folder-btn');
      if (!b) return;
      stopNavHard(e);
      setActiveFilter(b.dataset.folderId || 'ALL');
    }, true);

    primary.prepend(bar);
    subs.barEl = bar;
  }

  function setActiveFilter(folderId) {
    subs.activeId = folderId;
    state.ui.filterFolderId = folderId;
    saveStateDebounced();
    refreshFolderButtonsPressedState();
    scheduleApplySubsFilter();
  }

  function refreshFolderButtonsPressedState() {
    const bar = subs.barEl || document.getElementById('ytf-folder-bar');
    if (!bar) return;
    for (const btn of bar.querySelectorAll('button.ytf-folder-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset.folderId === subs.activeId ? 'true' : 'false');
    }
  }

  function findVideoChannelKeys(videoEl) {
    const info = extractChannelKeysFromElement(videoEl);
    return info.keys && info.keys.length ? info.keys : null;
  }

  function applySubscriptionsFilter() {
    const id = subs.activeId || 'ALL';
    const items = document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer');

    for (const item of items) {
      const channelKeys = findVideoChannelKeys(item);
      const ids = channelKeys ? unionFolderIdsForKeys(channelKeys) : [];
      const folders = ids.map(folderById).filter(Boolean);

      let show = true;
      if (id === 'ALL') show = true;
      else if (id === 'UNASSIGNED') show = !folders.length;
      else show = folders.some(f => f.id === id);

      item.style.display = show ? '' : 'none';
    }
  }

  function updateFeedCounts() {
    const bar = subs.barEl || document.getElementById('ytf-folder-bar');
    if (!bar) return;

    const items = document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer');
    const cap = 700;
    const nodes = items.length > cap ? Array.from(items).slice(0, cap) : Array.from(items);

    const counts = {};
    counts['ALL'] = nodes.length;
    counts['UNASSIGNED'] = 0;
    for (const f of state.folders) counts[f.id] = 0;

    for (const item of nodes) {
      const channelKeys = findVideoChannelKeys(item);
      const ids = channelKeys ? unionFolderIdsForKeys(channelKeys) : [];
      if (!ids.length) counts['UNASSIGNED'] += 1;
      else for (const fid of ids) if (counts[fid] != null) counts[fid] += 1;
    }

    for (const btn of bar.querySelectorAll('button.ytf-folder-btn')) {
      const id = btn.dataset.folderId;
      if (!id) continue;
      const labelSpan = btn.querySelector('span:last-child');
      if (!labelSpan) continue;

      const base = btn.dataset.baseLabel || labelSpan.textContent || '';
      btn.dataset.baseLabel = base.replace(/\s*\(\d+\)\s*$/, '');

      const n = counts[id];
      if (typeof n === 'number' && n >= 0) labelSpan.textContent = `${btn.dataset.baseLabel} (${n})`;
    }
  }

  function scheduleApplySubsFilter() {
    if (!isSubscriptionsFeedPage()) return;
    if (subsApplyTimer) clearTimeout(subsApplyTimer);
    subsApplyTimer = setTimeout(() => {
      subsApplyTimer = null;
      applySubscriptionsFilter();
      updateFeedCounts();
    }, 260);
  }

  function refreshSubscriptionsFeedUI(forceRebuildBar = false) {
    const primary = findBrowsePrimary('subscriptions');
    const existingBar = document.getElementById('ytf-folder-bar');

    const barNeedsRebuild = forceRebuildBar ||
      (!!existingBar && existingBar.querySelectorAll('button.ytf-folder-btn').length !== (state.folders.length + 2)) ||
      (!existingBar);

    if (barNeedsRebuild && primary) {
      if (existingBar) existingBar.remove();
      subs.barEl = null;
      ensureFolderBar();
    } else if (!existingBar) {
      // wait for primary; keepalive will add it
    } else {
      subs.barEl = existingBar;
    }

    subs.activeId = state.ui?.filterFolderId || 'ALL';
    refreshFolderButtonsPressedState();
    scheduleApplySubsFilter();
  }

  function scheduleSubsRefresh(forceRebuildBar = false) {
    if (!isSubscriptionsFeedPage()) return;
    if (subsRefreshTimer) return;
    subsRefreshTimer = setTimeout(() => {
      subsRefreshTimer = null;
      refreshSubscriptionsFeedUI(forceRebuildBar);
    }, 240);
  }

  function enhanceSubscriptionsFeedPage() {
    subs.activeId = state.ui?.filterFolderId || 'ALL';
    ensureFolderBar();
    refreshFolderButtonsPressedState();
    scheduleApplySubsFilter();

    const container = findBrowseContents('subscriptions') || document.body;

    if (subs.observer) subs.observer.disconnect();
    subs.observer = new MutationObserver(() => scheduleApplySubsFilter());
    subs.observer.observe(container, { childList: true, subtree: true });
  }

  // ---------------- SPA routing ----------------
  let routeTimer = null;

  function cleanupPageSpecific() {
    if (!isChannelsManagerPage() && channelsObserver) {
      channelsObserver.disconnect();
      channelsObserver = null;
      const drop = document.getElementById('ytf-channel-drop-bar');
      if (drop) drop.remove();
      document.documentElement.style.setProperty('--ytf-channelbar-offset', '0px');
    }
    if (!isSubscriptionsFeedPage() && subs.observer) {
      subs.observer.disconnect();
      subs.observer = null;
      const bar = document.getElementById('ytf-folder-bar');
      if (bar) bar.remove();
      subs.barEl = null;
    }
  }

  function initForRoute() {
    scheduleSidebarRefresh(false);

    if (isChannelsManagerPage()) enhanceChannelsManagerPage();
    if (isSubscriptionsFeedPage()) enhanceSubscriptionsFeedPage();
  }

  function onRouteMaybeChanged() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    cleanupPageSpecific();
    initForRoute();
  }

  async function main() {
    await loadState();
    chrome.storage.onChanged.addListener(onStorageChanged);

    initForRoute();
    startSidebarKeepAlive();
    startBarsKeepAlive();

    routeTimer = setInterval(onRouteMaybeChanged, 900);
  }

  main().catch(console.error);
})();
