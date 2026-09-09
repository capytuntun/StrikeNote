/* mindmap.js — mind maps that live inside the note, as plain text.
 *
 * A mind map is a ```mindmap fenced block holding an indented outline:
 *
 *     ```mindmap
 *     內網滲透
 *       初始存取
 *         釣魚信件
 *         VPN 弱密碼
 *       權限提升
 *     ```
 *
 * The outline IS the document. Nothing is stored in a side table and nothing is
 * serialised as JSON, which is what makes the feature survive everything else
 * this app already does: full-text search still finds the words, the three-way
 * merge still merges two people editing the same map, the PDF export and the
 * published e-book still get the picture because they render the same SVG, and
 * a map degrades to a readable outline in any plain-text view.
 *
 * Public surface:
 *   MindMap.parse(text)            -> {text, children:[…]}   (root node)
 *   MindMap.serialize(root)        -> outline text
 *   MindMap.layout(root)           -> {nodes, links, width, height}
 *   MindMap.renderSVG(text, opts)  -> '<svg …>' for preview / print / e-book
 *   MindMap.open(text, onSave)     -> the interactive editor (needs a DOM)
 *
 * Colours come from CSS custom properties with literal fallbacks baked into the
 * markup, so the same SVG string is correct on screen, inside a print document
 * and inside a standalone published file that has no stylesheet at all.
 */
(function (global) {
  'use strict';

  const INDENT = 2;              // spaces per level when serialising
  const FS_ROOT = 15;            // font sizes, px
  const FS_MAIN = 13;
  const FS_SUB = 12;
  const PAD_X = 12, PAD_Y = 7;   // node padding
  const GAP_X = 46;              // horizontal gap between levels
  const GAP_Y = 10;              // vertical gap between sibling boxes
  const MAX_TEXT = 220;          // wrap wider labels rather than let one run away

  // Branch palette. Six hues, assigned per top-level branch and inherited by its
  // whole subtree, so a reader can follow a branch by colour alone.
  const BRANCH = ['#2f6feb', '#12833f', '#b3541e', '#7b3fd0', '#0e7490', '#b32651'];

  /* ---------------------------------------------------------------- parsing */

  // Indentation is counted in spaces, a tab being worth INDENT. Leading list
  // markers ("- ", "* ", "1. ") are stripped so an outline that was written as a
  // markdown list still parses, and a heading marker is stripped too — people
  // paste both.
  function lineInfo(raw) {
    let i = 0, col = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === ' ') { col += 1; i++; }
      else if (c === '\t') { col += INDENT; i++; }
      else break;
    }
    let text = raw.slice(i);
    text = text.replace(/^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '');
    return { depth: col, text: text.trim() };
  }

  function parse(text) {
    const lines = String(text == null ? '' : text).split('\n')
      .map(lineInfo).filter(function (l) { return l.text !== ''; });
    const root = { text: lines.length ? lines[0].text : '心智圖', children: [] };
    if (lines.length < 2) return root;

    // A stack of {depth, node}. Depths are used only for ordering, never for
    // arithmetic, so a file indented with 4 spaces, 2 spaces or tabs all work.
    const stack = [{ depth: lines[0].depth, node: root }];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      while (stack.length > 1 && l.depth <= stack[stack.length - 1].depth) stack.pop();
      const node = { text: l.text, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth: l.depth, node: node });
    }
    return root;
  }

  function serialize(root) {
    const out = [];
    (function walk(n, d) {
      out.push(new Array(d * INDENT + 1).join(' ') + n.text);
      (n.children || []).forEach(function (c) { walk(c, d + 1); });
    })(root, 0);
    return out.join('\n');
  }

  /* --------------------------------------------------------------- measuring */

  // Text width without touching the DOM, so layout is identical in the browser,
  // in the print document and in a published file. Full-width CJK counts as one
  // em; everything else at roughly half. The result only has to be close — the
  // box is drawn to whatever this says, so it is self-consistent by construction.
  function charW(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6))) return 1;
    return 0.55;
  }

  function textWidth(s, fs) {
    let w = 0;
    for (let i = 0; i < s.length; i++) w += charW(s[i]);
    return w * fs;
  }

  // Greedy wrap at MAX_TEXT px. Breaks between CJK characters and at spaces for
  // latin words, which is the behaviour a reader expects from both scripts.
  function wrap(s, fs) {
    if (textWidth(s, fs) <= MAX_TEXT) return [s];
    const lines = [];
    let cur = '', curW = 0, wordStart = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], w = charW(ch) * fs;
      if (curW + w > MAX_TEXT && cur !== '') {
        // Prefer breaking at the last space if one is close to the end.
        const sp = cur.lastIndexOf(' ');
        if (sp > 0 && cur.length - sp < 14) {
          lines.push(cur.slice(0, sp));
          cur = cur.slice(sp + 1);
          curW = textWidth(cur, fs);
        } else { lines.push(cur); cur = ''; curW = 0; }
      }
      cur += ch; curW += w;
      if (ch === ' ') wordStart = i;
    }
    if (cur !== '') lines.push(cur);
    return lines;
  }

  function fontFor(depth) { return depth === 0 ? FS_ROOT : depth === 1 ? FS_MAIN : FS_SUB; }

  function measure(node, depth) {
    const fs = fontFor(depth);
    const lines = wrap(node.text, fs);
    let w = 0;
    lines.forEach(function (l) { w = Math.max(w, textWidth(l, fs)); });
    node._fs = fs;
    node._lines = lines;
    node._w = Math.round(w + PAD_X * 2);
    node._h = Math.round(lines.length * Math.round(fs * 1.35) + PAD_Y * 2);
    (node.children || []).forEach(function (c) { measure(c, depth + 1); });
  }

  /* ----------------------------------------------------------------- layout */

  // Vertical extent a subtree needs: its own box, or the stack of its children,
  // whichever is taller. This is the tidy-tree rule reduced to what a mind map
  // actually needs — no sibling-subtree shifting, because children are stacked
  // rather than centred over one another.
  function extent(node) {
    const kids = node._open === false ? [] : (node.children || []);
    if (!kids.length) { node._ext = node._h; return node._ext; }
    let sum = 0;
    kids.forEach(function (c) { sum += extent(c) + GAP_Y; });
    sum -= GAP_Y;
    node._ext = Math.max(node._h, sum);
    return node._ext;
  }

  function place(node, x, top, dir, depth, colour, out) {
    const kids = node._open === false ? [] : (node.children || []);
    node._x = dir > 0 ? x : x - node._w;      // x is the edge the branch leaves from
    node._y = Math.round(top + (node._ext - node._h) / 2);
    node._depth = depth;
    node._dir = dir;
    node._colour = colour;
    out.nodes.push(node);

    let cy = top + (node._ext - (function () {
      let s = 0;
      kids.forEach(function (c) { s += c._ext + GAP_Y; });
      return Math.max(0, s - GAP_Y);
    })()) / 2;

    const childX = dir > 0 ? node._x + node._w + GAP_X : node._x - GAP_X;
    kids.forEach(function (c) {
      place(c, childX, cy, dir, depth + 1, colour, out);
      out.links.push({ from: node, to: c, colour: colour, dir: dir });
      cy += c._ext + GAP_Y;
    });
  }

  function layout(root) {
    measure(root, 0);

    // Split top-level branches into a right and a left column so the map grows
    // in both directions instead of running off one edge. The split is by count,
    // filling the right side first: balancing by subtree height instead looks
    // arbitrary to the person reading it (four branches can come out 1 and 3),
    // and it makes a branch jump sides when an unrelated one gains a child.
    const kids = root._open === false ? [] : (root.children || []);
    kids.forEach(function (c) { extent(c); });
    const half = Math.ceil(kids.length / 2);
    const right = [], left = [];
    kids.forEach(function (c, i) {
      c._branch = i;
      if (i < half) { right.push(c); c._side = 1; }
      else { left.push(c); c._side = -1; }
    });

    const stackH = function (list) {
      let s = 0;
      list.forEach(function (c) { s += c._ext + GAP_Y; });
      return Math.max(0, s - GAP_Y);
    };
    const rh = stackH(right), lh = stackH(left);
    const height = Math.max(root._h, rh, lh) + 24;
    const mid = height / 2;

    const out = { nodes: [], links: [] };
    root._x = 0; root._y = Math.round(mid - root._h / 2);
    root._depth = 0; root._dir = 0; root._colour = null;
    out.nodes.push(root);

    let cy = mid - rh / 2;
    right.forEach(function (c) {
      place(c, root._w + GAP_X, cy, 1, 1, BRANCH[c._branch % BRANCH.length], out);
      out.links.push({ from: root, to: c, colour: c._colour, dir: 1 });
      cy += c._ext + GAP_Y;
    });
    cy = mid - lh / 2;
    left.forEach(function (c) {
      place(c, -GAP_X, cy, -1, 1, BRANCH[c._branch % BRANCH.length], out);
      out.links.push({ from: root, to: c, colour: c._colour, dir: -1 });
      cy += c._ext + GAP_Y;
    });

    // Shift everything positive and add a margin.
    let minX = 0, maxX = 0;
    out.nodes.forEach(function (n) {
      minX = Math.min(minX, n._x);
      maxX = Math.max(maxX, n._x + n._w);
    });
    const dx = 16 - minX;
    out.nodes.forEach(function (n) { n._x += dx; });
    out.width = Math.round(maxX - minX + 32);
    out.height = Math.round(height);
    out.root = root;
    return out;
  }

  /* --------------------------------------------------------------- rendering */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Connector: a horizontal-tangent cubic, which reads as a branch rather than
  // as a wire. Anchored at the vertical centre of each box.
  function linkPath(l) {
    const a = l.from, b = l.to;
    const x1 = l.dir > 0 ? a._x + a._w : a._x;
    const y1 = a._y + a._h / 2;
    const x2 = l.dir > 0 ? b._x : b._x + b._w;
    const y2 = b._y + b._h / 2;
    const c = (x2 - x1) * 0.5;
    return 'M' + x1 + ' ' + y1 + 'C' + (x1 + c) + ' ' + y1 + ',' + (x2 - c) + ' ' + y2 +
      ',' + x2 + ' ' + y2;
  }

  // Box fill and label colour come from CSS classes, never from inline attributes,
  // so one SVG string is correct in the light theme, the dark theme and a print
  // document. Only the branch colour is inline, because it varies per node and is
  // deliberately the same mid-tone in every context.
  function nodeSVG(n, idx) {
    const isRoot = n._depth === 0;
    const lh = Math.round(n._fs * 1.35);
    let t = '';
    n._lines.forEach(function (line, i) {
      t += '<tspan x="' + (n._x + n._w / 2) + '" y="' +
        (n._y + PAD_Y + lh * i + Math.round(lh * 0.74)) + '">' + esc(line) + '</tspan>';
    });
    const kids = (n.children || []).length;
    let badge = '';
    if (n._open === false && kids) {
      const bx = n._dir >= 0 ? n._x + n._w + 9 : n._x - 9;
      badge = '<circle class="mm-badge" cx="' + bx + '" cy="' + (n._y + n._h / 2) + '" r="8"' +
        ' fill="' + (n._colour || '#8a94a6') + '"/>' +
        '<text class="mm-badge-t" x="' + bx + '" y="' + (n._y + n._h / 2 + 3.5) + '"' +
        ' text-anchor="middle" font-size="10" font-weight="700">' + kids + '</text>';
    }
    return '<g class="mm-node' + (isRoot ? ' mm-is-root' : '') + '" data-i="' + idx + '">' +
      '<rect class="mm-rect' + (isRoot ? ' mm-rect-root' : '') + '"' +
      ' x="' + n._x + '" y="' + n._y + '" width="' + n._w + '" height="' + n._h + '"' +
      (isRoot ? '' : ' stroke="' + (n._colour || '#8a94a6') + '"') +
      ' stroke-width="' + (isRoot ? 1 : 1.5) + '"/>' +
      '<text class="mm-text' + (isRoot ? ' mm-text-root' : '') + '" text-anchor="middle"' +
      ' font-size="' + n._fs + '"' +
      ' font-weight="' + (isRoot ? 700 : n._depth === 1 ? 600 : 400) + '">' + t + '</text>' +
      badge + '</g>';
  }

  function renderTree(tree) {
    let s = '<svg class="mm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      tree.width + ' ' + tree.height + '" width="' + tree.width + '" height="' + tree.height + '">';
    tree.links.forEach(function (l) {
      s += '<path class="mm-link" d="' + linkPath(l) + '" fill="none" stroke="' +
        (l.colour || '#8a94a6') + '" stroke-width="' + (l.from._depth === 0 ? 2.2 : 1.4) + '"/>';
    });
    tree.nodes.forEach(function (n, i) { s += nodeSVG(n, i); });
    return s + '</svg>';
  }

  function renderSVG(text) {
    return renderTree(layout(parse(text)));
  }

  /* ----------------------------------------------------------- the editor */
  //
  // Keyboard-first, the way every mind-map tool works: Tab makes a child, Enter
  // makes a sibling, typing replaces the label. Anything the mouse can do here
  // the keyboard can do too, because building a map is a fast repetitive task
  // and reaching for the mouse between every node is what makes these tools
  // tiring to use.

  let seq = 0;
  function tag(n) {
    n._id = ++seq;
    (n.children || []).forEach(tag);
    return n;
  }
  function find(root, id) {
    if (root._id === id) return root;
    const kids = root.children || [];
    for (let i = 0; i < kids.length; i++) {
      const hit = find(kids[i], id);
      if (hit) return hit;
    }
    return null;
  }
  function parentOf(root, node) {
    const kids = root.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === node) return root;
      const hit = parentOf(kids[i], node);
      if (hit) return hit;
    }
    return null;
  }
  // Visible nodes top to bottom — the order the up/down arrows walk.
  function flatten(root, out) {
    out = out || [];
    out.push(root);
    if (root._open !== false) (root.children || []).forEach(function (c) { flatten(c, out); });
    return out;
  }

  function open(text, onSave) {
    if (typeof document === 'undefined') return null;

    let root = tag(parse(text));
    let selId = root._id;
    let tree = null;
    let zoom = 1, panX = 0, panY = 0;
    const undo = [], redo = [];

    const overlay = document.createElement('div');
    overlay.className = 'mm-overlay';
    overlay.innerHTML =
      '<div class="mm-editor" role="dialog" aria-label="心智圖編輯器">' +
      '<header class="mm-bar">' +
      '<span class="mm-bar-t">心智圖</span>' +
      '<span class="mm-bar-hint">Tab 子項目 · Enter 同層 · F2 改字 · Delete 刪除 · 空白鍵收合</span>' +
      '<span class="mm-bar-sp"></span>' +
      '<button class="btn btn-ghost mm-zo" type="button" title="縮小">−</button>' +
      '<button class="btn btn-ghost mm-zr" type="button" title="實際大小">100%</button>' +
      '<button class="btn btn-ghost mm-zi" type="button" title="放大">＋</button>' +
      '<button class="btn mm-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary mm-save" type="button">完成</button>' +
      '</header>' +
      '<div class="mm-canvas" tabindex="0"><div class="mm-stage"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('.mm-canvas');
    const stage = overlay.querySelector('.mm-stage');
    let input = null;

    function snapshot() {
      undo.push(serialize(root));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    function restore(from, to) {
      if (!from.length) return;
      to.push(serialize(root));
      root = tag(parse(from.pop()));
      selId = root._id;
      draw();
    }

    function selected() { return find(root, selId) || root; }

    function draw() {
      // Collapse state rides on the node objects, which survive every redraw —
      // the tree is only re-parsed on undo, and that deliberately resets it.
      tree = layout(root);
      stage.innerHTML = renderTree(tree);
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      const sel = selected();
      const idx = tree.nodes.indexOf(sel);
      if (idx >= 0) {
        const g = stage.querySelector('.mm-node[data-i="' + idx + '"]');
        if (g) g.classList.add('mm-sel');
      }
    }

    function nodeAt(target) {
      const g = target.closest && target.closest('.mm-node');
      if (!g) return null;
      return tree.nodes[Number(g.getAttribute('data-i'))] || null;
    }

    // ---- inline label editing ----
    function edit(node, selectAll) {
      commit();
      const idx = tree.nodes.indexOf(node);
      if (idx < 0) return;
      const g = stage.querySelector('.mm-node[data-i="' + idx + '"] rect');
      if (!g) return;
      const box = g.getBoundingClientRect();
      const host = canvas.getBoundingClientRect();
      input = document.createElement('input');
      input.className = 'mm-input';
      input.value = node.text;
      input.style.left = (box.left - host.left + canvas.scrollLeft) + 'px';
      input.style.top = (box.top - host.top + canvas.scrollTop) + 'px';
      input.style.width = Math.max(90, box.width) + 'px';
      input.style.height = box.height + 'px';
      input.style.fontSize = Math.round(node._fs * zoom) + 'px';
      input._node = node;
      canvas.appendChild(input);
      input.focus();
      if (selectAll) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); canvas.focus(); }
        else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault(); e.stopPropagation();
          const n = input._node, add = e.key;
          commit();
          canvas.focus();
          if (add === 'Tab') addChild(n); else addSibling(n);
        } else e.stopPropagation();
      });
      input.addEventListener('blur', function () { commit(); });
    }
    function commit() {
      if (!input) return;
      const el = input, node = el._node;
      input = null;
      const v = el.value.trim();
      el.remove();
      if (v && v !== node.text) { snapshot(); node.text = v; draw(); }
      else if (!v && node !== root) { snapshot(); removeNode(node); }
    }
    function cancelEdit() {
      if (!input) return;
      const el = input; input = null; el.remove();
    }

    // ---- structural edits ----
    function addChild(node) {
      snapshot();
      node._open = true;
      const child = tag({ text: '新節點', children: [] });
      (node.children = node.children || []).push(child);
      selId = child._id;
      draw();
      edit(child, true);
    }
    function addSibling(node) {
      if (node === root) return addChild(node);
      snapshot();
      const p = parentOf(root, node);
      const sib = tag({ text: '新節點', children: [] });
      p.children.splice(p.children.indexOf(node) + 1, 0, sib);
      selId = sib._id;
      draw();
      edit(sib, true);
    }
    function removeNode(node) {
      if (node === root) return;
      const p = parentOf(root, node);
      const i = p.children.indexOf(node);
      p.children.splice(i, 1);
      selId = (p.children[i] || p.children[i - 1] || p)._id;
      draw();
    }
    // Re-parent by dragging. A node may not be dropped inside its own subtree —
    // that would detach the whole branch from the tree.
    function reparent(node, target) {
      if (node === root || node === target) return;
      let p = target;
      while (p) { if (p === node) return; p = parentOf(root, p); }
      snapshot();
      const old = parentOf(root, node);
      old.children.splice(old.children.indexOf(node), 1);
      target._open = true;
      (target.children = target.children || []).push(node);
      selId = node._id;
      draw();
    }

    // ---- navigation ----
    function move(dir) {
      const sel = selected();
      if (dir === 'in') {
        if ((sel.children || []).length) {
          sel._open = true;
          selId = sel.children[0]._id;
        }
      } else if (dir === 'out') {
        const p = parentOf(root, sel);
        if (p) selId = p._id;
      } else {
        const list = flatten(root);
        const i = list.indexOf(sel);
        const next = list[i + (dir === 'down' ? 1 : -1)];
        if (next) selId = next._id;
      }
      draw();
      scrollSelIntoView();
    }
    function scrollSelIntoView() {
      const idx = tree.nodes.indexOf(selected());
      if (idx < 0) return;
      const g = stage.querySelector('.mm-node[data-i="' + idx + '"] rect');
      if (g && g.scrollIntoView) g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function setZoom(z) {
      zoom = Math.min(2.5, Math.max(0.35, z));
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    }

    // ---- events ----
    canvas.addEventListener('mousedown', function (e) {
      if (e.target.closest('.mm-input')) return;
      const node = nodeAt(e.target);
      if (node) {
        selId = node._id;
        draw();
        dragFrom = { node: node, x: e.clientX, y: e.clientY, moved: false };
      } else {
        panFrom = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      }
      canvas.focus();
    });
    let dragFrom = null, panFrom = null;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    function onMove(e) {
      if (dragFrom) {
        if (Math.abs(e.clientX - dragFrom.x) + Math.abs(e.clientY - dragFrom.y) > 5) {
          dragFrom.moved = true;
          canvas.classList.add('mm-dragging');
          const over = nodeAt(document.elementFromPoint(e.clientX, e.clientY) || document.body);
          stage.querySelectorAll('.mm-drop').forEach(function (n) { n.classList.remove('mm-drop'); });
          if (over && over !== dragFrom.node) {
            const g = stage.querySelector('.mm-node[data-i="' + tree.nodes.indexOf(over) + '"]');
            if (g) g.classList.add('mm-drop');
          }
        }
      } else if (panFrom) {
        panX = panFrom.px + (e.clientX - panFrom.x);
        panY = panFrom.py + (e.clientY - panFrom.y);
        stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      }
    }
    function onUp(e) {
      canvas.classList.remove('mm-dragging');
      if (dragFrom && dragFrom.moved) {
        const over = nodeAt(document.elementFromPoint(e.clientX, e.clientY) || document.body);
        if (over) reparent(dragFrom.node, over);
        else draw();
      }
      dragFrom = null;
      panFrom = null;
    }

    canvas.addEventListener('dblclick', function (e) {
      const node = nodeAt(e.target);
      if (node) edit(node, true);
    });

    canvas.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });

    canvas.addEventListener('keydown', function (e) {
      if (input) return;
      const sel = selected();
      const k = e.key;
      if (k === 'Tab') { e.preventDefault(); addChild(sel); }
      else if (k === 'Enter') { e.preventDefault(); addSibling(sel); }
      else if (k === 'F2') { e.preventDefault(); edit(sel, true); }
      else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); snapshot(); removeNode(sel); }
      else if (k === 'ArrowDown') { e.preventDefault(); move('down'); }
      else if (k === 'ArrowUp') { e.preventDefault(); move('up'); }
      else if (k === 'ArrowRight') { e.preventDefault(); move(sel._dir < 0 ? 'out' : 'in'); }
      else if (k === 'ArrowLeft') { e.preventDefault(); move(sel._dir < 0 ? 'in' : 'out'); }
      else if (k === ' ') {
        e.preventDefault();
        if ((sel.children || []).length) { sel._open = sel._open === false; draw(); }
      } else if (k === 'Escape') { e.preventDefault(); close(); }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) restore(redo, undo); else restore(undo, redo);
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typing straight onto a selected node replaces its label, as in every
        // other outliner — no need to press F2 first.
        e.preventDefault();
        edit(sel, true);
        if (input) { input.value = k; input.setSelectionRange(1, 1); }
      }
    });

    overlay.querySelector('.mm-zi').addEventListener('click', function () { setZoom(zoom * 1.2); });
    overlay.querySelector('.mm-zo').addEventListener('click', function () { setZoom(zoom / 1.2); });
    overlay.querySelector('.mm-zr').addEventListener('click', function () {
      panX = 0; panY = 0; setZoom(1);
    });
    overlay.querySelector('.mm-cancel').addEventListener('click', function () { close(); });
    overlay.querySelector('.mm-save').addEventListener('click', function () {
      commit();
      const out = serialize(root);
      close();
      if (onSave) onSave(out);
    });

    function close() {
      cancelEdit();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      overlay.remove();
    }

    draw();
    canvas.focus();
    return { close: close };
  }

  /* ------------------------------------------------- editing in the preview */
  //
  // The preview pane is rebuilt from scratch on every keystroke (app.js replaces
  // its innerHTML), so nothing here may keep a reference to a DOM node between
  // renders. Instead the selection is remembered as a *path* — the chain of child
  // indices from the root — and re-applied by `restorePreview` after each render,
  // the same trick `restoreInlineTocState` uses for the inline [toc].
  //
  // The one thing that cannot survive a re-render is the text field, so it does
  // not live in the preview at all: it is a fixed-position input parented to
  // <body> and moved over the node it is editing. That is what lets every
  // keystroke go straight back into the markdown — the editor and the map stay in
  // step character by character, and the field keeps focus while it happens.

  function nodeAtPath(root, path) {
    let n = root;
    for (let i = 0; i < path.length; i++) {
      const kids = n.children || [];
      if (!kids[path[i]]) return null;
      n = kids[path[i]];
    }
    return n;
  }
  function pathOfIndex(tree, idx) {
    // tree.nodes is in draw order; rebuild the path by walking parents.
    const node = tree.nodes[idx];
    if (!node) return null;
    const path = [];
    let cur = node;
    while (cur && cur !== tree.root) {
      const p = parentOf(tree.root, cur);
      if (!p) return null;
      path.unshift((p.children || []).indexOf(cur));
      cur = p;
    }
    return path;
  }
  function samePath(a, b) {
    return !!a && !!b && a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  }

  let pv = null;   // the single live binding; the app only ever has one preview

  function bindPreview(host, opts) {
    if (pv && pv.host === host) { pv.opts = opts || {}; return pv; }
    closeInput();
    pv = {
      host: host, opts: opts || {},
      block: -1, path: null,       // current selection
      collapsed: {},               // "block:path" -> true
      input: null, drag: null
    };

    host.addEventListener('mousedown', onDown);
    host.addEventListener('dblclick', onDbl);
    host.addEventListener('keydown', onKey);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
    return pv;
  }

  function readOnly() {
    return !!(pv && pv.opts.isReadOnly && pv.opts.isReadOnly());
  }

  function blockOf(el) {
    const b = el.closest && el.closest('.mindmap-block');
    if (!b || !pv) return null;
    const all = pv.host.querySelectorAll('.mindmap-block');
    const idx = Array.prototype.indexOf.call(all, b);
    return idx < 0 ? null : { el: b, index: idx };
  }

  // Re-derive the tree for a block from the markdown it carries, applying the
  // collapse flags this session has set on it.
  function treeFor(blockIndex, el) {
    const root = parse(el.getAttribute('data-mindmap') || '');
    const prefix = blockIndex + ':';
    (function walk(n, path) {
      if (pv.collapsed[prefix + path.join(',')]) n._open = false;
      (n.children || []).forEach(function (c, i) { walk(c, path.concat(i)); });
    })(root, []);
    return { root: root, tree: layout(root) };
  }

  function commitTree(blockIndex, root) {
    if (pv.opts.onChange) pv.opts.onChange(blockIndex, serialize(root));
  }

  function select(blockIndex, path) {
    pv.block = blockIndex;
    pv.path = path;
    paintSelection();
  }

  // Highlight whichever <g> currently corresponds to the remembered path.
  function paintSelection() {
    if (!pv) return;
    const blocks = pv.host.querySelectorAll('.mindmap-block');
    Array.prototype.forEach.call(blocks, function (b, i) {
      b.setAttribute('tabindex', '0');
      Array.prototype.forEach.call(b.querySelectorAll('.mm-node.mm-sel'), function (g) {
        g.classList.remove('mm-sel');
      });
      if (i !== pv.block || !pv.path) return;
      const info = treeFor(i, b);
      const target = nodeAtPath(info.root, pv.path);
      if (!target) return;
      const idx = info.tree.nodes.indexOf(target);
      const g = idx >= 0 && b.querySelector('.mm-node[data-i="' + idx + '"]');
      if (g) g.classList.add('mm-sel');
    });
  }

  // ---- events ----
  function onDown(e) {
    const b = blockOf(e.target);
    if (!b) return;
    if (e.target.closest('.mm-edit-btn')) return;   // the full-screen button
    const g = e.target.closest('.mm-node');
    b.el.focus({ preventScroll: true });
    if (!g) return;
    const info = treeFor(b.index, b.el);
    const path = pathOfIndex(info.tree, Number(g.getAttribute('data-i')));
    if (!path) return;
    if (!samePath(path, pv.path) || pv.block !== b.index) closeInput();
    select(b.index, path);
    if (!readOnly()) pv.drag = { block: b.index, path: path, x: e.clientX, y: e.clientY, moved: false };
    e.preventDefault();   // stop the browser starting a text selection on the SVG
  }

  function onDbl(e) {
    const b = blockOf(e.target);
    if (!b || readOnly()) return;
    const g = e.target.closest('.mm-node');
    if (!g) return;
    const info = treeFor(b.index, b.el);
    const path = pathOfIndex(info.tree, Number(g.getAttribute('data-i')));
    if (path) { select(b.index, path); openInput(true); }
  }

  function onDragMove(e) {
    if (!pv || !pv.drag) return;
    if (Math.abs(e.clientX - pv.drag.x) + Math.abs(e.clientY - pv.drag.y) < 6) return;
    pv.drag.moved = true;
    Array.prototype.forEach.call(pv.host.querySelectorAll('.mm-node.mm-drop'), function (g) {
      g.classList.remove('mm-drop');
    });
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const g = over && over.closest && over.closest('.mm-node');
    if (!g) return;
    const b = blockOf(g);
    if (!b || b.index !== pv.drag.block) return;   // no dragging between maps
    g.classList.add('mm-drop');
  }

  function onDragUp(e) {
    if (!pv || !pv.drag) return;
    const d = pv.drag;
    pv.drag = null;
    Array.prototype.forEach.call(pv.host.querySelectorAll('.mm-node.mm-drop'), function (g) {
      g.classList.remove('mm-drop');
    });
    if (!d.moved) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const g = over && over.closest && over.closest('.mm-node');
    if (!g) return;
    const b = blockOf(g);
    if (!b || b.index !== d.block) return;
    const info = treeFor(d.block, b.el);
    const targetPath = pathOfIndex(info.tree, Number(g.getAttribute('data-i')));
    const node = nodeAtPath(info.root, d.path);
    const target = targetPath && nodeAtPath(info.root, targetPath);
    if (!node || !target || node === target || node === info.root) return;
    // Never drop a node inside its own subtree — that detaches the branch.
    let p = target;
    while (p) { if (p === node) return; p = parentOf(info.root, p); }
    const old = parentOf(info.root, node);
    old.children.splice(old.children.indexOf(node), 1);
    (target.children = target.children || []).push(node);
    select(d.block, targetPath.concat(target.children.length - 1));
    commitTree(d.block, info.root);
  }

  function onKey(e) {
    if (!pv || pv.block < 0 || !pv.path) return;
    const blocks = pv.host.querySelectorAll('.mindmap-block');
    const el = blocks[pv.block];
    if (!el || !el.contains(document.activeElement) && document.activeElement !== el) return;
    const k = e.key;
    if (k === 'Escape') { closeInput(); el.focus({ preventScroll: true }); e.preventDefault(); return; }

    const info = treeFor(pv.block, el);
    const node = nodeAtPath(info.root, pv.path);
    if (!node) return;

    // Navigation and collapsing work even on a read-only note.
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const list = flatten(info.root);
      const i = list.indexOf(node);
      const next = list[i + (k === 'ArrowDown' ? 1 : -1)];
      if (next) select(pv.block, pathFor(info.root, next));
      return;
    }
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      const outward = (node._dir < 0) === (k === 'ArrowRight');
      if (outward) {
        const p = parentOf(info.root, node);
        if (p) select(pv.block, pathFor(info.root, p));
      } else if ((node.children || []).length) {
        setCollapsed(pv.block, pv.path, false);
        select(pv.block, pv.path.concat(0));
        repaintBlock(el);
      }
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      if ((node.children || []).length) {
        setCollapsed(pv.block, pv.path, node._open !== false);
        repaintBlock(el);
      }
      return;
    }

    if (readOnly()) return;

    if (k === 'Tab') {
      e.preventDefault();
      setCollapsed(pv.block, pv.path, false);
      const child = { text: '新節點', children: [] };
      (node.children = node.children || []).push(child);
      const path = pv.path.concat(node.children.length - 1);
      select(pv.block, path);
      commitTree(pv.block, info.root);
      openInputSoon(true);
    } else if (k === 'Enter') {
      e.preventDefault();
      // The root has no siblings, so Enter there means the same as Tab.
      if (node === info.root) { onKey(synthKey('Tab')); return; }
      const p = parentOf(info.root, node);
      const at = p.children.indexOf(node) + 1;
      p.children.splice(at, 0, { text: '新節點', children: [] });
      select(pv.block, pv.path.slice(0, -1).concat(at));
      commitTree(pv.block, info.root);
      openInputSoon(true);
    } else if (k === 'F2') {
      e.preventDefault();
      openInput(true);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (node === info.root) return;
      const p = parentOf(info.root, node);
      const at = p.children.indexOf(node);
      p.children.splice(at, 1);
      const nextPath = p.children.length
        ? pv.path.slice(0, -1).concat(Math.min(at, p.children.length - 1))
        : pv.path.slice(0, -1);
      select(pv.block, nextPath);
      commitTree(pv.block, info.root);
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openInput(true, k);
    }
  }

  // A plain object standing in for a KeyboardEvent, for the couple of places one
  // key handler delegates to another. Copying a real event does not work: its
  // properties live on the prototype, so Object.assign would produce a blank.
  function synthKey(key) {
    return { key: key, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: function () {}, stopPropagation: function () {} };
  }

  function pathFor(root, node) {
    const path = [];
    let cur = node;
    while (cur && cur !== root) {
      const p = parentOf(root, cur);
      if (!p) return null;
      path.unshift(p.children.indexOf(cur));
      cur = p;
    }
    return path;
  }

  function setCollapsed(blockIndex, path, on) {
    const key = blockIndex + ':' + path.join(',');
    if (on) pv.collapsed[key] = true; else delete pv.collapsed[key];
  }

  // Collapsing changes no markdown, so it cannot go through onChange — redraw
  // just this block in place instead.
  function repaintBlock(el) {
    const b = blockOf(el);
    if (!b) return;
    const info = treeFor(b.index, b.el);
    const svg = b.el.querySelector('svg.mm-svg');
    if (svg) svg.outerHTML = renderTree(info.tree);
    paintSelection();
  }

  // ---- the floating text field ----
  function openInputSoon(selectAll) {
    // After a structural change the preview re-renders on a timer; wait for the
    // new geometry before placing the field over the new node.
    setTimeout(function () { openInput(selectAll); }, 180);
  }

  function openInput(selectAll, seed) {
    if (!pv || pv.block < 0 || !pv.path || readOnly()) return;
    const blocks = pv.host.querySelectorAll('.mindmap-block');
    const el = blocks[pv.block];
    if (!el) return;
    const info = treeFor(pv.block, el);
    const node = nodeAtPath(info.root, pv.path);
    if (!node) return;

    closeInput();
    const inp = document.createElement('input');
    inp.className = 'mm-live-input';
    inp.value = seed != null ? seed : node.text;
    document.body.appendChild(inp);
    pv.input = inp;
    placeInput();
    inp.focus();
    if (seed != null) inp.setSelectionRange(seed.length, seed.length);
    else if (selectAll) inp.select();

    // Every keystroke can trigger a debounced preview re-render (app.js rebuilds
    // the whole pane's innerHTML), which detaches `el`. Re-querying the live
    // block by index, rather than closing over this one DOM node, is what keeps
    // focus() and re-selection working after that happens mid-edit.
    function liveBlock() {
      return (pv && pv.host.querySelectorAll('.mindmap-block')[pv.block]) || null;
    }
    function refocusBlock() {
      const live = liveBlock();
      if (live) live.focus({ preventScroll: true });
    }
    inp.addEventListener('input', function () {
      // Straight back into the markdown on every keystroke: this is what puts the
      // syntax in the editor while the map is being edited.
      const cur = treeFor(pv.block, liveBlock() || el);
      const n = nodeAtPath(cur.root, pv.path);
      if (!n) return;
      n.text = inp.value || ' ';
      commitTree(pv.block, cur.root);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeInput(); refocusBlock(); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        const add = e.key;
        closeInput();
        refocusBlock();
        onKey(synthKey(add));
      } else e.stopPropagation();
    });
    inp.addEventListener('blur', function () { closeInput(); });
  }

  function placeInput() {
    if (!pv || !pv.input) return;
    const blocks = pv.host.querySelectorAll('.mindmap-block');
    const el = blocks[pv.block];
    if (!el) { closeInput(); return; }
    const g = el.querySelector('.mm-node.mm-sel rect');
    if (!g) { closeInput(); return; }
    const r = g.getBoundingClientRect();
    const s = pv.input.style;
    s.left = r.left + 'px';
    s.top = r.top + 'px';
    s.width = Math.max(80, r.width) + 'px';
    s.height = r.height + 'px';
    s.fontSize = Math.max(11, Math.round(r.height * 0.42)) + 'px';
  }

  function closeInput() {
    if (pv && pv.input) { const i = pv.input; pv.input = null; i.remove(); }
  }

  // Called by the app after every preview render.
  function restorePreview() {
    if (!pv) return;
    paintSelection();
    if (pv.input) placeInput();
  }

  global.MindMap = {
    parse: parse,
    serialize: serialize,
    layout: layout,
    renderTree: renderTree,
    renderSVG: renderSVG,
    open: open,
    bindPreview: bindPreview,
    restorePreview: restorePreview,
    branchColours: BRANCH
  };
})(typeof window !== 'undefined' ? window : globalThis);
