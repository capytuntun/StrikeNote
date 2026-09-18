/* tablegrid.js — Obsidian 風格的表格編輯，疊在 Blog 模式排版好的 <table> 上。
 *
 * Blog 模式平常把一個區塊點一下換成 textarea 編原始碼；表格例外——它像 Obsidian／Notion
 * 一樣直接在排版好的表格上操作：
 *   - 點一格就地編輯那一格的 Markdown（不是整張表的原始碼）；Tab／Enter 跳格，跳出最後一格
 *     會自動長一列；Esc 收起。
 *   - 每一欄上方、每一列左邊各有一個把手：點開選單（插入／刪除／對齊／排序／移動），拖它可以
 *     直接搬動整欄／整列的位置。
 *   - 表格右緣、下緣各有一顆「＋」加欄、加列。
 *
 * 表格內容仍然是 Markdown，只是換一種編輯方式：每次改動都把整張表重新序列化，交回 Blog 寫進
 * #editor 的原始碼（api.softWrite 打字時不重排，api.commit 動到結構或跳格時重排並打開指定格），
 * 所以自動存檔、協作合併、搜尋、PDF、版本歷史全部照舊。欄寬（.blog-col-grip）另外處理，兩者並存。
 *
 * 解析／序列化直接借用 js/table.js 的 TableTool._parse／_serialize，跟編輯器裡那條浮動工具列
 * 用的是同一套模型，兩邊產生的 Markdown 一致。
 */
(function (global) {
  'use strict';

  function TT() { return global.TableTool; }

  // ---- 模型（借用 TableTool）------------------------------------------------
  // model = { header:[…], aligns:[…], rows:[[…]], cols }
  function parse(text) { return TT()._parse(String(text || '').split('\n')); }
  function serialize(m) { return TT()._serialize(m); }
  function clone(m) {
    return { header: m.header.slice(), aligns: m.aligns.slice(),
      rows: m.rows.map(function (r) { return r.slice(); }), cols: m.cols };
  }
  function nrows(m) { return 1 + m.rows.length; }        // 表頭 + 內文列
  function cellVal(m, r, c) { return r === 0 ? (m.header[c] || '') : ((m.rows[r - 1] || [])[c] || ''); }
  function setCellVal(m, r, c, v) {
    if (r === 0) m.header[c] = v;
    else { while (m.rows.length < r) m.rows.push(new Array(m.cols).fill('')); m.rows[r - 1][c] = v; }
  }

  // ---- 結構操作（都在 model 上就地做，回傳新的焦點格）--------------------------
  function insCol(m, at) {
    m.header.splice(at, 0, ''); m.aligns.splice(at, 0, '');
    m.rows.forEach(function (r) { r.splice(at, 0, ''); }); m.cols++;
  }
  function delCol(m, c) {
    if (m.cols <= 1) return; m.header.splice(c, 1); m.aligns.splice(c, 1);
    m.rows.forEach(function (r) { r.splice(c, 1); }); m.cols--;
  }
  function reorderCols(m, from, to) {           // to = 目標插槽 0..cols
    const order = []; for (let i = 0; i < m.cols; i++) order.push(i);
    order.splice(from, 1); order.splice(to > from ? to - 1 : to, 0, from);
    m.header = order.map(function (i) { return m.header[i]; });
    m.aligns = order.map(function (i) { return m.aligns[i]; });
    m.rows = m.rows.map(function (r) { return order.map(function (i) { return r[i]; }); });
    return order.indexOf(from);
  }
  function insRow(m, bodyAt) { m.rows.splice(bodyAt, 0, new Array(m.cols).fill('')); }
  function delRow(m, r) { if (r >= 1 && m.rows.length > 1) m.rows.splice(r - 1, 1); }
  function reorderRows(m, from, to) {           // 內文列的 0-based 索引
    const item = m.rows.splice(from, 1)[0];
    const at = to > from ? to - 1 : to;
    m.rows.splice(at, 0, item);
    return at;
  }
  function sortByCol(m, c, asc) {
    m.rows.sort(function (a, b) {
      const x = (a[c] || '').trim(), y = (b[c] || '').trim();
      const nx = parseFloat(x), ny = parseFloat(y);
      let d;
      if (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny) && /^[-+]?[\d.,]+%?$/.test(x) && /^[-+]?[\d.,]+%?$/.test(y)) d = nx - ny;
      else d = x.localeCompare(y, 'zh-Hant', { numeric: true, sensitivity: 'base' });
      return asc ? d : -d;
    });
  }

  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  // ---- 一次只有一格在編輯：模組層的狀態 --------------------------------------
  let open = null;   // { ctl, ta, onOutside }
  function teardown() {
    if (!open) return;
    if (open.onOutside) document.removeEventListener('mousedown', open.onOutside, true);
    if (open.ta && open.ta.parentNode) open.ta.parentNode.removeChild(open.ta);
    open = null;
  }

  // ---- 浮動選單 --------------------------------------------------------------
  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('mousedown', onMenuOutside, true); } }
  function onMenuOutside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function showMenu(x, y, items) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'tg-menu';
    items.forEach(function (it) {
      if (it === '-') { const s = document.createElement('div'); s.className = 'tg-menu-sep'; menu.appendChild(s); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = ic(it.icon) + '<span>' + it.label + '</span>';
      if (it.danger) b.className = 'is-danger';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { closeMenu(); it.run(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);   // body 子元素一律 fixed（見 CLAUDE.md 殼層不捲動規則）
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(6, Math.min(x, global.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, global.innerHeight - h - 8)) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', onMenuOutside, true); }, 0);
  }

  // ---- 對外：把控制項疊到一個排版好的 <table> 上 -----------------------------
  // api = { readOnly, source, pendingFocus:{r,c,sel}|null,
  //         softWrite(text), commit(text, focus|null) }
  function attach(table, api) {
    teardown();
    closeMenu();
    if (!table || !TT() || api.readOnly) return;
    const block = table.closest('.blog-block');
    if (!block || !table.rows || !table.rows[0]) return;
    let model;
    try { model = parse(api.source); } catch (e) { return; }
    if (!model || model.cols < 1) return;

    const ctl = { table: table, block: block, api: api, model: model };
    table.classList.add('tg');
    table.__tgLayout = function () { layout(ctl); };

    // 點一格 → 編輯那一格（先把目前在編的格收起來，再重排打開新的）
    table.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.blog-col-grip') || e.target.closest('.tg-cell-edit')) return;
      const cell = e.target.closest('td, th');
      if (!cell || !table.contains(cell)) return;
      const sel = global.getSelection && global.getSelection();
      if (sel && !sel.isCollapsed && sel.toString()) return;   // 正在選字要複製
      const tr = cell.parentNode;
      e.preventDefault();
      editCell(ctl, tr.rowIndex, cell.cellIndex, 'end');
    });

    layout(ctl);
    if (api.pendingFocus) openCell(ctl, api.pendingFocus.r, api.pendingFocus.c, api.pendingFocus.sel);
  }

  // 收掉目前這格（內容已隨打字寫回），重排並打開 (r,c)。所有「打開某格」都走這條，統一。
  function editCell(ctl, r, c, sel) {
    ctl.api.commit(serialize(ctl.model), { r: r, c: c, sel: sel || 'end' });
  }

  // ---- 就地編輯一格 ---------------------------------------------------------
  function openCell(ctl, r, c, sel) {
    teardown();
    const cell = ctl.table.rows[r] && ctl.table.rows[r].cells[c];
    if (!cell) return;
    const ta = document.createElement('textarea');
    ta.className = 'tg-cell-edit';
    ta.spellcheck = false;
    ta.rows = 1;
    ta.value = cellVal(ctl.model, r, c);
    placeCellEditor(ctl, ta, cell);
    ctl.block.appendChild(ta);

    const onOutside = function (e) {
      if (e.target === ta || (e.target.closest && (e.target.closest('.tg-cell-edit') ||
          e.target.closest('.tg-menu') || ctl.table.contains(e.target) || (ctl.overlay && ctl.overlay.contains(e.target))))) return;
      ctl.api.commit(serialize(ctl.model), null);
    };
    open = { ctl: ctl, ta: ta, onOutside: onOutside };

    autosize(ta);
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    if (sel === 'all') ta.select();
    else if (sel === 'start') ta.setSelectionRange(0, 0);
    else ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener('input', function () {
      setCellVal(ctl.model, r, c, ta.value);
      autosize(ta);
      ctl.api.softWrite(serialize(ctl.model));
    });
    ta.addEventListener('keydown', function (e) { onCellKey(e, ctl, r, c); });
    setTimeout(function () { document.addEventListener('mousedown', onOutside, true); }, 0);
  }

  function placeCellEditor(ctl, ta, cell) {
    const brect = ctl.block.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    ta.style.left = (cr.left - brect.left) + 'px';
    ta.style.top = (cr.top - brect.top) + 'px';
    ta.style.width = cr.width + 'px';
    ta.style.minHeight = cr.height + 'px';
  }
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, parseInt(ta.style.minHeight, 10) || 0) + 'px';
  }

  function onCellKey(e, ctl, r, c) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const m = ctl.model, cols = m.cols;
    if (e.key === 'Escape') { e.preventDefault(); ctl.api.commit(serialize(m), null); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { return; }  // 交給全域存檔
    if (e.key === 'Enter' && e.shiftKey) {   // Obsidian：格內換行是 <br>
      e.preventDefault();
      const ta = e.target, s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '<br>' + ta.value.slice(ta.selectionEnd);
      ta.setSelectionRange(s + 4, s + 4);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) move(ctl, r, c, 'prev');
      else move(ctl, r, c, 'next');
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); move(ctl, r, c, 'down'); return; }
    const ta = e.target;
    if (e.key === 'ArrowRight' && ta.selectionStart === ta.value.length && ta.selectionStart === ta.selectionEnd) {
      if (c < cols - 1) { e.preventDefault(); move(ctl, r, c, 'next'); } return;
    }
    if (e.key === 'ArrowLeft' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      if (c > 0) { e.preventDefault(); editCell(ctl, r, c - 1, 'end'); } return;
    }
    if (e.key === 'ArrowUp' && ta.value.lastIndexOf('\n', ta.selectionStart - 1) < 0) {
      if (r > 0) { e.preventDefault(); editCell(ctl, r - 1, c, 'end'); } return;
    }
    if (e.key === 'ArrowDown' && ta.value.indexOf('\n', ta.selectionStart) < 0) {
      if (r < nrows(m) - 1) { e.preventDefault(); editCell(ctl, r + 1, c, 'end'); } return;
    }
  }

  // 跳到下一格／上一格／下一列同欄，跳出最後一格會自動長一列。
  function move(ctl, r, c, dir) {
    const m = ctl.model, cols = m.cols;
    let nr = r, nc = c;
    if (dir === 'next') {
      if (c < cols - 1) nc = c + 1;
      else { nc = 0; nr = r + 1; }
    } else if (dir === 'prev') {
      if (c > 0) nc = c - 1;
      else if (r > 0) { nc = cols - 1; nr = r - 1; }
      else { editCell(ctl, 0, 0, 'all'); return; }
    } else {   // down
      nr = r + 1;
    }
    if (nr > nrows(m) - 1) insRow(m, m.rows.length);   // 跳出表尾 → 補一列
    editCell(ctl, nr, nc, 'all');
  }

  // ---- 把手、＋、拖曳的疊層 --------------------------------------------------
  function layout(ctl) {
    const table = ctl.table, block = ctl.block;
    if (ctl.overlay) ctl.overlay.remove();
    const ov = document.createElement('div');
    ov.className = 'tg-overlay';
    ctl.overlay = ov;
    const brect = block.getBoundingClientRect();
    const trect = table.getBoundingClientRect();
    const rows = table.rows, head = rows[0].cells;

    // 每一欄上方的把手
    for (let c = 0; c < head.length; c++) {
      const cr = head[c].getBoundingClientRect();
      const h = document.createElement('div');
      h.className = 'tg-h tg-colh';
      h.style.left = (cr.left - brect.left) + 'px';
      h.style.top = (trect.top - brect.top - 13) + 'px';
      h.style.width = cr.width + 'px';
      h.innerHTML = ic('more-horizontal');
      wireColHandle(ctl, h, c);
      ov.appendChild(h);
    }
    // 每一列左邊的把手
    for (let r = 0; r < rows.length; r++) {
      const rr = rows[r].getBoundingClientRect();
      const h = document.createElement('div');
      h.className = 'tg-h tg-rowh' + (r === 0 ? ' is-head' : '');
      h.style.top = (rr.top - brect.top) + 'px';
      h.style.left = (trect.left - brect.left - 13) + 'px';
      h.style.height = rr.height + 'px';
      h.innerHTML = ic('more-vertical');
      wireRowHandle(ctl, h, r);
      ov.appendChild(h);
    }
    // 右緣加欄
    const addC = document.createElement('div');
    addC.className = 'tg-add tg-add-col';
    addC.title = '加一欄';
    addC.innerHTML = ic('plus');
    addC.style.left = (trect.right - brect.left + 3) + 'px';
    addC.style.top = (trect.top - brect.top) + 'px';
    addC.style.height = trect.height + 'px';
    addC.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    addC.addEventListener('click', function () {
      const m = ctl.model; insCol(m, m.cols); editCell(ctl, 0, m.cols - 1, 'all');
    });
    ov.appendChild(addC);
    // 下緣加列
    const addR = document.createElement('div');
    addR.className = 'tg-add tg-add-row';
    addR.title = '加一列';
    addR.innerHTML = ic('plus');
    addR.style.top = (trect.bottom - brect.top + 3) + 'px';
    addR.style.left = (trect.left - brect.left) + 'px';
    addR.style.width = trect.width + 'px';
    addR.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    addR.addEventListener('click', function () {
      const m = ctl.model; insRow(m, m.rows.length); editCell(ctl, nrows(m) - 1, 0, 'all');
    });
    ov.appendChild(addR);

    block.appendChild(ov);
  }

  function highlightCol(ctl, c, on) {
    const rows = ctl.table.rows;
    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r].cells[c];
      if (cell) cell.classList.toggle('tg-hi', on);
    }
  }
  function highlightRow(ctl, r, on) {
    const row = ctl.table.rows[r];
    if (row) for (let i = 0; i < row.cells.length; i++) row.cells[i].classList.toggle('tg-hi', on);
  }

  // ---- 欄把手：點開選單、拖曳搬欄 --------------------------------------------
  function wireColHandle(ctl, h, c) {
    h.addEventListener('mouseenter', function () { highlightCol(ctl, c, true); });
    h.addEventListener('mouseleave', function () { highlightCol(ctl, c, false); });
    dragOrClick(h, {
      onClick: function () { colMenu(ctl, h, c); },
      onDrag: function (ev0) { startColDrag(ctl, c, ev0); }
    });
  }
  function colMenu(ctl, h, c) {
    const m = ctl.model;
    const r = h.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { icon: 'arrow-left-to-line', label: '左方插入欄', run: function () { insCol(m, c); editCell(ctl, 0, c, 'all'); } },
      { icon: 'arrow-right-to-line', label: '右方插入欄', run: function () { insCol(m, c + 1); editCell(ctl, 0, c + 1, 'all'); } },
      { icon: 'trash', label: '刪除此欄', danger: true, run: function () { delCol(m, c); ctl.api.commit(serialize(m), null); } },
      '-',
      { icon: 'align-left', label: '靠左對齊', run: function () { m.aligns[c] = 'left'; ctl.api.commit(serialize(m), null); } },
      { icon: 'align-center', label: '置中對齊', run: function () { m.aligns[c] = 'center'; ctl.api.commit(serialize(m), null); } },
      { icon: 'align-right', label: '靠右對齊', run: function () { m.aligns[c] = 'right'; ctl.api.commit(serialize(m), null); } },
      '-',
      { icon: 'arrow-up', label: '依此欄升冪排序', run: function () { sortByCol(m, c, true); ctl.api.commit(serialize(m), null); } },
      { icon: 'arrow-down', label: '依此欄降冪排序', run: function () { sortByCol(m, c, false); ctl.api.commit(serialize(m), null); } },
      '-',
      { icon: 'arrow-left', label: '左移一欄', run: function () { if (c > 0) { const n = reorderCols(m, c, c - 1); ctl.api.commit(serialize(m), { r: 0, c: n }); } } },
      { icon: 'arrow-right', label: '右移一欄', run: function () { if (c < m.cols - 1) { const n = reorderCols(m, c, c + 2); ctl.api.commit(serialize(m), { r: 0, c: n }); } } }
    ]);
  }

  function startColDrag(ctl, c) {
    const table = ctl.table, block = ctl.block;
    highlightCol(ctl, c, true);
    document.body.classList.add('tg-dragging');
    const marker = document.createElement('div');
    marker.className = 'tg-drop tg-drop-col';
    block.appendChild(marker);
    // 每個欄邊界（含最左、最右）相對 block 的 x
    const brect = block.getBoundingClientRect();
    const head = table.rows[0].cells;
    const bounds = [];
    for (let i = 0; i < head.length; i++) bounds.push(head[i].getBoundingClientRect().left - brect.left);
    bounds.push(table.getBoundingClientRect().right - brect.left);
    const trect = table.getBoundingClientRect();
    let target = c;
    function place(clientX) {
      const x = clientX - brect.left;
      let best = 0, bd = Infinity;
      for (let i = 0; i < bounds.length; i++) { const d = Math.abs(bounds[i] - x); if (d < bd) { bd = d; best = i; } }
      target = best;
      marker.style.left = (bounds[best] - 1) + 'px';
      marker.style.top = (trect.top - brect.top) + 'px';
      marker.style.height = trect.height + 'px';
    }
    function mv(e) { place(e.clientX); }
    function up() {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('tg-dragging');
      marker.remove();
      highlightCol(ctl, c, false);
      if (target !== c && target !== c + 1) {
        const n = reorderCols(ctl.model, c, target);
        ctl.api.commit(serialize(ctl.model), { r: 0, c: n });
      }
    }
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  // ---- 列把手：點開選單、拖曳搬列 --------------------------------------------
  function wireRowHandle(ctl, h, r) {
    h.addEventListener('mouseenter', function () { highlightRow(ctl, r, true); });
    h.addEventListener('mouseleave', function () { highlightRow(ctl, r, false); });
    dragOrClick(h, {
      onClick: function () { rowMenu(ctl, h, r); },
      onDrag: function () { if (r > 0) startRowDrag(ctl, r); }   // 表頭不搬
    });
  }
  function rowMenu(ctl, h, r) {
    const m = ctl.model;
    const rc = h.getBoundingClientRect();
    if (r === 0) {   // 表頭：只能在下面加一列
      showMenu(rc.right + 4, rc.top, [
        { icon: 'arrow-down-to-line', label: '下方插入列', run: function () { insRow(m, 0); editCell(ctl, 1, 0, 'all'); } }
      ]);
      return;
    }
    showMenu(rc.right + 4, rc.top, [
      { icon: 'arrow-up-to-line', label: '上方插入列', run: function () { insRow(m, r - 1); editCell(ctl, r, 0, 'all'); } },
      { icon: 'arrow-down-to-line', label: '下方插入列', run: function () { insRow(m, r); editCell(ctl, r + 1, 0, 'all'); } },
      { icon: 'trash', label: '刪除此列', danger: true, run: function () { delRow(m, r); ctl.api.commit(serialize(m), null); } },
      '-',
      { icon: 'arrow-up', label: '上移一列', run: function () { if (r > 1) { const n = reorderRows(m, r - 1, r - 2); ctl.api.commit(serialize(m), { r: n + 1, c: 0 }); } } },
      { icon: 'arrow-down', label: '下移一列', run: function () { if (r < nrows(m) - 1) { const n = reorderRows(m, r - 1, r + 1); ctl.api.commit(serialize(m), { r: n + 1, c: 0 }); } } }
    ]);
  }

  function startRowDrag(ctl, r) {
    const table = ctl.table, block = ctl.block;
    highlightRow(ctl, r, true);
    document.body.classList.add('tg-dragging');
    const marker = document.createElement('div');
    marker.className = 'tg-drop tg-drop-row';
    block.appendChild(marker);
    const brect = block.getBoundingClientRect();
    const rows = table.rows;
    const bounds = [];   // 每個內文列邊界（1..n）的 y；索引 0 = 第一列上緣
    for (let i = 1; i < rows.length; i++) bounds.push(rows[i].getBoundingClientRect().top - brect.top);
    bounds.push(table.getBoundingClientRect().bottom - brect.top);
    const trect = table.getBoundingClientRect();
    let target = r - 1;   // 內文插槽 0..n
    function place(clientY) {
      const y = clientY - brect.top;
      let best = 0, bd = Infinity;
      for (let i = 0; i < bounds.length; i++) { const d = Math.abs(bounds[i] - y); if (d < bd) { bd = d; best = i; } }
      target = best;
      marker.style.top = (bounds[best] - 1) + 'px';
      marker.style.left = (trect.left - brect.left) + 'px';
      marker.style.width = trect.width + 'px';
    }
    function mv(e) { place(e.clientY); }
    function up() {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('tg-dragging');
      marker.remove();
      highlightRow(ctl, r, false);
      const from = r - 1;
      if (target !== from && target !== from + 1) {
        const n = reorderRows(ctl.model, from, target);
        ctl.api.commit(serialize(ctl.model), { r: n + 1, c: 0 });
      }
    }
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  // 一個把手：小幅移動當點擊（開選單），拖過門檻就當拖曳（搬動）。
  function dragOrClick(el, o) {
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY;
      let dragging = false;
      function mv(ev) {
        if (dragging) return;
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 5) {
          dragging = true;
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
          o.onDrag(e);
        }
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (!dragging) o.onClick();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  global.TableGrid = {
    attach: attach,
    closeAll: function () { teardown(); closeMenu(); }
  };
})(window);
