/* sorting.js — one order for the sidebar tree and the dashboard.
 *
 * The mode (手動／名稱／建立時間／最近更新) is a per-browser preference in
 * localStorage. The manual order itself is `position` on notes and folders,
 * written by PUT /api/order (Store.saveOrder), so it follows the account.
 *
 * A row that was never dragged has position null. In manual mode those sort
 * ahead of positioned rows — notes by last update, folders by name — which is
 * exactly how both lists were ordered before manual ordering existed: nothing
 * moves until something is dragged, and a note created later shows up on top.
 * Pinned notes stay first in every mode.
 */
(function (global) {
  'use strict';

  const KEY = 'sortMode';
  const MODES = [
    { key: 'manual', label: '手動排序（拖拉）', short: '手動' },
    { key: 'name-asc', label: '名稱 A → Z', short: '名稱 A→Z' },
    { key: 'name-desc', label: '名稱 Z → A', short: '名稱 Z→A' },
    { key: 'created-desc', label: '建立時間（新 → 舊）', short: '建立時間' },
    { key: 'created-asc', label: '建立時間（舊 → 新）', short: '建立時間' },
    { key: 'updated-desc', label: '最近更新', short: '最近更新' }
  ];
  const listeners = [];

  function valid(m) { return MODES.some(function (x) { return x.key === m; }); }
  let mode = null;
  try { mode = localStorage.getItem(KEY); } catch (e) { mode = null; }
  if (!valid(mode)) mode = 'manual';

  function text(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hant', { numeric: true, sensitivity: 'base' });
  }
  function pinned(n) { return !!(n.meta && n.meta.pinned); }
  function newer(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
  function manual(a, b, fallback) {
    const pa = a.position != null, pb = b.position != null;
    if (pa !== pb) return pa ? 1 : -1;
    return (pa ? a.position - b.position : 0) || fallback(a, b);
  }

  function compareNotes(a, b, m) {
    const pin = (pinned(b) ? 1 : 0) - (pinned(a) ? 1 : 0);
    if (pin) return pin;
    switch (m || mode) {
      case 'name-asc': return text(a.title, b.title) || newer(a, b);
      case 'name-desc': return text(b.title, a.title) || newer(a, b);
      case 'created-desc': return (b.createdAt || 0) - (a.createdAt || 0);
      case 'created-asc': return (a.createdAt || 0) - (b.createdAt || 0);
      case 'updated-desc': return newer(a, b);
      default: return manual(a, b, newer);
    }
  }

  // Folders have no update time of their own, so 最近更新 keeps them by name.
  function compareFolders(a, b, m) {
    switch (m || mode) {
      case 'name-desc': return text(b.name, a.name);
      case 'created-desc': return (b.createdAt || 0) - (a.createdAt || 0) || text(a.name, b.name);
      case 'created-asc': return (a.createdAt || 0) - (b.createdAt || 0) || text(a.name, b.name);
      case 'manual': return manual(a, b, function (x, y) { return text(x.name, y.name); });
      default: return text(a.name, b.name);
    }
  }

  // The ids of one level after dropping `moving` before (or `after`) `targetId`;
  // a null targetId appends. `ids` is that level in display order and may or may
  // not already contain the moving ids (a move from another folder does not).
  function reorder(ids, moving, targetId, after) {
    const set = {};
    moving.forEach(function (id) { set[id] = true; });
    const rest = ids.filter(function (id) { return !set[id]; });
    let at = targetId == null ? rest.length : rest.indexOf(targetId);
    if (at < 0) at = rest.length;
    else if (after) at++;
    return rest.slice(0, at).concat(moving, rest.slice(at));
  }

  function set(m) {
    if (!valid(m) || m === mode) return;
    mode = m;
    try { localStorage.setItem(KEY, m); } catch (e) { /* private mode: this tab only */ }
    listeners.slice().forEach(function (fn) { fn(m); });
  }

  function info(m) {
    const k = m || mode;
    return MODES.filter(function (x) { return x.key === k; })[0];
  }

  global.Sorting = {
    MODES: MODES,
    mode: function () { return mode; },
    info: info,
    set: set,
    onChange: function (fn) { listeners.push(fn); },
    compareNotes: compareNotes,
    compareFolders: compareFolders,
    reorder: reorder
  };
})(window);
