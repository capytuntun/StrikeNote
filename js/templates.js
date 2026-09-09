/* templates.js — 可自訂的插入範本。
 *
 * 工具列的「範本」鈕與編輯器的 /指令 都從這裡取清單。內建兩個（機器、AD Set，
 * 內容沿用 editor.js 裡那一份，不另外複製），使用者可以自己新增、修改、刪除，
 * 存在瀏覽器的 localStorage。
 *
 * 一個範本 = { id, name, text, cmd, builtin }
 *   text 裡的 $CURSOR 標記插入後游標要停的位置（沒有就停在最後）
 *   cmd  是選填的斜線指令（例如 cmd:'web' → 在編輯器輸入 /web）
 */
(function (global) {
  'use strict';

  const KEY = 'strikenote.templates';

  // 內建範本：文字直接讀 Editor.snippets，維持單一來源
  function builtins() {
    const s = (global.Editor && Editor.snippets) || {};
    return [
      { id: 'machine', name: '機器', icon: 'monitor', cmd: 'machine', builtin: true, text: s.machine || '' },
      { id: 'adset', name: 'AD Set', icon: 'network', cmd: 'adset', builtin: true, text: s.adset || '' }
    ];
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(function (t) { return t && t.id && t.name; }) : [];
    } catch (e) { return []; }
  }
  function persist(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* 隱私模式或空間滿 */ }
  }

  // 斜線指令名稱：取名稱裡的英數字；中文名稱就沒有 /指令，只從選單插入
  function slugCmd(name, taken) {
    let base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!base) return '';
    let cmd = base, i = 2;
    while (taken.indexOf(cmd) >= 0) cmd = base + (i++);
    return cmd;
  }

  function all() {
    return builtins().concat(load());
  }
  function custom() { return load(); }
  function get(id) {
    return all().filter(function (t) { return t.id === id; })[0] || null;
  }

  // 新增或更新；回傳存好的範本。id 為空表示新增。
  function save(tpl) {
    const list = load();
    const name = String(tpl.name || '').trim() || '未命名範本';
    const text = String(tpl.text || '');
    if (tpl.id) {
      const i = list.findIndex(function (t) { return t.id === tpl.id; });
      if (i >= 0) {
        const taken = all().filter(function (t) { return t.id !== tpl.id; }).map(function (t) { return t.cmd; });
        list[i] = { id: tpl.id, name: name, text: text, cmd: slugCmd(name, taken) };
        persist(list);
        return list[i];
      }
    }
    const taken = all().map(function (t) { return t.cmd; });
    const rec = {
      id: 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      name: name, text: text, cmd: slugCmd(name, taken)
    };
    list.push(rec);
    persist(list);
    return rec;
  }

  function remove(id) {
    persist(load().filter(function (t) { return t.id !== id; }));
  }

  // 把自訂範本推給編輯器，讓 /指令 也能用
  function syncEditor() {
    if (!global.Editor || !Editor.setExtraSnippets) return;
    Editor.setExtraSnippets(load()
      .filter(function (t) { return t.cmd; })
      .map(function (t) { return { cmd: t.cmd, hint: '範本：' + t.name, text: t.text }; }));
  }

  global.Templates = {
    all: all, custom: custom, get: get, save: save, remove: remove, syncEditor: syncEditor
  };
  syncEditor();
})(window);
