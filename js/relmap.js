/* relmap.js — 關聯分析：自由畫布的節點／連線圖，像簡化版的 React Flow。
 *
 * 跟心智圖（mindmap.js）同一個哲學：一段純文字 DSL 是唯一的真實來源——可搜尋、
 * 可合併、版本歷史看得懂——每次渲染都從它重新算出 SVG。差別是心智圖的大綱只能
 * 表達樹狀關係，位置是自動排出來的；這裡的圖是自由的（任意節點連任意節點），
 * 所以每個節點的位置也得存下來，不能重新算：
 *
 *   ```relmap
 *   node n1 "弱點A" x=40 y=40 color=red
 *   node n2 "主機1" x=280 y=40
 *   edge n1 n2 "利用"
 *   ```
 *
 * `RelMap.open(text, onSave)` 開一個全螢幕編輯器（跟 MindMap.open 同一種疊層），
 * `RelMap.renderSVG(text)` 是唯讀渲染，預覽、PDF、電子書都呼叫這個——編輯器內部
 * 也是用同一份佈局／畫圖邏輯，畫面看到的東西不會因為在哪裡渲染而不一樣。
 *
 * 「多一種筆記」的部分（meta.relMap）在 app.js：開啟這種筆記直接進全螢幕編輯器，
 * 不用先點一下；新增筆記的下拉選單裡也有「關聯分析」範本。
 */
(function (global) {
  'use strict';

  // ---------------- DSL：剖析 / 序列化 ----------------------------------------
  // 一行一個 token：`"引號內含空白"` 當一個 token，其餘以空白分隔。
  function tokenize(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }
  function attrsOf(tokens) {
    const a = {};
    tokens.forEach(function (t) {
      const i = t.indexOf('=');
      if (i > 0) a[t.slice(0, i)] = t.slice(i + 1);
    });
    return a;
  }
  function quote(s) { return '"' + String(s || '').replace(/"/g, '\\"') + '"'; }

  function parse(text) {
    const nodes = [], edges = [];
    String(text || '').split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line || line[0] === '#') return;
      const t = tokenize(line);
      if (t[0] === 'node' && t[1]) {
        const attrs = attrsOf(t.slice(3));
        nodes.push({
          id: t[1], label: t[2] || '',
          x: attrs.x ? parseFloat(attrs.x) : 0, y: attrs.y ? parseFloat(attrs.y) : 0,
          color: attrs.color || '', shape: attrs.shape || ''
        });
      } else if (t[0] === 'edge' && t[1] && t[2]) {
        // 標籤是第 4 個 token，但只在它不是 key=value 的時候算——沒有標籤時
        // edge 後面可能直接接 style=... 這種屬性。
        let label = '', rest = t.slice(3);
        if (rest.length && rest[0].indexOf('=') < 0) { label = rest[0]; rest = rest.slice(1); }
        edges.push({ from: t[1], to: t[2], label: label });
      }
    });
    return { nodes: nodes, edges: edges };
  }

  function serialize(model) {
    const lines = [];
    model.nodes.forEach(function (n) {
      let l = 'node ' + n.id + ' ' + quote(n.label) + ' x=' + Math.round(n.x) + ' y=' + Math.round(n.y);
      if (n.color) l += ' color=' + n.color;
      if (n.shape) l += ' shape=' + n.shape;
      lines.push(l);
    });
    model.edges.forEach(function (e) {
      let l = 'edge ' + e.from + ' ' + e.to;
      if (e.label) l += ' ' + quote(e.label);
      lines.push(l);
    });
    return lines.join('\n');
  }

  // ---------------- 版面：文字寬度用字元分類估，跟心智圖同一招，不量真的 DOM --
  function charW(code) {
    // 粗略區分全形（CJK 等）跟半形字元的視覺寬度，14px 字級下的估計值。
    if (code >= 0x1100 && (code <= 0x115F || (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF00 && code <= 0xFF60) || (code >= 0x3000 && code <= 0x303F))) return 15;
    return 7.6;
  }
  function textWidth(s) {
    let w = 0;
    for (const ch of String(s || '')) w += charW(ch.codePointAt(0));
    return w;
  }
  const NODE_H = 40, NODE_PAD_X = 16;
  function nodeSize(n) { return { w: Math.max(64, textWidth(n.label) + NODE_PAD_X * 2), h: NODE_H }; }

  function sizedNodes(model) {
    return model.nodes.map(function (n) {
      const s = nodeSize(n);
      return { id: n.id, label: n.label, x: n.x, y: n.y, w: s.w, h: s.h, color: n.color, shape: n.shape };
    });
  }
  function bbox(nodes) {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // 從節點中心朝目標點的射線跟節點方框邊界的交點——連線因此停在方框邊上，
  // 不會穿過標籤文字。
  function clipToBox(n, tx, ty) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const hw = n.w / 2, hh = n.h / 2;
    const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------- SVG：唯讀渲染（預覽／PDF／電子書都呼叫這個）----------------
  // 節點的底色跟文字色一律用 CSS class（.rm-node.rm-<color>），不是 inline
  // style——這樣 pdf.js 才能像心智圖一樣，用自己的列印樣式表覆寫同一批 class。
  function nodeSVG(n, ox, oy, idx, selected) {
    const cls = 'rm-node' + (n.color ? ' rm-' + n.color : '') + (selected ? ' rm-sel' : '');
    const x = n.x + ox, y = n.y + oy;
    return '<g class="' + cls + '" data-i="' + idx + '">' +
      '<rect x="' + x + '" y="' + y + '" width="' + n.w + '" height="' + n.h + '"></rect>' +
      '<text x="' + (x + n.w / 2) + '" y="' + (y + n.h / 2) + '" text-anchor="middle" dominant-baseline="central">' +
      esc(n.label || '（未命名）') + '</text></g>';
  }
  function edgeSVG(a, b, label, ox, oy, idx, selected) {
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = clipToBox(a, cb.x, cb.y), p2 = clipToBox(b, ca.x, ca.y);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    let s = '<g class="rm-edge' + (selected ? ' rm-sel' : '') + '" data-i="' + idx + '">' +
      '<line x1="' + (p1.x + ox) + '" y1="' + (p1.y + oy) + '" x2="' + (p2.x + ox) + '" y2="' + (p2.y + oy) +
      '" marker-end="url(#rm-arrow)"></line>';
    if (label) {
      s += '<rect class="rm-edge-lbg" x="' + (mx + ox - textWidth(label) / 2 - 5) + '" y="' + (my + oy - 9) +
        '" width="' + (textWidth(label) + 10) + '" height="18"></rect>' +
        '<text class="rm-edge-lbl" x="' + (mx + ox) + '" y="' + (my + oy) +
        '" text-anchor="middle" dominant-baseline="central">' + esc(label) + '</text>';
    }
    return s + '</g>';
  }

  function renderSVG(text, sel) {
    const model = parse(text);
    if (!model.nodes.length) return '';
    const nodes = sizedNodes(model);
    const byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    const box = bbox(nodes);
    const PAD = 24;
    const ox = PAD - box.minX, oy = PAD - box.minY;
    const W = Math.max(1, box.maxX - box.minX) + PAD * 2, H = Math.max(1, box.maxY - box.minY) + PAD * 2;
    let edgesSVG = '';
    model.edges.forEach(function (e, i) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      edgesSVG += edgeSVG(a, b, e.label, ox, oy, i, sel && sel.type === 'edge' && sel.i === i);
    });
    const nodesSVG = nodes.map(function (n, i) {
      return nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
    }).join('');
    return '<svg class="relmap-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<defs><marker id="rm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
      '<path d="M0,0L10,5L0,10z" class="rm-arrowhead"></path></marker></defs>' +
      edgesSVG + nodesSVG + '</svg>';
  }

  // ---------------- 筆記種類（meta.relMap）------------------------------------
  function isRelNote(note) { return !!(note && note.meta && note.meta.relMap); }
  const TEMPLATE = 'node n1 "起點" x=40 y=80\nnode n2 "目標" x=320 y=80\nedge n1 n2 "利用"';
  function generate() { return '```relmap\n' + TEMPLATE + '\n```\n'; }

  // ---------------- 編輯器：全螢幕疊層，跟 MindMap.open 同一種殼 --------------
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'];
  let uidSeq = 0;
  function newId() { return 'n' + (Date.now().toString(36)) + (uidSeq++); }

  function open(text, onSave) {
    if (typeof document === 'undefined') return null;
    let model = parse(text);
    let zoom = 1, panX = 40, panY = 40;
    let sel = null;   // { type: 'node'|'edge', i }
    const undo = [], redo = [];

    const overlay = document.createElement('div');
    overlay.className = 'mm-overlay rm-overlay';
    overlay.innerHTML =
      '<div class="mm-editor rm-editor" role="dialog" aria-label="關聯分析編輯器">' +
      '<header class="mm-bar">' +
      '<span class="mm-bar-t">關聯分析</span>' +
      '<span class="mm-bar-hint">拖曳節點移動位置 · 拖右側的圓點連到另一個節點 · 雙擊空白處新增節點 · Delete 刪除選取 · F2／雙擊改文字</span>' +
      '<span class="mm-bar-sp"></span>' +
      '<button class="btn btn-ghost rm-add" type="button" title="新增節點">＋ 節點</button>' +
      '<button class="btn btn-ghost mm-zo" type="button" title="縮小">−</button>' +
      '<button class="btn btn-ghost mm-zr" type="button" title="實際大小">100%</button>' +
      '<button class="btn btn-ghost mm-zi" type="button" title="放大">＋</button>' +
      '<button class="btn mm-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary mm-save" type="button">完成</button>' +
      '</header>' +
      '<div class="mm-canvas rm-canvas" tabindex="0"><div class="mm-stage rm-stage"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    const canvas = overlay.querySelector('.rm-canvas');
    const stage = overlay.querySelector('.rm-stage');
    let input = null;

    function snapshot() {
      undo.push(serialize(model));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    function nodesSized() { return sizedNodes(model); }
    function byId(id) { return model.nodes.find(function (n) { return n.id === id; }); }

    function draw() {
      closeInput();
      const sized = nodesSized();
      const byIdS = {}; sized.forEach(function (n) { byIdS[n.id] = n; });
      const box = bbox(sized);
      const PAD = 60;
      stage.dataset.ox = PAD - box.minX; stage.dataset.oy = PAD - box.minY;
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const W = Math.max(canvas.clientWidth / zoom, box.maxX - box.minX + PAD * 2);
      const H = Math.max(canvas.clientHeight / zoom, box.maxY - box.minY + PAD * 2);
      let edgesSVG = '';
      model.edges.forEach(function (e, i) {
        const a = byIdS[e.from], b = byIdS[e.to];
        if (!a || !b) return;
        edgesSVG += edgeSVG(a, b, e.label, ox, oy, i, sel && sel.type === 'edge' && sel.i === i);
      });
      const nodesSVG = sized.map(function (n, i) {
        const s = nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
        // 編輯器多一顆連線用的把手，貼在節點右緣中點
        const cx = n.x + ox + n.w, cy = n.y + oy + n.h / 2;
        return s + '<circle class="rm-handle" data-i="' + i + '" cx="' + cx + '" cy="' + cy + '" r="6"></circle>';
      }).join('');
      stage.innerHTML = '<svg class="relmap-svg" width="' + W + '" height="' + H + '">' +
        '<defs><marker id="rm-arrow-ed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
        '<path d="M0,0L10,5L0,10z" class="rm-arrowhead"></path></marker></defs>' +
        edgesSVG.split('url(#rm-arrow)').join('url(#rm-arrow-ed)') + nodesSVG + '</svg>';
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    }

    function toModelXY(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left - panX) / zoom - (+stage.dataset.ox || 0),
        y: (clientY - r.top - panY) / zoom - (+stage.dataset.oy || 0)
      };
    }

    // ---- 選取 / 刪除 ----
    function select(type, i) { sel = (type == null) ? null : { type: type, i: i }; draw(); }
    function deleteSelected() {
      if (!sel) return;
      snapshot();
      if (sel.type === 'node') {
        const id = model.nodes[sel.i].id;
        model.nodes.splice(sel.i, 1);
        model.edges = model.edges.filter(function (e) { return e.from !== id && e.to !== id; });
      } else {
        model.edges.splice(sel.i, 1);
      }
      sel = null;
      draw();
    }

    // ---- 新增節點 ----
    function addNodeAt(x, y) {
      snapshot();
      const n = { id: newId(), label: '新節點', x: x - 32, y: y - 20, color: '', shape: '' };
      model.nodes.push(n);
      draw();
      select('node', model.nodes.length - 1);
      openInput(model.nodes.length - 1, true);
    }

    // ---- 拖曳：移動節點 / 平移畫布 / 拉線連接 ----
    function onCanvasDown(e) {
      const handle = e.target.closest && e.target.closest('.rm-handle');
      const nodeEl = e.target.closest && e.target.closest('.rm-node');
      const edgeEl = e.target.closest && e.target.closest('.rm-edge');
      if (handle) { startConnect(e, +handle.getAttribute('data-i')); return; }
      if (nodeEl) { startMoveNode(e, +nodeEl.getAttribute('data-i')); return; }
      if (edgeEl) { select('edge', +edgeEl.getAttribute('data-i')); return; }
      select(null);
      startPan(e);
    }
    function startMoveNode(e, i) {
      e.preventDefault();
      select('node', i);
      const n = model.nodes[i];
      snapshot();
      const sx = e.clientX, sy = e.clientY, ox0 = n.x, oy0 = n.y;
      let moved = false;
      function move(ev) {
        const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        n.x = ox0 + dx; n.y = oy0 + dy;
        draw();
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!moved) { undo.pop(); }   // 只是點一下，不算真的移動，不留 undo 記錄
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    function startPan(e) {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, px0 = panX, py0 = panY;
      function move(ev) { panX = px0 + (ev.clientX - sx); panY = py0 + (ev.clientY - sy); stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'; }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    function startConnect(e, fromIdx) {
      e.preventDefault(); e.stopPropagation();
      const fromNode = model.nodes[fromIdx];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'rm-rubberband');
      const svg = stage.querySelector('svg');
      svg.appendChild(line);
      function place(clientX, clientY) {
        const p = toModelXY(clientX, clientY);
        const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
        const a = clipToBox(nodeSize2(fromNode), p.x, p.y);
        line.setAttribute('x1', a.x + fromNode.x + ox);
        line.setAttribute('y1', a.y + fromNode.y + oy);
        line.setAttribute('x2', p.x + ox);
        line.setAttribute('y2', p.y + oy);
      }
      function nodeSize2(n) { const s = nodeSize(n); return { x: n.x, y: n.y, w: s.w, h: s.h }; }
      place(e.clientX, e.clientY);
      function move(ev) { place(ev.clientX, ev.clientY); }
      function up(ev) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        line.remove();
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetNodeEl = target && target.closest && target.closest('.rm-node');
        if (targetNodeEl) {
          const toIdx = +targetNodeEl.getAttribute('data-i');
          const toNode = model.nodes[toIdx];
          if (toNode && toNode.id !== fromNode.id) {
            snapshot();
            model.edges.push({ from: fromNode.id, to: toNode.id, label: '' });
            select('edge', model.edges.length - 1);
          }
        }
        draw();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    canvas.addEventListener('mousedown', onCanvasDown);
    canvas.addEventListener('dblclick', function (e) {
      const nodeEl = e.target.closest && e.target.closest('.rm-node');
      const edgeEl = e.target.closest && e.target.closest('.rm-edge');
      if (nodeEl) { const i = +nodeEl.getAttribute('data-i'); select('node', i); openInput(i, true); return; }
      if (edgeEl) { const i = +edgeEl.getAttribute('data-i'); select('edge', i); openEdgeInput(i); return; }
      const p = toModelXY(e.clientX, e.clientY);
      addNodeAt(p.x, p.y);
    });

    // ---- 就地改文字（節點）----
    function openInput(i, selectAll) {
      closeInput();
      const n = model.nodes[i];
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const s = nodeSize(n);
      input = document.createElement('input');
      input.className = 'rm-input';
      input.value = n.label;
      overlay.querySelector('.rm-editor').appendChild(input);
      placeInputAt(n.x + ox, n.y + oy, s.w, s.h);
      input.focus();
      if (selectAll) input.select();
      function commit() {
        const v = input.value;
        closeInput();
        if (v !== n.label) { snapshot(); n.label = v; draw(); }
      }
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeInput(); draw(); }
      });
      input.addEventListener('blur', commit);
    }
    // ---- 就地改文字（連線標籤）----
    function openEdgeInput(i) {
      closeInput();
      const e = model.edges[i];
      const a = byId(e.from), b = byId(e.to);
      if (!a || !b) return;
      const sa = nodeSize(a), sb = nodeSize(b);
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const ca = { x: a.x + sa.w / 2 + ox, y: a.y + sa.h / 2 + oy };
      const cb = { x: b.x + sb.w / 2 + ox, y: b.y + sb.h / 2 + oy };
      const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
      input = document.createElement('input');
      input.className = 'rm-input rm-input-edge';
      input.placeholder = '連線文字…';
      input.value = e.label || '';
      overlay.querySelector('.rm-editor').appendChild(input);
      placeInputAt(mx - 70, my - 12, 140, 24);
      input.focus();
      input.select();
      function commit() {
        const v = input.value;
        closeInput();
        if (v !== e.label) { snapshot(); e.label = v; draw(); }
      }
      input.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeInput(); }
      });
      input.addEventListener('blur', commit);
    }
    function placeInputAt(x, y, w, h) {
      const r = canvas.getBoundingClientRect();
      input.style.left = (r.left + x * zoom + panX) + 'px';
      input.style.top = (r.top + y * zoom + panY) + 'px';
      input.style.width = (w * zoom) + 'px';
      input.style.height = (h * zoom) + 'px';
      input.style.fontSize = Math.max(11, 14 * zoom) + 'px';
    }
    function closeInput() { if (input) { input.remove(); input = null; } }

    // ---- 顏色（選取節點時的小選單，掛在工具列旁）----
    function colorMenu() {
      if (!sel || sel.type !== 'node') return;
      closeColorMenu();
      const n = model.nodes[sel.i];
      const pop = document.createElement('div');
      pop.className = 'rm-colors';
      COLORS.forEach(function (c) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rm-swatch' + (c ? ' rm-' + c : ' rm-none') + (n.color === c ? ' on' : '');
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () { snapshot(); n.color = c; draw(); closeColorMenu(); });
        pop.appendChild(b);
      });
      overlay.querySelector('.rm-editor').appendChild(pop);
      const nodeEl = stage.querySelector('.rm-node[data-i="' + sel.i + '"] rect');
      const r = nodeEl.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
      setTimeout(function () { document.addEventListener('mousedown', onColorOutside, true); }, 0);
    }
    function onColorOutside(e) { if (!e.target.closest('.rm-colors')) closeColorMenu(); }
    function closeColorMenu() {
      const p = overlay.querySelector('.rm-colors');
      if (p) p.remove();
      document.removeEventListener('mousedown', onColorOutside, true);
    }

    // ---- 鍵盤 ----
    function onKey(e) {
      if (input) return;   // 就地編輯中，交給那個 input 自己的 keydown
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSelected(); return; }
      if (e.key === 'F2' && sel && sel.type === 'node') { e.preventDefault(); openInput(sel.i, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) { if (redo.length) { undo.push(serialize(model)); model = parse(redo.pop()); sel = null; draw(); } }
        else if (undo.length) { redo.push(serialize(model)); model = parse(undo.pop()); sel = null; draw(); }
      }
    }
    overlay.addEventListener('keydown', onKey);

    // ---- 工具列 ----
    overlay.querySelector('.rm-add').addEventListener('click', function () {
      const r = canvas.getBoundingClientRect();
      const p = toModelXY(r.left + canvas.clientWidth / 2, r.top + canvas.clientHeight / 2);
      addNodeAt(p.x, p.y);
    });
    overlay.querySelector('.mm-zi').addEventListener('click', function () { zoom = Math.min(2.5, zoom + 0.15); draw(); });
    overlay.querySelector('.mm-zo').addEventListener('click', function () { zoom = Math.max(0.3, zoom - 0.15); draw(); });
    overlay.querySelector('.mm-zr').addEventListener('click', function () { zoom = 1; draw(); });

    function close() { overlay.remove(); }
    function cancel() { close(); }
    function save() { close(); if (onSave) onSave(serialize(model)); }
    overlay.querySelector('.mm-cancel').addEventListener('click', cancel);
    overlay.querySelector('.mm-save').addEventListener('click', save);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) cancel(); });

    draw();
    canvas.focus();
    return { close: close, save: save };
  }

  global.RelMap = {
    parse: parse,
    serialize: serialize,
    renderSVG: renderSVG,
    open: open,
    isRelNote: isRelNote,
    generate: generate
  };
})(window);
