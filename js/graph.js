/* graph.js — Obsidian 風格的關聯圖：把 [[wikilink]] 反向連結跟 #hashtag 畫成一張
 * 可拖曳、可縮放的力導向網絡圖。筆記本身跟標籤都是節點，連結是邊——這是
 * 唯一呈現「反向連結」跟「標籤」關聯的地方，故意不放進首頁儀表板。
 *
 * 資料來源：呼叫端（app.js）傳整份 state.notes（每筆已經帶 content），這裡用
 * MD.extractLinks / MD.extractTags 從內文重新抽取一次，跟編輯器裡 [[title]]
 * 真正解析出來的連結、跟儀表板標籤篩選用的是同一套規則（normTitle 大小寫、
 * 前後空白不分）。開圖時只算一次——這是瀏覽用的快照，筆記內容變動不會即時
 * 反映，要看最新關聯圖就重新打開。
 *
 *   Graph.open(notes, { onOpenNote(note), onOpenTag(tag) })
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function normTitle(t) { return String(t || '').trim().toLowerCase(); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 節點／連線的顏色、彎曲方向都是「看資料算出來的固定值」，不是隨機——同一張圖
  // 重畫（切換顯示標籤、視窗大小改變）顏色跟彎法要一樣，不能每次都跳動。用 id
  // 算一個穩定的雜湊當種子。
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  const NODE_COLORS = ['#e0c674', '#6fa8dc', '#e08a52', '#5fb88a', '#d97a9c', '#9a86d6', '#5cc2c2', '#d66a6a'];
  // 邊的配色刻意偏重橘棕：參考圖裡絕大多數的線是橘棕色虛線，只有少數幾條是藍／紅／
  // 紫／青的重點線——調色盤裡橘棕多放幾份，雜湊出來的分布才會是「一片暖色底、
  // 零星幾條彩色」，不是每種顏色平均分配的彩虹。
  const EDGE_COLORS = ['#c9822a', '#c9822a', '#c9822a', '#b8702a', '#a86a2c', '#4f8fd6', '#d65f6b', '#8e6fd6', '#4fb0a8'];
  function nodeColor(n) { return n.kind === 'tag' ? null : NODE_COLORS[hash(n.id) % NODE_COLORS.length]; }
  function edgeColor(e) { return EDGE_COLORS[hash(e.a + '|' + e.b) % EDGE_COLORS.length]; }

  // 節點裡的小圖示：參考圖的節點是「白色圓底、彩色圓環、中間一個小 icon」（那邊是
  // 網站的 favicon），這裡沒有 favicon，就用 icons.js 現成的線條圖示——筆記是
  // file-text、標籤是 hash。Icons.el() 給的是一個完整的 <svg>，但 .ic-svg 的全站
  // CSS 會把它的寬高鎖在 16px，所以不是把 <svg> 塞進去，而是把裡面的 <path> 搬進一個
  // 自己的 <g>，用 transform 從 24×24 的座標縮到節點需要的大小；stroke 走
  // currentColor，筆記節點在 JS 上 inline 指定 color，標籤節點交給 CSS 的 --folder。
  function iconGroup(name, size) {
    const src = (global.Icons && Icons.el) ? Icons.el(name) : null;
    const g = svgEl('g', {
      class: 'graph-node-ic', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      transform: 'translate(' + (-size / 2) + ',' + (-size / 2) + ') scale(' + (size / 24) + ')'
    });
    if (src) while (src.firstChild) g.appendChild(src.firstChild);
    return g;
  }
  // 二次貝茲曲線：控制點從邊的中點沿垂直方向偏移，偏移量隨線長縮放、方向照雜湊
  // 奇偶交替（有的往左彎有的往右彎），整張圖才會有機、不會每條線都彎同一邊。
  function curvePath(ax, ay, bx, by, seed) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const bend = (seed % 2 === 0 ? 1 : -1) * Math.min(len * 0.18, 70);
    const mx = (ax + bx) / 2 + (-dy / len) * bend;
    const my = (ay + by) / 2 + (dx / len) * bend;
    return 'M' + ax + ',' + ay + ' Q' + mx + ',' + my + ' ' + bx + ',' + by;
  }

  // ---- 從筆記內容建圖：節點 = 筆記 + 標籤，邊 = wikilink 解析結果 + 標籤歸屬 ----
  function buildGraph(notes) {
    const nodes = [];
    const byId = {};
    const byTitle = {};
    notes.forEach(function (n) {
      const node = { id: 'note:' + n.id, kind: 'note', label: n.title || '未命名筆記', note: n, deg: 0 };
      byId[node.id] = node;
      nodes.push(node);
      const k = normTitle(n.title);
      if (k && !byTitle[k]) byTitle[k] = n;
    });
    const edges = [];
    const edgeSeen = {};
    function addEdge(a, b, kind) {
      if (a === b) return;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (edgeSeen[key]) return;
      edgeSeen[key] = true;
      edges.push({ a: a, b: b, kind: kind });
      byId[a].deg++; byId[b].deg++;
    }
    notes.forEach(function (n) {
      const aId = 'note:' + n.id;
      const links = (global.MD && MD.extractLinks) ? MD.extractLinks(n.content || '') : [];
      links.forEach(function (target) {
        const hit = byTitle[normTitle(target)];
        if (hit) addEdge(aId, 'note:' + hit.id, 'link');
      });
      const tags = (global.MD && MD.extractTags) ? MD.extractTags(n.content || '') : [];
      tags.forEach(function (tag) {
        const tid = 'tag:' + tag.toLowerCase();
        if (!byId[tid]) { byId[tid] = { id: tid, kind: 'tag', label: '#' + tag, deg: 0 }; nodes.push(byId[tid]); }
        addEdge(aId, tid, 'tag');
      });
    });
    return { nodes: nodes, edges: edges };
  }

  // Vogel 螺旋：用黃金角把初始位置攤開成螺旋狀，避免完美對稱的圓形排列讓
  // 排斥力永遠互相抵銷（那樣模擬出來的圖會一直維持成一個呆板的正圓環）。
  // 係數比早期版本大：起始佈局本身就不擁擠，物理模擬穩定後也不會擠成一團。
  const GOLDEN_ANGLE = 2.399963;
  function seedPositions(nodes) {
    nodes.forEach(function (n, i) {
      if (typeof n.x === 'number') return;
      const r = 42 * Math.sqrt(i + 1);
      const a = i * GOLDEN_ANGLE;
      n.x = r * Math.cos(a);
      n.y = r * Math.sin(a);
      n.vx = 0; n.vy = 0;
    });
  }

  function open(notes, opts) {
    opts = opts || {};
    const data = buildGraph(notes || []);

    const overlay = document.createElement('div');
    overlay.className = 'graph-overlay';
    overlay.innerHTML =
      '<div class="graph-editor" role="dialog" aria-label="關聯圖">' +
      '<header class="graph-bar">' +
      '<span class="graph-bar-t">關聯圖</span>' +
      '<span class="graph-bar-hint">拖曳調整位置・滾輪縮放・點筆記開啟・點標籤篩選</span>' +
      '<label class="graph-tag-toggle"><input type="checkbox" class="graph-tags-cb" checked> 顯示標籤</label>' +
      '<span class="graph-bar-sp"></span>' +
      '<span class="graph-legend">' + (global.Icons ? Icons.svg('file-text') : '') + '筆記' + (global.Icons ? Icons.svg('hash') : '') + '標籤</span>' +
      '<button class="btn graph-close" type="button">關閉</button>' +
      '</header>' +
      '<div class="graph-canvas" tabindex="0">' +
      '<div class="graph-zoom-ctrl">' +
      '<button class="graph-ctrl-btn graph-zo" type="button" title="縮小">' + (global.Icons ? Icons.svg('minus') : '') + '</button>' +
      '<button class="graph-ctrl-btn graph-zi" type="button" title="放大">' + (global.Icons ? Icons.svg('plus') : '') + '</button>' +
      '<button class="graph-ctrl-btn graph-zfit" type="button" title="縮放置中，讓整張圖剛好塞進畫面">' + (global.Icons ? Icons.svg('maximize') : '') + '</button>' +
      '</div>' +
      '<button class="graph-reset-btn" type="button" title="還原成一開始的佈局，重新跑一次模擬">重置視圖</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('.graph-canvas');
    const closeBtn = overlay.querySelector('.graph-close');
    const zoomOutBtn = overlay.querySelector('.graph-zo');
    const zoomInBtn = overlay.querySelector('.graph-zi');
    const zoomFitBtn = overlay.querySelector('.graph-zfit');
    const resetBtn = overlay.querySelector('.graph-reset-btn');
    const tagsCb = overlay.querySelector('.graph-tags-cb');

    if (!data.nodes.length) {
      canvas.innerHTML = '<div class="graph-empty">還沒有任何筆記可以畫成關聯圖。</div>';
      function onKeyEmpty(e) { if (e.key === 'Escape') closeEmpty(); }
      function closeEmpty() { document.removeEventListener('keydown', onKeyEmpty); overlay.remove(); }
      document.addEventListener('keydown', onKeyEmpty);
      closeBtn.addEventListener('click', closeEmpty);
      overlay.querySelector('.graph-tag-toggle').hidden = true;
      overlay.querySelector('.graph-legend').hidden = true;
      return { close: closeEmpty };
    }

    const svg = svgEl('svg', { class: 'graph-svg' });
    const stage = svgEl('g', { class: 'graph-stage' });
    const edgeLayer = svgEl('g', { class: 'graph-edges' });
    const nodeLayer = svgEl('g', { class: 'graph-nodes' });
    stage.appendChild(edgeLayer);
    stage.appendChild(nodeLayer);
    svg.appendChild(stage);
    canvas.appendChild(svg);

    seedPositions(data.nodes);

    let showTags = true;
    let zoom = 1, panX = 0, panY = 0;
    let raf = null, active = true;
    let hoverId = null;

    function visibleNodes() { return showTags ? data.nodes : data.nodes.filter(function (n) { return n.kind !== 'tag'; }); }
    function visibleEdges() { return showTags ? data.edges : data.edges.filter(function (e) { return e.kind !== 'tag'; }); }

    // ---- DOM：每個節點/邊固定對應一個元素，之後每個 tick 只更新屬性 ----
    // 邊是彎的（curvePath），節點顏色跟邊顏色都是雜湊出來的固定值，只有「度數」
    // 高於平均的節點預設就顯示標籤——其餘節點的標籤還在，只是靠 CSS 的
    // .is-minor 藏著，滑過去（既有的 is-hover）就會現形，不用另外接邏輯。
    const edgeEls = {}, nodeEls = {};
    function rebuildDom() {
      edgeLayer.innerHTML = ''; nodeLayer.innerHTML = '';
      Object.keys(edgeEls).forEach(function (k) { delete edgeEls[k]; });
      Object.keys(nodeEls).forEach(function (k) { delete nodeEls[k]; });
      visibleEdges().forEach(function (e) {
        const path = svgEl('path', { class: 'graph-edge graph-edge-' + e.kind });
        path.style.stroke = edgeColor(e);
        edgeLayer.appendChild(path);
        edgeEls[e.a + '|' + e.b] = { el: path, edge: e, seed: hash(e.a + '|' + e.b) };
      });
      const vn = visibleNodes();
      const avgDeg = vn.length ? vn.reduce(function (s, n) { return s + n.deg; }, 0) / vn.length : 0;
      vn.forEach(function (n) {
        // 節點比之前大一號：白底圓盤裡要放得下一個看得出來的小圖示。
        const r = n.kind === 'tag' ? 8 : (10 + Math.min(n.deg * 1.6, 12));
        const major = n.deg > avgDeg;
        const g = svgEl('g', { class: 'graph-node graph-node-' + n.kind + (major ? '' : ' is-minor'), 'data-id': n.id });
        const c = svgEl('circle', { r: r, class: 'graph-node-dot' });
        const ring = nodeColor(n);
        if (ring) { c.style.stroke = ring; g.style.color = ring; }
        const ic = iconGroup(n.kind === 'tag' ? 'hash' : 'file-text', r * 1.15);
        const t = svgEl('text', { class: 'graph-node-label', x: 0, y: r + 14 });
        t.textContent = n.label.length > 40 ? n.label.slice(0, 39) + '…' : n.label;
        const title = svgEl('title', {});
        title.textContent = n.label;
        g.appendChild(c); g.appendChild(ic); g.appendChild(t); g.appendChild(title);
        nodeLayer.appendChild(g);
        n.r = r;
        nodeEls[n.id] = { el: g, dot: c, node: n };
        bindNodeDrag(g, n);
      });
    }
    rebuildDom();

    function neighborsOf(id) {
      const set = { };
      set[id] = true;
      visibleEdges().forEach(function (e) {
        if (e.a === id) set[e.b] = true;
        else if (e.b === id) set[e.a] = true;
      });
      return set;
    }

    function applyHover() {
      const near = hoverId ? neighborsOf(hoverId) : null;
      Object.keys(nodeEls).forEach(function (id) {
        nodeEls[id].el.classList.toggle('is-dim', !!near && !near[id]);
        nodeEls[id].el.classList.toggle('is-hover', id === hoverId);
      });
      Object.keys(edgeEls).forEach(function (k) {
        const e = edgeEls[k].edge;
        const dim = !!near && !(near[e.a] && near[e.b]);
        edgeEls[k].el.classList.toggle('is-dim', dim);
      });
    }

    // ---- 力導向模擬：排斥＋沿邊彈簧＋微弱回中，速度阻尼到穩定就停 ----
    function tick() {
      const vn = visibleNodes(), ve = visibleEdges();
      let maxV = 0;
      // 拖曳中的節點還是留在模擬裡（其他節點會照樣被它排斥／牽動），只是
      // 它自己的速度每格都清空、位置直接交給滑鼠決定，放開後才重新累積速度。
      for (let i = 0; i < vn.length; i++) {
        for (let j = i + 1; j < vn.length; j++) {
          const a = vn[i], b = vn[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const f = 4200 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      ve.forEach(function (e) {
        const a = nodeEls[e.a] && nodeEls[e.a].node, b = nodeEls[e.b] && nodeEls[e.b].node;
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const rest = e.kind === 'tag' ? 140 : 200;
        const f = (d - rest) * 0.02;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });
      vn.forEach(function (n) {
        if (n.dragging) { n.vx = 0; n.vy = 0; return; }
        n.vx += -n.x * 0.0016; n.vy += -n.y * 0.0016;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
        maxV = Math.max(maxV, Math.abs(n.vx), Math.abs(n.vy));
      });
      render();
      if (maxV > 0.05 || draggingId) { raf = requestAnimationFrame(tick); }
      else {
        active = false; raf = null;
        if (!hasAutoFit) { hasAutoFit = true; fitView(); }
      }
    }
    function kick() { if (!active) { active = true; raf = requestAnimationFrame(tick); } }

    // 縮放置中：量出目前所有節點（含半徑跟標籤大概的高度）的邊界框，算出剛好能
    // 把整張圖塞進畫布的縮放與位移。模擬第一次穩定下來時自動呼叫一次——不然
    // 一開始一大片空白畫布中間擠一小球，看起來像沒東西可看；使用者拖亂／
    // 縮亂之後也可以按「置中」鈕手動再呼叫一次，抓的是當下位置，不是初始佈局。
    function fitView() {
      const vn = visibleNodes();
      if (!vn.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      vn.forEach(function (n) {
        const pad = (n.r || 8) + 44; // 給標籤跟節點本身留邊
        minX = Math.min(minX, n.x - pad); maxX = Math.max(maxX, n.x + pad);
        minY = Math.min(minY, n.y - pad); maxY = Math.max(maxY, n.y + pad);
      });
      const w = Math.max(maxX - minX, 60), h = Math.max(maxY - minY, 60);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      zoom = clamp(Math.min(rect.width / w, rect.height / h), 0.15, 2.5);
      panX = -((minX + maxX) / 2) * zoom;
      panY = -((minY + maxY) / 2) * zoom;
      render();
    }
    let hasAutoFit = false;

    // 重置視圖跟「置中」不一樣：置中只是重新對焦當下的位置；這裡連位置本身都
    // 丟掉，回到一開始的螺旋佈局重新跑模擬，等於把拖曳過的節點全部復原。
    function resetView() {
      data.nodes.forEach(function (n) { n.x = undefined; n.y = undefined; n.vx = 0; n.vy = 0; });
      seedPositions(data.nodes);
      hasAutoFit = false;
      kick();
    }
    function zoomStep(factor) { zoom = clamp(zoom * factor, 0.15, 3); render(); }

    function render() {
      Object.keys(edgeEls).forEach(function (k) {
        const rec = edgeEls[k];
        const a = nodeEls[rec.edge.a] && nodeEls[rec.edge.a].node;
        const b = nodeEls[rec.edge.b] && nodeEls[rec.edge.b].node;
        if (!a || !b) return;
        rec.el.setAttribute('d', curvePath(a.x, a.y, b.x, b.y, rec.seed));
      });
      Object.keys(nodeEls).forEach(function (id) {
        const rec = nodeEls[id];
        rec.el.setAttribute('transform', 'translate(' + rec.node.x + ',' + rec.node.y + ')');
      });
      const rect = canvas.getBoundingClientRect();
      stage.setAttribute('transform',
        'translate(' + (rect.width / 2 + panX) + ',' + (rect.height / 2 + panY) + ') scale(' + zoom + ')');
    }
    render();

    // ---- 拖曳節點：拖的那顆暫時退出模擬（固定跟著滑鼠），放開再回去 ----
    // dragMoved 用位移量判斷，不是「滑鼠有沒有動過」——按下瞬間滑鼠幾乎一定會
    // 抖動個 1px 左右（尤其是自動化測試送出的合成事件），門檻抓太低的話，
    // 每次點筆記想開啟都會被誤判成一次極小的拖曳而打不開。
    const DRAG_THRESHOLD = 4;
    let draggingId = null, dragMoved = false, dragStart = null;
    function toWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left, sy = clientY - rect.top;
      return { x: (sx - (rect.width / 2 + panX)) / zoom, y: (sy - (rect.height / 2 + panY)) / zoom };
    }
    function bindNodeDrag(g, n) {
      g.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        draggingId = n.id; dragMoved = false; n.dragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        n.vx = 0; n.vy = 0;
        kick();
      });
      g.addEventListener('mouseenter', function () { hoverId = n.id; applyHover(); });
      g.addEventListener('mouseleave', function () { if (hoverId === n.id) { hoverId = null; applyHover(); } });
      g.addEventListener('click', function () {
        if (dragMoved) return;
        if (n.kind === 'note' && opts.onOpenNote) { close(); opts.onOpenNote(n.note); }
        else if (n.kind === 'tag' && opts.onOpenTag) { close(); opts.onOpenTag(n.label.replace(/^#/, '')); }
      });
    }
    let panning = false, panStart = null;
    canvas.addEventListener('mousedown', function (e) {
      if (e.target !== canvas && e.target !== svg) return;
      panning = true; panStart = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
    });
    function onWindowMove(e) {
      if (draggingId) {
        if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > DRAG_THRESHOLD) dragMoved = true;
        const w = toWorld(e.clientX, e.clientY);
        const n = nodeEls[draggingId].node;
        n.x = w.x; n.y = w.y;
        render();
      } else if (panning) {
        panX = panStart.panX + (e.clientX - panStart.x);
        panY = panStart.panY + (e.clientY - panStart.y);
        render();
      }
    }
    function onWindowUp() {
      if (draggingId) { const n = nodeEls[draggingId].node; n.dragging = false; kick(); }
      draggingId = null; panning = false;
    }
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const wx = (sx - (rect.width / 2 + panX)) / zoom, wy = (sy - (rect.height / 2 + panY)) / zoom;
      zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.15, 3);
      panX = sx - rect.width / 2 - wx * zoom;
      panY = sy - rect.height / 2 - wy * zoom;
      render();
    }, { passive: false });

    tagsCb.addEventListener('change', function () {
      showTags = tagsCb.checked;
      rebuildDom();
      kick();
    });

    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', close);
    zoomOutBtn.addEventListener('click', function () { zoomStep(1 / 1.25); });
    zoomInBtn.addEventListener('click', function () { zoomStep(1.25); });
    zoomFitBtn.addEventListener('click', fitView);
    resetBtn.addEventListener('click', resetView);

    function close() {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
      overlay.remove();
    }

    raf = requestAnimationFrame(tick);
    return { close: close };
  }

  global.Graph = { open: open };
})(window);
