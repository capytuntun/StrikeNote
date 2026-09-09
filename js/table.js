/* table.js — Notion-like interactive markdown table editing on a textarea */
(function (global) {
  'use strict';

  // ---------- display width (CJK / full-width counts as 2) ----------
  function isWide(code) {
    return code >= 0x1100 && (
      code <= 0x115F ||
      code === 0x2329 || code === 0x232A ||
      (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x1F300 && code <= 0x1FAFF) ||
      (code >= 0x20000 && code <= 0x3FFFD)
    );
  }
  function dispWidth(str) {
    let w = 0;
    for (const ch of String(str)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
    return w;
  }
  function padTo(text, width, align) {
    const pad = Math.max(0, width - dispWidth(text));
    if (align === 'right') return ' '.repeat(pad) + text;
    if (align === 'center') { const l = Math.floor(pad / 2); return ' '.repeat(l) + text + ' '.repeat(pad - l); }
    return text + ' '.repeat(pad);
  }

  // ---------- parse / serialize ----------
  function splitCells(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }
  function isSepLine(l) {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && /-/.test(l);
  }
  function isTableLine(l) { return l.indexOf('|') >= 0 && l.trim() !== ''; }

  function parseModel(block) {
    const header = splitCells(block[0]);
    const aligns = splitCells(block[1]).map(function (c) {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    const rows = block.slice(2).map(splitCells);
    let cols = header.length;
    cols = Math.max(cols, aligns.length);
    rows.forEach(function (r) { cols = Math.max(cols, r.length); });
    function fit(a) { const x = a.slice(); while (x.length < cols) x.push(''); return x.slice(0, cols); }
    return { header: fit(header), aligns: fit(aligns), rows: rows.map(fit), cols: cols };
  }

  function serialize(m) {
    const widths = [];
    const bodyAll = [m.header].concat(m.rows);
    for (let c = 0; c < m.cols; c++) {
      let w = 3;
      bodyAll.forEach(function (r) { w = Math.max(w, dispWidth(r[c] || '')); });
      widths[c] = w;
    }
    function row(cells) {
      return '| ' + cells.map(function (c, i) { return padTo(c || '', widths[i], m.aligns[i]); }).join(' | ') + ' |';
    }
    function sep() {
      return '| ' + widths.map(function (w, i) {
        const a = m.aligns[i];
        if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
        if (a === 'right') return '-'.repeat(Math.max(1, w - 1)) + ':';
        if (a === 'left') return ':' + '-'.repeat(Math.max(1, w - 1));
        return '-'.repeat(w);
      }).join(' | ') + ' |';
    }
    return [row(m.header), sep()].concat(m.rows.map(row)).join('\n');
  }

  function emptyModel(rows, cols) {
    const header = [];
    for (let c = 0; c < cols; c++) header.push('欄位 ' + (c + 1));
    const body = [];
    for (let r = 0; r < Math.max(1, rows - 1); r++) {
      const line = []; for (let c = 0; c < cols; c++) line.push('');
      body.push(line);
    }
    return { header: header, aligns: new Array(cols).fill(''), rows: body, cols: cols };
  }

  // ---------- locate the table under the caret ----------
  function findTable(value, caret) {
    const lines = value.split('\n');
    // which line is the caret on
    let acc = 0, li = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length + 1;
      if (caret <= acc + lines[i].length) { li = i; break; }
      if (caret < acc + len) { li = i; break; }
      acc += len;
      li = i + 1;
    }
    if (li >= lines.length) li = lines.length - 1;
    if (!lines[li] || !isTableLine(lines[li])) return null;
    let start = li, end = li;
    while (start > 0 && isTableLine(lines[start - 1])) start--;
    while (end < lines.length - 1 && isTableLine(lines[end + 1])) end++;
    const block = lines.slice(start, end + 1);
    if (block.length < 2 || !isSepLine(block[1])) return null;
    let startChar = 0;
    for (let i = 0; i < start; i++) startChar += lines[i].length + 1;
    let endChar = startChar;
    for (let i = start; i <= end; i++) endChar += lines[i].length + (i < end ? 1 : 0);
    // caret position within block
    const caretLine = li - start;
    const lineStartChar = startChar + block.slice(0, caretLine).reduce(function (s, l) { return s + l.length + 1; }, 0);
    const colInLine = caret - lineStartChar;
    let pipes = 0;
    const leading = block[caretLine].trimStart().startsWith('|');
    for (let i = 0; i < colInLine && i < block[caretLine].length; i++) if (block[caretLine][i] === '|') pipes++;
    const cellCol = leading ? Math.max(0, pipes - 1) : pipes;
    // row index in body (-1 = header/separator)
    let bodyRow;
    if (caretLine <= 1) bodyRow = -1; else bodyRow = caretLine - 2;
    return { start: start, end: end, startChar: startChar, endChar: endChar, block: block, cellCol: cellCol, bodyRow: bodyRow };
  }

  // ---------- caret pixel coordinates (mirror div) ----------
  const MIRROR = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace'];
  function caretCoords(el, pos) {
    let div = caretCoords._d;
    if (!div) { div = document.createElement('div'); caretCoords._d = div; document.body.appendChild(div); }
    const cs = getComputedStyle(el), st = div.style;
    st.position = 'absolute'; st.visibility = 'hidden'; st.whiteSpace = 'pre-wrap'; st.wordWrap = 'break-word'; st.overflow = 'hidden';
    MIRROR.forEach(function (p) { st[p] = cs[p]; });
    div.textContent = el.value.substring(0, pos);
    const span = document.createElement('span');
    span.textContent = el.value.substring(pos) || '.';
    div.appendChild(span);
    const r = { top: span.offsetTop, left: span.offsetLeft, height: parseInt(cs.lineHeight, 10) || parseInt(cs.fontSize, 10) * 1.4 };
    div.textContent = '';
    return r;
  }

  // ---------- attach ----------
  function attach(ta, opts) {
    opts = opts || {};
    const isActive = opts.isActive || function () { return true; };
    let bar = null;
    let cur = null; // current table context

    function fire() { ta.dispatchEvent(new Event('input', { bubbles: true })); }

    function replaceTable(ctx, model, keepRow, keepCol) {
      const text = serialize(model);
      const v = ta.value;
      ta.value = v.slice(0, ctx.startChar) + text + v.slice(ctx.endChar);
      // put caret at the start of a sensible cell
      const newLines = text.split('\n');
      let targetLine = 0;
      if (keepRow != null) targetLine = (keepRow < 0) ? 0 : Math.min(newLines.length - 1, keepRow + 2);
      let off = ctx.startChar;
      for (let i = 0; i < targetLine; i++) off += newLines[i].length + 1;
      // move into first cell content
      const lead = newLines[targetLine] ? newLines[targetLine].indexOf('|') : -1;
      off += (lead >= 0 ? lead + 2 : 0);
      ta.selectionStart = ta.selectionEnd = Math.min(off, ta.value.length);
      fire();
      update();
    }

    const OPS = {
      rowAbove: function (c, m) { m.rows.splice(Math.max(0, c.bodyRow < 0 ? 0 : c.bodyRow), 0, new Array(m.cols).fill('')); return c.bodyRow < 0 ? 0 : c.bodyRow; },
      rowBelow: function (c, m) { const at = (c.bodyRow < 0 ? 0 : c.bodyRow + 1); m.rows.splice(at, 0, new Array(m.cols).fill('')); return at; },
      rowDel: function (c, m) { if (c.bodyRow >= 0 && m.rows.length > 1) m.rows.splice(c.bodyRow, 1); return Math.max(0, Math.min(c.bodyRow, m.rows.length - 1)); },
      colLeft: function (c, m) { insCol(m, c.cellCol); return null; },
      colRight: function (c, m) { insCol(m, c.cellCol + 1); return null; },
      colDel: function (c, m) { if (m.cols > 1) { m.header.splice(c.cellCol, 1); m.aligns.splice(c.cellCol, 1); m.rows.forEach(function (r) { r.splice(c.cellCol, 1); }); m.cols--; } return null; },
      alignLeft: function (c, m) { m.aligns[c.cellCol] = 'left'; return null; },
      alignCenter: function (c, m) { m.aligns[c.cellCol] = 'center'; return null; },
      alignRight: function (c, m) { m.aligns[c.cellCol] = 'right'; return null; },
      tidy: function () { return null; }
    };
    function insCol(m, at) {
      m.header.splice(at, 0, '');
      m.aligns.splice(at, 0, '');
      m.rows.forEach(function (r) { r.splice(at, 0, ''); });
      m.cols++;
    }

    function doOp(name) {
      if (!cur) return;
      const ctx = findTable(ta.value, ta.selectionStart) || cur;
      const model = parseModel(ctx.block);
      const keepRow = OPS[name](ctx, model);
      replaceTable(ctx, model, keepRow == null ? ctx.bodyRow : keepRow, ctx.cellCol);
    }

    function deleteTable() {
      if (!cur) return;
      const ctx = findTable(ta.value, ta.selectionStart) || cur;
      let s = ctx.startChar, e = ctx.endChar;
      // swallow a trailing newline
      if (ta.value[e] === '\n') e++;
      ta.value = ta.value.slice(0, s) + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s;
      fire();
      update();
      ta.focus();
    }

    function buildBar() {
      bar = document.createElement('div');
      bar.className = 'table-tb';
      // [op, icon, label, tooltip] — label may be '' for icon-only buttons
      const defs = [
        ['rowAbove', 'arrow-up-to-line', '列', '上方插入列'],
        ['rowBelow', 'arrow-down-to-line', '列', '下方插入列'],
        ['rowDel', 'x', '列', '刪除此列'],
        ['sep'],
        ['colLeft', 'arrow-left-to-line', '欄', '左方插入欄'],
        ['colRight', 'arrow-right-to-line', '欄', '右方插入欄'],
        ['colDel', 'x', '欄', '刪除此欄'],
        ['sep'],
        ['alignLeft', 'align-left', '', '此欄靠左'],
        ['alignCenter', 'align-center', '', '此欄置中'],
        ['alignRight', 'align-right', '', '此欄靠右'],
        ['sep'],
        ['tidy', 'wand', '整理對齊', '整理欄寬與對齊'],
        ['del', 'trash', '', '刪除整個表格']
      ];
      const ic = function (name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; };
      defs.forEach(function (d) {
        if (d[0] === 'sep') { const s = document.createElement('span'); s.className = 'tb-sep'; bar.appendChild(s); return; }
        const btn = document.createElement('button');
        btn.innerHTML = ic(d[1]) + (d[2] ? '<span>' + d[2] + '</span>' : '');
        btn.title = d[3];
        btn.dataset.op = d[0];
        bar.appendChild(btn);
      });
      bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
      bar.addEventListener('click', function (e) {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.op === 'del') deleteTable();
        else doOp(b.dataset.op);
      });
      document.body.appendChild(bar);
    }

    function positionBar(ctx) {
      const topC = caretCoords(ta, ctx.startChar);   // top of the header line
      const botC = caretCoords(ta, ctx.endChar);     // top of the last line
      const rect = ta.getBoundingClientRect();
      const yTop = topC.top - ta.scrollTop;                 // header line top (relative to editor)
      const yBot = botC.top - ta.scrollTop + botC.height;   // just below the last line
      // hide only if the whole table is scrolled out of view
      if (yBot < 0 || yTop > rect.height) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const bh = bar.offsetHeight || 34;
      const aboveTop = rect.top + yTop - bh - 6;   // sit above the table
      const belowTop = rect.top + yBot + 6;        // sit below the whole table
      let top;
      if (aboveTop >= rect.top + 2) {
        top = aboveTop;                            // room above → never covers the table
      } else if (belowTop + bh <= rect.bottom - 2) {
        top = belowTop;                            // no room above → drop below the whole table
      } else {
        top = Math.max(rect.top + 2, Math.min(aboveTop, rect.bottom - bh - 2));
      }
      let left = rect.left + 12;
      left = Math.min(left, window.innerWidth - bar.offsetWidth - 10);
      bar.style.top = Math.max(6, top) + 'px';
      bar.style.left = Math.max(6, left) + 'px';
    }

    function update() {
      if (!isActive()) { if (bar) bar.style.display = 'none'; cur = null; return; }
      const ctx = findTable(ta.value, ta.selectionStart);
      cur = ctx;
      if (!ctx) { if (bar) bar.style.display = 'none'; return; }
      if (!bar) buildBar();
      positionBar(ctx);
    }

    ['keyup', 'click', 'input', 'scroll'].forEach(function (ev) {
      ta.addEventListener(ev, update);
    });
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === ta) update();
    });
    ta.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== ta && bar && (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('.table-tb'))) bar.style.display = 'none'; }, 200); });
    window.addEventListener('resize', function () { if (cur) update(); });

    // expose insert for the toolbar button
    ta._insertTable = function (rows, cols) {
      const model = emptyModel(rows, cols);
      const text = serialize(model);
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const pad0 = (s > 0 && v[s - 1] !== '\n') ? '\n' : '';
      const pad1 = (e < v.length && v[e] !== '\n') ? '\n' : '';
      const insert = pad0 + text + pad1;
      ta.value = v.slice(0, s) + insert + v.slice(e);
      const caret = s + pad0.length + text.indexOf('|') + 2;
      ta.selectionStart = ta.selectionEnd = caret;
      ta.focus();
      fire();
      update();
    };
  }

  // ---------- grid-size picker for inserting a table ----------
  function showInsertPicker(ta, anchor) {
    closePicker();
    const MAXR = 8, MAXC = 8;
    const pop = document.createElement('div');
    pop.className = 'table-picker';
    const grid = document.createElement('div');
    grid.className = 'tp-grid';
    const label = document.createElement('div');
    label.className = 'tp-label';
    label.textContent = '插入表格';
    const cells = [];
    for (let r = 0; r < MAXR; r++) {
      for (let c = 0; c < MAXC; c++) {
        const cell = document.createElement('div');
        cell.className = 'tp-cell';
        cell.dataset.r = r; cell.dataset.c = c;
        grid.appendChild(cell);
        cells.push(cell);
      }
    }
    function highlight(rr, cc) {
      cells.forEach(function (cell) {
        const on = (+cell.dataset.r <= rr && +cell.dataset.c <= cc);
        cell.classList.toggle('on', on);
      });
      label.textContent = (cc + 1) + ' 欄 × ' + (rr + 1) + ' 列';
    }
    grid.addEventListener('mousemove', function (e) {
      const cell = e.target.closest('.tp-cell');
      if (cell) highlight(+cell.dataset.r, +cell.dataset.c);
    });
    grid.addEventListener('click', function (e) {
      const cell = e.target.closest('.tp-cell');
      if (!cell) return;
      const rows = +cell.dataset.r + 1, cols = +cell.dataset.c + 1;
      closePicker();
      if (ta._insertTable) ta._insertTable(rows, cols);
    });
    pop.appendChild(grid);
    pop.appendChild(label);
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    let left = rect.left, top = rect.bottom + 6;
    left = Math.min(left, window.innerWidth - pop.offsetWidth - 10);
    if (top + pop.offsetHeight > window.innerHeight) top = rect.top - pop.offsetHeight - 6;
    pop.style.left = Math.max(6, left) + 'px';
    pop.style.top = Math.max(6, top) + 'px';
    showInsertPicker._pop = pop;
    setTimeout(function () { document.addEventListener('mousedown', onOutside, true); }, 0);
    function onOutside(e) { if (!pop.contains(e.target)) closePicker(); }
    showInsertPicker._outside = onOutside;
  }
  function closePicker() {
    if (showInsertPicker._pop) { showInsertPicker._pop.remove(); showInsertPicker._pop = null; }
    if (showInsertPicker._outside) { document.removeEventListener('mousedown', showInsertPicker._outside, true); showInsertPicker._outside = null; }
  }

  global.TableTool = { attach: attach, showInsertPicker: showInsertPicker,
    _parse: parseModel, _serialize: serialize, _find: findTable, _empty: emptyModel };
})(window);
