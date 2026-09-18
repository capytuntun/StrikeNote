/* quicknotes.js — 隨筆區：照著 Google Keep 實際的操作方式做，不是自己發明的近似物。
 *
 * 跟其他筆記一樣是一篇 note（area:'quick'，永遠在最上層、沒有資料夾），只是瀏覽／
 * 編輯方式完全不同：點一張卡片就地把內文換成 textarea 編輯（跟 Blog 模式點一個
 * 區塊變成 textarea 是同一個想法，只是這裡整篇筆記只有一個「區塊」），離開卡片
 * 自動存檔。上方常駐一個「記點什麼…」輸入列，打字就新增一張卡片。
 *
 * 幾個直接照 Keep 做、不是憑印象簡化的地方：
 *   - 卡片牆是「平衡欄」佈局（layoutMasonry），不是 CSS column-width——CSS 多欄
 *     會先把整欄由上到下排滿才換下一欄，讀起來的順序是「欄1由上到下、再欄2…」，
 *     Keep 是每張新卡片放進當下最短的那一欄，順序才會照卡片本身的順序左右流動。
 *   - 釘選是卡片右上角一顆單獨的圖釘（.qn-pin-corner），跟底部工具列是分開的兩
 *     個東西——Keep 也是這樣放，不是工具列裡的一顆按鈕。
 *   - 上方輸入列在「聚焦」（不是「打字」）那一刻就展開工具列，並且多一顆關閉鈕，
 *     跟 Keep 點進去立刻看到完整輸入框、工具列，而不是要先打字才看得到一樣。
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
      card.appendChild(makePinCorner());
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

    // Keep 把釘選放在卡片右上角，跟底下那排「顏色／封存／刪除」是分開的兩個東西，
    // 不是工具列裡的一顆按鈕。
    function makePinCorner() {
      const pin = el('button', 'qn-pin-corner' + (isPinned(note) ? ' on' : ''), ic('pin'));
      pin.type = 'button'; pin.title = isPinned(note) ? '取消釘選' : '釘選';
      pin.addEventListener('click', function (e) { e.stopPropagation(); o.onPatch(note, { pinned: !isPinned(note) }); });
      return pin;
    }

    function makeToolbar() {
      const bar = el('div', 'qn-toolbar');
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
  // Keep 點進輸入框那一刻（聚焦，不用先打字）就展開成完整輸入框＋工具列，還有
  // 一顆關閉鈕收合回單行；這裡沒有 Keep 的提醒／協作者／圖片那幾顆，但展開的
  // 時機跟收合鈕是照實做的。
  function makeComposer(o) {
    const box = el('div', 'qn-composer');
    const ta = document.createElement('textarea');
    ta.className = 'qn-composer-input';
    ta.rows = 1;
    ta.placeholder = '記點什麼…';
    box.appendChild(ta);
    const actions = el('div', 'qn-composer-actions');
    const closeBtn = el('button', 'qn-composer-close', ic('x'));
    closeBtn.type = 'button'; closeBtn.title = '關閉';
    const addBtn = el('button', 'btn btn-primary qn-composer-add', '新增');
    addBtn.type = 'button';
    actions.appendChild(closeBtn);
    actions.appendChild(addBtn);
    box.appendChild(actions);
    actions.hidden = true;

    function autosize() { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    function expand() { actions.hidden = false; }
    function collapse() { if (!ta.value.trim()) actions.hidden = true; }
    function commit() {
      const text = ta.value.trim();
      ta.value = '';
      autosize();
      actions.hidden = true;
      if (!text) return;
      o.onCreate(text);
    }
    function cancel() { ta.value = ''; autosize(); actions.hidden = true; ta.blur(); }
    ta.addEventListener('focus', expand);
    ta.addEventListener('input', autosize);
    ta.addEventListener('blur', collapse);
    [closeBtn, addBtn].forEach(function (b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
    closeBtn.addEventListener('click', cancel);
    addBtn.addEventListener('click', commit);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    return box;
  }

  // ---- 平衡欄卡片牆：跟 Keep 一樣每張新卡片放進「目前最短的那一欄」，不是 CSS
  // column-width 那種先把一欄由上到下排滿才換下一欄——後者的閱讀順序是「欄1到底
  // 再欄2」，跟卡片本身的順序（釘選／更新時間）對不起來。欄數看容器寬度即時算，
  // 用 ResizeObserver 而不是監聽 window resize，因為側邊欄抽屜開合只是改變
  // .quick-page 的 padding，不會觸發 window 的 resize 事件，但容器寬度確實變了。
  const COL_WIDTH = 236;
  let roList = [];
  function layoutMasonry(grid, cardEls) {
    grid.innerHTML = '';
    const width = grid.clientWidth || COL_WIDTH;
    const gap = 16;
    const cols = Math.max(1, Math.min(6, Math.floor((width + gap) / (COL_WIDTH + gap))));
    const colEls = [];
    for (let i = 0; i < cols; i++) {
      const c = el('div', 'qn-col');
      grid.appendChild(c);
      colEls.push(c);
    }
    cardEls.forEach(function (card) {
      let shortest = colEls[0];
      for (let i = 1; i < colEls.length; i++) {
        if (colEls[i].offsetHeight < shortest.offsetHeight) shortest = colEls[i];
      }
      shortest.appendChild(card);
    });
  }
  function buildGrid(container, cardEls) {
    const grid = el('div', 'qn-grid');
    container.appendChild(grid); // 先插進文件，量寬度才準
    layoutMasonry(grid, cardEls);
    const ro = new ResizeObserver(function () { layoutMasonry(grid, cardEls); });
    ro.observe(grid);
    roList.push(ro);
    return grid;
  }

  function render(container, opts) {
    lastOpts = { container: container, opts: opts };
    roList.forEach(function (ro) { ro.disconnect(); });
    roList = [];
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
      buildGrid(container, pinned.map(function (n) { return makeCard(n, opts); }));
    }
    if (rest.length) {
      if (pinned.length) container.appendChild(el('div', 'dash-section-head qn-section-head', '<span>其他</span>'));
      buildGrid(container, rest.map(function (n) { return makeCard(n, opts); }));
    }
  }

  global.QuickNotes = {
    render: render,
    refresh: function (opts) { if (lastOpts) render(lastOpts.container, opts); },
    reset: function () {
      roList.forEach(function (ro) { ro.disconnect(); });
      roList = [];
      showArchived = false; lastOpts = null;
    }
  };
})(window);
