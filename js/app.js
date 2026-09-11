/* app.js — UI orchestration: tree, editor, view modes, paste, export */
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };
  const LS = {
    get: function (k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  const state = {
    folders: [],
    notes: [],
    currentId: null,
    mode: LS.get('mode', 'split'),
    expanded: {},
    current: null
  };

  try { state.expanded = JSON.parse(LS.get('expanded', '{}')) || {}; } catch (e) { state.expanded = {}; }

  // ---- Elements ----------------------------------------------------------
  const treeEl = $('#tree');
  const editorEl = $('#editor');
  const previewEl = $('#preview');
  const previewScrollEl = $('#preview-scroll');
  const tocEl = $('#preview-toc');
  const titleEl = $('#note-title');
  const panesEl = $('#panes');
  const emptyEl = $('#empty-state');
  const wrapEl = $('#editor-wrap');
  const statusInfo = $('#status-info');
  const statusSave = $('#status-save');
  const ctxMenu = $('#ctx-menu');
  const backlinksEl = $('#backlinks');
  const searchInput = $('#search-input');
  const searchResultsEl = $('#search-results');
  const searchClearEl = $('#search-clear');
  const shareBtn = $('#share-btn');
  const historyBtn = $('#history-btn');
  const presenceEl = $('#presence');
  const editorAreaEl = $('#editor-area');
  const notePathEl = $('#note-path');
  const selected = new Set();   // 批次選取的筆記 id

  // ---- Note links --------------------------------------------------------
  function normTitle(t) { return String(t || '').trim().toLowerCase(); }
  function findNoteByTitle(title) {
    const k = normTitle(title);
    return state.notes.filter(function (n) { return normTitle(n.title) === k; })[0] || null;
  }
  // markdown.js resolves [[…]] through this; editor.js autocompletes through it.
  MD.setNoteLookup(findNoteByTitle);
  // 樹狀清單／搜尋結果用的筆記圖示：分享來的看權限，自己的看筆記種類。
  function noteIcon(note) {
    if (note.perm && note.perm !== 'owner') return note.perm === 'edit' ? 'pen-line' : 'lock';
    if (note.meta && note.meta.perfReport) return 'chart';
    if (note.meta && note.meta.secReport) return 'shield';
    return 'file-text';
  }
  if (window.Editor) Editor.setNoteProvider(function (query) {
    const q = normTitle(query);
    return state.notes
      .filter(function (n) { return n.id !== state.currentId && normTitle(n.title).indexOf(q) >= 0; })
      .sort(function (a, b) {
        // Prefix matches first, then most recently touched.
        const ap = normTitle(a.title).indexOf(q) === 0, bp = normTitle(b.title).indexOf(q) === 0;
        if (ap !== bp) return ap ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  });

  // ---- Init --------------------------------------------------------------
  function init() {
    applyTheme(LS.get('theme', 'light'));
    setMode(state.mode);
    setTocCollapsed(LS.get('tocCollapsed', '0') === '1');
    bindEvents();
    // Nothing loads until the session is confirmed by the server.
    Auth.init(function (user) {
      loadData().then(function () {
        // Notes from before the server existed are stranded in IndexedDB — offer
        // to bring them across rather than silently leave them behind.
        if (window.Migrate) Migrate.maybeOffer(user, function () { loadData(); });
      }).catch(function (e) {
        alert('無法載入筆記：' + (e && e.message || e));
      });
    });
  }

  function loadData() {
    return Promise.all([Store.getFolders(), Store.getNotes()]).then(function (res) {
      state.folders = res[0];
      state.notes = res[1];
      renderTree();
      // 網址帶 #note/<id> 或 #book/<id>（複製連結）優先；否則回到上次開的筆記
      const wantNote = noteIdFromHash();
      const wantBook = bookIdFromHash();
      const last = wantNote || LS.get('lastNote', null);
      if (wantBook && state.folders.some(function (f) { return f.id === wantBook; })) {
        openBook(wantBook);
      } else if (last && state.notes.some(function (n) { return n.id === last; })) {
        openNote(last);
      } else {
        if (wantNote || wantBook) toast('找不到這篇筆記，或你沒有存取權');
        showEmpty();
      }
    });
  }

  // ---- Tree rendering ----------------------------------------------------
  function childFolders(parentId) {
    return state.folders
      .filter(function (f) { return (f.parentId || null) === parentId; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
  }
  const isMine = n => !n.perm || n.perm === 'owner';
  function childNotes(folderId) {
    return state.notes
      .filter(function (n) { return isMine(n) && (n.folderId || null) === folderId; })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }
  // Notes shared with me live in their owner's folder tree, not mine, so they get
  // their own section instead of being filed under a folder id I do not have.
  function sharedNotes() {
    return state.notes.filter(function (n) { return !isMine(n); })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function renderTree() {
    // Notes changed (created / deleted / renamed / moved), so any open result
    // list is now stale — recompute it against the current notes.
    if (search.query.trim()) runSearch(search.query);
    treeEl.innerHTML = '';
    treeEl.appendChild(buildLevel(null));
    if (!state.folders.length && !state.notes.length) {
      const hint = document.createElement('div');
      hint.className = 'tree-hint';
      hint.textContent = '尚無筆記，點上方「＋ 筆記」開始。';
      treeEl.appendChild(hint);
    }
    const shared = sharedNotes();
    if (shared.length) {
      const head = document.createElement('div');
      head.className = 'tree-section';
      head.textContent = '分享給我的（' + shared.length + '）';
      treeEl.appendChild(head);
      shared.forEach(function (n) { treeEl.appendChild(buildNoteRow(n)); });
    }
    pruneSelection();   // 同步批次列（丟掉已不存在的選取）
  }

  function buildLevel(parentId) {
    const frag = document.createDocumentFragment();
    childFolders(parentId).forEach(function (f) { frag.appendChild(buildFolder(f)); });
    childNotes(parentId).forEach(function (n) { frag.appendChild(buildNoteRow(n)); });
    return frag;
  }

  function buildFolder(folder) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-folder';
    const open = !!state.expanded[folder.id];

    const row = document.createElement('div');
    row.className = 'tree-row folder-row';
    row.draggable = true;
    row.dataset.type = 'folder';
    row.dataset.id = folder.id;
    row.innerHTML =
      '<span class="twisty">' + Icons.svg(open ? 'chevron-down' : 'chevron-right') + '</span>' +
      '<span class="ic ic-folder">' + Icons.svg('folder') + '</span>' +
      '<span class="label">' + MD.escapeHtml(folder.name) + '</span>';

    // hover actions: add subfolder / add note inside this folder
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const bFolder = document.createElement('button');
    bFolder.className = 'row-act'; bFolder.title = '新增子資料夾'; bFolder.innerHTML = Icons.svg('folder-plus');
    const bNote = document.createElement('button');
    bNote.className = 'row-act'; bNote.title = '在此新增筆記'; bNote.innerHTML = Icons.svg('file-plus');
    const bBook = document.createElement('button');
    bBook.className = 'row-act'; bBook.title = '以電子書閱讀這個資料夾'; bBook.innerHTML = Icons.svg('book-open');
    bFolder.addEventListener('click', function (e) { e.stopPropagation(); newFolder(folder.id); });
    bNote.addEventListener('click', function (e) { e.stopPropagation(); newNote(folder.id); });
    bBook.addEventListener('click', function (e) { e.stopPropagation(); openBook(folder.id); });
    actions.appendChild(bFolder);
    actions.appendChild(bNote);
    actions.appendChild(bBook);
    row.appendChild(actions);

    row.addEventListener('click', function () { toggleFolder(folder.id); });
    row.addEventListener('dblclick', function (e) { e.stopPropagation(); startRename('folder', folder.id); });
    row.addEventListener('contextmenu', function (e) { showCtx(e, 'folder', folder); });
    attachDrag(row, 'folder', folder.id);
    attachDrop(row, folder.id);
    wrap.appendChild(row);

    if (open) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      kids.appendChild(buildLevel(folder.id));
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function buildNoteRow(note) {
    const row = document.createElement('div');
    const mine = isMine(note);
    row.className = 'tree-row note-row' + (note.id === state.currentId ? ' active' : '') +
      (mine ? '' : ' shared-row') + (selected.has(note.id) ? ' selected' : '');
    row.draggable = mine;   // dragging a shared note into my folders would do nothing
    row.dataset.type = 'note';
    row.dataset.id = note.id;
    // 只有自己的筆記才有勾選框（批次移動／刪除都需要擁有權）
    const checkHtml = mine
      ? '<input type="checkbox" class="note-check" title="選取"' + (selected.has(note.id) ? ' checked' : '') + '>'
      : '';
    row.innerHTML = checkHtml +
      '<span class="ic">' + Icons.svg(noteIcon(note)) + '</span>' +
      '<span class="label">' + MD.escapeHtml(note.title || '未命名筆記') + '</span>' +
      (mine ? '' : '<span class="share-by">' + MD.escapeHtml(note.sharedBy || '') + '</span>');
    const cb = row.querySelector('.note-check');
    if (cb) {
      // 點框只切換選取，不要順便打開筆記
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(note.id); else selected.delete(note.id);
        row.classList.toggle('selected', cb.checked);
        syncDashCheck(note.id, cb.checked);   // 反映到儀表板「所有筆記」
        updateBatchBar();
      });
    }
    row.addEventListener('click', function () { openNote(note.id); });
    row.addEventListener('contextmenu', function (e) { showCtx(e, 'note', note); });
    attachDrag(row, 'note', note.id);
    return row;
  }

  function toggleFolder(id) {
    state.expanded[id] = !state.expanded[id];
    LS.set('expanded', JSON.stringify(state.expanded));
    renderTree();
  }

  // ---- Drag & drop (move items between folders) --------------------------
  let dragData = null;
  function attachDrag(el, type, id) {
    el.addEventListener('dragstart', function (e) {
      dragData = { type: type, id: id };
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
    el.addEventListener('dragend', function () { dragData = null; clearDropHints(); });
  }
  function attachDrop(el, folderId) {
    el.addEventListener('dragover', function (e) {
      if (!dragData) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      moveItem(dragData, folderId);
    });
  }
  function clearDropHints() {
    document.querySelectorAll('.drop-target').forEach(function (n) { n.classList.remove('drop-target'); });
  }

  function isDescendant(folderId, maybeAncestorId) {
    // true if folderId is the same as, or nested inside, maybeAncestorId
    let cur = folderId;
    while (cur) {
      if (cur === maybeAncestorId) return true;
      const f = state.folders.find(function (x) { return x.id === cur; });
      cur = f ? f.parentId : null;
    }
    return false;
  }

  function moveItem(data, targetFolderId) {
    if (!data) return;
    if (data.type === 'note') {
      const n = state.notes.find(function (x) { return x.id === data.id; });
      if (n && (n.folderId || null) !== (targetFolderId || null)) {
        n.folderId = targetFolderId || null;
        Store.updateNote(n).then(refreshViews);
      }
    } else if (data.type === 'folder') {
      if (data.id === targetFolderId || isDescendant(targetFolderId, data.id)) return; // no cycles
      const f = state.folders.find(function (x) { return x.id === data.id; });
      if (f && (f.parentId || null) !== (targetFolderId || null)) {
        f.parentId = targetFolderId || null;
        Store.updateFolder(f).then(refreshViews);
      }
    }
  }

  // ---- 批次選取：勾選筆記後整批移動到資料夾或刪除 -----------------------
  function updateBatchBar() {
    const bar = document.getElementById('batch-bar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    // 批次列在抽屜裡：從首頁勾選筆記時抽屜多半是收起的，得拉出來才看得到移動／刪除鈕
    if (selected.size > 0 && !isSidebarOpen()) setSidebarOpen(true);
    const c = bar.querySelector('.batch-count');
    if (c) c.textContent = '已選 ' + selected.size + ' 篇';
  }
  function clearSelection() {
    selected.clear();
    treeEl.querySelectorAll('.note-row.selected').forEach(function (r) {
      r.classList.remove('selected');
      const cb = r.querySelector('.note-check'); if (cb) cb.checked = false;
    });
    updateBatchBar();
  }
  // 丟掉已不存在（或非自己）的筆記 id，避免選取殘留
  function pruneSelection() {
    const valid = {};
    state.notes.forEach(function (n) { if (isMine(n)) valid[n.id] = true; });
    Array.from(selected).forEach(function (id) { if (!valid[id]) selected.delete(id); });
    updateBatchBar();
  }
  // 側邊欄該列的勾選狀態同步（供儀表板那邊改動時反映）
  function syncTreeCheck(id, on) {
    const row = treeEl.querySelector('.note-row[data-id="' + id + '"]');
    if (!row) return;
    row.classList.toggle('selected', on);
    const c = row.querySelector('.note-check'); if (c) c.checked = on;
  }
  // 儀表板「所有筆記」那邊該筆記的勾選狀態同步（供側邊欄改動時反映）
  function syncDashCheck(id, on) {
    const w = document.querySelector('#dashboard .dash-note-wrap[data-id="' + id + '"]');
    if (!w) return;
    w.classList.toggle('selected', on);
    const c = w.querySelector('.dash-note-check'); if (c) c.checked = on;
  }
  // 給儀表板用的選取 API（讓「所有筆記」也能勾選、共用同一份選取與批次列）
  const selectionApi = {
    has: function (id) { return selected.has(id); },
    ids: function () { return Array.from(selected); },
    toggle: function (id, on) {
      if (on) selected.add(id); else selected.delete(id);
      syncTreeCheck(id, on);   // 反映到側邊欄
      updateBatchBar();
    }
  };
  // 批次動作後同時刷新側邊欄與（若正在顯示的）儀表板
  function refreshViews() {
    renderTree();
    if (!emptyEl.hidden && window.Dashboard) Dashboard.refresh(dashOpts());
  }
  // 儀表板需要的資料與回呼，集中一處，render / refresh 共用
  function dashOpts() {
    return {
      notes: state.notes, folders: state.folders,
      onOpen: openNote, onBook: openBook, onBookRemove: unmarkBook, onBookUpdate: updateBook,
      onPin: pinNote, onRename: renameNoteTo, onMenu: showNoteMenu,
      onFolderMenu: showFolderMenu, onFolderRename: renameFolderTo,
      onMoveNotes: moveNotesToFolder,
      selection: selectionApi
    };
  }

  // Drag-and-drop filing from the dashboard. `folderId` may be null, meaning the
  // top level. Notes already in the target are skipped so dropping a mixed
  // selection does not generate pointless saves.
  function moveNotesToFolder(ids, folderId) {
    const target = folderId || null;
    const moving = ids
      .map(function (id) { return state.notes.find(function (n) { return n.id === id; }); })
      .filter(function (n) { return n && isMine(n) && (n.folderId || null) !== target; });
    if (!moving.length) return;
    moving.forEach(function (n) { n.folderId = target; });
    Promise.all(moving.map(function (n) {
      return Store.updateNote(n).catch(function (e) {
        toast('搬移「' + (n.title || '未命名筆記') + '」失敗：' + e.message);
      });
    })).then(function () {
      selected.clear();
      updateBatchBar();
      refreshViews();
      const where = target
        ? '「' + ((state.folders.find(function (f) { return f.id === target; }) || {}).name || '資料夾') + '」'
        : '最上層';
      toast('已搬移 ' + moving.length + ' 篇筆記到' + where);
    });
  }

  function batchDelete() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    showConfirm({
      title: '移至垃圾桶',
      message: '把所選的 ' + ids.length + ' 篇筆記移到垃圾桶？\n保留期內可以從側邊欄的「垃圾桶」復原。',
      ok: '移至垃圾桶'
    }).then(function (ok) {
      if (!ok) return;
      Promise.all(ids.map(function (id) { return Store.deleteNote(id).catch(function () {}); })).then(function () {
        const gone = {};
        ids.forEach(function (id) { gone[id] = true; });
        state.notes = state.notes.filter(function (n) { return !gone[n.id]; });
        if (state.currentId && gone[state.currentId]) showEmpty();
        selected.clear();
        refreshViews();
        toast('已移至垃圾桶 ' + ids.length + ' 篇筆記');
      });
    });
  }

  function batchMove() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    showFolderPicker('移動 ' + ids.length + ' 篇筆記到…').then(function (res) {
      if (!res) return;                                  // 取消
      const target = res.folderId || null;
      const jobs = [];
      ids.forEach(function (id) {
        const n = state.notes.find(function (x) { return x.id === id; });
        if (n && isMine(n) && (n.folderId || null) !== target) {
          n.folderId = target;
          jobs.push(Store.updateNote(n).catch(function () {}));
        }
      });
      Promise.all(jobs).then(function () {
        selected.clear();
        refreshViews();
      });
    });
  }

  // 資料夾完整路徑名（給選單顯示，例：外層 / 內層）
  function folderFullName(id) {
    const parts = [];
    let cur = id, guard = 0;
    while (cur && guard++ < 50) {
      const f = state.folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      parts.unshift(f.name || '');
      cur = f.parentId || null;
    }
    return parts.join(' / ');
  }
  // 選資料夾對話框：resolve({folderId}) 或 resolve(null)（取消）
  function showFolderPicker(title, o) {
    o = o || {};
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'modal';
      const opts = o.noRoot ? [] : ['<option value="">（最上層）</option>'];
      state.folders.slice().sort(function (a, b) {
        return folderFullName(a.id).localeCompare(folderFullName(b.id), 'zh-Hant');
      }).forEach(function (f) {
        opts.push('<option value="' + f.id + '">' + MD.escapeHtml(folderFullName(f.id)) + '</option>');
      });
      modal.innerHTML =
        '<div class="modal-title">' + MD.escapeHtml(title || '移動到資料夾') + '</div>' +
        '<div class="modal-body"><select class="folder-picker">' + opts.join('') + '</select></div>' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel" type="button">取消</button>' +
        '<button class="btn btn-primary modal-ok" type="button">' + MD.escapeHtml(o.ok || '移動') + '</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const sel = modal.querySelector('.folder-picker');
      function close(val) { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });
      modal.querySelector('.modal-cancel').addEventListener('click', function () { close(null); });
      modal.querySelector('.modal-ok').addEventListener('click', function () { close({ folderId: sel.value || null }); });
      setTimeout(function () { sel.focus(); }, 30);
    });
  }

  // Allow dropping onto empty tree area => move to root
  treeEl.addEventListener('dragover', function (e) { if (dragData) { e.preventDefault(); } });
  treeEl.addEventListener('drop', function (e) {
    if (dragData && e.target === treeEl) { e.preventDefault(); moveItem(dragData, null); }
  });

  // ---- Note open / editor ------------------------------------------------
  const secWrapEl = $('#sec-wrap');
  const perfWrapEl = $('#perf-wrap');
  const bookWrapEl = $('#book-wrap');
  // 切換頂列的「筆記模式」：開一般筆記時顯示標題與編輯按鈕，回首頁時只留 logo + 帳號。
  function noteBar(on) {
    const app = document.getElementById('app');
    if (app) app.classList.toggle('note-open', !!on);
  }

  // 資料夾路徑前綴：往上層走到根，組成「a\b\」（無資料夾時回空字串）。
  function folderPathPrefix(folderId) {
    const parts = [];
    let cur = folderId || null, guard = 0;
    while (cur && guard++ < 50) {
      const f = state.folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      parts.unshift(f.name || '');
      cur = f.parentId || null;
    }
    return parts.length ? parts.join('\\') + '\\' : '';
  }
  function updateNotePath(note) {
    if (notePathEl) {
      notePathEl.textContent = note ? folderPathPrefix(note.folderId) : '';
      const f = note && note.folderId && state.folders.find(function (x) { return x.id === note.folderId; });
      notePathEl.title = f ? '回到「' + (f.name || '未命名資料夾') + '」' : '';
    }
    fitNoteTitle();
  }
  // 點標題前的「資料夾\」前綴：回到首頁並直接走進那個資料夾
  function goToFolder(folderId) {
    saveNow();
    LS.set('lastNote', '');
    showEmpty();            // render() 會回到最上層，再 navigate 進目標資料夾
    renderTree();
    if (window.Dashboard && Dashboard.openFolder) Dashboard.openFolder(folderId);
  }
  // 資料夾頁的「更新到電子書」：這本書現有的公開分享連結全部用最新內容重新打包
  // （連結是快照，不會自己更新），然後打開閱讀器。閱讀器本身永遠是最新內容，
  // 所以沒有連結時只是把書打開、告訴使用者沒什麼要更新。
  function updateBook(folderId) {
    openBook(folderId);
    if (!window.Book || !Book.renderStandalone) return;
    Store.getBookLinks(folderId).then(function (links) {
      if (!links.length) { toast('這本電子書沒有公開分享連結；閱讀器顯示的就是最新內容'); return; }
      const book = Book.current();
      if (!book) return;
      return Book.renderStandalone().then(function (html) {
        return Promise.all(links.map(function (lk) {
          return Store.updateBookLink(lk.token, {
            title: book.title || '未命名電子書', html: html, chapters: book.chapters.length
          });
        }));
      }).then(function () { toast('已用最新內容更新 ' + links.length + ' 個分享連結'); });
    }).catch(function (e) { toast('更新電子書失敗：' + (e && e.message || e)); });
  }
  // 標題輸入框依內容伸縮：它跟資料夾路徑前綴排在同一個絕對置中的容器裡，寬度
  // 貼著文字，「測試資料夾\測試筆記」才會看起來是一整串置中的字，而不是路徑在
  // 左、標題在一個固定寬度的框裡各自為政。量測用同字型的隱形 span。
  let titleMeasure = null;
  function fitNoteTitle() {
    if (!titleEl) return;
    if (!titleMeasure) {
      titleMeasure = document.createElement('span');
      titleMeasure.className = 'note-title-measure';
      titleMeasure.setAttribute('aria-hidden', 'true');
      (titleEl.parentNode || document.body).appendChild(titleMeasure);
    }
    titleMeasure.textContent = titleEl.value || titleEl.placeholder || '';
    titleEl.style.width = Math.ceil(titleMeasure.getBoundingClientRect().width + 8) + 'px';
  }
  // 內建字體載入後字寬會變，重量一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitNoteTitle(); });

  function showEmpty() {
    closeStream();
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    setHash('');
    emptyEl.hidden = false;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeBookView();
    if (window.Dashboard) {
      Dashboard.render(dashOpts());
    }
    setSidebarOpen(true);    // 首頁預設打開抽屜；開啟筆記時才收回
  }

  // ---- 電子書模式 ---------------------------------------------------------
  // 把一個資料夾當成一本書：裡面的筆記是章節、子資料夾是分部。閱讀介面與
  // 「出版成單檔 HTML」都在 book.js；這裡只負責把其他檢視收起來、把書打開。
  function closeBookView() {
    if (!bookWrapEl) return;
    if (!bookWrapEl.hidden && window.Book && Book.close) Book.close();
    bookWrapEl.hidden = true;
  }
  function openBook(folderId) {
    if (!window.Book || !bookWrapEl) return;
    saveNow();
    closeStream();
    LS.set('lastNote', '');
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    emptyEl.hidden = true;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    bookWrapEl.hidden = false;
    setSidebarOpen(false);
    setHash('book/' + folderId);
    Book.open({
      container: bookWrapEl,
      folderId: folderId,
      notes: state.notes,
      folders: state.folders,
      onOpenNote: function (id) { openNote(id); },
      onClose: function () { goHome(); },
      // Restoring a book version rewrites several chapter notes on the server,
      // so the in-memory copies are stale. loadData re-opens the book on its own
      // because the URL hash is still #book/<id>.
      onRestored: function () { loadData(); }
    });
    renderTree();
    markBook(folderId);
  }
  // 用電子書模式開過的資料夾就留在書櫃（folders.is_book），之後從側邊欄的
  // 「電子書」直接找得到，不用每次再從整個資料夾清單裡挑。
  function markBook(folderId) {
    const f = state.folders.find(function (x) { return x.id === folderId; });
    if (!f || f.isBook) return;
    f.isBook = true;
    Store.updateFolder(f).then(function (saved) {
      // 舊版伺服器（還沒重啟、沒有 folders.is_book）會回 200 但不帶 isBook：
      // 標記只留在記憶體，重整就不見。與其默默吞掉，不如直接說要重啟。
      if (saved && saved.isBook === undefined) {
        toast('伺服器還在跑舊版程式，電子書標記存不進去——請重新啟動 node server/server.js');
      }
    }).catch(function () { f.isBook = false; });
  }

  // 回到首頁：先存好目前這篇，再顯示儀表板
  function goHome() {
    saveNow();
    LS.set('lastNote', '');
    showEmpty();
    renderTree();
  }

  // 點擊 #標籤：回到首頁並列出帶有該標籤的所有筆記
  function browseTag(tag) {
    if (!tag) return;
    saveNow();
    LS.set('lastNote', '');
    showEmpty();
    renderTree();
    if (window.Dashboard && Dashboard.setTag) Dashboard.setTag(tag);
  }

  // A note shared read-only must not look editable. The server would reject the
  // write anyway; this stops you wasting effort typing into a note you can't save.
  function applyReadOnly(note) {
    const ro = note.perm === 'read';
    editorEl.readOnly = ro;
    titleEl.readOnly = ro;
    wrapEl.classList.toggle('read-only', ro);
    let banner = document.getElementById('ro-banner');
    if (ro) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ro-banner';
        banner.className = 'ro-banner';
        wrapEl.insertBefore(banner, wrapEl.firstChild);
      }
      banner.innerHTML = Icons.svg('lock') + ' 唯讀 — 由 ' + MD.escapeHtml(note.sharedBy || '其他使用者') + ' 分享給你';
      banner.hidden = false;
    } else if (banner) {
      banner.hidden = true;
    }
  }

  function openNote(id) {
    closeStream();   // stop listening to the note we're leaving
    Store.getNote(id).then(function (note) {
      if (!note) { showEmpty(); return; }
      state.currentId = id;
      state.current = note;
      // Seed the collaboration baseline: this is the version we're now in sync with.
      note._syncRev = note.rev || 0;
      note._syncContent = note.content || '';
      LS.set('lastNote', id);
      setHash('note/' + id);
      tocOpen.clear();         // 目錄的展開狀態是每篇筆記各自的
      emptyEl.hidden = true;
      closeBookView();
      setSidebarOpen(false);   // 從抽屜點開筆記後收回，把整個寬度留給筆記

      // 儲存後同步樹狀標題 / 記憶體中的筆記（給步驟式與表格式編輯器共用）。
      const onSaved = function (n) {
        const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
        if (idx >= 0) { state.notes[idx].title = n.title; state.notes[idx].content = n.content; }
        const row = treeEl.querySelector('.note-row[data-id="' + n.id + '"] .label');
        if (row) row.textContent = n.title || '未命名筆記';
      };

      // 資安院筆記：右側整個是步驟式編輯器，沒有 md 編輯器。
      if (window.SecEditor && SecEditor.isSecNote(note)) {
        noteBar(false);   // 步驟式編輯器有自己的工具列，頂列只留 logo + 帳號
        wrapEl.hidden = true;
        if (perfWrapEl) perfWrapEl.hidden = true;
        secWrapEl.hidden = false;
        SecEditor.open(note, { onSaved: onSaved });
        renderTree();
        return;
      }

      // 成效報告筆記：右側整個是表格式編輯器。
      if (window.PerfReport && PerfReport.isPerfNote(note)) {
        noteBar(false);
        wrapEl.hidden = true;
        if (secWrapEl) secWrapEl.hidden = true;
        perfWrapEl.hidden = false;
        PerfReport.open(note, { onSaved: onSaved });
        renderTree();
        return;
      }

      noteBar(true);      // 一般 md 筆記：標題與編輯按鈕併入頂列 bar
      if (secWrapEl) secWrapEl.hidden = true;
      if (perfWrapEl) perfWrapEl.hidden = true;
      wrapEl.hidden = false;
      titleEl.value = note.title || '';
      fitNoteTitle();
      editorEl.value = note.content || '';
      // Setting .value leaves the caret at the end, so the focus() below would
      // scroll the editor to the bottom while the preview opens at the top.
      // Start every note at the top on both sides instead.
      try { editorEl.setSelectionRange(0, 0); } catch (e) {}
      editorEl.scrollTop = 0;
      if (previewScrollEl) previewScrollEl.scrollTop = 0;
      applyReadOnly(note);
      updateNotePath(note);   // 標題前綴顯示所在資料夾（如 pp\）
      // Only the owner may (re)share; recipients just see the collaborators.
      if (shareBtn) shareBtn.hidden = !isMine(note);
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      renderPreview();
      updateStatus();
      renderTree();
      startStream(note);   // go live: receive others' edits + presence
      if (note.perm !== 'read') editorEl.focus();
    }).catch(function () { showEmpty(); });
  }

  let previewTimer = null;
  function renderPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreviewNow, 120);
  }
  function renderPreviewNow() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    previewEl.innerHTML = MD.render(editorEl.value);
    MD.resolveImages(previewEl);
    restoreInlineTocState();
    // Mind maps are edited in place in the preview, and the preview is rebuilt
    // from scratch here, so the selection has to be re-applied every time.
    if (window.MindMap && MindMap.restorePreview) MindMap.restorePreview();
    buildPreviewTOC();
    renderBacklinks();
    scrollAnchorsDirty = true;
  }

  // ---- 左右捲動對齊 -----------------------------------------------------
  // 純比例同步會讓「左邊已到第三章、右邊還在第二章」：圖片、表格、程式碼在
  // 兩邊的高度差太多。改以標題為錨點：把編輯區每個 # 標題的像素位置對上預覽區
  // 對應的 <h1>~<h6>，同一節裡的程式碼區塊、圖片、表格也一併配對，
  // 錨點之間再按比例內插。什麼都對不上時等同純比例。
  let scrollAnchorsDirty = true;
  let scrollAnchors = null;   // [{ e: 編輯區 y, p: 預覽區 y }]，兩欄皆遞增

  // 編輯區裡可以當錨點的區塊（依出現順序）：
  //   h     ATX 標題（含層級）        pre   ``` / ~~~ 圍欄起點
  //   img   以 ![ 開頭的圖片行        table 一段 | 表格的第一行
  // 圍欄內的內容一律跳過。
  function editorBlocks() {
    const v = editorEl.value;
    const out = [];
    let pos = 0, fence = '', inTable = false;
    v.split('\n').forEach(function (line) {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) { fence = f[1][0]; out.push({ type: 'pre', pos: pos }); }
        else if (f[1][0] === fence) fence = '';
        inTable = false;
      } else if (!fence) {
        const h = line.match(/^\s{0,3}(#{1,6})\s/);
        const isTable = /^\s*\|/.test(line);
        if (h) out.push({ type: 'h', pos: pos, level: h[1].length });
        else if (/^\s*!\[/.test(line)) out.push({ type: 'img', pos: pos });
        else if (isTable && !inTable) out.push({ type: 'table', pos: pos });
        inTable = isTable;
      }
      pos += line.length + 1;
    });
    return out;
  }

  // 預覽區裡對應的元素（同樣依文件順序）
  function previewBlocks() {
    const out = [];
    previewEl.querySelectorAll('h1,h2,h3,h4,h5,h6,.code-block,img,.pdf-embed,table').forEach(function (el) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) out.push({ type: 'h', el: el, level: parseInt(tag.charAt(1), 10) });
      else if (tag === 'TABLE') out.push({ type: 'table', el: el });
      else if (tag === 'IMG' || el.classList.contains('pdf-embed')) out.push({ type: 'img', el: el });
      else out.push({ type: 'pre', el: el });
    });
    return out;
  }

  // 一次量出多個字元位置在 textarea 內容裡的像素高度（用共筆游標的量測鏡）
  function measureEditorYs(positions) {
    if (!ensureMirror()) return null;
    syncMirrorStyle();
    const v = editorEl.value;
    const frag = document.createDocumentFragment();
    const marks = [];
    let last = 0;
    positions.forEach(function (p) {
      frag.appendChild(document.createTextNode(v.slice(last, p)));
      const m = document.createElement('span');
      m.textContent = '​';
      marks.push(m);
      frag.appendChild(m);
      last = p;
    });
    frag.appendChild(document.createTextNode(v.slice(last)));
    caretMirror.textContent = '';
    caretMirror.appendChild(frag);
    const ys = marks.map(function (m) { return m.offsetTop; });
    caretMirror.textContent = '';
    return ys;
  }

  // 兩邊的區塊清單以標題切成一段一段，同一段裡同類型的區塊數量相同才逐一配對；
  // 數量不同（HTML 圖片、清單裡的程式碼…）就只放棄那一段的那一類，不影響其他段。
  function pairBlocks(eb, pb) {
    const pairs = [];
    const eHeads = eb.map(function (b, i) { return b.type === 'h' ? i : -1; }).filter(function (i) { return i >= 0; });
    const pHeads = pb.map(function (b, i) { return b.type === 'h' ? i : -1; }).filter(function (i) { return i >= 0; });
    let n = Math.min(eHeads.length, pHeads.length);
    for (let k = 0; k < n; k++) {
      // 標題層級對不上（setext 標題、引用裡的標題…）就從這裡起只剩比例
      if (eb[eHeads[k]].level !== pb[pHeads[k]].level) { n = k; break; }
    }
    // 段落邊界：[0, 第一個標題, …, 第 n 個標題, 結尾]
    const eBounds = [0].concat(eHeads.slice(0, n), [eb.length]);
    const pBounds = [0].concat(pHeads.slice(0, n), [pb.length]);
    for (let seg = 0; seg + 1 < eBounds.length; seg++) {
      const es = eb.slice(eBounds[seg], eBounds[seg + 1]);
      const ps = pb.slice(pBounds[seg], pBounds[seg + 1]);
      ['h', 'pre', 'img', 'table'].forEach(function (type) {
        const a = es.filter(function (b) { return b.type === type; });
        const b = ps.filter(function (b) { return b.type === type; });
        if (!a.length || a.length !== b.length) return;
        for (let i = 0; i < a.length; i++) pairs.push({ pos: a[i].pos, el: b[i].el });
      });
    }
    pairs.sort(function (x, y) { return x.pos - y.pos; });
    return pairs;
  }

  function buildScrollAnchors() {
    scrollAnchorsDirty = false;
    const eMax = editorEl.scrollHeight - editorEl.clientHeight;
    const pMax = previewScrollEl.scrollHeight - previewScrollEl.clientHeight;
    const list = [{ e: 0, p: 0 }];
    const pairs = pairBlocks(editorBlocks(), previewBlocks());
    const ys = pairs.length ? measureEditorYs(pairs.map(function (x) { return x.pos; })) : null;
    if (ys) {
      const base = previewScrollEl.getBoundingClientRect().top - previewScrollEl.scrollTop;
      for (let i = 0; i < pairs.length; i++) {
        const a = { e: ys[i], p: pairs[i].el.getBoundingClientRect().top - base };
        const prev = list[list.length - 1];
        // 最後一屏內的錨點不需要，且錨點在兩邊都必須嚴格遞增
        if (a.e >= eMax || a.p >= pMax || a.e <= prev.e || a.p <= prev.p) continue;
        list.push(a);
      }
    }
    list.push({ e: eMax, p: pMax });
    scrollAnchors = list;
  }

  // 把某一側的 scrollTop 換算成另一側應有的 scrollTop
  function mapScrollTop(fromEditor, y) {
    if (scrollAnchorsDirty || !scrollAnchors) buildScrollAnchors();
    const k1 = fromEditor ? 'e' : 'p', k2 = fromEditor ? 'p' : 'e';
    const A = scrollAnchors;
    let i = 1;
    while (i < A.length - 1 && A[i][k1] <= y) i++;
    const a = A[i - 1], b = A[i];
    const span = b[k1] - a[k1];
    const t = span > 0 ? Math.max(0, Math.min(1, (y - a[k1]) / span)) : 0;
    return a[k2] + t * (b[k2] - a[k2]);
  }

  // ---- Backlinks ---------------------------------------------------------
  // Which other notes point at the open one — the other half of a two-way link.
  function renderBacklinks() {
    if (!backlinksEl) return;
    backlinksEl.innerHTML = '';
    if (!state.current) { backlinksEl.hidden = true; return; }
    const target = normTitle(titleEl.value || state.current.title);
    const refs = state.notes.filter(function (n) {
      if (n.id === state.currentId) return false;
      return MD.extractLinks(n.content).some(function (t) { return normTitle(t) === target; });
    });
    if (!refs.length) { backlinksEl.hidden = true; return; }
    backlinksEl.hidden = false;
    const head = document.createElement('div');
    head.className = 'backlinks-title';
    head.innerHTML = Icons.svg('link') + ' 反向連結（' + refs.length + '）';
    backlinksEl.appendChild(head);
    refs.forEach(function (n) {
      const a = document.createElement('button');
      a.className = 'backlink';
      a.textContent = n.title || '未命名筆記';
      a.addEventListener('click', function () { saveNow(); openNote(n.id); });
      backlinksEl.appendChild(a);
    });
  }

  // Follow a [[link]] from the preview; unresolved ones create the note first.
  function handleNoteLink(a) {
    const id = a.getAttribute('data-note-id');
    if (id) { saveNow(); openNote(id); return; }
    const title = a.getAttribute('data-note-title');
    if (!title) return;
    saveNow();
    Store.createNote(title, state.current ? state.current.folderId : null).then(function (n) {
      state.notes.push(n);
      renderTree();
      openNote(n.id);
    });
  }

  // ---- Version history ----------------------------------------------------
  //
  // The unsaved buffer is flushed first: opening history on a note whose last
  // few keystrokes have not reached the server yet would show a "current
  // version" that is not what is on screen.
  function openHistory() {
    if (!state.current || !window.Versions) return;
    saveNow();
    Versions.openNote(state.current, {
      onRestored: function (fresh) {
        const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
        if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
        renderTree();
        openNote(fresh.id);
      }
    });
  }

  // ---- To-do items and mind maps in the preview --------------------------
  //
  // Both write back into the textarea and then fire the same synthetic `input`
  // event a keystroke would, so autosave, the highlight backdrop and the preview
  // re-render all happen through the existing path rather than a second one.
  function applyEditorText(text) {
    const start = editorEl.selectionStart, end = editorEl.selectionEnd;
    const top = editorEl.scrollTop;
    editorEl.value = text;
    editorEl.selectionStart = Math.min(start, text.length);
    editorEl.selectionEnd = Math.min(end, text.length);
    editorEl.scrollTop = top;
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Walk the source counting task lines, skipping fenced code so a `- [ ]`
  // inside a code sample is never mistaken for the checkbox that was clicked.
  // markdown.js numbers the checkboxes in the same document order.
  function eachTaskLine(text, fn) {
    const lines = text.split('\n');
    let inFence = false, seq = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\][\s\S]*)$/);
      if (!m) continue;
      if (fn(seq++, i, m, lines) === false) break;
    }
    return lines;
  }

  function toggleTask(index, checked) {
    let hit = false;
    const lines = eachTaskLine(editorEl.value, function (seq, i, m, ls) {
      if (seq !== index) return;
      ls[i] = m[1] + (checked ? 'x' : ' ') + m[3];
      hit = true;
      return false;
    });
    // If the counts ever disagree the safest thing is to change nothing and let
    // the next render put the checkbox back where the source says it is.
    if (!hit) { renderPreviewNow(); return; }
    applyEditorText(lines.join('\n'));
  }

  // Replace the body of the nth ```mindmap block in the source.
  function replaceMindmapBlock(index, outline) {
    const lines = editorEl.value.split('\n');
    let seq = -1;
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^(\s{0,3})(```+|~~~+)\s*mindmap\s*$/);
      if (!open) continue;
      let end = i + 1;
      while (end < lines.length && !new RegExp('^\\s{0,3}' + open[2][0] + '{3,}\\s*$').test(lines[end])) end++;
      if (++seq !== index) { i = end; continue; }
      const body = outline.split('\n');
      lines.splice(i + 1, end - i - 1, ...body);
      applyEditorText(lines.join('\n'));
      return true;
    }
    return false;
  }

  function openMindMapBlock(block) {
    if (!block || !window.MindMap || !MindMap.open) return;
    if (state.current && state.current.perm === 'read') {
      toast('這篇筆記你只有唯讀權限');
      return;
    }
    const all = previewEl.querySelectorAll('.mindmap-block');
    const index = Array.prototype.indexOf.call(all, block);
    if (index < 0) return;
    MindMap.open(block.getAttribute('data-mindmap') || '', function (outline) {
      if (!replaceMindmapBlock(index, outline)) toast('找不到對應的心智圖區塊，請重試');
    });
  }

  // ---- Preview table of contents ----------------------------------------
  function setTocCollapsed(v) {
    const pane = document.querySelector('.pane-preview');
    if (pane) pane.classList.toggle('toc-hidden', !!v);
    LS.set('tocCollapsed', v ? '1' : '0');
  }
  function buildPreviewTOC() {
    if (!tocEl) return;
    const pane = document.querySelector('.pane-preview');
    const heads = previewEl.querySelectorAll('h1, h2, h3');
    tocEl.innerHTML = '';
    if (!heads.length) { if (pane) pane.classList.add('no-toc'); return; }
    if (pane) pane.classList.remove('no-toc');
    const title = document.createElement('div');
    title.className = 'toc-title';
    const label = document.createElement('span');
    label.textContent = '目錄';
    const collapse = document.createElement('button');
    collapse.className = 'toc-collapse';
    collapse.title = '收合目錄';
    collapse.textContent = '«';
    collapse.addEventListener('click', function () { setTocCollapsed(true); });
    title.appendChild(label);
    title.appendChild(collapse);
    tocEl.appendChild(title);
    // 預設只列到最上層（通常是 #）：底下的 ## / ### 收起來，點右邊的箭頭才展開。
    // 展開狀態記在 tocOpen（以上層標題的 id 為鍵，與內文 [toc] 共用），
    // 重新渲染時保留，換筆記時清空。
    function makeLink(h) {
      const a = document.createElement('a');
      a.className = 'toc-' + h.tagName.toLowerCase();
      a.textContent = h.textContent;
      a.href = '#';
      a._target = h;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return a;
    }
    // 只有從 # 開始的筆記才會只剩 #；若整篇最淺的標題是 ##，就以 ## 為上層。
    let top = 6;
    heads.forEach(function (h) {
      const lv = parseInt(h.tagName.charAt(1), 10);
      if (lv < top) top = lv;
    });
    let group = null;   // 目前的上層群組：{ wrap, kids, twisty }
    heads.forEach(function (h) {
      const lv = parseInt(h.tagName.charAt(1), 10);
      const a = makeLink(h);
      if (lv > top) {
        if (group) group.kids.appendChild(a);
        else tocEl.appendChild(a);        // 前面沒有上層標題可掛，直接列出
        return;
      }
      // 上層標題：一列 = 連結 + 展開箭頭；子項放在下面的 .toc-children
      const key = h.id || h.textContent;   // 與內文 [toc] 用同一組鍵，兩邊同步展開
      const wrap = document.createElement('div');
      wrap.className = 'toc-group' + (tocOpen.has(key) ? ' open' : '');
      const rowEl = document.createElement('div');
      rowEl.className = 'toc-row';
      const tw = document.createElement('button');
      tw.type = 'button';
      tw.className = 'toc-twisty';
      tw.title = '展開／收合子標題';
      tw.innerHTML = Icons.svg('chevron-right');
      tw.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        const open = wrap.classList.toggle('open');
        if (open) tocOpen.add(key); else tocOpen.delete(key);
        updateTocActive();
      });
      rowEl.appendChild(a);
      rowEl.appendChild(tw);
      const kids = document.createElement('div');
      kids.className = 'toc-children';
      wrap.appendChild(rowEl);
      wrap.appendChild(kids);
      tocEl.appendChild(wrap);
      group = { wrap: wrap, kids: kids, twisty: tw };
    });
    // 底下沒有子標題的，不需要箭頭
    tocEl.querySelectorAll('.toc-group').forEach(function (g) {
      if (!g.querySelector('.toc-children a')) { g.classList.add('leaf'); const t = g.querySelector('.toc-twisty'); if (t) t.remove(); }
    });
    updateTocActive();
  }
  // 哪些 ## 段落的子標題是展開的（側邊目錄與內文 [toc] 共用，以標題 id 為鍵）。
  // 換筆記時清空——展開狀態屬於某一篇筆記，不該跟著跑到下一篇。
  const tocOpen = new Set();
  // 內文 [toc] 每次重新渲染都會重建，這裡把展開狀態貼回去
  function restoreInlineTocState() {
    previewEl.querySelectorAll('.md-toc .md-toc-toggle').forEach(function (b) {
      if (tocOpen.has(b.getAttribute('data-toc'))) b.closest('li').classList.add('open');
    });
  }
  function updateTocActive() {
    if (!tocEl || !previewScrollEl) return;
    const links = Array.prototype.slice.call(tocEl.querySelectorAll('a'));
    if (!links.length) return;
    const containerTop = previewScrollEl.getBoundingClientRect().top;
    let active = links[0];
    links.forEach(function (a) {
      if (a._target && a._target.getBoundingClientRect().top - containerTop <= 40) active = a;
    });
    // 目前段落是收合中的 ###：改反白它所屬的 ##
    let shown = active;
    if (active && active.offsetParent === null) {
      const g = active.closest('.toc-group');
      const parent = g && g.querySelector('.toc-row > a');
      if (parent) shown = parent;
    }
    links.forEach(function (a) { a.classList.toggle('active', a === shown); });
  }

  // ---- Live collaboration (Server-Sent Events) --------------------------
  // A note carries two extra fields while open: `_syncRev` / `_syncContent` —
  // the revision and exact text this client last agreed with the server on. They
  // are the common ancestor every merge is measured against.
  let noteStream = null;   // closer fn for the current note's event stream

  function closeStream() {
    if (noteStream) { noteStream(); noteStream = null; }
    renderPresence([]);
    clearRemoteCarets();
    lastSentPos = -1;
  }

  // Map a caret offset from the pre-merge text onto the merged text, keeping the
  // caret put when the edit landed elsewhere. Best-effort: exact within an
  // unchanged prefix/suffix, otherwise anchored at the start of the change.
  function mapCaret(oldV, newV, caret) {
    const max = Math.min(oldV.length, newV.length);
    let p = 0;
    while (p < max && oldV[p] === newV[p]) p++;
    if (caret <= p) return caret;
    let s = 0;
    while (s < max - p && oldV[oldV.length - 1 - s] === newV[newV.length - 1 - s]) s++;
    if (caret >= oldV.length - s) return caret + (newV.length - oldV.length);
    return Math.min(newV.length - s, p);
  }

  function applyMergedToEditor(merged) {
    const oldV = editorEl.value;
    if (merged === oldV) return;
    const focused = document.activeElement === editorEl;
    const caret = editorEl.selectionStart;
    const scroll = editorEl.scrollTop;
    editorEl.value = merged;
    if (focused) {
      const c = mapCaret(oldV, merged, caret);
      try { editorEl.selectionStart = editorEl.selectionEnd = c; } catch (e) {}
    }
    editorEl.scrollTop = scroll;
    if (editorEl._hlRefresh) editorEl._hlRefresh();
    scheduleCaretRender();
  }

  // Reconcile an authoritative server version (from an SSE push or a save reply)
  // with whatever is in the editor right now. Non-conflicting local edits survive.
  function applyRemoteUpdate(payload) {
    const cur = state.current;
    if (!cur || !payload || payload.rev == null) return;
    if (payload.rev <= (cur._syncRev || 0)) return;    // our own echo, or stale

    const base = cur._syncContent || '';
    const theirs = String(payload.content || '');
    const merged = (window.Merge ? Merge.merge3(base, editorEl.value, theirs) : theirs);

    cur._syncRev = payload.rev;
    cur._syncContent = theirs;          // the server's text is the new ancestor

    if (merged !== editorEl.value) {
      applyMergedToEditor(merged);
      cur.content = merged;
      const idx = state.notes.findIndex(function (n) { return n.id === cur.id; });
      if (idx >= 0) state.notes[idx].content = merged;
      renderPreview();
      updateStatus();
      // If we merged in local edits the server hasn't seen, push them back.
      if (merged !== theirs && cur.perm !== 'read') scheduleSave();
    } else {
      cur.content = merged;
    }

    // Adopt a remote title change unless the user is busy renaming.
    if (payload.title != null && document.activeElement !== titleEl && payload.title !== titleEl.value) {
      titleEl.value = payload.title;
      fitNoteTitle();
      cur.title = payload.title;
      updateTitleInTree();
    }
  }

  // Render the avatars of other people viewing this note (self excluded).
  function renderPresence(users) {
    if (!presenceEl) return;
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    const others = (users || []).filter(function (u) { return u !== me; });
    presenceEl.innerHTML = '';
    others.slice(0, 5).forEach(function (u) {
      const dot = document.createElement('span');
      dot.className = 'presence-dot';
      dot.textContent = (u || '?').charAt(0).toUpperCase();
      dot.title = u + '  正在編輯';
      dot.style.background = presenceColor(u);
      presenceEl.appendChild(dot);
    });
    if (others.length > 5) {
      const more = document.createElement('span');
      more.className = 'presence-more';
      more.textContent = '+' + (others.length - 5);
      presenceEl.appendChild(more);
    }
    presenceEl.classList.toggle('has-people', others.length > 0);
  }
  // Stable per-name colour so the same collaborator keeps the same avatar hue.
  function presenceColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 55%, 45%)';
  }

  // ---- Remote carets -----------------------------------------------------
  // Show every other editor's caret (a coloured line with their name) inside the
  // markdown textarea. Positions are measured with a hidden mirror div that copies
  // the textarea's exact text metrics, then offset by the current scroll.
  const remoteCarets = {};     // username -> { pos, el }
  let caretMirror = null;
  let caretRAF = null;

  function ensureMirror() {
    if (caretMirror || !editorAreaEl) return caretMirror;
    caretMirror = document.createElement('div');
    caretMirror.className = 'caret-mirror';
    caretMirror.setAttribute('aria-hidden', 'true');
    editorAreaEl.appendChild(caretMirror);
    return caretMirror;
  }

  // Copy the metrics that decide where text wraps, so the mirror lays out
  // identically to the textarea. --sbw matches the reserved scrollbar gutter.
  function syncMirrorStyle() {
    if (!caretMirror) return;
    const cs = getComputedStyle(editorEl);
    const sbw = (editorEl.offsetWidth - editorEl.clientWidth) || 0;
    const st = caretMirror.style;
    // Copy longhands (the `font` shorthand reads back empty in most browsers).
    st.fontFamily = cs.fontFamily;
    st.fontSize = cs.fontSize;
    st.fontWeight = cs.fontWeight;
    st.fontStyle = cs.fontStyle;
    st.lineHeight = cs.lineHeight;
    st.letterSpacing = cs.letterSpacing;
    st.tabSize = cs.tabSize;
    st.paddingTop = cs.paddingTop;
    st.paddingBottom = cs.paddingBottom;
    st.paddingLeft = cs.paddingLeft;
    st.paddingRight = (parseFloat(cs.paddingRight) + sbw) + 'px';
  }

  // Pixel position (relative to #editor-area, scroll already applied) of a caret
  // offset in the textarea. Returns null if it cannot be measured.
  function measureCaret(pos) {
    if (!ensureMirror()) return null;
    syncMirrorStyle();
    const v = editorEl.value;
    pos = Math.max(0, Math.min(pos, v.length));
    caretMirror.textContent = v.slice(0, pos);
    const marker = document.createElement('span');
    marker.textContent = '​';
    caretMirror.appendChild(marker);
    const x = marker.offsetLeft;
    const y = marker.offsetTop - editorEl.scrollTop;
    caretMirror.removeChild(marker);
    return { x: x, y: y };
  }

  function caretLineHeight() {
    const lh = parseFloat(getComputedStyle(editorEl).lineHeight);
    return isFinite(lh) ? lh : 24;
  }

  function renderRemoteCarets() {
    caretRAF = null;
    if (wrapEl.hidden) return;               // markdown editor not on screen
    const h = caretLineHeight();
    const areaH = editorAreaEl ? editorAreaEl.clientHeight : 0;
    Object.keys(remoteCarets).forEach(function (name) {
      const rc = remoteCarets[name];
      const p = measureCaret(rc.pos);
      if (!p) { rc.el.style.display = 'none'; return; }
      // Hide when scrolled out of view (with a little slack for the label).
      if (p.y < -h || p.y > areaH + h) { rc.el.style.display = 'none'; return; }
      rc.el.style.display = 'block';
      rc.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
      rc.el.style.height = h + 'px';
      // Flip the name tag below the caret when it would be clipped at the top.
      rc.el.classList.toggle('label-below', p.y < 18);
    });
  }
  function scheduleCaretRender() {
    if (caretRAF == null) caretRAF = requestAnimationFrame(renderRemoteCarets);
  }

  function onRemoteCursor(payload) {
    if (!payload || !payload.by) return;
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    if (payload.by === me) return;           // never draw my own caret
    let rc = remoteCarets[payload.by];
    if (!rc) {
      const el = document.createElement('div');
      el.className = 'remote-caret';
      el.style.setProperty('--caret-color', presenceColor(payload.by));
      const label = document.createElement('span');
      label.className = 'remote-caret-label';
      label.textContent = payload.by;
      el.appendChild(label);
      if (editorAreaEl) editorAreaEl.appendChild(el);
      rc = remoteCarets[payload.by] = { pos: 0, el: el };
    }
    rc.pos = payload.pos || 0;
    scheduleCaretRender();
  }

  function removeRemoteCaret(name) {
    const rc = remoteCarets[name];
    if (!rc) return;
    if (rc.el && rc.el.parentNode) rc.el.parentNode.removeChild(rc.el);
    delete remoteCarets[name];
  }
  function clearRemoteCarets() {
    Object.keys(remoteCarets).forEach(removeRemoteCaret);
  }
  // Drop carets for anyone who has left (per the presence list).
  function pruneRemoteCarets(users) {
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    const live = {};
    (users || []).forEach(function (u) { if (u !== me) live[u] = true; });
    Object.keys(remoteCarets).forEach(function (name) { if (!live[name]) removeRemoteCaret(name); });
  }

  // Broadcast my own caret, throttled so a burst of keystrokes sends at most ~1/120ms.
  let cursorTimer = null, cursorPending = false, lastSentPos = -1;
  function sendMyCursor() {
    if (!state.current || !noteStream) return;
    const pos = editorEl.selectionStart;
    if (pos === lastSentPos) return;
    lastSentPos = pos;
    if (Store.sendCursor) Store.sendCursor(state.current.id, pos, editorEl.selectionEnd).catch(function () {});
  }
  // Force-send my caret (used when someone joins, so a newcomer sees me even if
  // I'm not currently moving — the caret is transient and otherwise never resent).
  function announceCursor() {
    if (!state.current || !noteStream || !Store.sendCursor) return;
    lastSentPos = -1;
    Store.sendCursor(state.current.id, editorEl.selectionStart, editorEl.selectionEnd).catch(function () {});
  }
  function scheduleSendCursor() {
    if (!noteStream) return;
    if (cursorTimer) { cursorPending = true; return; }
    sendMyCursor();
    cursorTimer = setTimeout(function () {
      cursorTimer = null;
      if (cursorPending) { cursorPending = false; sendMyCursor(); }
    }, 120);
  }

  // Open the live stream for the note now showing in the markdown editor.
  function startStream(note) {
    closeStream();
    if (!note || !Store.openNoteStream) return;
    lastSentPos = -1;
    noteStream = Store.openNoteStream(note.id, {
      onUpdate: function (payload) { if (state.current && state.current.id === note.id) applyRemoteUpdate(payload); },
      onPresence: function (users) {
        if (state.current && state.current.id !== note.id) return;
        renderPresence(users);
        pruneRemoteCarets(users);
        // Someone joined/left → re-announce my caret so newcomers see me right away.
        announceCursor();
      },
      onCursor: function (payload) { if (state.current && state.current.id === note.id) onRemoteCursor(payload); }
    });
  }

  let saveTimer = null;
  function scheduleSave() {
    if (state.current && state.current.perm === 'read') return;
    statusSave.textContent = '編輯中…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }
  function saveNow() {
    if (!state.current || state.current.perm === 'read') return;
    state.current.title = titleEl.value || '未命名筆記';
    state.current.content = editorEl.value;
    // Tell the server which revision this edit is based on, so it can merge in
    // anyone else's concurrent changes rather than clobbering them.
    state.current.baseRev = state.current._syncRev || 0;
    state.current.baseContent = state.current._syncContent || '';
    // Keep the in-memory list in step immediately — link resolution, backlinks
    // and search all read from it and must not see a stale copy.
    const idx = state.notes.findIndex(function (n) { return n.id === state.current.id; });
    if (idx >= 0) state.notes[idx] = state.current;
    Store.updateNote(state.current).then(function (saved) {
      statusSave.textContent = '已儲存 ✓';
      // The reply is authoritative and may carry a merge of someone else's edit.
      applyRemoteUpdate({ rev: saved.rev, content: saved.content, title: saved.title });
      updateTitleInTree();
      updateStatus();
    }).catch(function (e) {
      statusSave.textContent = '⚠ 未儲存：' + (e && e.message || e);
    });
  }
  function updateTitleInTree() {
    const row = treeEl.querySelector('.note-row[data-id="' + state.currentId + '"] .label');
    if (row) row.textContent = state.current.title || '未命名筆記';
  }

  function updateStatus() {
    const text = editorEl.value || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    statusInfo.textContent = text.length + ' 字元 · ' + words + ' 詞';
  }

  // ---- 彩蛋：打字時，標題旁的小水豚會跳舞，停手約 1.4 秒後坐下 ----------
  let capyTimer = null;
  function danceCapybara() {
    const capy = $('#capybara');
    if (!capy) return;
    capy.classList.add('dancing');
    if (capyTimer) clearTimeout(capyTimer);
    capyTimer = setTimeout(function () { capy.classList.remove('dancing'); }, 1400);
  }

  // ---- View modes --------------------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    LS.set('mode', mode);
    panesEl.classList.remove('mode-split', 'mode-edit', 'mode-preview');
    panesEl.classList.add('mode-' + mode);
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (mode === 'preview') renderPreview();
  }

  // ---- Paste image -------------------------------------------------------
  // Store.putImage() is a network round-trip, so the caret must be captured
  // synchronously at paste time — reading editorEl.selectionStart only once the
  // upload resolves inserts wherever the user's cursor has drifted to *by then*
  // (they kept typing elsewhere, or switched notes entirely), not where they pasted.
  function handlePaste(e) {
    const items = (e.clipboardData || {}).items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
        e.preventDefault();
        const blob = it.getAsFile();
        const at = { s: editorEl.selectionStart, e: editorEl.selectionEnd, noteId: state.currentId };
        Store.putImage(blob).then(function (id) {
          if (!insertAtCursor('\n![貼上的圖片](img:' + id + ')\n', at)) return;
          if (editorEl._hlRefresh) editorEl._hlRefresh();
          scheduleSave();
          renderPreviewNow();
        });
        return;
      }
    }
  }

  // `at` (optional): { s, e, noteId } captured before an async upload, so the
  // insert lands where the user acted, not wherever the caret/note ended up by
  // the time the upload finished. Returns false (and skips the insert) if the
  // note was switched away from in the meantime, rather than splicing the text
  // into whatever note now happens to be open.
  function insertAtCursor(text, at) {
    if (at && at.noteId !== state.currentId) {
      toast('圖片已上傳，但筆記已切換，未插入內容');
      return false;
    }
    const start = at ? at.s : editorEl.selectionStart, end = at ? at.e : editorEl.selectionEnd;
    const v = editorEl.value;
    editorEl.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    editorEl.selectionStart = editorEl.selectionEnd = pos;
    updateStatus();
    return true;
  }

  // ---- Formatting toolbar ------------------------------------------------
  function getSel() {
    return { s: editorEl.selectionStart, e: editorEl.selectionEnd, v: editorEl.value };
  }
  function setRange(newValue, selStart, selEnd) {
    editorEl.value = newValue;
    editorEl.selectionStart = selStart;
    editorEl.selectionEnd = (selEnd == null ? selStart : selEnd);
    editorEl.focus();
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function insertAround(before, after, placeholder) {
    const g = getSel();
    const sel = g.v.slice(g.s, g.e);
    const mid = sel || placeholder || '';
    const nv = g.v.slice(0, g.s) + before + mid + after + g.v.slice(g.e);
    const start = g.s + before.length;
    setRange(nv, start, start + mid.length);
  }
  function insertBlockAround(before, after, placeholder) {
    const g = getSel();
    const pad0 = (g.s > 0 && g.v[g.s - 1] !== '\n') ? '\n' : '';
    const pad1 = (g.e < g.v.length && g.v[g.e] !== '\n') ? '\n' : '';
    const b = pad0 + before, a = after + pad1;
    const sel = g.v.slice(g.s, g.e);
    const mid = sel || placeholder || '';
    const nv = g.v.slice(0, g.s) + b + mid + a + g.v.slice(g.e);
    const start = g.s + b.length;
    setRange(nv, start, start + mid.length);
  }
  function setLinePrefix(prefix, ordered) {
    const g = getSel();
    const lineStart = g.v.lastIndexOf('\n', g.s - 1) + 1;
    let lineEnd = g.v.indexOf('\n', g.e);
    if (lineEnd < 0) lineEnd = g.v.length;
    const block = g.v.slice(lineStart, lineEnd);
    const newBlock = block.split('\n').map(function (l, i) {
      return (ordered ? (i + 1) + '. ' : prefix) + l;
    }).join('\n');
    const nv = g.v.slice(0, lineStart) + newBlock + g.v.slice(lineEnd);
    // Multi-line: keep the whole block selected so a second click applies to the
    // same lines. Single line: just shift the caret past the prefix. Selecting
    // that one line (the old behaviour) meant the very next key typed replaced it.
    if (block.indexOf('\n') >= 0) { setRange(nv, lineStart, lineStart + newBlock.length); return; }
    const delta = newBlock.length - block.length;
    setRange(nv, g.s + delta, g.e + delta);
  }
  function applyFormat(fmt) {
    switch (fmt) {
      case 'bold': return insertAround('**', '**', '粗體');
      case 'italic': return insertAround('*', '*', '斜體');
      case 'strike': return insertAround('~~', '~~', '刪除線');
      case 'code': return insertAround('`', '`', '程式碼');
      case 'link': return insertAround('[', '](url)', '文字');
      case 'notelink': return insertAround('[[', ']]', '筆記標題');
      case 'image': return insertAround('![', '](url)', '替代文字');
      case 'h1': return setLinePrefix('# ');
      case 'h2': return setLinePrefix('## ');
      case 'h3': return setLinePrefix('### ');
      case 'quote': return setLinePrefix('> ');
      case 'ul': return setLinePrefix('- ');
      case 'task': return setLinePrefix('- [ ] ');
      case 'ol': return setLinePrefix(null, true);
      case 'codeblock': return insertBlockAround('```=\n', '\n```', '');   // = 預設顯示行號
      case 'callout': return insertBlockAround('> [!NOTE]\n> ', '', '內容');
      case 'table':
        if (window.TableTool) return TableTool.showInsertPicker(editorEl, $('#edit-toolbar button[data-fmt="table"]'));
        return insertBlockAround('| 欄位 A | 欄位 B |\n| --- | --- |\n| 內容 | 內容 |', '', '');
      case 'hr': return insertBlockAround('---', '', '');
      case 'template': return showTemplatePicker($('#edit-toolbar button[data-fmt="template"]'));
      case 'pdf': return pickPdf();
    }
  }

  // ---- 插入範本 -----------------------------------------------------------
  // 內建「機器」「AD Set」加上使用者自訂的範本（templates.js）。從工具列的
  // 「範本」鈕選，或在編輯器裡輸入 /機器指令名稱。
  function showTemplatePicker(anchor) {
    if (!window.Templates || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const list = Templates.all();
    const pop = document.createElement('div');
    pop.className = 'tpl-popup';
    pop.innerHTML = '<div class="tpl-popup-head">範本</div>';
    const body = document.createElement('div');
    body.className = 'tpl-popup-list';
    list.forEach(function (t) {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'tpl-pick';
      pick.innerHTML = Icons.svg(t.icon || 'template') +
        '<span class="tpl-name">' + MD.escapeHtml(t.name) + '</span>' +
        (t.cmd ? '<span class="tpl-cmd">/' + MD.escapeHtml(t.cmd) + '</span>' : '');
      pick.addEventListener('click', function () { close(); insertTemplateText(t.text); });
      row.appendChild(pick);
      if (!t.builtin) {
        const ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'tpl-act'; ed.title = '編輯範本';
        ed.innerHTML = Icons.svg('pencil');
        ed.addEventListener('click', function (e) { e.stopPropagation(); close(); showTemplateEditor(t); });
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'tpl-act danger'; rm.title = '刪除範本';
        rm.innerHTML = Icons.svg('trash');
        rm.addEventListener('click', function (e) {
          e.stopPropagation();
          close();
          showConfirm({ title: '刪除範本', message: '確定刪除範本「' + t.name + '」？', ok: '刪除', danger: true })
            .then(function (ok) {
              if (!ok) return;
              Templates.remove(t.id); Templates.syncEditor(); toast('已刪除範本');
            });
        });
        row.appendChild(ed);
        row.appendChild(rm);
      }
      body.appendChild(row);
    });
    pop.appendChild(body);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tpl-add';
    add.innerHTML = Icons.svg('plus') + '<span>新增範本…</span>';
    add.addEventListener('click', function () { close(); showTemplateEditor(null); });
    pop.appendChild(add);

    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px';

    function close() {
      pop.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onOutside(e) { if (!pop.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    setTimeout(function () {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  // 新增／編輯自訂範本。tpl 為 null 表示新增；有選取內容時可一鍵帶入。
  function showTemplateEditor(tpl) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal tpl-modal';
    const sel = getSel();
    const picked = sel.v.slice(sel.s, sel.e);
    modal.innerHTML =
      '<div class="modal-title">' + Icons.svg('template') + ' ' + (tpl ? '編輯範本' : '新增範本') + '</div>' +
      '<div class="oscp-hint">範本會出現在工具列的「範本」選單；名稱含英數字時也會自動有一個 <code>/指令</code>。' +
      '在內容裡寫 <code>$CURSOR</code> 可指定插入後游標停的位置。</div>' +
      '<div class="oscp-field"><label>名稱</label><input class="tpl-name-input" type="text" placeholder="例如：Web 應用測試"></div>' +
      '<div class="oscp-field"><label>內容（Markdown）</label>' +
      '<textarea class="tpl-text-input" spellcheck="false" placeholder="## $CURSOR&#10;&#10;### 步驟&#10;"></textarea></div>' +
      '<div class="modal-actions">' +
      (picked ? '<button class="btn tpl-from-sel" type="button">帶入目前選取內容</button>' : '') +
      '<button class="btn modal-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary tpl-save" type="button">儲存</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const nameEl = modal.querySelector('.tpl-name-input');
    const textEl = modal.querySelector('.tpl-text-input');
    if (tpl) { nameEl.value = tpl.name; textEl.value = tpl.text; }
    const fromSel = modal.querySelector('.tpl-from-sel');
    if (fromSel) fromSel.addEventListener('click', function () { textEl.value = picked; textEl.focus(); });

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    modal.querySelector('.tpl-save').addEventListener('click', function () {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      Templates.save({ id: tpl ? tpl.id : '', name: name, text: textEl.value });
      Templates.syncEditor();
      close();
      toast(tpl ? '已更新範本' : '已新增範本');
    });
    setTimeout(function () { nameEl.focus(); }, 30);
  }

  function insertTemplateText(tpl) {
    if (!tpl) return;
    editorEl.focus();
    const g = getSel();
    const idx = tpl.indexOf('$CURSOR');
    const clean = tpl.replace('$CURSOR', '');
    const pad0 = (g.s > 0 && g.v[g.s - 1] !== '\n') ? '\n' : '';
    const pad1 = (g.e < g.v.length && g.v[g.e] !== '\n') ? '\n' : '';
    const text = pad0 + clean + pad1;
    const nv = g.v.slice(0, g.s) + text + g.v.slice(g.e);
    const cur = g.s + pad0.length + (idx < 0 ? clean.length : idx);
    setRange(nv, cur, cur);
  }

  // ---- Embed PDF ---------------------------------------------------------
  function insertPdfFile(file) {
    if (!file || file.type !== 'application/pdf') return false;
    statusSave.textContent = '上傳 PDF…';
    const at = { s: editorEl.selectionStart, e: editorEl.selectionEnd, noteId: state.currentId };
    Store.putImage(file).then(function (id) {
      const name = (file.name || 'PDF').replace(/\.pdf$/i, '');
      if (at.noteId === state.currentId) editorEl.focus();
      if (!insertAtCursor('\n![' + name + '](pdf:' + id + ')\n', at)) return;
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      scheduleSave();
      renderPreviewNow();
    }).catch(function (e) { statusSave.textContent = '⚠ PDF 上傳失敗：' + (e && e.message || e); });
    return true;
  }
  function pickPdf() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/pdf';
    inp.addEventListener('change', function () {
      const f = inp.files && inp.files[0];
      if (f) insertPdfFile(f);
    });
    inp.click();
  }
  // ---- Copy to clipboard (works on file://) ------------------------------
  function copyText(text, btn) {
    function done() {
      const old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old === '已複製' ? '複製' : old);
      btn.textContent = '已複製';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '複製'; btn.classList.remove('copied'); }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.focus(); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    t.remove();
  }

  // ---- Modal confirm dialog ----------------------------------------------
  // Same shape as showConfirm but with a text field. Resolves to the string, or
  // to null if the person cancelled — an empty string is a legitimate answer
  // (it is how a version name gets cleared), so the two cannot be conflated.
  function showPrompt(opts) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-title">' + MD.escapeHtml(opts.title || '') + '</div>' +
        (opts.message ? '<div class="modal-body">' + MD.escapeHtml(opts.message) + '</div>' : '') +
        '<input class="modal-input" type="text">' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel">' + MD.escapeHtml(opts.cancel || '取消') + '</button>' +
        '<button class="btn btn-primary modal-ok">' + MD.escapeHtml(opts.ok || '確定') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const field = overlay.querySelector('.modal-input');
      field.value = opts.value || '';
      if (opts.placeholder) field.placeholder = opts.placeholder;
      function close(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); close(field.value); }
      }
      overlay.querySelector('.modal-cancel').addEventListener('click', function () { close(null); });
      overlay.querySelector('.modal-ok').addEventListener('click', function () { close(field.value); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { field.focus(); field.select(); }, 30);
    });
  }

  function showConfirm(opts) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const msg = MD.escapeHtml(opts.message || '').replace(/\n/g, '<br>');
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-title">' + MD.escapeHtml(opts.title || '確認') + '</div>' +
        '<div class="modal-body">' + msg + '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel">' + MD.escapeHtml(opts.cancel || '取消') + '</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' modal-ok">' +
        MD.escapeHtml(opts.ok || '確定') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      function close(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); close(true); }
      }
      overlay.querySelector('.modal-cancel').addEventListener('click', function () { close(false); });
      overlay.querySelector('.modal-ok').addEventListener('click', function () { close(true); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { overlay.querySelector('.modal-ok').focus(); }, 30);
    });
  }

  // ---- Drag & drop image upload ------------------------------------------
  function hasFiles(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    return t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }

  function insertImageFiles(files) {
    const images = Array.prototype.filter.call(files, function (f) {
      return f.type && f.type.indexOf('image/') === 0;
    });
    if (!images.length) return false;
    statusSave.textContent = '插入圖片…';
    const at = { s: editorEl.selectionStart, e: editorEl.selectionEnd, noteId: state.currentId };
    Promise.all(images.map(function (f) {
      return Store.putImage(f).then(function (id) {
        const name = (f.name || '圖片').replace(/\.[^.]+$/, '');
        return '![' + name + '](img:' + id + ')';
      });
    })).then(function (mds) {
      if (at.noteId === state.currentId) editorEl.focus();
      if (!insertAtCursor('\n' + mds.join('\n') + '\n', at)) return;
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      scheduleSave();
      renderPreviewNow();
    });
    return true;
  }

  function handleEditorDrop(e) {
    if (!hasFiles(e)) return;      // let internal tree drags fall through
    e.preventDefault();
    e.stopPropagation();
    editorEl.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files && files.length) {
      insertImageFiles(files);     // handles the image/* ones
      // …and any PDFs dropped alongside them
      Array.prototype.forEach.call(files, function (f) {
        if (f.type === 'application/pdf') insertPdfFile(f);
      });
    }
  }

  // ---- 筆記列動作（儀表板）／連結／提示 -----------------------------------
  // 只改 meta（釘選等）：先抓最新版本再存，避免用記憶體裡較舊的內文蓋掉別人的編輯。
  function patchNoteMeta(id, patch) {
    return Store.getNote(id).then(function (fresh) {
      if (!fresh) throw new Error('找不到筆記');
      fresh.meta = Object.assign({}, fresh.meta || {}, patch);
      fresh.baseRev = fresh.rev;
      fresh.baseContent = fresh.content;
      return Store.updateNote(fresh).then(function (saved) {
        const n = state.notes.find(function (x) { return x.id === id; });
        if (n) { n.meta = fresh.meta; n.rev = saved.rev; n.updatedAt = saved.updatedAt; }
        if (state.current && state.current.id === id) state.current.meta = fresh.meta;
        return saved;
      });
    });
  }
  function pinNote(note, on) {
    patchNoteMeta(note.id, { pinned: !!on })
      .then(function () { refreshViews(); toast(on ? '已釘選到最上面' : '已取消釘選'); })
      .catch(function (e) { toast('儲存失敗：' + (e && e.message || e)); });
  }
  function noteLink(id) { return location.origin + location.pathname + '#note/' + encodeURIComponent(id); }
  function copyNoteLink(note) {
    const url = noteLink(note.id);
    function done() { toast('已複製連結（需登入且有權限的人才能開啟）'); }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('無法自動複製，連結：' + url); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  // 儀表板筆記列的「⋯」：貼著按鈕右下角打開
  function showNoteMenu(note, anchor) {
    const r = anchor.getBoundingClientRect();
    const actions = [
      { icon: 'link', label: '複製連結', fn: function () { copyNoteLink(note); } },
      { icon: 'users', label: '分享…', fn: function () { showShareDialog(note); } },
      { icon: 'copy', label: '複製筆記', fn: function () { duplicateNote(note); } },
      { icon: 'trash', label: '移至垃圾桶', fn: function () { deleteNote(note); }, danger: true }
    ];
    openMenuAt(r.right, r.bottom + 4, actions, { alignRight: true });
  }
  // 資料夾方框右上的「⋮」
  function showFolderMenu(folder, anchor) {
    const r = anchor.getBoundingClientRect();
    const actions = [
      { icon: 'book-open', label: '以電子書閱讀', fn: function () { openBook(folder.id); } },
      { icon: 'file-plus', label: '在此新增筆記', fn: function () { newNote(folder.id); } },
      { icon: 'folder-plus', label: '在此新增子資料夾', fn: function () { newFolder(folder.id); } },
      { icon: 'pencil', label: '重新命名', fn: function () { startFolderRename(folder); } },
      { icon: 'trash', label: '刪除資料夾', fn: function () { deleteFolder(folder); }, danger: true }
    ];
    openMenuAt(r.right, r.bottom + 4, actions, { alignRight: true });
  }
  // 儀表板方框上就地改名（找不到方框就退回側邊欄的樹狀改名）
  function startFolderRename(folder) {
    const tile = document.querySelector('#dashboard .dash-folder-tile[data-id="' + folder.id + '"]');
    if (tile && window.Dashboard && Dashboard.renameFolderTile) Dashboard.renameFolderTile(folder.id);
    else { setSidebarOpen(true); startRename('folder', folder.id); }
  }
  function renameFolderTo(folder, val) {
    const f = state.folders.find(function (x) { return x.id === folder.id; });
    if (!f || !val || val === f.name) return;
    f.name = val;
    Store.updateFolder(f)
      .then(function () { refreshViews(); })
      .catch(function (e) { toast('改名失敗：' + (e && e.message || e)); refreshViews(); });
  }
  // 電子書：從「新增 → 電子書」挑一個資料夾做成電子書；開過一次它就會留在
  // 首頁最上層的「電子書」區（folders.is_book），直到用方塊上的 ✕ 移出。
  function pickBookFolder() {
    if (!state.folders.length) { toast('先建立一個資料夾並放入筆記，再把它做成電子書'); return; }
    showFolderPicker('選擇要做成電子書的資料夾', { ok: '開啟', noRoot: true }).then(function (res) {
      if (res && res.folderId) openBook(res.folderId);
    });
  }
  function unmarkBook(folderId) {
    const f = state.folders.find(function (x) { return x.id === folderId; });
    if (!f || !f.isBook) return;
    f.isBook = false;
    refreshViews();
    Store.updateFolder(f).catch(function (e) {
      f.isBook = true;
      toast('移出電子書區失敗：' + (e && e.message || e));
      refreshViews();
    });
  }
  // 網址 hash：#note/<id>、#book/<folderId>——「複製連結」貼給別人就能直接開到那一篇
  function noteIdFromHash() {
    const m = location.hash.match(/^#note\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function bookIdFromHash() {
    const m = location.hash.match(/^#book\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setHash(h) {
    const want = h ? '#' + h : '';
    if (location.hash === want) return;
    // pushState（不是 replaceState）：首頁／筆記／電子書要各自留一筆瀏覽紀錄，
    // 這樣瀏覽器的「上一頁」才能一路退回首頁，而不是直接跳出整個 App。
    try { history.pushState(null, '', location.pathname + location.search + want); } catch (e) { /* ignore */ }
  }

  // ---- Context menu ------------------------------------------------------
  function showCtx(e, type, item) {
    e.preventDefault();
    e.stopPropagation();
    const actions = [];
    if (type === 'folder') {
      actions.push({ icon: 'book-open', label: '以電子書閱讀', fn: function () { openBook(item.id); } });
      actions.push({ icon: 'file-plus', label: '在此新增筆記', fn: function () { newNote(item.id); } });
      actions.push({ icon: 'folder-plus', label: '在此新增子資料夾', fn: function () { newFolder(item.id); } });
      actions.push({ icon: 'pencil', label: '重新命名', fn: function () { renameFolder(item); } });
      actions.push({ icon: 'trash', label: '刪除資料夾', fn: function () { deleteFolder(item); }, danger: true });
    } else if (item.perm && item.perm !== 'owner') {
      // Shared with me: I can copy it into my own space, or drop it. Renaming or
      // deleting someone else's note is not mine to do.
      actions.push({ icon: 'link', label: '複製連結', fn: function () { copyNoteLink(item); } });
      actions.push({ icon: 'copy', label: '複製到我的筆記', fn: function () { duplicateNote(item); } });
      // 透過「此站台所有使用者」看到的筆記沒有分享列可移除
      if (!item.viaSite) actions.push({ icon: 'x', label: '移除這個分享', fn: function () { leaveShare(item); }, danger: true });
    } else {
      actions.push({ icon: 'link', label: '複製連結', fn: function () { copyNoteLink(item); } });
      actions.push({ icon: 'users', label: '分享…', fn: function () { showShareDialog(item); } });
      actions.push({ icon: 'pencil', label: '重新命名', fn: function () { renameNote(item); } });
      actions.push({ icon: 'copy', label: '複製', fn: function () { duplicateNote(item); } });
      actions.push({ icon: 'trash', label: '移至垃圾桶', fn: function () { deleteNote(item); }, danger: true });
    }
    openMenuAt(e.clientX, e.clientY, actions);
  }
  // 在指定座標打開一份動作選單（右鍵選單與儀表板筆記列的「⋯」共用）
  function openMenuAt(x, y, actions, o) {
    ctxMenu.innerHTML = '';
    actions.forEach(function (a) {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (a.danger ? ' danger' : '');
      b.innerHTML = (a.icon ? Icons.svg(a.icon) : '') + '<span>' + MD.escapeHtml(a.label) + '</span>';
      b.addEventListener('click', function () { hideCtx(); a.fn(); });
      ctxMenu.appendChild(b);
    });
    ctxMenu.hidden = false;
    let left = (o && o.alignRight) ? x - ctxMenu.offsetWidth : x;
    left = Math.max(8, Math.min(left, window.innerWidth - ctxMenu.offsetWidth - 8));
    const top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 10);
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
  }
  function hideCtx() { ctxMenu.hidden = true; }
  document.addEventListener('click', hideCtx);
  document.addEventListener('scroll', hideCtx, true);

  // ---- Sharing -----------------------------------------------------------
  // 共用對話框（Google Drive 式）：
  //   1. 新增使用者 + 角色（檢視者／編輯者）
  //   2. 「具有存取權的使用者」：擁有者一列（固定），其他人可就地改角色或移除存取權
  //   3. 「一般存取權」：限制（預設）或此站台的所有使用者（可再選檢視／編輯）
  //   4. 複製連結（開啟仍需登入且有權限）
  // 沒有「知道連結的任何人」——這台伺服器上放的是考試報告，不開匿名存取。
  function showShareDialog(note) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal share-modal';
    const me = (Auth.user && Auth.user()) ? Auth.user().username : '';
    modal.innerHTML =
      '<div class="modal-title">' + Icons.svg('users') + ' 共用「' + MD.escapeHtml(note.title || '未命名筆記') + '」</div>' +
      '<div class="share-add">' +
      '<input class="share-user" type="text" placeholder="新增使用者（輸入帳號）" autocomplete="off" spellcheck="false">' +
      '<select class="share-perm" title="角色">' +
      '<option value="read">檢視者</option><option value="edit">編輯者</option>' +
      '</select>' +
      '<button class="btn btn-primary share-add-btn" type="button">' + Icons.svg('user-plus') + '<span>新增</span></button>' +
      '</div>' +
      '<div class="share-error" hidden></div>' +
      '<div class="share-section-title">具有存取權的使用者</div>' +
      '<div class="share-people"></div>' +
      '<div class="share-section-title">一般存取權</div>' +
      '<div class="share-general">' +
        '<span class="share-general-ic"></span>' +
        '<div class="share-general-body">' +
          '<select class="share-access">' +
            '<option value="restricted">限制</option>' +
            '<option value="site">此站台的所有使用者</option>' +
          '</select>' +
          '<div class="share-general-desc"></div>' +
        '</div>' +
        '<select class="share-access-perm" title="站台使用者的角色" hidden>' +
          '<option value="read">檢視者</option><option value="edit">編輯者</option>' +
        '</select>' +
      '</div>' +
      '<div class="share-footer">' +
        '<button class="btn share-link-btn" type="button">' + Icons.svg('link') + '<span>複製連結</span></button>' +
        '<button class="btn btn-primary modal-cancel" type="button">完成</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const peopleEl = modal.querySelector('.share-people');
    const errEl = modal.querySelector('.share-error');
    const userEl = modal.querySelector('.share-user');
    const permEl = modal.querySelector('.share-perm');
    const accessEl = modal.querySelector('.share-access');
    const accessPermEl = modal.querySelector('.share-access-perm');
    const generalEl = modal.querySelector('.share-general');
    const generalIc = modal.querySelector('.share-general-ic');
    const generalDesc = modal.querySelector('.share-general-desc');

    function err(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; }
    function avatar(name) {
      const s = document.createElement('span');
      s.className = 'share-avatar';
      s.textContent = String(name || '?').charAt(0).toUpperCase();
      let h = 0;
      for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
      s.style.background = 'hsl(' + h + ', 55%, 45%)';
      return s;
    }
    function personRow(name, right, sub) {
      const row = document.createElement('div');
      row.className = 'share-person';
      row.appendChild(avatar(name));
      const label = document.createElement('span');
      label.className = 'share-person-name';
      label.textContent = name;
      if (sub) { const sm = document.createElement('small'); sm.textContent = sub; label.appendChild(sm); }
      row.appendChild(label);
      row.appendChild(right);
      return row;
    }

    function paintGeneral() {
      const site = (note.access || 'restricted') === 'site';
      accessEl.value = site ? 'site' : 'restricted';
      accessPermEl.hidden = !site;
      accessPermEl.value = note.accessPerm === 'edit' ? 'edit' : 'read';
      generalEl.classList.toggle('site', site);
      generalIc.innerHTML = Icons.svg(site ? 'globe' : 'lock');
      generalDesc.textContent = site
        ? '這個站台上任何登入的使用者都能' + (note.accessPerm === 'edit' ? '編輯' : '檢視') + '這篇筆記。'
        : '只有上面列出的使用者可以開啟。';
    }
    function saveAccess() {
      err('');
      const mode = accessEl.value === 'site' ? 'site' : 'restricted';
      const perm = accessPermEl.value === 'edit' ? 'edit' : 'read';
      Store.setAccess(note.id, mode, perm).then(function (r) {
        note.access = r.access; note.accessPerm = r.accessPerm;
        const n = state.notes.find(function (x) { return x.id === note.id; });
        if (n) { n.access = r.access; n.accessPerm = r.accessPerm; }
        paintGeneral();
      }).catch(function (e) { err(e.message); paintGeneral(); });
    }
    accessEl.addEventListener('change', saveAccess);
    accessPermEl.addEventListener('change', saveAccess);

    function refresh() {
      Store.getShares(note.id).then(function (shares) {
        peopleEl.innerHTML = '';
        const ownerTag = document.createElement('span');
        ownerTag.className = 'share-role';
        ownerTag.textContent = '擁有者';
        peopleEl.appendChild(personRow(me, ownerTag, '（你）'));
        shares.forEach(function (s) {
          // 角色下拉：檢視者／編輯者／移除存取權，變更即時套用
          const sel = document.createElement('select');
          sel.className = 'share-role-select';
          sel.innerHTML = '<option value="read">檢視者</option><option value="edit">編輯者</option>' +
            '<option disabled>──────</option><option value="remove">移除存取權</option>';
          sel.value = s.perm === 'edit' ? 'edit' : 'read';
          sel.addEventListener('change', function () {
            err('');
            sel.disabled = true;
            const p = sel.value === 'remove'
              ? Store.removeShare(note.id, s.username)
              : Store.addShare(note.id, s.username, sel.value);
            p.then(refresh).catch(function (e) { err(e.message); refresh(); });
          });
          peopleEl.appendChild(personRow(s.username, sel));
        });
      }).catch(function (e) { err(e.message); });
    }

    function add() {
      const u = userEl.value.trim();
      if (!u) return;
      err('');
      Store.addShare(note.id, u, permEl.value).then(function () {
        userEl.value = '';
        refresh();
      }).catch(function (e) { err(e.message); });
    }
    modal.querySelector('.share-add-btn').addEventListener('click', add);
    userEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      e.stopPropagation();
    });
    modal.querySelector('.share-link-btn').addEventListener('click', function () { copyNoteLink(note); });

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    setTimeout(function () { userEl.focus(); }, 30);
    paintGeneral();
    refresh();
  }

  // Removing myself from a share is done by the owner's endpoint — I can only ask
  // the server to drop my own row, which it allows because it is my share.
  function leaveShare(note) {
    showConfirm({
      title: '移除分享',
      message: '把「' + (note.title || '未命名筆記') + '」從你的清單移除？\n這不會刪除原始筆記，擁有者仍保有它。',
      ok: '移除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      Store.removeShare(note.id, Auth.user().username).then(function () {
        state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
        if (state.currentId === note.id) showEmpty();
        refreshViews();
      }).catch(function (e) { alert('移除失敗：' + e.message); });
    });
  }

  // ---- CRUD actions ------------------------------------------------------
  // 「目前打開的資料夾」：儀表板正瀏覽到的資料夾，或閱讀器裡那本書的資料夾。
  // 新增 → 筆記／證照範本／資安院報告／成效報告 都預設放進這裡，而不是丟到最上層；
  // 電子書不在此列（它本來就自己挑資料夾）。沒有打開資料夾時回 null = 最上層。
  function currentFolderId() {
    if (emptyEl && !emptyEl.hidden && window.Dashboard && Dashboard.currentFolder) {
      return Dashboard.currentFolder() || null;
    }
    if (bookWrapEl && !bookWrapEl.hidden && window.Book && Book.current) {
      const b = Book.current();
      return (b && b.folder && b.folder.id) || null;
    }
    return null;
  }
  function newNote(folderId) {
    Store.createNote('未命名筆記', folderId || null).then(function (n) {
      state.notes.push(n);
      if (folderId) state.expanded[folderId] = true;
      renderTree();
      openNote(n.id);
      setTimeout(function () { titleEl.select(); }, 50);
    });
  }
  // 資安院報告：先跳 modal 收集 單位 / Domain / IP / 弱點類型，確認後才建立筆記。
  // 帶 meta.secReport，開啟時走行內步驟編輯器。
  function createSecReport() {
    SecEditor.showNewDialog(function (info) {
      const blank = SecEditor.blankReport();
      blank.unit = info.unit; blank.domain = info.domain;
      blank.ip = info.ip; blank.vulnType = info.vulnType; blank.impact = info.impact;
      blank.title = SecEditor.titleFrom(info);
      Store.createNote(blank.title, currentFolderId()).then(function (n) {
        n.meta = Object.assign({}, n.meta, { secReport: blank });
        n.content = (window.SecReport && SecReport.generate)
          ? SecReport.generate(blank, blank.steps).content : '';
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          renderTree();
          openNote(n.id);
        });
      });
    });
  }

  // 成效報告：先跳 modal 收集 單位 / 期間 / 範圍，確認後建立帶 meta.perfReport 的筆記。
  function createPerfReport() {
    PerfReport.showNewDialog(function (info) {
      const blank = PerfReport.blankReport();
      blank.unit = info.unit; blank.scope = info.scope;
      blank.periodStart = info.periodStart; blank.periodEnd = info.periodEnd;
      blank.title = PerfReport.titleFrom(info);
      Store.createNote(blank.title, currentFolderId()).then(function (n) {
        n.meta = Object.assign({}, n.meta, { perfReport: blank });
        n.content = PerfReport.generate(blank).content;
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          renderTree();
          openNote(n.id);
        });
      });
    });
  }

  function newFolder(parentId) {
    Store.createFolder('新資料夾', parentId || null).then(function (f) {
      state.folders.push(f);
      if (parentId) state.expanded[parentId] = true;
      state.expanded[f.id] = true;
      refreshViews();   // 儀表板立刻長出新資料夾，不用重新整理
      startRename('folder', f.id);
    });
  }
  function renameNote(note) { startRename('note', note.id); }
  function renameFolder(folder) { startRename('folder', folder.id); }

  // Inline rename directly in the tree (no blocking prompt() dialogs).
  function startRename(type, id) {
    const sel = type === 'folder' ? '.folder-row' : '.note-row';
    const row = treeEl.querySelector(sel + '[data-id="' + id + '"]');
    if (!row) return;
    const label = row.querySelector('.label');
    if (!label) return;
    const input = document.createElement('input');
    input.className = 'tree-edit';
    input.value = label.textContent;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val) {
        if (type === 'folder') {
          const f = state.folders.find(function (x) { return x.id === id; });
          if (f) { f.name = val; Store.updateFolder(f).then(refreshViews); return; }
        } else {
          const n = state.notes.find(function (x) { return x.id === id; });
          if (n) {
            applyNoteTitle(id, val).then(function () { refreshViews(); renderPreview(); });
            return;
          }
        }
      }
      renderTree(); // revert / no-op
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', function () { commit(true); });
  }
  // 改標題的共用路徑：樹狀清單的就地改名與儀表板的「修改標題」都走這裡。
  function applyNoteTitle(id, val) {
    const n = state.notes.find(function (x) { return x.id === id; });
    if (!n || !val || val === n.title) return Promise.resolve();
    const oldTitle = n.title;
    n.title = val;
    return Store.updateNote(n).then(function () {
      if (state.currentId === id) { titleEl.value = val; fitNoteTitle(); }
      if (state.current && state.current.id === id) state.current.title = val;
      return retargetLinks(oldTitle, val);
    });
  }
  function renameNoteTo(note, val) {
    applyNoteTitle(note.id, val)
      .then(function () { refreshViews(); renderPreview(); })
      .catch(function (e) { toast('改名失敗：' + (e && e.message || e)); refreshViews(); });
  }
  // Renaming a note would orphan every [[old title]] pointing at it, so rewrite
  // those links across all notes to follow the new title.
  function retargetLinks(oldTitle, newTitle) {
    if (normTitle(oldTitle) === normTitle(newTitle)) return Promise.resolve();
    const re = /\[\[([^\[\]|\n]+)(\|[^\[\]\n]+)?\]\]/g;
    const jobs = [];
    state.notes.forEach(function (n) {
      const next = String(n.content || '').replace(re, function (raw, target, alias) {
        return normTitle(target) === normTitle(oldTitle) ? '[[' + newTitle + (alias || '') + ']]' : raw;
      });
      if (next === n.content) return;
      n.content = next;
      if (n.id === state.currentId) {
        editorEl.value = next;
        if (state.current) state.current.content = next;
        if (editorEl._hlRefresh) editorEl._hlRefresh();
      }
      jobs.push(Store.updateNote(n));
    });
    return Promise.all(jobs);
  }

  function duplicateNote(note) {
    Store.getNote(note.id).then(function (full) {
      // A copy of someone else's note lands at my root — its folderId belongs to
      // their tree and would leave the copy invisible in mine.
      const folder = full.perm === 'owner' ? full.folderId : null;
      Store.createNote((full.title || '未命名筆記') + ' (複本)', folder).then(function (n) {
        n.content = full.content;
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          refreshViews();
        });
      });
    });
  }
  // "Delete" is a move to the trash (server keeps the row with deleted_at set);
  // the trash dialog (js/trash.js) is where it is restored or really deleted.
  function deleteNote(note) {
    showConfirm({
      title: '移至垃圾桶',
      message: '把筆記「' + (note.title || '未命名筆記') + '」移到垃圾桶？\n保留期內可以從側邊欄的「垃圾桶」復原。',
      ok: '移至垃圾桶'
    }).then(function (ok) {
      if (!ok) return;
      Store.deleteNote(note.id).then(function () {
        state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
        if (state.currentId === note.id) showEmpty();
        refreshViews();
        toast('已移至垃圾桶');
      }).catch(function (e) { toast('刪除失敗：' + (e && e.message || e)); });
    });
  }
  function deleteFolder(folder) {
    const folderIds = descendantFolderIds(folder.id);
    const notesInside = state.notes.filter(function (n) { return folderIds.indexOf(n.folderId) >= 0; });
    const subFolders = folderIds.length - 1;
    let detail = '含 ' + notesInside.length + ' 篇筆記';
    if (subFolders > 0) detail += '、' + subFolders + ' 個子資料夾';
    showConfirm({
      title: '刪除資料夾',
      message: '確定刪除資料夾「' + folder.name + '」？（' + detail + '）\n資料夾本身會直接刪除；裡面的筆記會移到垃圾桶，保留期內可以復原（復原後放在最上層）。',
      ok: '刪除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      const noteDeletes = notesInside.map(function (n) { return Store.deleteNote(n.id); });
      const folderDeletes = folderIds.map(function (id) { return Store.deleteFolder(id); });
      Promise.all(noteDeletes.concat(folderDeletes)).then(function () {
        state.notes = state.notes.filter(function (n) { return folderIds.indexOf(n.folderId) < 0; });
        state.folders = state.folders.filter(function (f) { return folderIds.indexOf(f.id) < 0; });
        if (state.current && folderIds.indexOf(state.current.folderId) >= 0) showEmpty();
        refreshViews();
      });
    });
  }
  function descendantFolderIds(rootId) {
    const ids = [rootId];
    let changed = true;
    while (changed) {
      changed = false;
      state.folders.forEach(function (f) {
        if (ids.indexOf(f.parentId) >= 0 && ids.indexOf(f.id) < 0) { ids.push(f.id); changed = true; }
      });
    }
    return ids;
  }

  // ---- Export ------------------------------------------------------------
  function exportPDF() {
    if (!state.current) return;
    // Make sure preview reflects latest text before export.
    previewEl.innerHTML = MD.render(editorEl.value);
    MD.resolveImages(previewEl);
    statusSave.textContent = '準備列印預覽…';
    // small delay so images resolve
    setTimeout(function () {
      PDF.showPreview(state.current, previewEl, {
        meta: state.current.meta,
        // Cover fields live on the note. Save through here rather than from pdf.js
        // so the note's title/content stay in step with the editor.
        onMeta: function (meta) {
          if (!state.current) return;
          state.current.meta = meta;
          saveNow();
        }
      }).then(function () {
        statusSave.textContent = '';
      }).catch(function (err) {
        alert('產生列印預覽失敗：' + (err && err.message || err));
        statusSave.textContent = '';
      });
    }, 250);
  }

  // ---- Search ------------------------------------------------------------
  const search = { query: '', results: [], index: -1 };

  function renderMarkedText(parts, into) {
    parts.forEach(function (p) {
      const node = p.hit ? document.createElement('mark') : document.createTextNode(p.text);
      if (p.hit) { node.className = 'search-hit'; node.textContent = p.text; }
      into.appendChild(node);
    });
  }

  function runSearch(q) {
    const sameQuery = q === search.query;
    // Keep the caret on the note the user had highlighted when this is a
    // refresh of the same query (e.g. after opening a result), not a new one.
    const keepId = sameQuery && search.results[search.index]
      ? search.results[search.index].note.id : null;
    search.query = q;
    const active = !!q.trim();
    searchClearEl.hidden = !active;
    treeEl.hidden = active;
    searchResultsEl.hidden = !active;
    if (!active) { search.results = []; search.index = -1; searchResultsEl.innerHTML = ''; return; }
    // The open note's edits live in the textarea until the debounced save runs.
    // state.current is a separate object loaded from IndexedDB, not the array
    // element, so swap in a live copy rather than mutating state.notes here.
    let corpus = state.notes;
    if (state.current) {
      const live = Object.assign({}, state.current, {
        title: titleEl.value || '未命名筆記',
        content: editorEl.value
      });
      corpus = state.notes.map(function (n) { return n.id === live.id ? live : n; });
    }
    search.results = Search.search(q, corpus);
    let idx = -1;
    if (keepId) {
      idx = search.results.findIndex(function (r) { return r.note.id === keepId; });
    }
    search.index = idx >= 0 ? idx : (search.results.length ? 0 : -1);
    renderSearchResults();
  }

  function renderSearchResults() {
    searchResultsEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'search-count';
    head.textContent = search.results.length ? search.results.length + ' 個結果' : '找不到符合的筆記';
    searchResultsEl.appendChild(head);

    search.results.forEach(function (r, i) {
      const row = document.createElement('div');
      row.className = 'search-row' + (i === search.index ? ' active' : '') +
        (r.note.id === state.currentId ? ' current' : '');
      const title = document.createElement('div');
      title.className = 'search-row-title';
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.innerHTML = Icons.svg(noteIcon(r.note));
      title.appendChild(ic);
      const label = document.createElement('span');
      label.className = 'label';
      renderMarkedText(r.titleParts, label);
      title.appendChild(label);
      row.appendChild(title);

      r.snippets.forEach(function (s) {
        const snip = document.createElement('div');
        snip.className = 'search-snippet';
        if (s.lead) snip.appendChild(document.createTextNode('…'));
        renderMarkedText(s.parts, snip);
        if (s.trail) snip.appendChild(document.createTextNode('…'));
        row.appendChild(snip);
      });

      row.addEventListener('click', function () { openSearchResult(i); });
      row.addEventListener('mousemove', function () {
        if (search.index === i) return;
        search.index = i;
        highlightSearchRow();
      });
      searchResultsEl.appendChild(row);
    });
  }

  function highlightSearchRow() {
    const rows = searchResultsEl.querySelectorAll('.search-row');
    Array.prototype.forEach.call(rows, function (r, i) {
      r.classList.toggle('active', i === search.index);
    });
    const active = rows[search.index];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function moveSearchSelection(dir) {
    if (!search.results.length) return;
    search.index = (search.index + dir + search.results.length) % search.results.length;
    highlightSearchRow();
  }

  function openSearchResult(i) {
    const r = search.results[i == null ? search.index : i];
    if (!r) return;
    saveNow();
    openNote(r.note.id);
  }

  function clearSearch(focusEditor) {
    searchInput.value = '';
    runSearch('');
    if (focusEditor && state.current) editorEl.focus();
  }

  // ---- Image annotation --------------------------------------------------
  function openAnnotator(id) {
    if (!id || !window.Annotate) return;
    Annotate.open(id, {
      onSaved: function () {
        statusSave.textContent = '標註已儲存 ✓';
        renderPreviewNow(); // re-read the blob through the invalidated URL cache
      }
    });
  }

  // ---- Theme -------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    LS.set('theme', theme);
    // swap hljs theme
    const link = $('#hljs-theme-light');
    if (link) link.href = theme === 'dark' ? 'vendor/hljs-github-dark.min.css' : 'vendor/hljs-github.min.css';
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    renderPreview();
  }

  // ---- Sidebar drawer ------------------------------------------------------
  // 側邊欄是浮動抽屜：預設收起，筆記區永遠吃滿整個寬度。打開只認明確動作——
  // 點左緣把手、頂列的 ☰、或 Ctrl+\——不再用滑過左緣自動彈出；收回則靠點主區／
  // 頂列、Esc 或開啟筆記。
  function isSidebarOpen() {
    const app = $('#app');
    return !!(app && app.classList.contains('sidebar-open'));
  }
  function setSidebarOpen(v) {
    const app = $('#app');
    if (!app) return;
    app.classList.toggle('sidebar-open', !!v);
  }
  function toggleSidebar() { setSidebarOpen(!isSidebarOpen()); }
  function initSidebarDrawer() {
    const sidebar = $('#sidebar');
    const handle = $('#sidebar-reopen');
    const toggleBtn = $('#sidebar-collapse');
    if (!sidebar) return;
    // 點左緣把手（中間那條帶箭頭的把手）才拉出抽屜——刻意不再用滑過去自動彈出，
    // 免得開著筆記時游標一碰到左邊就跳出來擋住內容。
    if (handle) handle.addEventListener('click', function () { setSidebarOpen(true); });
    // 點到主區或頂列（抽屜鈕除外）→ 收回；右鍵選單、對話框等都在這兩區之外，不受影響
    document.addEventListener('mousedown', function (e) {
      if (!isSidebarOpen()) return;
      if (toggleBtn && toggleBtn.contains(e.target)) return;
      // 首頁預設開著抽屜：點儀表板不收回，只有 ☰、Esc 或開啟筆記才會收
      if (!emptyEl.hidden) return;
      const main = $('#main'), top = $('#topbar');
      if ((main && main.contains(e.target)) || (top && top.contains(e.target))) setSidebarOpen(false);
    });
    // Esc：其他對話框／搜尋框已經吃掉的 Esc 不會走到這裡
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented && isSidebarOpen()) setSidebarOpen(false);
    });
  }

  // ---- Divider resize ----------------------------------------------------
  function initDivider() {
    const divider = $('#divider');
    let dragging = false;
    const saved = LS.get('splitRatio', null);
    if (saved) panesEl.style.setProperty('--edit-basis', saved);
    divider.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const rect = panesEl.getBoundingClientRect();
      let ratio = (e.clientX - rect.left) / rect.width;
      ratio = Math.max(0.2, Math.min(0.8, ratio));
      const pct = (ratio * 100).toFixed(1) + '%';
      panesEl.style.setProperty('--edit-basis', pct);
      LS.set('splitRatio', pct);
    });
    window.addEventListener('mouseup', function () { dragging = false; document.body.style.cursor = ''; });
  }

  // ---- Events ------------------------------------------------------------
  function bindEvents() {
    // 點頂列 logo 回到首頁儀表板
    const logo = document.querySelector('#topbar .logo');
    if (logo) {
      logo.style.cursor = 'pointer';
      logo.title = '回到首頁';
      logo.addEventListener('click', goHome);
    }

    $('#new-note').addEventListener('click', function () { newNote(currentFolderId()); });
    $('#new-folder').addEventListener('click', function () { newFolder(null); });
    // 「新增」選單：筆記／證照範本／資安院報告／成效報告合併成一顆鈕，點開再選。
    // 選項按鈕保留原本的 id，各自的 click 處理（下面）完全不用改；選項自己的
    // handler 先跑（target 階段），事件冒泡到選單這層時再把它收起來。
    const newBtn = $('#new-btn');
    const newMenu = $('#new-dropdown');
    function closeNewMenu() {
      if (newMenu) newMenu.hidden = true;
      if (newBtn) newBtn.setAttribute('aria-expanded', 'false');
    }
    if (newBtn && newMenu) {
      newBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = newMenu.hidden;
        newMenu.hidden = !open;
        newBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      newMenu.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target.closest('button')) closeNewMenu();
      });
      document.addEventListener('click', closeNewMenu);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNewMenu(); });
    }
    $('#export-pdf').addEventListener('click', exportPDF);
    $('#toggle-theme').addEventListener('click', toggleTheme);
    if (shareBtn) shareBtn.addEventListener('click', function () {
      if (state.current && isMine(state.current)) showShareDialog(state.current);
    });
    if (historyBtn) historyBtn.addEventListener('click', openHistory);

    // 批次操作列
    const bMove = $('#batch-move'); if (bMove) bMove.addEventListener('click', batchMove);
    const bDel = $('#batch-delete'); if (bDel) bDel.addEventListener('click', batchDelete);
    const bClr = $('#batch-clear'); if (bClr) bClr.addEventListener('click', clearSelection);

    // 頂列的抽屜鈕：開 ↔ 關；左緣把手與自動收回的邏輯在 initSidebarDrawer
    const collapseBtn = $('#sidebar-collapse');
    if (collapseBtn) collapseBtn.addEventListener('click', toggleSidebar);
    initSidebarDrawer();

    const oscpBtn = $('#oscp-report');
    if (oscpBtn && window.OSCP) oscpBtn.addEventListener('click', function () {
      OSCP.showForm(function (title, md) {
        Store.createNote(title, currentFolderId()).then(function (n) {
          n.content = md;
          Store.updateNote(n).then(function () {
            state.notes.push(n);
            renderTree();
            openNote(n.id);
            setMode('split');
          });
        });
      });
    });

    const secBtn = $('#sec-report');
    if (secBtn && window.SecEditor) secBtn.addEventListener('click', createSecReport);

    const perfBtn = $('#perf-report');
    if (perfBtn && window.PerfReport) perfBtn.addEventListener('click', createPerfReport);

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    // Search
    let searchTimer = null;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { runSearch(searchInput.value); }, 120);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchSelection(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); openSearchResult(); }
      else if (e.key === 'Escape') { e.preventDefault(); clearSearch(true); }
    });
    searchClearEl.addEventListener('click', function () { clearSearch(false); searchInput.focus(); });
    // Ctrl/Cmd+K from anywhere focuses the search box.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebarOpen(true);      // 搜尋框在抽屜裡，先拉出來
        searchInput.focus();
        searchInput.select();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    });

    // 複製連結：#note/<id> 或 #book/<id> 變化時跟著切換（瀏覽器上一頁／下一頁也適用）
    window.addEventListener('hashchange', function () {
      const nid = noteIdFromHash();
      if (nid) {
        if (nid !== state.currentId && state.notes.some(function (n) { return n.id === nid; })) openNote(nid);
        return;
      }
      const bid = bookIdFromHash();
      if (bid) {
        if (state.folders.some(function (f) { return f.id === bid; })) openBook(bid);
        return;
      }
      // hash 變回空字串：通常是「上一頁」退回首頁那一層，把畫面切回儀表板
      if (state.currentId || (bookWrapEl && !bookWrapEl.hidden)) goHome();
    });
    // 新增 → 電子書：挑一個資料夾做成電子書；開過就會出現在首頁的「電子書」區
    const newBook = $('#new-book');
    if (newBook) newBook.addEventListener('click', pickBookFolder);
    const graphBtn = $('#graph-open-btn');
    if (graphBtn) graphBtn.addEventListener('click', function () {
      if (!window.Graph) return;
      Graph.open(state.notes, {
        onOpenNote: function (note) { openNote(note.id); },
        onOpenTag: function (tag) { browseTag(tag); }
      });
    });
    // 垃圾桶：復原／永久刪除過之後只重抓筆記清單，不走 loadData（它會重開上一篇筆記）
    const trashBtn = $('#trash-open-btn');
    if (trashBtn) trashBtn.addEventListener('click', function () {
      if (!window.Trash) return;
      Trash.open({
        folders: state.folders,
        onChanged: function () {
          Store.getNotes().then(function (notes) { state.notes = notes; refreshViews(); });
        }
      });
    });

    editorEl.addEventListener('input', function () {
      renderPreview();
      scheduleSave();
      updateStatus();
      danceCapybara();
      scheduleSendCursor();     // my caret moved
      scheduleCaretRender();    // text reflowed → reposition others' carets
    });
    editorEl.addEventListener('paste', handlePaste);
    // Broadcast my caret as it moves; reposition remote carets on scroll/resize.
    editorEl.addEventListener('keyup', scheduleSendCursor);
    editorEl.addEventListener('click', scheduleSendCursor);
    editorEl.addEventListener('focus', scheduleSendCursor);
    editorEl.addEventListener('scroll', scheduleCaretRender);
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editorEl) scheduleSendCursor();
    });
    window.addEventListener('resize', scheduleCaretRender);
    editorEl.addEventListener('keydown', function (e) {
      // Ctrl/Cmd+S saves
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNow();
      }
    });
    // Drag & drop image files into the editor
    editorEl.addEventListener('dragover', function (e) {
      if (hasFiles(e)) { e.preventDefault(); editorEl.classList.add('drag-over'); }
    });
    editorEl.addEventListener('dragleave', function (e) {
      if (e.target === editorEl) editorEl.classList.remove('drag-over');
    });
    editorEl.addEventListener('drop', handleEditorDrop);
    // Prevent the browser from navigating away if a file is dropped outside the editor
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });
    // Editor syntax-highlight backdrop + line numbers
    if (window.EditorHL) EditorHL.attach(editorEl, $('#editor-backdrop'));
    // Markdown editing helpers + autocomplete (auto-pairs, list continuation, suggestions)
    if (window.Editor) Editor.attach(editorEl);
    // Mind maps are editable directly in the preview; every change writes the
    // outline straight back into the fenced block, so the markdown in the editor
    // updates as the map is edited.
    if (window.MindMap && MindMap.bindPreview) {
      MindMap.bindPreview(previewEl, {
        onChange: function (blockIndex, outline) { replaceMindmapBlock(blockIndex, outline); },
        isReadOnly: function () { return !!(state.current && state.current.perm === 'read'); }
      });
    }
    // Interactive table tooling (Notion-like controls + align/tidy)
    if (window.TableTool) TableTool.attach(editorEl, {
      isActive: function () { return state.mode !== 'preview' && !!state.current; }
    });

    // Formatting toolbar
    const tb = $('#edit-toolbar');
    if (tb) {
      tb.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) e.preventDefault(); // keep textarea selection/focus
      });
      tb.addEventListener('click', function (e) {
        const btn = e.target.closest('button');
        if (btn && btn.dataset.fmt) applyFormat(btn.dataset.fmt);
      });
    }
    // sync scroll between editor & preview in split mode (bidirectional, heading-anchored)
    let scrollSyncing = false;
    function linkScroll(src, dst) {
      src.addEventListener('scroll', function () {
        if (state.mode !== 'split' || !src || !dst) return;
        // 對方剛被程式捲動而觸發的 scroll 事件：吃掉一次即可，避免來回震盪
        if (scrollSyncing) { scrollSyncing = false; return; }
        const sMax = src.scrollHeight - src.clientHeight;
        const dMax = dst.scrollHeight - dst.clientHeight;
        if (sMax <= 0 || dMax <= 0) return;
        const target = Math.round(Math.max(0, Math.min(dMax, mapScrollTop(src === editorEl, src.scrollTop))));
        if (Math.abs(dst.scrollTop - target) < 1) return;   // 已對齊就別再設，免得卡住旗標
        scrollSyncing = true;
        dst.scrollTop = target;
      });
    }
    if (previewScrollEl) {
      linkScroll(editorEl, previewScrollEl);   // 左捲動 → 右跟隨
      linkScroll(previewScrollEl, editorEl);   // 右捲動 → 左跟隨
      // 兩邊任何一側高度變了（打字、圖片載入、拖分隔線、改視窗大小）錨點就重算
      const dirty = function () { scrollAnchorsDirty = true; };
      editorEl.addEventListener('input', dirty);
      window.addEventListener('resize', dirty);
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(dirty);
        ro.observe(previewEl);
        ro.observe(previewScrollEl);
        ro.observe(editorEl);
      }
    }
    // scroll-spy: highlight the current heading in the TOC
    if (previewScrollEl) previewScrollEl.addEventListener('scroll', updateTocActive);
    // TOC show button (re-open a collapsed TOC)
    const tocShow = $('#toc-show');
    if (tocShow) tocShow.addEventListener('click', function () { setTocCollapsed(false); });
    // Copy button on code blocks
    previewEl.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      // 待辦清單：預覽裡的勾選框直接改寫原始 markdown（Notion 式）
      const task = e.target.closest('.task-check');
      if (task) {
        if (state.current && state.current.perm === 'read') { e.preventDefault(); return; }
        toggleTask(Number(task.getAttribute('data-task')), task.checked);
        return;
      }
      const mmBtn = e.target.closest('.mm-edit-btn');
      if (mmBtn) { e.preventDefault(); openMindMapBlock(mmBtn.closest('.mindmap-block')); return; }
      const link = e.target.closest('.note-link');
      if (link) { e.preventDefault(); handleNoteLink(link); return; }
      const tag = e.target.closest('.hashtag');
      if (tag) { e.preventDefault(); browseTag(tag.getAttribute('data-tag')); return; }
      const anno = e.target.closest('.img-annotate');
      if (anno) { e.preventDefault(); openAnnotator(anno.getAttribute('data-annotate')); return; }
      // 內文 [toc] 的展開鈕：預設只列到 ##，點了才顯示底下的 ###
      const tocToggle = e.target.closest('.md-toc-toggle');
      if (tocToggle) {
        e.preventDefault();
        const key = tocToggle.getAttribute('data-toc');
        const li = tocToggle.closest('li');
        const open = li.classList.toggle('open');
        if (open) tocOpen.add(key); else tocOpen.delete(key);
        return;
      }
      // Inline [toc] entries: scroll the preview pane instead of changing the URL hash.
      const tocLink = e.target.closest('.md-toc a[href^="#"]');
      if (tocLink) {
        e.preventDefault();
        const id = decodeURIComponent(tocLink.getAttribute('href').slice(1));
        const target = id && previewEl.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const btn = e.target.closest('.code-copy');
      if (!btn) return;
      const block = btn.closest('.code-block');
      if (!block) return;
      // Numbered blocks hold one <code> per <li> (see markdown.js) instead of
      // a single blob, so their lines have to be rejoined for copying.
      const lines = block.querySelectorAll('.code-lines > li');
      const text = lines.length
        ? Array.prototype.map.call(lines, function (li) { return li.textContent; }).join('\n')
        : (block.querySelector('pre code') || {}).textContent;
      if (text != null) copyText(text, btn);
    });

    titleEl.addEventListener('input', scheduleSave);
    titleEl.addEventListener('input', fitNoteTitle);
    if (notePathEl) notePathEl.addEventListener('click', function () {
      if (state.current && state.current.folderId) goToFolder(state.current.folderId);
    });

    // import
    $('#import-btn').addEventListener('click', function () { $('#import-input').click(); });
    $('#import-input').addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const fr = new FileReader();
      fr.onload = function () {
        Store.createNote(file.name.replace(/\.(md|markdown)$/i, ''), null).then(function (n) {
          n.content = fr.result;
          Store.updateNote(n).then(function () {
            state.notes.push(n);
            renderTree();
            openNote(n.id);
          });
        });
      };
      fr.readAsText(file);
      e.target.value = '';
    });

    initDivider();
  }

  // Shared with other modules (admin.js reuses the confirm dialog).
  window.App = { confirm: showConfirm, prompt: showPrompt, toast: toast, reload: loadData };

  // Go
  init();
})();
