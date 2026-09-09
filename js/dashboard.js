/* dashboard.js — 首頁儀表板（沒有開啟筆記時顯示於右側）
 *
 * 版面：頁面標題（含可點的麵包屑）→ #標籤 → 資料夾方框 → 筆記條列。
 * 沒有外框，直接鋪在整個頁面上；資料夾是方框（右上角有「⋮」選單），筆記是
 * 條列，滑過去才出現勾選框與「釘選／改標題／⋯」。標籤篩選時平列所有帶該標籤
 * 的筆記。全部由目前載入的 state（notes / folders）即時計算，不需額外 API。
 *
 * 用法：Dashboard.render(opts) / Dashboard.refresh(opts)
 *   notes, folders            目前資料
 *   onOpen(noteId)            開啟筆記
 *   onBook(folderId)          以電子書模式閱讀整個資料夾（book.js）
 *   onBookRemove(folderId)    電子書方塊的 ✕：把資料夾移出電子書區（清 is_book）
 *   onBookUpdate(folderId)    資料夾頁的「更新到電子書」（只有 is_book 的資料夾才有）
 *   onPin(note, on)           釘選／取消釘選（存在 note.meta.pinned）
 *   onRename(note, title)     改筆記標題
 *   onMenu(note, el)          筆記的「⋯」選單
 *   onFolderMenu(folder, el)  資料夾的「⋮」選單
 *   onFolderRename(folder, n) 改資料夾名稱
 *   selection                 { has(id), toggle(id, on) }，與側邊欄共用批次選取
 * render() 會清掉標籤篩選（回首頁 = 顯示全部）；refresh() 保留目前的資料夾與篩選。
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
  function ic(name, cls) { return (global.Icons && Icons.svg) ? Icons.svg(name, cls) : ''; }

  const isMine = function (n) { return !n.perm || n.perm === 'owner'; };
  const isPinned = function (n) { return !!(n.meta && n.meta.pinned); };
  function noteKind(n) {
    if (n.meta && n.meta.perfReport) return { icon: 'chart', label: '成效報告', cls: 'kind-perf' };
    if (n.meta && n.meta.secReport) return { icon: 'shield', label: '資安院報告', cls: 'kind-sec' };
    return { icon: 'file-text', label: '', cls: '' };
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

  // ---- 狀態 ----------------------------------------------------------------
  let curFolderId = null;          // 目前瀏覽到哪個資料夾（null = 最上層）
  let lastOpts = null;             // 記住最近一次 render 的資料，供導覽時重繪
  let tagFilter = null;            // 目前的 #標籤 篩選（null = 不篩選）

  function foldersIn(folders, parentId) {
    return folders
      .filter(function (f) { return (f.parentId || null) === parentId; })
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant', { numeric: true }); });
  }
  // 釘選的排最前面，其餘依最近更新
  function sortNotes(list) {
    return list.sort(function (a, b) {
      const pa = isPinned(a) ? 1 : 0, pb = isPinned(b) ? 1 : 0;
      return (pb - pa) || ((b.updatedAt || 0) - (a.updatedAt || 0));
    });
  }
  function notesIn(notes, folderId) {
    return sortNotes(notes.filter(function (n) { return isMine(n) && (n.folderId || null) === folderId; }));
  }
  function folderById(folders, id) {
    for (let i = 0; i < folders.length; i++) if (folders[i].id === id) return folders[i];
    return null;
  }
  function countNotesDeep(notes, folders, folderId) {
    let c = notesIn(notes, folderId).length;
    foldersIn(folders, folderId).forEach(function (f) { c += countNotesDeep(notes, folders, f.id); });
    return c;
  }
  function crumbPath(folders, id) {
    const path = [];
    let cur = id;
    const guard = {};
    while (cur && !guard[cur]) {
      guard[cur] = true;
      const f = folderById(folders, cur);
      if (!f) break;
      path.unshift(f);
      cur = f.parentId || null;
    }
    return path;
  }

  function navigate(folderId) {
    curFolderId = folderId || null;
    paint();
  }
  function setTag(tag) {
    tagFilter = tag || null;
    paint();
  }

  function collectTags(notes) {
    const map = {};
    notes.filter(isMine).forEach(function (n) {
      const tags = (global.MD && MD.extractTags) ? MD.extractTags(n.content || '') : [];
      tags.forEach(function (t) {
        const k = t.toLowerCase();
        if (!map[k]) map[k] = { tag: t, count: 0 };
        map[k].count++;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hant'); });
  }

  // ---- 就地改名（資料夾方框與筆記列共用同一套行為）---------------------------
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

  // ---- 頁面標題 + 麵包屑 -----------------------------------------------------
  // 最上層時標題就是「所有筆記」；進到資料夾後，上方多一行可點的路徑，
  // 標題換成目前的資料夾名稱，點路徑上的任何一段都能跳回去。
  function renderHead(o) {
    const head = el('header', 'dash-head');
    const main = el('div', 'dash-head-main');
    const path = crumbPath(o.folders, curFolderId);

    // The breadcrumb is always present, including at the top level where it is a
    // single 所有筆記 crumb. A path that appears only once you are inside a folder
    // reads as an error message rather than as navigation, and there is nowhere
    // to drop a note you want to move back out to the top.
    const nav = el('nav', 'dash-crumbs');
    nav.setAttribute('aria-label', '資料夾路徑');

    function crumb(label, iconName, folderId, isCurrent) {
      const c = el('button', 'dash-crumb' + (isCurrent ? ' is-current' : ''),
        (iconName ? ic(iconName) : '') + '<span>' + esc(label) + '</span>');
      c.type = 'button';
      if (isCurrent) {
        c.setAttribute('aria-current', 'page');
      } else {
        c.title = '回到「' + (label) + '」';
        c.addEventListener('click', function () { tagFilter = null; navigate(folderId); });
      }
      // Every crumb accepts a drop, so dragging onto an ancestor moves a note up
      // the tree — the reverse of dropping it onto a folder tile.
      makeDropTarget(c, folderId, o);
      return c;
    }

    const atRoot = !curFolderId && !tagFilter;
    nav.appendChild(crumb('所有筆記', 'layout-grid', null, atRoot));
    path.forEach(function (f, i) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      nav.appendChild(crumb(f.name || '未命名資料夾', null, f.id,
        !tagFilter && i === path.length - 1));
    });
    if (tagFilter) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      const t = el('button', 'dash-crumb is-current', ic('tag') + '<span>' + esc(tagFilter) + '</span>');
      t.type = 'button';
      t.setAttribute('aria-current', 'page');
      nav.appendChild(t);
    }
    main.appendChild(nav);

    // 目前層的內容量，當麵包屑的副標——不再另外疊一個「所有筆記」大標題，
    // 麵包屑本身（含目前這一段的醒目樣式）就是頁面標題。
    if (!tagFilter) {
      const subs = foldersIn(o.folders, curFolderId).length;
      const ns = notesIn(o.notes, curFolderId).length;
      const bits = [];
      if (subs) bits.push(subs + ' 個資料夾');
      bits.push(ns + ' 篇筆記');
      main.appendChild(el('div', 'dash-subtitle', esc(bits.join('・'))));
    }
    head.appendChild(main);

    const right = el('div', 'dash-head-right');
    if (tagFilter) {
      const clear = el('button', 'btn', ic('x') + '<span>清除篩選</span>');
      clear.type = 'button';
      clear.addEventListener('click', function () { setTag(null); });
      right.appendChild(clear);
    } else if (curFolderId && o.onBookUpdate && (folderById(o.folders, curFolderId) || {}).isBook) {
      // 只有做成電子書的資料夾才有這顆鈕：把公開分享連結用目前內容重新打包，
      // 再打開閱讀器。沒做成電子書的資料夾什麼都不顯示（要做就走 新增 → 電子書）。
      const b = el('button', 'btn btn-primary dash-book-btn', ic('book-open') + '<span>更新到電子書</span>');
      b.type = 'button';
      b.title = '用這個資料夾目前的內容重新打包公開分享連結，然後打開電子書';
      b.addEventListener('click', function () { o.onBookUpdate(curFolderId); });
      right.appendChild(b);
    }
    head.appendChild(right);
    return head;
  }

  // ---- #標籤 ---------------------------------------------------------------
  function renderTagCloud(notes) {
    const tags = collectTags(notes);
    if (!tags.length) return null;
    const sec = el('section', 'dash-section dash-tags');
    sec.appendChild(sectionHead('tag', '標籤', tags.length));
    const cloud = el('div', 'dash-tag-cloud');
    tags.forEach(function (t) {
      const active = tagFilter && tagFilter.toLowerCase() === t.tag.toLowerCase();
      const chip = el('button', 'tag-chip' + (active ? ' active' : ''));
      chip.type = 'button';
      chip.innerHTML = '<span class="tag-hash">#</span>' + esc(t.tag) + '<span class="tag-count">' + t.count + '</span>';
      chip.addEventListener('click', function () { setTag(active ? null : t.tag); });
      cloud.appendChild(chip);
    });
    sec.appendChild(cloud);
    return sec;
  }

  // ---- 資料夾方框 -------------------------------------------------------------
  // ---- Drag notes into folders --------------------------------------------
  //
  // The payload rides on a private MIME type rather than a module variable, so a
  // drag that starts here is inert everywhere else on the page (and a drag that
  // starts elsewhere — a file, a link — never looks like a note move).
  const DND = 'application/x-strikenote-notes';
  let dragging = null;   // ids being dragged, for the dragover check

  function beginNoteDrag(e, note, o) {
    // Dragging one of several selected notes moves the whole selection, which is
    // what the checkboxes are for; dragging an unselected note moves just it.
    let ids = [note.id];
    if (o.selection && o.selection.has(note.id) && o.selection.ids) {
      const all = o.selection.ids();
      if (all.length > 1) ids = all;
    }
    dragging = ids;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(DND, JSON.stringify(ids));
      // A plain-text fallback keeps the cursor from showing "no drop" in browsers
      // that ignore unknown MIME types during dragover.
      e.dataTransfer.setData('text/plain', note.title || '');
    } catch (err) { /* older browsers restrict setData; the module var still works */ }
    e.stopPropagation();
  }

  function isNoteDrag(e) {
    if (dragging) return true;
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!(t && Array.prototype.indexOf.call(t, DND) >= 0);
  }

  // `folderId` may be null, which means "the top level" — that is how a note gets
  // dragged back out of a folder onto the 所有筆記 crumb.
  function makeDropTarget(el, folderId, o) {
    if (!o.onMoveNotes) return el;
    el.addEventListener('dragover', function (e) {
      if (!isNoteDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (e) {
      if (!isNoteDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      let ids = dragging;
      try {
        const raw = e.dataTransfer.getData(DND);
        if (raw) ids = JSON.parse(raw);
      } catch (err) { /* fall back to the ids captured on dragstart */ }
      dragging = null;
      if (ids && ids.length) o.onMoveNotes(ids, folderId);
    });
    return el;
  }

  // 電子書方塊：點了用閱讀器打開；右上角的 ✕ 只是移出電子書區（清掉 is_book），
  // 資料夾與筆記都還在。版型借用資料夾方塊的 head / meta / acts。
  function makeBookTile(folder, o) {
    const chapters = countNotesDeep(o.notes, o.folders, folder.id);
    const tile = el('div', 'dash-book-tile');
    tile.dataset.id = folder.id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '以電子書閱讀';
    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic dash-book-ic', ic('book-open')));
    head.appendChild(el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾')));
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(chapters + ' 章')));
    function open() { if (o.onBook) o.onBook(folder.id); }
    tile.addEventListener('click', open);
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    if (o.onBookRemove) {
      const acts = el('div', 'dash-folder-acts');
      const x = el('button', 'dash-folder-menu dash-book-remove', ic('x'));
      x.type = 'button';
      x.title = '移出電子書區（資料夾與筆記都不會被刪除）';
      x.addEventListener('click', function (e) { e.stopPropagation(); o.onBookRemove(folder.id); });
      acts.appendChild(x);
      tile.appendChild(acts);
    }
    return tile;
  }

  function makeFolderTile(folder, o) {
    const notes = o.notes, folders = o.folders;
    const own = notesIn(notes, folder.id);
    const subs = foldersIn(folders, folder.id);
    const deep = countNotesDeep(notes, folders, folder.id);
    const metaBits = [deep + ' 筆記'];
    if (subs.length) metaBits.push(subs.length + ' 子資料夾');

    const tile = el('div', 'dash-folder-tile');
    tile.dataset.id = folder.id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '打開資料夾';
    makeDropTarget(tile, folder.id, o);

    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic', ic('folder')));
    const nameEl = el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾'));
    head.appendChild(nameEl);
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(metaBits.join('・'))));

    let preview = '';
    own.slice(0, 3).forEach(function (n) {
      const k = noteKind(n);
      preview += '<li>' + ic(k.icon) + '<span>' + esc(n.title || '未命名筆記') + '</span></li>';
    });
    // 超過三篇只補一個「…」；整份清單放進滑過去才浮出來的 peek，方塊本身不長高
    if (own.length > 3) {
      preview += '<li class="more dash-folder-ellipsis" title="還有 ' + (own.length - 3) + ' 篇，滑過去看全部">…</li>';
    }
    if (!own.length && subs.length) preview += '<li class="more">筆記在子資料夾裡</li>';
    if (!own.length && !subs.length) preview += '<li class="more">空資料夾</li>';
    tile.appendChild(el('ul', 'dash-folder-preview', preview));
    if (own.length > 3) {
      const PEEK_MAX = 15;
      let peek = '<div class="dash-folder-peek-title">' + ic('file-text') +
        '<span>全部 ' + own.length + ' 篇</span></div><ul>';
      own.slice(0, PEEK_MAX).forEach(function (n) {
        const k = noteKind(n);
        peek += '<li>' + ic(k.icon) + '<span>' + esc(n.title || '未命名筆記') + '</span></li>';
      });
      if (own.length > PEEK_MAX) peek += '<li class="more">還有 ' + (own.length - PEEK_MAX) + ' 篇…</li>';
      peek += '</ul>';
      tile.appendChild(el('div', 'dash-folder-peek', peek));
    }

    // 右上角：電子書 + 直式「⋮」選單
    const acts = el('div', 'dash-folder-acts');
    if (o.onBook && deep > 0) {
      const b = el('button', 'dash-folder-book', ic('book-open') + '<span>電子書</span>');
      b.type = 'button';
      b.title = '以電子書模式閱讀這個資料夾';
      b.addEventListener('click', function (e) { e.stopPropagation(); o.onBook(folder.id); });
      acts.appendChild(b);
    }
    if (o.onFolderMenu) {
      const m = el('button', 'dash-folder-menu', ic('more-vertical'));
      m.type = 'button';
      m.title = '更多';
      m.addEventListener('click', function (e) { e.stopPropagation(); o.onFolderMenu(folder, m); });
      acts.appendChild(m);
    }
    tile.appendChild(acts);

    tile.addEventListener('dblclick', function (e) {
      if (!o.onFolderRename) return;
      e.preventDefault(); e.stopPropagation();
      renameTile(folder, nameEl, o);
    });
    tile.addEventListener('click', function () { navigate(folder.id); });
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(folder.id); }
      else if (e.key === 'F2') { e.preventDefault(); renameTile(folder, nameEl, o); }
    });
    return tile;
  }
  function renameTile(folder, nameEl, o) {
    inlineRename(nameEl, folder.name || '', 'dash-folder-edit', function (val) {
      if (o.onFolderRename) o.onFolderRename(folder, val);
    });
  }

  // ---- 筆記條列 ---------------------------------------------------------------
  function actBtn(icon, title, cls, fn) {
    const b = el('button', 'dash-row-act' + (cls ? ' ' + cls : ''), ic(icon));
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(e, b); });
    return b;
  }

  function makeNoteRow(note, o) {
    const k = noteKind(note);
    const mine = isMine(note);
    const pinned = isPinned(note);
    const wrap = el('div', 'dash-note-wrap' + (pinned ? ' pinned' : ''));
    wrap.dataset.id = note.id;

    // Only my own notes can be filed. A note shared with me lives in the owner's
    // tree, so dragging it into one of my folders would do nothing.
    if (mine && o.onMoveNotes) {
      wrap.draggable = true;
      wrap.addEventListener('dragstart', function (e) { beginNoteDrag(e, note, o); });
      wrap.addEventListener('dragend', function () {
        dragging = null;
        const hints = document.querySelectorAll('.drop-target');
        Array.prototype.forEach.call(hints, function (n) { n.classList.remove('drop-target'); });
      });
    }

    if (o.selection && mine) {
      if (o.selection.has(note.id)) wrap.className += ' selected';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dash-note-check';
      cb.checked = o.selection.has(note.id);
      cb.title = '選取';
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        o.selection.toggle(note.id, cb.checked);
        wrap.classList.toggle('selected', cb.checked);
      });
      wrap.appendChild(cb);
    }

    const row = el('div', 'dash-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.appendChild(el('span', 'dash-row-ic ' + k.cls, ic(k.icon)));
    const titleEl = el('span', 'dash-row-title', esc(note.title || '未命名筆記'));
    row.appendChild(titleEl);
    if (pinned) row.appendChild(el('span', 'dash-row-pin', ic('pin')));
    const meta = el('span', 'dash-row-meta');
    if (k.label) meta.appendChild(el('span', 'dash-row-kind ' + k.cls, k.label));
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    row.addEventListener('click', function () { o.onOpen(note.id); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); o.onOpen(note.id); }
      else if (e.key === 'F2' && mine) { e.preventDefault(); startNoteRename(); }
    });
    wrap.appendChild(row);

    function startNoteRename() {
      inlineRename(titleEl, note.title || '', 'dash-row-edit', function (val) {
        if (o.onRename) o.onRename(note, val);
      });
    }

    if (mine) {
      const acts = el('div', 'dash-row-actions');
      acts.appendChild(actBtn('pin', pinned ? '取消釘選' : '釘選到最上面', pinned ? 'on' : '', function () {
        if (o.onPin) o.onPin(note, !pinned);
      }));
      acts.appendChild(actBtn('pencil', '修改標題', '', startNoteRename));
      acts.appendChild(actBtn('more-horizontal', '更多', '', function (e, b) {
        if (o.onMenu) o.onMenu(note, b);
      }));
      wrap.appendChild(acts);
    }
    return wrap;
  }

  function sectionHead(icon, label, count) {
    return el('div', 'dash-section-head',
      ic(icon) + '<span>' + esc(label) + '</span>' +
      (count != null ? '<span class="dash-section-count">' + count + '</span>' : ''));
  }

  // ---- 內容區 ---------------------------------------------------------------
  function renderBody(o) {
    const frag = document.createDocumentFragment();
    if (tagFilter) {
      const key = tagFilter.toLowerCase();
      const matches = sortNotes(o.notes.filter(function (n) {
        if (!isMine(n)) return false;
        const tags = (global.MD && MD.extractTags) ? MD.extractTags(n.content || '') : [];
        return tags.some(function (t) { return t.toLowerCase() === key; });
      }));
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('file-text', '筆記', matches.length));
      const body = el('div', 'dash-list');
      if (!matches.length) body.appendChild(emptyState('tag', '沒有帶有 #' + tagFilter + ' 的筆記。'));
      matches.forEach(function (n) { body.appendChild(makeNoteRow(n, o)); });
      sec.appendChild(body);
      frag.appendChild(sec);
      return frag;
    }

    if (curFolderId && !folderById(o.folders, curFolderId)) curFolderId = null;
    const subs = foldersIn(o.folders, curFolderId);
    const ns = notesIn(o.notes, curFolderId);

    // 電子書：做過的電子書（is_book 的資料夾）在最上層獨立一區，跟資料夾、
    // 未歸類筆記並列；沒有的時候也留著這一區，提示要從哪裡做一本。
    if (!curFolderId) {
      const books = o.folders.filter(function (f) { return f.isBook; }).sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
      });
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('book-open', '電子書', books.length));
      if (books.length) {
        const grid = el('div', 'dash-folder-grid');
        books.forEach(function (f) { grid.appendChild(makeBookTile(f, o)); });
        sec.appendChild(grid);
      } else {
        sec.appendChild(emptyState('book-open', '還沒有電子書。從左側「新增 → 電子書」把一個資料夾做成電子書，它就會放在這裡。'));
      }
      frag.appendChild(sec);
    }

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
    const body = el('div', 'dash-list');
    if (!ns.length) {
      body.appendChild(emptyState('file-text',
        !subs.length && !curFolderId ? '還沒有筆記。從左側的「筆記」或上方的報告模式開始吧。' :
        curFolderId ? '這個資料夾裡還沒有筆記。' : '所有筆記都已歸入資料夾。'));
    }
    ns.forEach(function (n) { body.appendChild(makeNoteRow(n, o)); });
    sec2.appendChild(body);
    frag.appendChild(sec2);
    return frag;
  }

  function emptyState(icon, text) {
    return el('div', 'dash-empty', ic(icon) + '<span>' + esc(text) + '</span>');
  }

  // ---- 進入點 ------------------------------------------------------------
  function paint() {
    const root = document.getElementById('dashboard');
    if (!root || !lastOpts) return;
    root.innerHTML = '';
    root.appendChild(renderHead(lastOpts));
    if (!tagFilter) {
      const cloud = renderTagCloud(lastOpts.notes);
      if (cloud) root.appendChild(cloud);
    }
    root.appendChild(renderBody(lastOpts));
  }
  function normalize(opts) {
    const o = opts || {};
    return {
      notes: o.notes || [], folders: o.folders || [],
      onOpen: o.onOpen || function () {},
      onBook: o.onBook, onBookRemove: o.onBookRemove, onBookUpdate: o.onBookUpdate,
      onPin: o.onPin, onRename: o.onRename, onMenu: o.onMenu,
      onFolderMenu: o.onFolderMenu, onFolderRename: o.onFolderRename,
      onMoveNotes: o.onMoveNotes,
      selection: o.selection
    };
  }
  // render() = 回首頁：清掉標籤篩選、也回到最上層。之前只清篩選不清資料夾，
  // 所以在資料夾裡點左上角的 StrikeNote 會原地不動。
  function render(opts) {
    lastOpts = normalize(opts);
    tagFilter = null;
    curFolderId = null;
    paint();
  }
  function refresh(opts) {
    lastOpts = normalize(Object.assign({}, lastOpts || {}, opts || {}));
    paint();
  }
  // 讓 app.js 的資料夾選單也能觸發方框上的就地改名
  function renameFolderTile(id) {
    const tile = document.querySelector('#dashboard .dash-folder-tile[data-id="' + id + '"]');
    if (!tile || !lastOpts) return;
    const folder = folderById(lastOpts.folders, id);
    const nameEl = tile.querySelector('.dash-folder-name');
    if (folder && nameEl) renameTile(folder, nameEl, lastOpts);
  }

  // currentFolder：app.js 用它決定「新增」要把東西放進哪個資料夾
  function currentFolder() { return curFolderId; }
  global.Dashboard = {
    render: render, refresh: refresh, setTag: setTag, openFolder: navigate,
    currentFolder: currentFolder, renameFolderTile: renameFolderTile
  };
})(window);
