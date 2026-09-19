/* areabrowser.js — 課程筆記、知識區、小說共用的簡化檔案總管。
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
 *   onUploadFile(file, folderId, onProgress)  有給才會出現「上傳檔案」跟拖放上傳；回傳
 *                             Promise<note>——檔案在資料夾裡是一篇「檔案筆記」（meta.file），
 *                             所以改名／移動／垃圾桶／備份都走筆記既有的那一套
 *   onOpenFile(note)          點一個檔案（呼叫端開檢視器：PDF／影片直接看，其餘下載）
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

  // ---- 檔案筆記：meta.file = { id, name, mime, size } ----
  function fileOf(n) { return n && n.meta && n.meta.file ? n.meta.file : null; }
  function fileKind(f) {
    const mime = String(f.mime || '').toLowerCase(), ext = (/\.([a-z0-9]+)$/i.exec(f.name || '') || [])[1] || '';
    const e = ext.toLowerCase();
    if (mime === 'application/pdf' || e === 'pdf') return { icon: 'file-text', tag: 'PDF', cls: 'pdf' };
    if (mime.indexOf('video/') === 0 || /^(mp4|webm|mov|mkv|avi|m4v)$/.test(e)) return { icon: 'film', tag: (e || 'video').toUpperCase(), cls: 'video' };
    if (/^(pptx?|key|odp)$/.test(e) || mime.indexOf('presentation') >= 0) return { icon: 'presentation', tag: (e || 'ppt').toUpperCase(), cls: 'ppt' };
    if (mime.indexOf('image/') === 0) return { icon: 'image', tag: (e || 'img').toUpperCase(), cls: 'img' };
    if (mime.indexOf('audio/') === 0) return { icon: 'film', tag: (e || 'audio').toUpperCase(), cls: 'video' };
    return { icon: 'paperclip', tag: (e || 'file').toUpperCase().slice(0, 5), cls: 'other' };
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  // 正在上傳的檔案（跨 render 保留：上傳中切資料夾、別處觸發 refresh 都不會讓進度列消失）。
  // 一次傳一個，其餘排隊——大影片同時開好幾條只會互搶頻寬。
  let uploads = [];   // { key, name, size, sent, folderId, error, bar, pct }
  let uploading = false, upSeq = 0;
  function queueUploads(files, o) {
    Array.prototype.forEach.call(files, function (f) {
      // 區域跟上傳函式在排隊當下就記住：傳到一半切去別的區域，檔案還是進原本那個資料夾
      uploads.push({ key: ++upSeq, file: f, name: f.name, size: f.size, sent: 0, folderId: curFolderId, area: o.area || null, upload: o.onUploadFile, error: null });
    });
    render(o, true);
    pump();
  }
  function pump() {
    if (uploading) return;
    const u = uploads.find(function (x) { return !x.error && !x.started; });
    if (!u) return;
    uploading = true; u.started = true;
    u.upload(u.file, u.folderId, function (sent) {
      u.sent = sent;
      const p = u.size ? Math.min(100, Math.round(sent / u.size * 100)) : 0;
      if (u.bar) u.bar.style.width = p + '%';
      if (u.pct) u.pct.textContent = p + '%';
    }).then(function (note) {
      uploads = uploads.filter(function (x) { return x !== u; });
      if (note && lastOpts && (lastOpts.area || null) === u.area && !lastOpts.notes.some(function (n) { return n.id === note.id; })) lastOpts.notes.push(note);
    }, function (e) {
      u.error = (e && e.message) || String(e);
    }).then(function () {
      uploading = false;
      if (lastOpts) render(lastOpts, true);
      pump();
    });
  }

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
  // files=true 數檔案筆記，false 數一般筆記（資料夾方框上分開寫「N 筆記・M 檔案」）
  function countDeep(notes, folders, folderId, files) {
    let c = notesIn(notes, folderId).filter(function (n) { return !!fileOf(n) === !!files; }).length;
    foldersIn(folders, folderId).forEach(function (f) { c += countDeep(notes, folders, f.id, files); });
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
    const here = notesIn(o.notes, curFolderId);
    const nFiles = here.filter(fileOf).length, ns = here.length - nFiles;
    const bits = [];
    if (subs) bits.push(subs + ' 個資料夾');
    bits.push(ns + ' 篇筆記');
    if (nFiles || o.onUploadFile) bits.push(nFiles + ' 個檔案');
    main.appendChild(el('div', 'dash-subtitle', esc(bits.join('・'))));
    head.appendChild(main);

    const right = el('div', 'dash-head-right');
    if (o.onUploadFile) {
      const bu = el('button', 'btn', ic('upload') + '<span>上傳檔案</span>');
      bu.type = 'button';
      bu.title = '把 PPTX、PDF、影片或任何檔案放進這個資料夾（也可以直接拖進頁面）';
      bu.addEventListener('click', function () {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.hidden = true;
        document.body.appendChild(inp);
        inp.addEventListener('change', function () { const fs = inp.files; inp.remove(); if (fs && fs.length) queueUploads(fs, o); });
        inp.click();
      });
      right.appendChild(bu);
    }
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
    const deep = countDeep(o.notes, o.folders, folder.id, false);
    const deepFiles = countDeep(o.notes, o.folders, folder.id, true);
    const subs = foldersIn(o.folders, folder.id).length;
    const metaBits = [deep + ' 筆記'];
    if (deepFiles) metaBits.push(deepFiles + ' 檔案');
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
    if (o.onMoveArea) {
      acts.appendChild(actBtn('layout-grid', '換到其他區域', function (btn) {
        const r = btn.getBoundingClientRect();
        o.onMoveArea(note, r.right, r.bottom + 4);
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
  // ---- 檔案條列：一個檔案一列，點了開檢視器（PDF／影片直接看，其餘下載）------------
  function makeFileRow(note, o) {
    const f = fileOf(note), kind = fileKind(f);
    const wrap = el('div', 'dash-note-wrap ab-file-wrap');
    wrap.dataset.id = note.id;
    const row = el('div', 'dash-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.appendChild(el('span', 'dash-row-ic ab-file-ic ab-file-' + kind.cls, ic(kind.icon)));
    const titleEl = el('span', 'dash-row-title', esc(note.title || f.name || '未命名檔案'));
    row.appendChild(titleEl);
    const meta = el('span', 'dash-row-meta');
    meta.appendChild(el('span', 'ab-file-tag ab-file-' + kind.cls, esc(kind.tag)));
    meta.appendChild(el('span', 'ab-file-size', esc(fmtSize(f.size))));
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    function open() { if (o.onOpenFile) o.onOpenFile(note); }
    row.addEventListener('click', open);
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(); } });
    wrap.appendChild(row);

    const acts = el('div', 'dash-row-actions');
    const dl = el('a', 'dash-row-act', ic('download'));
    dl.href = '/api/images/' + encodeURIComponent(f.id);
    dl.setAttribute('download', f.name || note.title || 'file');
    dl.title = '下載';
    dl.addEventListener('click', function (e) { e.stopPropagation(); });
    acts.appendChild(dl);
    if (o.onRenameNote) {
      acts.appendChild(actBtn('pencil', '改名（只改這裡顯示的名稱）', function () {
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
  function makeUploadRow(u) {
    const wrap = el('div', 'ab-upload' + (u.error ? ' is-error' : ''));
    wrap.appendChild(el('span', 'dash-row-ic', ic(u.error ? 'alert-triangle' : 'upload')));
    const main = el('div', 'ab-upload-main');
    main.appendChild(el('div', 'ab-upload-name', esc(u.name)));
    if (u.error) {
      main.appendChild(el('div', 'ab-upload-err', esc('上傳失敗：' + u.error)));
    } else {
      const track = el('div', 'ab-upload-track');
      const p = u.size ? Math.min(100, Math.round(u.sent / u.size * 100)) : 0;
      u.bar = el('div', 'ab-upload-bar');
      u.bar.style.width = p + '%';
      track.appendChild(u.bar);
      main.appendChild(track);
    }
    wrap.appendChild(main);
    if (u.error) {
      const x = el('button', 'dash-row-act', ic('x'));
      x.type = 'button'; x.title = '關掉這一列';
      x.addEventListener('click', function () { uploads = uploads.filter(function (y) { return y !== u; }); if (lastOpts) render(lastOpts, true); });
      wrap.appendChild(x);
    } else {
      u.pct = el('span', 'ab-upload-pct', u.started ? (u.size ? Math.round(u.sent / u.size * 100) : 0) + '%' : '排隊中');
      wrap.appendChild(el('span', 'ab-file-size', esc(fmtSize(u.size))));
      wrap.appendChild(u.pct);
    }
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
    // fn 拿到按鈕本身，換區域選單要貼著它的位置開（其餘呼叫端都不需要，忽略即可）
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); });
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
    const here = notesIn(o.notes, curFolderId);
    const ns = here.filter(function (n) { return !fileOf(n); });
    const files = here.filter(fileOf);
    const ups = uploads.filter(function (u) { return u.area === (o.area || null) && (u.folderId || null) === curFolderId; });

    if (subs.length) {
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('folder', '資料夾', subs.length));
      const grid = el('div', 'dash-folder-grid');
      subs.forEach(function (f) { grid.appendChild(makeFolderTile(f, o)); });
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    // 只放檔案的資料夾（一週的投影片跟錄影）不需要一段「還沒有筆記」擋在檔案上面
    if (ns.length || !(files.length || ups.length)) {
      const sec2 = el('section', 'dash-section');
      sec2.appendChild(sectionHead('file-text', curFolderId ? '筆記' : '未歸類筆記', ns.length));
      const list = el('div', 'dash-list');
      if (!ns.length) list.appendChild(emptyState('file-text', o.emptyHint || (curFolderId ? '這個資料夾裡還沒有筆記。' : '還沒有筆記。')));
      ns.forEach(function (n) { list.appendChild(makeNoteRow(n, o)); });
      sec2.appendChild(list);
      frag.appendChild(sec2);
    }

    // 檔案：跟筆記放在同一個資料夾裡，分開一段列出來。有上傳功能的區域就算還沒有檔案
    // 也顯示這一段（當作拖放的落點跟提示）；沒有上傳功能的區域只在真的有檔案時才出現。
    if (o.onUploadFile || files.length || ups.length) {
      const sec3 = el('section', 'dash-section');
      sec3.appendChild(sectionHead('paperclip', '檔案', files.length));
      const flist = el('div', 'dash-list');
      ups.forEach(function (u) { flist.appendChild(makeUploadRow(u)); });
      if (!files.length && !ups.length) {
        flist.appendChild(emptyState('upload', '把 PPTX、PDF、影片拖進來，或按右上角的「上傳檔案」，就會放在這個資料夾裡。'));
      }
      files.forEach(function (n) { flist.appendChild(makeFileRow(n, o)); });
      sec3.appendChild(flist);
      frag.appendChild(sec3);
    }
    return frag;
  }

  // 拖放上傳：整頁都是落點。監聽只掛一次在容器上（render 每次清的是裡面的內容）。
  function bindDrop(container) {
    if (container._abDrop) return;
    container._abDrop = true;
    let depth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
    function off() { depth = 0; container.classList.remove('ab-dropping'); }
    container.addEventListener('dragenter', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      e.preventDefault(); depth++; container.classList.add('ab-dropping');
    });
    container.addEventListener('dragover', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      container.classList.add('ab-dropping');   // 拖到一半畫面重畫過、漏了 dragenter 也照樣亮
    });
    container.addEventListener('dragleave', function () { if (--depth <= 0) off(); });
    container.addEventListener('drop', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      e.preventDefault(); off();
      if (e.dataTransfer.files && e.dataTransfer.files.length) queueUploads(e.dataTransfer.files, lastOpts);
    });
  }

  function render(opts, keepPos) {
    lastOpts = opts;
    if (!keepPos) curFolderId = null;
    const container = opts.container;
    bindDrop(container);
    container.innerHTML = '';
    container.appendChild(renderHead(opts));
    container.appendChild(renderBody(opts));
  }

  global.AreaBrowser = {
    render: function (container, opts) { opts.container = container; render(opts, false); },
    refresh: function (opts) { if (lastOpts) { opts.container = lastOpts.container; render(opts, true); } },
    // 直接進到某個資料夾（#note/<id> 連到一個檔案時，背景停在它所在的資料夾）
    openFolder: function (id) { go(id || null); },
    // app.js 的檔案檢視器用同一套分類／大小寫法，列表跟檢視器才不會各說各話
    fileKind: fileKind, fmtSize: fmtSize,
    reset: function () { curFolderId = null; lastOpts = null; }
  };
})(window);
