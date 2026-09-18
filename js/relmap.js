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
 * 畫面照著使用者給的參考圖做（深色畫布上的關聯網）：節點是白色圓盤＋彩色圓環，
 * 盤裡是標籤的第一個字當作「圖示」（參考圖裡那是各網站的 favicon，這裡沒有圖片，
 * 拿標籤首字最貼近、也最看得出是哪一顆），完整標籤放在圓盤下方；連線是彎的虛線，
 * 顏色以橘棕為主、零星幾條藍紅紫青，全由 id 雜湊決定所以每次畫都一樣。畫布不分
 * 主題一律深色——跟程式碼區塊、Markdown 編輯器一樣是「畫布類」表面；列印時由
 * pdf.js 用自己的樣式表換成白底（所有顏色都走 class，沒有 inline，pdf.js 才蓋得掉）。
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
    // 粗略區分全形（CJK 等）跟半形字元的視覺寬度，12px 字級下的估計值。
    if (code >= 0x1100 && (code <= 0x115F || (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF00 && code <= 0xFF60) || (code >= 0x3000 && code <= 0x303F))) return 13;
    return 6.8;
  }
  function textWidth(s) {
    let w = 0;
    for (const ch of String(s || '')) w += charW(ch.codePointAt(0));
    return w;
  }
  // 節點 = 半徑 R 的圓盤 + 下方一行標籤。x,y 是整個節點（圓盤＋標籤）外框的左上角，
  // 圓盤置中在外框寬度上；外框寬度取圓盤跟標籤文字較寬者。
  const R = 20, LABEL_H = 22;
  function nodeSize(n) { return { w: Math.max(R * 2 + 8, textWidth(n.label) + 8), h: R * 2 + LABEL_H }; }
  function center(n) { return { x: n.x + n.w / 2, y: n.y + R }; }

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

  // 顏色、彎曲方向都由 id 雜湊決定：同一張圖每次畫都一樣，不會跳動。
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  const AUTO_COLORS = 8;   // .rm-auto-0 … .rm-auto-7（app.css / pdf.js）
  const EDGE_COLORS = 9;   // .rm-e0 … .rm-e8，橘棕佔多數
  function nodeColorClass(n) { return n.color ? 'rm-' + n.color : 'rm-auto-' + (hash(n.id) % AUTO_COLORS); }
  function edgeColorClass(e) { return 'rm-e' + (hash(e.from + '|' + e.to) % EDGE_COLORS); }

  // 連線的幾何：兩端停在圓盤邊緣（留 3px 給箭頭），中間是二次貝茲曲線，控制點
  // 從連線中點往垂直方向偏，偏移量隨線長縮放、方向照雜湊奇偶決定，整張圖的線才
  // 會有的往左彎有的往右彎。mid 是曲線 t=0.5 的點，標籤跟就地編輯框都放那裡。
  function edgeGeometry(a, b, seed) {
    const ca = center(a), cb = center(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / len, uy = dy / len;
    const bend = (seed % 2 === 0 ? 1 : -1) * Math.min(len * 0.18, 60);
    const c = { x: (ca.x + cb.x) / 2 - uy * bend, y: (ca.y + cb.y) / 2 + ux * bend };
    // 起終點：從圓心朝控制點方向走 R，這樣曲線離開圓盤的方向才跟弧線一致
    function edgePoint(cen, toward) {
      const vx = toward.x - cen.x, vy = toward.y - cen.y;
      const l = Math.max(1, Math.sqrt(vx * vx + vy * vy));
      return { x: cen.x + vx / l * (R + 3), y: cen.y + vy / l * (R + 3) };
    }
    const p1 = edgePoint(ca, c), p2 = edgePoint(cb, c);
    const mid = { x: 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y };
    return { p1: p1, p2: p2, c: c, mid: mid };
  }
  function pathD(g, ox, oy) {
    return 'M' + (g.p1.x + ox) + ',' + (g.p1.y + oy) + ' Q' + (g.c.x + ox) + ',' + (g.c.y + oy) +
      ' ' + (g.p2.x + ox) + ',' + (g.p2.y + oy);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // 圓盤裡的「圖示」：標籤第一個字（英文字母轉大寫）。
  function monogram(label) {
    const first = Array.from(String(label || '').trim())[0];
    return first ? first.toUpperCase() : '·';
  }

  // ---------------- SVG：唯讀渲染（預覽／PDF／電子書都呼叫這個）----------------
  // 所有顏色一律走 CSS class（.rm-node.rm-<color>／.rm-auto-k、.rm-edge.rm-e<k>），不是
  // inline style——pdf.js 才能像心智圖一樣，用自己的列印樣式表覆寫同一批 class。
  function nodeSVG(n, ox, oy, idx, selected) {
    const cls = 'rm-node ' + nodeColorClass(n) + (selected ? ' rm-sel' : '');
    const c = center(n);
    const cx = c.x + ox, cy = c.y + oy;
    return '<g class="' + cls + '" data-i="' + idx + '">' +
      '<circle class="rm-disc" cx="' + cx + '" cy="' + cy + '" r="' + R + '"></circle>' +
      '<text class="rm-mono" x="' + cx + '" y="' + (cy + 1) + '" text-anchor="middle" dominant-baseline="central">' +
      esc(monogram(n.label)) + '</text>' +
      '<text class="rm-lbl" x="' + cx + '" y="' + (cy + R + 15) + '" text-anchor="middle">' +
      esc(n.label || '（未命名）') + '</text></g>';
  }
  function edgeSVG(a, b, e, ox, oy, idx, selected, markerId) {
    const g = edgeGeometry(a, b, hash(e.from + '|' + e.to));
    let s = '<g class="rm-edge ' + edgeColorClass(e) + (selected ? ' rm-sel' : '') + '" data-i="' + idx + '">' +
      // 粗一點的透明底線：讓細虛線也好點選
      '<path class="rm-hit" d="' + pathD(g, ox, oy) + '"></path>' +
      '<path class="rm-line" d="' + pathD(g, ox, oy) + '" marker-end="url(#' + markerId + ')"></path>';
    if (e.label) {
      const tw = textWidth(e.label);
      s += '<rect class="rm-edge-lbg" x="' + (g.mid.x + ox - tw / 2 - 6) + '" y="' + (g.mid.y + oy - 9) +
        '" width="' + (tw + 12) + '" height="18" rx="9"></rect>' +
        '<text class="rm-edge-lbl" x="' + (g.mid.x + ox) + '" y="' + (g.mid.y + oy) +
        '" text-anchor="middle" dominant-baseline="central">' + esc(e.label) + '</text>';
    }
    return s + '</g>';
  }
  function markerDef(id) {
    return '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0L10,5L0,10z" class="rm-arrowhead"></path></marker></defs>';
  }

  function renderSVG(text, sel) {
    const model = parse(text);
    if (!model.nodes.length) return '';
    const nodes = sizedNodes(model);
    const byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    const box = bbox(nodes);
    const PAD = 28;
    const ox = PAD - box.minX, oy = PAD - box.minY;
    const W = Math.max(1, box.maxX - box.minX) + PAD * 2, H = Math.max(1, box.maxY - box.minY) + PAD * 2;
    let edgesSVG = '';
    model.edges.forEach(function (e, i) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      edgesSVG += edgeSVG(a, b, e, ox, oy, i, sel && sel.type === 'edge' && sel.i === i, 'rm-arrow');
    });
    const nodesSVG = nodes.map(function (n, i) {
      return nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
    }).join('');
    return '<svg class="relmap-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      markerDef('rm-arrow') + edgesSVG + nodesSVG + '</svg>';
  }

  // ---------------- 筆記種類（meta.relMap）------------------------------------
  function isRelNote(note) { return !!(note && note.meta && note.meta.relMap); }
  const TEMPLATE = 'node n1 "起點" x=40 y=80\nnode n2 "目標" x=320 y=80\nedge n1 n2 "利用"';
  function generate() { return '```relmap\n' + TEMPLATE + '\n```\n'; }

  // ---------------- 編輯器：全螢幕疊層，跟 MindMap.open 同一種殼 --------------
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'];
  let uidSeq = 0;
  function newId() { return 'n' + (Date.now().toString(36)) + (uidSeq++); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

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
      '<span class="mm-bar-hint">拖曳節點移動 · 拖節點右側的圓點連到另一個節點 · 雙擊空白處新增節點 · 雙擊改文字 · Delete 刪除 · 滾輪縮放</span>' +
      '<span class="mm-bar-sp"></span>' +
      '<button class="btn btn-ghost rm-add" type="button" title="新增節點">' + ic('plus') + ' 節點</button>' +
      '<button class="btn btn-ghost rm-color" type="button" title="選取一個節點後可以換它的顏色" disabled>' + ic('grid') + ' 顏色</button>' +
      '<button class="btn mm-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary mm-save" type="button">完成</button>' +
      '</header>' +
      '<div class="mm-canvas rm-canvas" tabindex="0">' +
      '<div class="mm-stage rm-stage"></div>' +
      // 浮在畫布上的縮放群組（左上）跟重置鈕（右下），跟 graph.js 的關聯圖同一套
      '<div class="rm-zoom-ctrl rm-ctrl">' +
      '<button class="rm-ctrl-btn rm-zo" type="button" title="縮小">' + ic('minus') + '</button>' +
      '<button class="rm-ctrl-btn rm-zi" type="button" title="放大">' + ic('plus') + '</button>' +
      '<button class="rm-ctrl-btn rm-zfit" type="button" title="縮放到剛好看見整張圖">' + ic('maximize') + '</button>' +
      '</div>' +
      '<button class="rm-reset-btn rm-ctrl" type="button" title="回到 100%、原始位置">重置視圖</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const canvas = overlay.querySelector('.rm-canvas');
    const stage = overlay.querySelector('.rm-stage');
    const colorBtn = overlay.querySelector('.rm-color');
    let input = null;

    function snapshot() {
      undo.push(serialize(model));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    function nodesSized() { return sizedNodes(model); }
    function byId(id) { return model.nodes.find(function (n) { return n.id === id; }); }
    function sizedOf(n) { const s = nodeSize(n); return { id: n.id, label: n.label, x: n.x, y: n.y, w: s.w, h: s.h }; }

    function applyTransform() {
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    }
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
        edgesSVG += edgeSVG(a, b, e, ox, oy, i, sel && sel.type === 'edge' && sel.i === i, 'rm-arrow-ed');
      });
      const nodesSVG = sized.map(function (n, i) {
        const s = nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
        // 編輯器多一顆連線用的把手，貼在圓盤右側
        const c = center(n);
        return s + '<circle class="rm-handle" data-i="' + i + '" cx="' + (c.x + ox + R + 9) + '" cy="' + (c.y + oy) + '" r="6"></circle>';
      }).join('');
      stage.innerHTML = '<svg class="relmap-svg" width="' + W + '" height="' + H + '">' +
        markerDef('rm-arrow-ed') + edgesSVG + nodesSVG + '</svg>';
      applyTransform();
      colorBtn.disabled = !(sel && sel.type === 'node');
    }

    function toModelXY(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left - panX) / zoom - (+stage.dataset.ox || 0),
        y: (clientY - r.top - panY) / zoom - (+stage.dataset.oy || 0)
      };
    }

    // ---- 縮放／視圖 ----
    // 以畫布上某一點為錨縮放：那一點在畫面上不動，跟滾輪縮放的手感一致。
    function zoomAt(nz, ax, ay) {
      nz = Math.max(0.3, Math.min(2.5, nz));
      panX = ax - (ax - panX) * (nz / zoom);
      panY = ay - (ay - panY) * (nz / zoom);
      zoom = nz;
      draw();
    }
    function zoomStep(f) { zoomAt(zoom * f, canvas.clientWidth / 2, canvas.clientHeight / 2); }
    // 縮放到剛好看見整張圖：對的是內容的外框（含邊距），不是 draw() 撐到畫布大的 SVG。
    function fitView() {
      const sized = nodesSized();
      if (!sized.length) return;
      const box = bbox(sized);
      const PAD = 60;
      const W = box.maxX - box.minX + PAD * 2, H = box.maxY - box.minY + PAD * 2;
      zoom = Math.max(0.3, Math.min(2.5, Math.min(canvas.clientWidth / W, canvas.clientHeight / H)));
      panX = (canvas.clientWidth - W * zoom) / 2;
      panY = (canvas.clientHeight - H * zoom) / 2;
      draw();
    }
    // 重置視圖只動鏡頭（100%、回到原點），不動節點——位置是使用者自己排的。
    function resetView() { zoom = 1; panX = 40; panY = 40; draw(); }
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

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
      const n = { id: newId(), label: '新節點', x: x - R, y: y - R, color: '', shape: '' };
      model.nodes.push(n);
      draw();
      select('node', model.nodes.length - 1);
      openInput(model.nodes.length - 1, true);
    }

    // ---- 拖曳：移動節點 / 平移畫布 / 拉線連接 ----
    function onCanvasDown(e) {
      if (e.target.closest && e.target.closest('.rm-ctrl')) return;   // 浮動控制鈕自己處理
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
      canvas.classList.add('mm-dragging');
      function move(ev) { panX = px0 + (ev.clientX - sx); panY = py0 + (ev.clientY - sy); applyTransform(); }
      function up() { canvas.classList.remove('mm-dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
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
        const c = center(sizedOf(fromNode));
        const vx = p.x - c.x, vy = p.y - c.y;
        const l = Math.max(1, Math.sqrt(vx * vx + vy * vy));
        line.setAttribute('x1', c.x + vx / l * R + ox);
        line.setAttribute('y1', c.y + vy / l * R + oy);
        line.setAttribute('x2', p.x + ox);
        line.setAttribute('y2', p.y + oy);
      }
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
      if (e.target.closest && e.target.closest('.rm-ctrl')) return;
      const nodeEl = e.target.closest && e.target.closest('.rm-node');
      const edgeEl = e.target.closest && e.target.closest('.rm-edge');
      if (nodeEl) { const i = +nodeEl.getAttribute('data-i'); select('node', i); openInput(i, true); return; }
      if (edgeEl) { const i = +edgeEl.getAttribute('data-i'); select('edge', i); openEdgeInput(i); return; }
      const p = toModelXY(e.clientX, e.clientY);
      addNodeAt(p.x, p.y);
    });

    // ---- 就地改文字（節點）：輸入框蓋在圓盤下方的標籤上 ----
    function openInput(i, selectAll) {
      closeInput();
      const n = model.nodes[i];
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const s = sizedOf(n), c = center(s);
      input = document.createElement('input');
      input.className = 'rm-input';
      input.value = n.label;
      overlay.querySelector('.rm-editor').appendChild(input);
      const w = Math.max(120, s.w + 24);
      placeInputAt(c.x + ox - w / 2, c.y + oy + R + 3, w, 24);
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
    // ---- 就地改文字（連線標籤）：放在曲線中點 ----
    function openEdgeInput(i) {
      closeInput();
      const e = model.edges[i];
      const a = byId(e.from), b = byId(e.to);
      if (!a || !b) return;
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const g = edgeGeometry(sizedOf(a), sizedOf(b), hash(e.from + '|' + e.to));
      input = document.createElement('input');
      input.className = 'rm-input rm-input-edge';
      input.placeholder = '連線文字…';
      input.value = e.label || '';
      overlay.querySelector('.rm-editor').appendChild(input);
      placeInputAt(g.mid.x + ox - 70, g.mid.y + oy - 12, 140, 24);
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
      input.style.fontSize = Math.max(11, 13 * zoom) + 'px';
    }
    function closeInput() { if (input) { input.remove(); input = null; } }

    // ---- 顏色（選取節點後按工具列的「顏色」，圓形色板出現在圓盤下方）----
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
        b.title = c || '自動';
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () { snapshot(); n.color = c; draw(); closeColorMenu(); });
        pop.appendChild(b);
      });
      overlay.querySelector('.rm-editor').appendChild(pop);
      const disc = stage.querySelector('.rm-node[data-i="' + sel.i + '"] .rm-disc');
      const r = disc ? disc.getBoundingClientRect() : colorBtn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 74, window.innerWidth - 160)) + 'px';
      pop.style.top = (r.bottom + 26) + 'px';
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

    // ---- 工具列 / 浮動控制 ----
    overlay.querySelector('.rm-add').addEventListener('click', function () {
      const r = canvas.getBoundingClientRect();
      const p = toModelXY(r.left + canvas.clientWidth / 2, r.top + canvas.clientHeight / 2);
      addNodeAt(p.x, p.y);
    });
    colorBtn.addEventListener('click', colorMenu);
    overlay.querySelector('.rm-zi').addEventListener('click', function () { zoomStep(1.25); });
    overlay.querySelector('.rm-zo').addEventListener('click', function () { zoomStep(1 / 1.25); });
    overlay.querySelector('.rm-zfit').addEventListener('click', fitView);
    overlay.querySelector('.rm-reset-btn').addEventListener('click', resetView);

    function close() { closeColorMenu(); overlay.remove(); }
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
