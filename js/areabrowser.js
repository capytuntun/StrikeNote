/* areabrowser.js — 證照／課程筆記、知識區、小說共用的簡化檔案總管。
 *
 * 跟首頁儀表板（dashboard.js）長得像、用的是同一套 CSS class（.dash-*），但功能
 * 刻意精簡很多：只有「資料夾方框 + 筆記條列 + 麵包屑導覽 + 新增／改名／刪除／移動」，
 * 沒有標籤雲、沒有電子書區、沒有批次勾選多選、沒有拖拉排序。一篇筆記一旦點開，
 * 分享／版本歷史／PDF／協作編輯全部照常運作——那些功能都在筆記編輯器本身，
 * 不需要這裡重做一份。
 *
 * 用法：AreaBrowser.render(container, opts) / AreaBrowser.refresh(opts)
 *   notes, folders          這個區域目前的筆記與資料夾（呼叫端先依 area 篩好）
 *   title, hint              頁首標題與說明文字
 *   emptyHint                完全沒有內容時顯示的提示
 *   onOpen(noteId)            開啟筆記
 *   onNewNote(folderId)       新增筆記，回傳 Promise
 *   onNewFolder(parentId)     新增資料夾，回傳 Promise
 *   onRenameNote(note, title) / onRenameFolder(folder, name)
 *   onDeleteNote(note) / onDeleteFolder(folder)
 *   onMoveNote(note) / onMoveFolder(folder)   跳出資料夾選擇對話框（呼叫端做）
 * render() 會把瀏覽位置重置到最上層；refresh() 保留目前瀏覽到哪個資料夾。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  let curFolderId = null;   // 目前瀏覽到哪個資料夾；每次 render() 重置為最上層
  let lastOpts = null;

  function foldersIn(folders, parentId) {
    return folders.filter(function (f) { return (f.parentId || null) === parentId; })
      .sort(function (a, b) { return Sorting.compareFolders(a, b); });
  }
  function notesIn(notes, folderId) {
    return notes.filter(function (n) { return (n.folderId || null) === folderId; })
      .sort(function (a, b) { return Sorting.compareNotes(a, b); });
  }
  function countDeep(notes, folders, folderId) {
    let c = notesIn(notes, folderId).length;
    foldersIn(folders, folderId).forEach(function (f) { c += countDeep(notes, folders, f.id); });
    return c;
  }
  function crumbPath(folders, id) {
    const path = [];
    let cur = id, guard = {};
    while (cur && !guard[cur]) {
      guard[cur] = true;
      const f = folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      path.unshift(f);
      cur = f.parentId || null;
    }
    return path;
  }

  function inlineRename(host, current, cls, onDone) {
    if (host.parentNode.querySelector('.' + cls)) return;
    const input = el('input', cls);
    input.type = 'text';
    input.value = current || '';
    host.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      const val = input.value.trim();
      input.replaceWith(host);
      if (save && val && val !== current) { host.textContent = val; onDone(val); }
    }
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  function go(folderId) { curFolderId = folderId; if (lastOpts) render(lastOpts, true); }

  // ---- 頁首：標題 + 麵包屑 + 新增按鈕 ----------------------------------------
  function renderHead(o) {
    const head = el('header', 'dash-head');
    const main = el('div', 'dash-head-main');
    const path = crumbPath(o.folders, curFolderId);

    const nav = el('nav', 'dash-crumbs');
    nav.setAttribute('aria-label', '資料夾路徑');
    function crumb(label, iconName, folderId, isCurrent) {
      const c = el('button', 'dash-crumb' + (isCurrent ? ' is-current' : ''),
        (iconName ? ic(iconName) : '') + '<span>' + esc(label) + '</span>');
      c.type = 'button';
      if (isCurrent) c.setAttribute('aria-current', 'page');
      else { c.title = '回到「' + label + '」'; c.addEventListener('click', function () { go(folderId); }); }
      return c;
    }
    nav.appendChild(crumb(o.title || '筆記', o.icon, null, !curFolderId));
    path.forEach(function (f, i) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      nav.appendChild(crumb(f.name || '未命名資料夾', null, f.id, i === path.length - 1));
    });
    main.appendChild(nav);

    const subs = foldersIn(o.folders, curFolderId).length;
    const ns = notesIn(o.notes, curFolderId).length;
    const bits = [];
    if (subs) bits.push(subs + ' 個資料夾');
    bits.push(ns + ' 篇筆記');
    main.appendChild(el('div', 'dash-subtitle', esc(bits.join('・'))));
    head.appendChild(main);

    const right = el('div', 'dash-head-right');
    if (o.onNewFolder) {
      const bf = el('button', 'btn', ic('folder-plus') + '<span>新增資料夾</span>');
      bf.type = 'button';
      bf.addEventListener('click', function () {
        o.onNewFolder(curFolderId).then(function (f) { if (f) { o.folders.push(f); render(o, true); } });
      });
      right.appendChild(bf);
    }
    if (o.onNewNote) {
      const bn = el('button', 'btn btn-primary', ic('file-plus') + '<span>新增筆記</span>');
      bn.type = 'button';
      bn.addEventListener('click', function () {
        o.onNewNote(curFolderId).then(function (n) { if (n && o.onOpen) o.onOpen(n.id); });
      });
      right.appendChild(bn);
    }
    head.appendChild(right);
    return head;
  }

  // ---- 資料夾方框 -------------------------------------------------------------
  function makeFolderTile(folder, o) {
    const deep = countDeep(o.notes, o.folders, folder.id);
    const subs = foldersIn(o.folders, folder.id).length;
    const metaBits = [deep + ' 筆記'];
    if (subs) metaBits.push(subs + ' 子資料夾');

    const tile = el('div', 'dash-folder-tile');
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '打開資料夾';
    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic', ic('folder')));
    const nameEl = el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾'));
    head.appendChild(nameEl);
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(metaBits.join('・'))));

    const acts = el('div', 'dash-folder-acts');
    if (o.onMoveFolder) {
      const mv = el('button', 'dash-folder-menu', ic('folder-open'));
      mv.type = 'button'; mv.title = '移動到其他資料夾';
      mv.addEventListener('click', function (e) { e.stopPropagation(); o.onMoveFolder(folder).then(function (ok) { if (ok) render(o, true); }); });
      acts.appendChild(mv);
    }
    if (o.onDeleteFolder) {
      const del = el('button', 'dash-folder-menu', ic('trash'));
      del.type = 'button'; del.title = '刪除資料夾（裡面的筆記會移到垃圾桶）';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        o.onDeleteFolder(folder).then(function (ok) {
          if (ok) { o.folders = o.folders.filter(function (f) { return f.id !== folder.id; }); render(o, true); }
        });
      });
      acts.appendChild(del);
    }
    tile.appendChild(acts);

    tile.addEventListener('dblclick', function (e) {
      if (!o.onRenameFolder) return;
      e.preventDefault(); e.stopPropagation();
      inlineRename(nameEl, folder.name || '', 'dash-folder-edit', function (val) { o.onRenameFolder(folder, val); });
    });
    tile.addEventListener('click', function () { go(folder.id); });
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(folder.id); }
    });
    return tile;
  }

  // ---- 筆記條列（沿用 dashboard.js 的 DOM 結構，同一套 .dash-row-* CSS）--------
  function makeNoteRow(note, o) {
    const wrap = el('div', 'dash-note-wrap');
    wrap.dataset.id = note.id;

    const row = el('div', 'dash-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.appendChild(el('span', 'dash-row-ic', ic('file-text')));
    const titleEl = el('span', 'dash-row-title', esc(note.title || '未命名筆記'));
    row.appendChild(titleEl);
    const meta = el('span', 'dash-row-meta');
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    row.addEventListener('click', function () { if (o.onOpen) o.onOpen(note.id); });
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (o.onOpen) o.onOpen(note.id); } });
    wrap.appendChild(row);

    const acts = el('div', 'dash-row-actions');
    if (o.onRenameNote) {
      acts.appendChild(actBtn('pencil', '修改標題', function () {
        inlineRename(titleEl, note.title || '', 'dash-row-edit', function (val) { o.onRenameNote(note, val); });
      }));
    }
    if (o.onMoveNote) {
      acts.appendChild(actBtn('folder-open', '移動到其他資料夾', function () {
        o.onMoveNote(note).then(function (ok) { if (ok) render(o, true); });
      }));
    }
    if (o.onDeleteNote) {
      acts.appendChild(actBtn('trash', '移到垃圾桶', function () {
        o.onDeleteNote(note).then(function (ok) {
          if (ok) { o.notes = o.notes.filter(function (n) { return n.id !== note.id; }); render(o, true); }
        });
      }));
    }
    wrap.appendChild(acts);
    return wrap;
  }
  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return min + ' 分鐘前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小時前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    const mon = Math.floor(day / 30);
    if (mon < 12) return mon + ' 個月前';
    return Math.floor(mon / 12) + ' 年前';
  }
  function actBtn(icon, title, fn) {
    const b = el('button', 'dash-row-act', ic(icon));
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  // ---- 內文：資料夾方框格線 + 筆記條列（跟 dashboard.js 一樣回傳 fragment）-----
  function sectionHead(icon, label, count) {
    return el('div', 'dash-section-head',
      ic(icon) + '<span>' + esc(label) + '</span><span class="dash-section-count">' + count + '</span>');
  }
  function emptyState(icon, text) { return el('div', 'dash-empty', ic(icon) + '<span>' + esc(text) + '</span>'); }

  function renderBody(o) {
    const frag = document.createDocumentFragment();
    if (curFolderId && !o.folders.some(function (f) { return f.id === curFolderId; })) curFolderId = null;
    const subs = foldersIn(o.folders, curFolderId);
    const ns = notesIn(o.notes, curFolderId);

    if (subs.length) {
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('folder', '資料夾', subs.length));
      const grid = el('div', 'dash-folder-grid');
      subs.forEach(function (f) { grid.appendChild(makeFolderTile(f, o)); });
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    const sec2 = el('section', 'dash-section');
    sec2.appendChild(sectionHead('file-text', curFolderId ? '筆記' : '未歸類筆記', ns.length));
    const list = el('div', 'dash-list');
    if (!ns.length) list.appendChild(emptyState('file-text', o.emptyHint || (curFolderId ? '這個資料夾裡還沒有筆記。' : '還沒有筆記。')));
    ns.forEach(function (n) { list.appendChild(makeNoteRow(n, o)); });
    sec2.appendChild(list);
    frag.appendChild(sec2);
    return frag;
  }

  function render(opts, keepPos) {
    lastOpts = opts;
    if (!keepPos) curFolderId = null;
    const container = opts.container;
    container.innerHTML = '';
    container.appendChild(renderHead(opts));
    container.appendChild(renderBody(opts));
  }

  global.AreaBrowser = {
    render: function (container, opts) { opts.container = container; render(opts, false); },
    refresh: function (opts) { if (lastOpts) { opts.container = lastOpts.container; render(opts, true); } },
    reset: function () { curFolderId = null; lastOpts = null; }
  };
})(window);
