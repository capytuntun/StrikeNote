/* quicknotes.js — 隨筆區：像 Google Keep 一樣的卡片牆。
 *
 * 跟其他筆記一樣是一篇 note（area:'quick'，永遠在最上層、沒有資料夾），只是瀏覽／
 * 編輯方式完全不同：CSS 多欄（column-count）排出的錯落卡片牆，點一張卡片就地把
 * 內文換成 textarea 編輯（跟 Blog 模式點一個區塊變成 textarea 是同一個想法，只是
 * 這裡整篇筆記只有一個「區塊」），離開卡片自動存檔。上方常駐一個「記點什麼…」
 * 輸入列，打字就新增一張卡片。
 *
 * 顏色（meta.color）、釘選（meta.pinned，沿用既有欄位）、封存（meta.archived）都
 * 存在筆記的 meta 裡；卡片內文仍是 Markdown，用 MD.render() 顯示——待辦清單
 * 「- [ ]」因此原生就能顯示成勾選框，但這裡是唯讀的（跟 pdf.js／book.js 的匯出
 * 畫面一樣停用），要打勾就點進卡片直接改原始碼，不在這裡另外接一條寫回路徑。
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

  const COLORS = [
    { key: '', name: '預設' },
    { key: 'red', name: '紅' }, { key: 'orange', name: '橘' }, { key: 'yellow', name: '黃' },
    { key: 'green', name: '綠' }, { key: 'teal', name: '青' }, { key: 'blue', name: '藍' },
    { key: 'purple', name: '紫' }, { key: 'pink', name: '粉' }
  ];

  let showArchived = false;
  let lastOpts = null;

  function isPinned(n) { return !!(n.meta && n.meta.pinned); }
  function isArchived(n) { return !!(n.meta && n.meta.archived); }
  function colorOf(n) { return (n.meta && n.meta.color) || ''; }

  // ---- 一張卡片 ---------------------------------------------------------------
  function makeCard(note, o) {
    const card = el('div', 'qn-card' + (colorOf(note) ? ' qn-c-' + colorOf(note) : ''));
    card.dataset.id = note.id;
    let editing = false;

    function renderRead() {
      card.innerHTML = '';
      // 卡片沒有標題欄（像 Keep 一樣），只有在筆記真的有標題（例如從一般筆記改成隨筆）
      // 時才顯示；新增時一律留空標題，伺服器預設的「未命名筆記」不算「真的有標題」。
      if (note.title && note.title !== '未命名筆記') card.appendChild(el('div', 'qn-title', esc(note.title)));
      const body = el('div', 'qn-body markdown-body');
      body.innerHTML = (global.MD ? MD.render(note.content || '') : esc(note.content || ''));
      body.querySelectorAll('input.task-check').forEach(function (cb) { cb.disabled = true; });
      card.appendChild(body);
      if (global.MD && MD.resolveImages) MD.resolveImages(body);
      card.appendChild(makeToolbar());
    }

    function makeToolbar() {
      const bar = el('div', 'qn-toolbar');
      const pin = el('button', 'qn-tbtn' + (isPinned(note) ? ' on' : ''), ic('pin'));
      pin.type = 'button'; pin.title = isPinned(note) ? '取消釘選' : '釘選';
      pin.addEventListener('click', function (e) { e.stopPropagation(); o.onPatch(note, { pinned: !isPinned(note) }); });
      bar.appendChild(pin);

      const pal = el('button', 'qn-tbtn', ic('grid'));
      pal.type = 'button'; pal.title = '顏色';
      pal.addEventListener('click', function (e) { e.stopPropagation(); openPalette(pal); });
      bar.appendChild(pal);

      const arc = el('button', 'qn-tbtn', ic(isArchived(note) ? 'folder-open' : 'folder'));
      arc.type = 'button'; arc.title = isArchived(note) ? '取消封存' : '封存';
      arc.addEventListener('click', function (e) { e.stopPropagation(); o.onPatch(note, { archived: !isArchived(note) }); });
      bar.appendChild(arc);

      const del = el('button', 'qn-tbtn', ic('trash'));
      del.type = 'button'; del.title = '移到垃圾桶';
      del.addEventListener('click', function (e) { e.stopPropagation(); o.onDelete(note); });
      bar.appendChild(del);
      return bar;
    }

    function openPalette(anchor) {
      document.querySelectorAll('.qn-palette').forEach(function (p) { p.remove(); });
      const pop = el('div', 'qn-palette');
      COLORS.forEach(function (c) {
        const b = el('button', 'qn-swatch qn-c-' + (c.key || 'none') + (colorOf(note) === c.key ? ' on' : ''));
        b.type = 'button'; b.title = c.name;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
          e.stopPropagation(); pop.remove();
          o.onPatch(note, { color: c.key || null });
        });
        pop.appendChild(b);
      });
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(r.left, global.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (r.bottom + 4) + 'px';
      setTimeout(function () {
        document.addEventListener('mousedown', function out(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', out, true); } }, true);
      }, 0);
    }

    function renderEdit() {
      card.innerHTML = '';
      const ta = document.createElement('textarea');
      ta.className = 'qn-edit';
      ta.value = note.content || '';
      ta.placeholder = '內容…';
      card.appendChild(ta);
      function autosize() { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
      ta.addEventListener('input', autosize);
      let saveTimer = null;
      function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () { o.onEdit(note, ta.value); }, 500);
      }
      ta.addEventListener('input', scheduleSave);
      ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
      ta.addEventListener('blur', function () {
        clearTimeout(saveTimer);
        editing = false;
        note.content = ta.value;
        o.onEdit(note, ta.value);
        renderRead();
      });
      setTimeout(function () { ta.focus(); autosize(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    }

    card.addEventListener('click', function (e) {
      if (editing || e.target.closest('.qn-toolbar, .task-check, a, button')) return;
      editing = true;
      renderEdit();
    });

    renderRead();
    return card;
  }

  // ---- 新增列：常駐在牆頂端的「記點什麼…」------------------------------------
  function makeComposer(o) {
    const box = el('div', 'qn-composer');
    const ta = document.createElement('textarea');
    ta.className = 'qn-composer-input';
    ta.rows = 1;
    ta.placeholder = '記點什麼…';
    box.appendChild(ta);
    const actions = el('div', 'qn-composer-actions', '<button type="button" class="btn btn-primary qn-composer-add">新增</button>');
    box.appendChild(actions);
    actions.hidden = true;

    function autosize() { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    ta.addEventListener('input', function () { autosize(); actions.hidden = !ta.value.trim(); });
    function commit() {
      const text = ta.value.trim();
      ta.value = '';
      autosize();
      actions.hidden = true;
      if (!text) return;
      o.onCreate(text);
    }
    actions.querySelector('.qn-composer-add').addEventListener('mousedown', function (e) { e.preventDefault(); });
    actions.querySelector('.qn-composer-add').addEventListener('click', commit);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); ta.value = ''; autosize(); actions.hidden = true; ta.blur(); }
    });
    return box;
  }

  function render(container, opts) {
    lastOpts = { container: container, opts: opts };
    container.innerHTML = '';

    const head = el('div', 'qn-head');
    head.appendChild(el('h1', 'qn-title-h', ic('pin') + '<span>隨筆</span>'));
    const toggle = el('button', 'qn-archive-toggle' + (showArchived ? ' on' : ''),
      ic(showArchived ? 'folder-open' : 'folder') + '<span>' + (showArchived ? '顯示未封存' : '顯示已封存') + '</span>');
    toggle.type = 'button';
    toggle.addEventListener('click', function () { showArchived = !showArchived; render(container, opts); });
    head.appendChild(toggle);
    container.appendChild(head);

    container.appendChild(makeComposer(opts));

    const notes = opts.notes.filter(function (n) { return isArchived(n) === showArchived; });
    if (!notes.length) {
      container.appendChild(el('div', 'dash-empty', ic('pin') + '<span>' + (showArchived ? '沒有封存的隨筆。' : '還沒有隨筆，在上面記點什麼開始。') + '</span>'));
      return;
    }
    const pinned = notes.filter(isPinned);
    const rest = notes.filter(function (n) { return !isPinned(n); });
    function sortByTime(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
    pinned.sort(sortByTime); rest.sort(sortByTime);

    if (pinned.length) {
      container.appendChild(el('div', 'dash-section-head qn-section-head', '<span>已釘選</span>'));
      const grid = el('div', 'qn-grid');
      pinned.forEach(function (n) { grid.appendChild(makeCard(n, opts)); });
      container.appendChild(grid);
    }
    if (rest.length) {
      if (pinned.length) container.appendChild(el('div', 'dash-section-head qn-section-head', '<span>其他</span>'));
      const grid = el('div', 'qn-grid');
      rest.forEach(function (n) { grid.appendChild(makeCard(n, opts)); });
      container.appendChild(grid);
    }
  }

  global.QuickNotes = {
    render: render,
    refresh: function (opts) { if (lastOpts) render(lastOpts.container, opts); },
    reset: function () { showArchived = false; lastOpts = null; }
  };
})(window);
