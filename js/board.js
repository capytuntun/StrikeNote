/* board.js — 看板：照著 Trello 的操作方式做的看板／列表／卡片。
 *
 * 一個看板就是一篇筆記（area:'board'，meta.board = true），內容是一個 ```board 圍欄，裡面是
 * 看板的 JSON——跟關聯分析、drawio 一樣「文字就是真相」：版本歷史、備份還原、搜尋、分享
 * 都不用為它多寫一行；markdown.js 遇到 ```board 圍欄就用 blockHTML() 畫成靜態的看板
 * （預覽、PDF、電子書）。
 *
 * 照 Trello 做的部分，一項一項對：
 *   - 看板頁：橫向一排列表，每個列表是一欄卡片，底下「＋ 新增卡片」展開成輸入框，Enter 新增、
 *     輸入框留著繼續打下一張，Esc 收起；最右邊「＋ 新增另一個列表」。列表標題點一下就地改名，
 *     ⋯ 選單有 新增卡片／複製列表／移動／封存列表。卡片、列表都能拖（卡片可以拖到別的列表）。
 *   - 卡片正面：標籤色條、標題、徽章（到期日——過期紅、24 小時內黃、完成綠；描述圖示；
 *     待辦清單 完成數／總數，全部完成變綠）。
 *   - 卡片背面（點一下）：標題、「在列表「X」中」、標籤、到期日（可勾完成）、描述（Markdown，
 *     點了才變輸入框，儲存／取消）、待辦清單（進度條、勾選、新增、刪除項目）；右欄「新增至
 *     卡片」：標籤、待辦清單、到期日；「動作」：移動、複製、封存；封存後才有「刪除」。
 *   - 標籤是看板層級的（名稱＋顏色，Trello 的十個顏色），卡片只記 id；標籤彈窗裡可以改名、
 *     新建。
 *   - 封存的卡片與列表收在右邊「已封存的項目」面板，可以送回看板或刪除。
 *   - 看板背景：Trello 的九個底色，建立看板時選、看板頁的「變更背景」改。
 *
 * 寫入：每一個動作呼叫 opts.onChange(json)——app.js 那邊跟 drawio 同一套單一寫入路徑。
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
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

  // Trello 的看板底色與標籤顏色（名稱沿用它的）
  const BG = [
    { key: 'blue', hex: '#0079bf' }, { key: 'orange', hex: '#d29034' }, { key: 'green', hex: '#519839' },
    { key: 'red', hex: '#b04632' }, { key: 'purple', hex: '#89609e' }, { key: 'pink', hex: '#cd5a91' },
    { key: 'lime', hex: '#4bbf6b' }, { key: 'sky', hex: '#00aecc' }, { key: 'grey', hex: '#838c91' }
  ];
  const LABEL_COLORS = [
    { key: 'green', hex: '#61bd4f' }, { key: 'yellow', hex: '#f2d600' }, { key: 'orange', hex: '#ff9f1a' },
    { key: 'red', hex: '#eb5a46' }, { key: 'purple', hex: '#c377e0' }, { key: 'blue', hex: '#0079bf' },
    { key: 'sky', hex: '#00c2e0' }, { key: 'lime', hex: '#51e898' }, { key: 'pink', hex: '#ff78cb' },
    { key: 'black', hex: '#344563' }
  ];
  function bgHex(key) { const b = BG.find(function (x) { return x.key === key; }); return (b || BG[0]).hex; }
  function labelHex(key) { const c = LABEL_COLORS.find(function (x) { return x.key === key; }); return (c || LABEL_COLORS[0]).hex; }
  // 黃、青綠、天藍、淺綠這幾個底色上白字看不清，字用深色
  function darkText(key) { return ['yellow', 'lime', 'sky', 'orange'].indexOf(key) >= 0; }

  // ---------------- 資料 ----------------
  // Trello 新看板預設六個沒有名字的標籤
  function defaultLabels() {
    return ['green', 'yellow', 'orange', 'red', 'purple', 'blue'].map(function (c) { return { id: uid('l'), name: '', color: c }; });
  }
  function newBoard(bg) {
    return { bg: bg || 'blue', labels: defaultLabels(), lists: [] };
  }
  function newList(name) { return { id: uid('L'), name: name, archived: false, cards: [] }; }
  function newCard(title) {
    return { id: uid('c'), title: title, desc: '', labels: [], due: null, dueDone: false, checklist: null, archived: false, created: Date.now() };
  }
  // 讀回來的 JSON 不信任：每個欄位都整理過，壞的丟掉
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 4000) : ''; }
  function parse(text) {
    let raw = null;
    try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') raw = {};
    const b = { bg: BG.some(function (x) { return x.key === raw.bg; }) ? raw.bg : 'blue', labels: [], lists: [] };
    const seen = {};
    (Array.isArray(raw.labels) ? raw.labels : []).forEach(function (l) {
      if (!l || typeof l.id !== 'string' || seen[l.id]) return;
      seen[l.id] = 1;
      b.labels.push({ id: l.id.slice(0, 40), name: str(l.name, 60), color: LABEL_COLORS.some(function (x) { return x.key === l.color; }) ? l.color : 'green' });
    });
    (Array.isArray(raw.lists) ? raw.lists : []).forEach(function (L) {
      if (!L || typeof L.id !== 'string' || seen[L.id]) return;
      seen[L.id] = 1;
      const list = { id: L.id.slice(0, 40), name: str(L.name, 200), archived: !!L.archived, cards: [] };
      (Array.isArray(L.cards) ? L.cards : []).forEach(function (c) {
        if (!c || typeof c.id !== 'string' || seen[c.id]) return;
        seen[c.id] = 1;
        const card = {
          id: c.id.slice(0, 40), title: str(c.title, 500), desc: str(c.desc, 20000),
          labels: (Array.isArray(c.labels) ? c.labels : []).filter(function (id) { return typeof id === 'string' && b.labels.some(function (l) { return l.id === id; }); }),
          due: typeof c.due === 'number' && isFinite(c.due) ? c.due : null, dueDone: !!c.dueDone,
          checklist: null, archived: !!c.archived,
          created: typeof c.created === 'number' ? c.created : 0
        };
        if (c.checklist && typeof c.checklist === 'object') {
          card.checklist = { title: str(c.checklist.title, 200) || '待辦清單', items: [] };
          (Array.isArray(c.checklist.items) ? c.checklist.items : []).forEach(function (it) {
            if (!it || typeof it.id !== 'string') return;
            card.checklist.items.push({ id: it.id.slice(0, 40), text: str(it.text, 1000), done: !!it.done });
          });
        }
        list.cards.push(card);
      });
      b.lists.push(list);
    });
    return b;
  }
  function serialize(b) { return JSON.stringify(b, null, 1); }
  function payloadOf(content) {
    const m = /^```board[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || ''));
    return m ? m[1] : null;
  }
  function wrap(json) { return '```board\n' + json + '\n```\n'; }
  function generate(bg) { return wrap(serialize(newBoard(bg))); }
  function isNote(note) { return !!(note && note.meta && note.meta.board); }
  function boardOf(note) { return parse(payloadOf(note && note.content) || ''); }

  // ---------------- 日期 ----------------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDue(ts) {
    const d = new Date(ts), now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return (sameYear ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dueState(card) {
    if (!card.due) return '';
    if (card.dueDone) return 'done';
    const diff = card.due - Date.now();
    if (diff < 0) return 'over';
    if (diff < 24 * 3600 * 1000) return 'soon';
    return '';
  }
  function toLocalInput(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ---------------- 靜態渲染（預覽、PDF、電子書） ----------------
  function cardStaticHTML(b, c) {
    let h = '<div class="kbs-card">';
    const labels = c.labels.map(function (id) { return b.labels.find(function (l) { return l.id === id; }); }).filter(Boolean);
    if (labels.length) h += '<div class="kbs-labels">' + labels.map(function (l) { return '<span class="kbs-label" style="background:' + labelHex(l.color) + ';color:' + (darkText(l.color) ? '#172b4d' : '#fff') + '">' + esc(l.name) + '</span>'; }).join('') + '</div>';
    h += '<div class="kbs-title">' + esc(c.title) + '</div>';
    const badges = [];
    if (c.due) badges.push('<span class="kbs-badge kbs-due is-' + dueState(c) + '">' + ic('clock') + esc(fmtDue(c.due)) + '</span>');
    if (c.checklist && c.checklist.items.length) {
      const done = c.checklist.items.filter(function (i) { return i.done; }).length;
      badges.push('<span class="kbs-badge' + (done === c.checklist.items.length ? ' is-done' : '') + '">' + ic('check-square') + done + '/' + c.checklist.items.length + '</span>');
    }
    if (badges.length) h += '<div class="kbs-badges">' + badges.join('') + '</div>';
    if (c.desc) h += '<div class="kbs-desc markdown-body">' + (global.MD && MD.render ? MD.render(c.desc) : esc(c.desc)) + '</div>';
    if (c.checklist && c.checklist.items.length) {
      h += '<ul class="kbs-check">' + c.checklist.items.map(function (i) { return '<li class="' + (i.done ? 'is-done' : '') + '">' + ic(i.done ? 'check-square' : 'square-empty') + esc(i.text) + '</li>'; }).join('') + '</ul>';
    }
    return h + '</div>';
  }
  function blockHTML(payload) {
    const b = parse(payload);
    const lists = b.lists.filter(function (L) { return !L.archived; });
    if (!lists.length) return '<div class="kbs-board is-empty">' + ic('kanban') + '<span>空白的看板</span></div>';
    return '<div class="kbs-board" style="background:' + bgHex(b.bg) + '">' + lists.map(function (L) {
      const cards = L.cards.filter(function (c) { return !c.archived; });
      return '<div class="kbs-list"><div class="kbs-list-t">' + esc(L.name) + ' <span class="kbs-n">' + cards.length + '</span></div>' +
        cards.map(function (c) { return cardStaticHTML(b, c); }).join('') + '</div>';
    }).join('') + '</div>';
  }

  // ---------------- 彈窗（Trello 的小 popover） ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function popupAt(anchor, title, cls) {
    closePop();
    const p = el('div', 'kb-pop' + (cls ? ' ' + cls : ''));
    const head = el('div', 'kb-pop-head');
    head.appendChild(el('span', 'kb-pop-title', esc(title)));
    const x = el('button', 'kb-pop-x', ic('x')); x.type = 'button'; x.title = '關閉';
    x.addEventListener('click', closePop);
    head.appendChild(x);
    p.appendChild(head);
    const body = el('div', 'kb-pop-body');
    p.appendChild(body);
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    p.style.left = left + 'px'; p.style.top = top + 'px';
    popEl = p;
    return body;
  }
  document.addEventListener('mousedown', function (e) {
    if (popEl && !popEl.contains(e.target)) closePop();
  }, true);

  function bgPicker(body, current, onPick) {
    const grid = el('div', 'kb-bg-grid');
    BG.forEach(function (bgc) {
      const b = el('button', 'kb-bg-swatch' + (bgc.key === current ? ' is-on' : ''));
      b.type = 'button'; b.style.background = bgc.hex; b.title = bgc.key;
      b.setAttribute('data-bg', bgc.key);
      b.addEventListener('click', function () { onPick(bgc.key); });
      grid.appendChild(b);
    });
    body.appendChild(grid);
    return grid;
  }

  // ---------------- 看板列表頁（Trello 的「看板」頁） ----------------
  // opts: { boards: [note], onCreate({title, bg}) → Promise, onOpen(id), onRename(note), onDelete(note) }
  function renderIndex(container, opts) {
    container.innerHTML = '';
    const page = el('div', 'boards-inner');
    const head = el('div', 'boards-head');
    head.appendChild(el('div', 'boards-title', ic('kanban') + '<span>看板</span>'));
    head.appendChild(el('div', 'boards-sub', '像 Trello 一樣的列表與卡片。點一個看板打開，或建立新的。'));
    page.appendChild(head);
    const grid = el('div', 'boards-grid');
    const boards = (opts.boards || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    boards.forEach(function (n) {
      const b = boardOf(n);
      const lists = b.lists.filter(function (L) { return !L.archived; });
      const cards = lists.reduce(function (t, L) { return t + L.cards.filter(function (c) { return !c.archived; }).length; }, 0);
      const tile = el('button', 'boards-tile');
      tile.type = 'button';
      tile.style.background = bgHex(b.bg);
      tile.setAttribute('data-id', n.id);
      tile.innerHTML = '<span class="boards-tile-t">' + esc(n.title || '未命名看板') + '</span>' +
        '<span class="boards-tile-m">' + lists.length + ' 個列表・' + cards + ' 張卡片</span>' +
        '<span class="boards-tile-more" title="更多">' + ic('more-horizontal') + '</span>';
      tile.addEventListener('click', function (e) {
        if (e.target.closest('.boards-tile-more')) { e.stopPropagation(); tileMenu(tile, n); return; }
        if (opts.onOpen) opts.onOpen(n.id);
      });
      tile.addEventListener('contextmenu', function (e) { e.preventDefault(); tileMenu(tile, n); });
      grid.appendChild(tile);
    });
    const add = el('button', 'boards-tile boards-tile-new');
    add.type = 'button';
    add.innerHTML = '<span>建立新看板</span>';
    add.addEventListener('click', function () { createPop(add); });
    grid.appendChild(add);
    page.appendChild(grid);
    container.appendChild(page);

    function tileMenu(anchor, n) {
      const body = popupAt(anchor, '看板', 'kb-pop-menu');
      [['rename', '重新命名'], ['bg', '變更背景'], null, ['del', '移到垃圾桶']].forEach(function (it) {
        if (!it) { body.appendChild(el('div', 'kb-pop-sep')); return; }
        const b = el('button', 'kb-pop-item' + (it[0] === 'del' ? ' is-danger' : ''), esc(it[1]));
        b.type = 'button';
        b.addEventListener('click', function () {
          if (it[0] === 'rename') { closePop(); if (opts.onRename) opts.onRename(n); }
          else if (it[0] === 'bg') {
            const bb = popupAt(anchor, '變更背景');
            bgPicker(bb, boardOf(n).bg, function (key) {
              closePop();
              const data = boardOf(n); data.bg = key;
              if (opts.onPatch) opts.onPatch(n, wrap(serialize(data)));
            });
          } else { closePop(); if (opts.onDelete) opts.onDelete(n); }
        });
        body.appendChild(b);
      });
    }
    function createPop(anchor) {
      const body = popupAt(anchor, '建立看板', 'kb-pop-create');
      let bg = 'blue';
      body.appendChild(el('div', 'kb-pop-label', '背景'));
      const grid = bgPicker(body, bg, function (key) {
        bg = key;
        grid.querySelectorAll('.kb-bg-swatch').forEach(function (s) { s.classList.toggle('is-on', s.getAttribute('data-bg') === key); });
      });
      body.appendChild(el('div', 'kb-pop-label', '看板標題 <span class="kb-req">*</span>'));
      const input = el('input', 'kb-input');
      input.type = 'text'; input.placeholder = '例如：OSCP 進度'; input.maxLength = 200;
      body.appendChild(input);
      const hint = el('div', 'kb-pop-hint', '👋 看板需要標題');
      body.appendChild(hint);
      const btn = el('button', 'kb-btn kb-btn-primary', '建立');
      btn.type = 'button'; btn.disabled = true;
      body.appendChild(btn);
      input.addEventListener('input', function () { btn.disabled = !input.value.trim(); hint.hidden = !!input.value.trim(); });
      const go = function () {
        const t = input.value.trim();
        if (!t || btn.disabled) return;
        btn.disabled = true;
        closePop();
        if (opts.onCreate) opts.onCreate({ title: t, bg: bg });
      };
      btn.addEventListener('click', go);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') closePop(); });
      setTimeout(function () { input.focus(); }, 0);
    }
  }

  // ---------------- 看板頁 ----------------
  // opts: { container, title(), onChange(content), onTitle(t), readOnly }
  function open(note, opts) {
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    let b = parse(payloadOf(note.content) || '');
    const ro = !!opts.readOnly;
    let closed = false, drag = null, modalEl = null, modalCardId = null, archiveOpen = false;
    const openComposers = {};   // 哪些列表的「新增卡片」是展開的（重畫之後要留著）

    host.classList.add('kb-page');
    host.innerHTML = '<div class="kb-head"></div><div class="kb-lists" tabindex="-1"></div>';
    const headEl = host.querySelector('.kb-head');
    const listsEl = host.querySelector('.kb-lists');

    function save() {
      if (ro) return;
      if (opts.onChange) opts.onChange(wrap(serialize(b)));
    }
    function mutate(fn) { fn(); save(); render(); if (modalCardId) renderModal(); }
    function findCard(id) {
      for (let i = 0; i < b.lists.length; i++) {
        const L = b.lists[i];
        for (let k = 0; k < L.cards.length; k++) if (L.cards[k].id === id) return { list: L, card: L.cards[k], index: k };
      }
      return null;
    }
    function listById(id) { return b.lists.find(function (L) { return L.id === id; }); }
    function labelById(id) { return b.labels.find(function (l) { return l.id === id; }); }
    function title() { return (opts.title ? opts.title() : note.title) || '未命名看板'; }

    // ---- 標題列 ----
    function renderHead() {
      headEl.innerHTML = '';
      const t = el('div', 'kb-title');
      const tb = el('button', 'kb-title-btn', esc(title()));
      tb.type = 'button'; tb.title = ro ? '' : '點一下改名';
      if (!ro) tb.addEventListener('click', function () {
        const inp = el('input', 'kb-title-input');
        inp.type = 'text'; inp.value = title(); inp.maxLength = 200;
        t.replaceChild(inp, tb);
        inp.focus(); inp.select();
        const done = function () {
          const v = inp.value.trim();
          if (v && v !== title() && opts.onTitle) opts.onTitle(v);
          renderHead();
        };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') { inp.value = title(); inp.blur(); } });
      });
      t.appendChild(tb);
      headEl.appendChild(t);
      const sp = el('span', 'kb-head-sp'); headEl.appendChild(sp);
      if (!ro) {
        const bgb = el('button', 'kb-head-btn', ic('layout-grid') + '<span>變更背景</span>'); bgb.type = 'button';
        bgb.addEventListener('click', function () {
          const body = popupAt(bgb, '變更背景');
          bgPicker(body, b.bg, function (key) { closePop(); mutate(function () { b.bg = key; }); });
        });
        headEl.appendChild(bgb);
      }
      const nArch = b.lists.filter(function (L) { return L.archived; }).length + b.lists.reduce(function (t2, L) { return t2 + L.cards.filter(function (c) { return c.archived; }).length; }, 0);
      const ab = el('button', 'kb-head-btn' + (archiveOpen ? ' is-on' : ''), ic('archive') + '<span>已封存的項目' + (nArch ? ' <b>' + nArch + '</b>' : '') + '</span>'); ab.type = 'button';
      ab.addEventListener('click', function () { archiveOpen = !archiveOpen; render(); });
      headEl.appendChild(ab);
    }

    // ---- 卡片正面 ----
    function cardEl(c, L) {
      const card = el('div', 'kb-card');
      card.setAttribute('data-card', c.id);
      card.draggable = !ro;
      const labels = c.labels.map(labelById).filter(Boolean);
      if (labels.length) {
        const row = el('div', 'kb-card-labels');
        labels.forEach(function (l) {
          const s = el('span', 'kb-chip'); s.style.background = labelHex(l.color); s.title = l.name || l.color;
          if (l.name) { s.textContent = l.name; s.style.color = darkText(l.color) ? '#172b4d' : '#fff'; }
          row.appendChild(s);
        });
        card.appendChild(row);
      }
      card.appendChild(el('div', 'kb-card-t', esc(c.title)));
      const badges = el('div', 'kb-card-badges');
      if (c.due) badges.appendChild(el('span', 'kb-badge kb-badge-due is-' + dueState(c), ic('clock') + '<span>' + esc(fmtDue(c.due)) + '</span>'));
      if (c.desc) { const d = el('span', 'kb-badge', ic('align-left')); d.title = '這張卡片有描述'; badges.appendChild(d); }
      if (c.checklist && c.checklist.items.length) {
        const done = c.checklist.items.filter(function (i) { return i.done; }).length;
        badges.appendChild(el('span', 'kb-badge' + (done === c.checklist.items.length ? ' is-done' : ''), ic('check-square') + '<span>' + done + '/' + c.checklist.items.length + '</span>'));
      }
      if (badges.children.length) card.appendChild(badges);
      card.addEventListener('click', function () { openModal(c.id); });
      if (!ro) {
        card.addEventListener('dragstart', function (e) {
          drag = { type: 'card', id: c.id, from: L.id, h: card.offsetHeight };
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('application/x-strikenote-card', c.id); e.dataTransfer.setData('text/plain', c.title); } catch (err) { /* */ }
          setTimeout(function () { card.classList.add('is-dragging'); }, 0);
        });
        card.addEventListener('dragend', function () { card.classList.remove('is-dragging'); clearPlaceholder(); drag = null; });
      }
      return card;
    }

    // ---- 拖放：卡片放進某個列表的某個位置、列表換順序 ----
    let ph = null;
    function placeholder(h) {
      if (!ph) ph = el('div', 'kb-placeholder');
      ph.style.height = (h || 40) + 'px';
      return ph;
    }
    function clearPlaceholder() { if (ph && ph.parentNode) ph.parentNode.removeChild(ph); }
    function cardIndexAt(cardsEl, y) {
      const cards = Array.prototype.filter.call(cardsEl.querySelectorAll('.kb-card'), function (x) { return !x.classList.contains('is-dragging'); });
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return cards.length;
    }
    function listIndexAt(x) {
      const lists = Array.prototype.filter.call(listsEl.querySelectorAll('.kb-list'), function (L) { return !L.classList.contains('is-dragging'); });
      for (let i = 0; i < lists.length; i++) {
        const r = lists[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return i;
      }
      return lists.length;
    }

    // ---- 列表 ----
    function listEl(L) {
      const list = el('div', 'kb-list');
      list.setAttribute('data-list', L.id);
      const head = el('div', 'kb-list-head');
      head.draggable = !ro;
      const name = el('button', 'kb-list-name', esc(L.name)); name.type = 'button';
      if (!ro) name.addEventListener('click', function () {
        const inp = el('textarea', 'kb-list-name-input'); inp.value = L.name; inp.rows = 1; inp.maxLength = 200;
        head.replaceChild(inp, name);
        inp.focus(); inp.select();
        const done = function () { const v = inp.value.trim(); if (v && v !== L.name) mutate(function () { L.name = v; }); else render(); };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') { inp.value = L.name; inp.blur(); } });
      });
      head.appendChild(name);
      if (!ro) {
        const more = el('button', 'kb-list-more', ic('more-horizontal')); more.type = 'button'; more.title = '列表動作';
        more.addEventListener('click', function () { listMenu(more, L); });
        head.appendChild(more);
        head.addEventListener('dragstart', function (e) {
          if (e.target !== head && e.target.closest('.kb-list-more')) { e.preventDefault(); return; }
          drag = { type: 'list', id: L.id, w: list.offsetWidth };
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('application/x-strikenote-list', L.id); e.dataTransfer.setData('text/plain', L.name); } catch (err) { /* */ }
          setTimeout(function () { list.classList.add('is-dragging'); }, 0);
        });
        head.addEventListener('dragend', function () { list.classList.remove('is-dragging'); clearPlaceholder(); drag = null; });
      }
      list.appendChild(head);
      const cards = el('div', 'kb-cards');
      L.cards.filter(function (c) { return !c.archived; }).forEach(function (c) { cards.appendChild(cardEl(c, L)); });
      list.appendChild(cards);
      if (!ro) {
        cards.addEventListener('dragover', function (e) {
          if (!drag || drag.type !== 'card') return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'move';
          const idx = cardIndexAt(cards, e.clientY);
          const p = placeholder(drag.h);
          const live = Array.prototype.filter.call(cards.querySelectorAll('.kb-card'), function (x) { return !x.classList.contains('is-dragging'); });
          if (idx >= live.length) cards.appendChild(p); else cards.insertBefore(p, live[idx]);
        });
        list.addEventListener('dragover', function (e) {
          if (!drag) return;
          if (drag.type === 'card' && !e.target.closest('.kb-cards')) {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            cards.appendChild(placeholder(drag.h));     // 丟在列表標題或底部：放到最後
          }
        });
        list.addEventListener('drop', function (e) {
          if (!drag || drag.type !== 'card') return;
          e.preventDefault(); e.stopPropagation();
          const idx = ph && ph.parentNode === cards ? Array.prototype.indexOf.call(cards.children, ph) : cards.children.length;
          const src = findCard(drag.id);
          clearPlaceholder();
          if (!src) return;
          // placeholder 的索引是「畫面上非封存卡片」的索引，換算成 L.cards 裡的位置
          let visible = 0, insertAt = L.cards.length;
          for (let i = 0; i < L.cards.length; i++) {
            if (L.cards[i].archived) continue;
            if (L.cards[i].id === drag.id) continue;
            if (visible === idx) { insertAt = i; break; }
            visible++;
          }
          mutate(function () {
            src.list.cards.splice(src.index, 1);
            if (src.list === L && src.index < insertAt) insertAt--;
            L.cards.splice(Math.min(insertAt, L.cards.length), 0, src.card);
          });
        });
      }
      // 新增卡片（Trello：展開輸入框，Enter 新增、留著繼續打，Esc 收起）
      const foot = el('div', 'kb-list-foot');
      if (!ro) {
        if (openComposers[L.id]) foot.appendChild(composer(L, foot));
        else {
          const addb = el('button', 'kb-add-card', ic('plus') + '<span>新增卡片</span>'); addb.type = 'button';
          addb.addEventListener('click', function () { openComposers[L.id] = true; render(); });
          foot.appendChild(addb);
        }
      }
      list.appendChild(foot);
      return list;
    }
    function composer(L) {
      const box = el('div', 'kb-composer');
      const ta = el('textarea', 'kb-composer-ta'); ta.placeholder = '為這張卡片輸入標題…'; ta.rows = 2; ta.maxLength = 500;
      box.appendChild(ta);
      const row = el('div', 'kb-composer-row');
      const add = el('button', 'kb-btn kb-btn-primary', '新增卡片'); add.type = 'button';
      const x = el('button', 'kb-composer-x', ic('x')); x.type = 'button'; x.title = '捨棄（Esc）';
      row.appendChild(add); row.appendChild(x);
      box.appendChild(row);
      const submit = function () {
        const t = ta.value.trim();
        if (!t) return;
        mutate(function () { L.cards.push(newCard(t)); });
        // render() 重畫了整個看板；新的輸入框要拿回焦點，繼續打下一張
        const again = listsEl.querySelector('.kb-list[data-list="' + L.id + '"] .kb-composer-ta');
        if (again) again.focus();
        const cardsBox = listsEl.querySelector('.kb-list[data-list="' + L.id + '"] .kb-cards');
        if (cardsBox) cardsBox.scrollTop = cardsBox.scrollHeight;
      };
      const closeIt = function () { delete openComposers[L.id]; render(); };
      add.addEventListener('click', submit);
      x.addEventListener('click', closeIt);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeIt(); }
      });
      setTimeout(function () { ta.focus(); }, 0);
      return box;
    }
    function listMenu(anchor, L) {
      const body = popupAt(anchor, '列表動作', 'kb-pop-menu');
      const i = b.lists.indexOf(L);
      [['add', '新增卡片…'], ['copy', '複製列表…'], null, ['left', '往左移', i === 0], ['right', '往右移', i === b.lists.length - 1], null,
        ['sort-name', '依名稱排序卡片'], ['sort-date', '依建立時間排序卡片'], null, ['archive-cards', '封存此列表的所有卡片'], ['archive', '封存此列表']].forEach(function (it) {
        if (!it) { body.appendChild(el('div', 'kb-pop-sep')); return; }
        const btn = el('button', 'kb-pop-item', esc(it[1])); btn.type = 'button';
        if (it[2]) btn.disabled = true;
        btn.addEventListener('click', function () {
          closePop();
          if (it[0] === 'add') { openComposers[L.id] = true; render(); }
          else if (it[0] === 'copy') {
            mutate(function () {
              const c = newList(L.name + ' 複本');
              c.cards = L.cards.filter(function (x) { return !x.archived; }).map(function (x) { return Object.assign(JSON.parse(JSON.stringify(x)), { id: uid('c'), created: Date.now() }); });
              b.lists.splice(b.lists.indexOf(L) + 1, 0, c);
            });
          } else if (it[0] === 'left' || it[0] === 'right') {
            mutate(function () {
              const k = b.lists.indexOf(L), j = it[0] === 'left' ? k - 1 : k + 1;
              if (j < 0 || j >= b.lists.length) return;
              b.lists[k] = b.lists[j]; b.lists[j] = L;
            });
          } else if (it[0] === 'sort-name') mutate(function () { L.cards.sort(function (p, q) { return p.title.localeCompare(q.title, 'zh-Hant'); }); });
          else if (it[0] === 'sort-date') mutate(function () { L.cards.sort(function (p, q) { return (q.created || 0) - (p.created || 0); }); });
          else if (it[0] === 'archive-cards') mutate(function () { L.cards.forEach(function (c) { c.archived = true; }); });
          else if (it[0] === 'archive') mutate(function () { L.archived = true; });
        });
        body.appendChild(btn);
      });
    }

    // ---- 新增列表 ----
    let listComposerOpen = false;
    function addListEl() {
      const box = el('div', 'kb-add-list' + (listComposerOpen ? ' is-open' : ''));
      if (!listComposerOpen) {
        const btn = el('button', 'kb-add-list-btn', ic('plus') + '<span>' + (b.lists.filter(function (L) { return !L.archived; }).length ? '新增另一個列表' : '新增列表') + '</span>'); btn.type = 'button';
        btn.addEventListener('click', function () { listComposerOpen = true; render(); });
        box.appendChild(btn);
        return box;
      }
      const inp = el('input', 'kb-input'); inp.type = 'text'; inp.placeholder = '輸入列表名稱…'; inp.maxLength = 200;
      box.appendChild(inp);
      const row = el('div', 'kb-composer-row');
      const add = el('button', 'kb-btn kb-btn-primary', '新增列表'); add.type = 'button';
      const x = el('button', 'kb-composer-x', ic('x')); x.type = 'button'; x.title = '取消（Esc）';
      row.appendChild(add); row.appendChild(x);
      box.appendChild(row);
      const submit = function () {
        const t = inp.value.trim();
        if (!t) return;
        mutate(function () { b.lists.push(newList(t)); });
        const again = listsEl.querySelector('.kb-add-list input');
        if (again) again.focus();
        listsEl.scrollLeft = listsEl.scrollWidth;
      };
      const closeIt = function () { listComposerOpen = false; render(); };
      add.addEventListener('click', submit);
      x.addEventListener('click', closeIt);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); closeIt(); } });
      setTimeout(function () { inp.focus(); }, 0);
      return box;
    }

    // ---- 已封存的項目 ----
    function archiveEl() {
      const panel = el('aside', 'kb-archive');
      const head = el('div', 'kb-archive-head', '<span>已封存的項目</span>');
      const x = el('button', 'kb-pop-x', ic('x')); x.type = 'button'; x.title = '關閉';
      x.addEventListener('click', function () { archiveOpen = false; render(); });
      head.appendChild(x);
      panel.appendChild(head);
      const cards = [];
      b.lists.forEach(function (L) { L.cards.forEach(function (c) { if (c.archived) cards.push({ c: c, L: L }); }); });
      const lists = b.lists.filter(function (L) { return L.archived; });
      panel.appendChild(el('div', 'kb-archive-t', '卡片（' + cards.length + '）'));
      if (!cards.length) panel.appendChild(el('div', 'kb-archive-empty', '沒有封存的卡片。'));
      cards.forEach(function (o) {
        const row = el('div', 'kb-archive-row');
        row.appendChild(el('div', 'kb-archive-name', esc(o.c.title) + '<small>在「' + esc(o.L.name) + '」</small>'));
        const acts = el('div', 'kb-archive-acts');
        if (!ro) {
          const back = el('button', 'kb-link', '送回看板'); back.type = 'button';
          back.addEventListener('click', function () { mutate(function () { o.c.archived = false; }); });
          const del = el('button', 'kb-link is-danger', '刪除'); del.type = 'button';
          del.addEventListener('click', function () { confirmBox('刪除卡片「' + o.c.title + '」？刪除後無法復原。', function () { mutate(function () { o.L.cards.splice(o.L.cards.indexOf(o.c), 1); }); }); });
          acts.appendChild(back); acts.appendChild(del);
        }
        row.appendChild(acts);
        panel.appendChild(row);
      });
      panel.appendChild(el('div', 'kb-archive-t', '列表（' + lists.length + '）'));
      if (!lists.length) panel.appendChild(el('div', 'kb-archive-empty', '沒有封存的列表。'));
      lists.forEach(function (L) {
        const row = el('div', 'kb-archive-row');
        row.appendChild(el('div', 'kb-archive-name', esc(L.name) + '<small>' + L.cards.length + ' 張卡片</small>'));
        const acts = el('div', 'kb-archive-acts');
        if (!ro) {
          const back = el('button', 'kb-link', '送回看板'); back.type = 'button';
          back.addEventListener('click', function () { mutate(function () { L.archived = false; }); });
          const del = el('button', 'kb-link is-danger', '刪除'); del.type = 'button';
          del.addEventListener('click', function () { confirmBox('刪除列表「' + L.name + '」和裡面的 ' + L.cards.length + ' 張卡片？刪除後無法復原。', function () { mutate(function () { b.lists.splice(b.lists.indexOf(L), 1); }); }); });
          acts.appendChild(back); acts.appendChild(del);
        }
        row.appendChild(acts);
        panel.appendChild(row);
      });
      return panel;
    }
    function confirmBox(msg, yes) {
      const ask = global.App && App.confirm ? App.confirm({ title: '確認', message: msg, ok: '刪除', danger: true }) : Promise.resolve(window.confirm(msg));
      ask.then(function (ok) { if (ok) yes(); });
    }

    // ---- 整頁 ----
    function render() {
      if (closed) return;
      host.style.background = bgHex(b.bg);
      renderHead();
      const scrollX = listsEl.scrollLeft;
      listsEl.innerHTML = '';
      b.lists.filter(function (L) { return !L.archived; }).forEach(function (L) { listsEl.appendChild(listEl(L)); });
      if (!ro) listsEl.appendChild(addListEl());
      const old = host.querySelector('.kb-archive');
      if (old) old.remove();
      if (archiveOpen) host.appendChild(archiveEl());
      listsEl.scrollLeft = scrollX;
    }
    // 列表換順序：在列表之間放 placeholder
    listsEl.addEventListener('dragover', function (e) {
      if (!drag || drag.type !== 'list') return;
      if (e.target.closest('.kb-list') && e.target.closest('.kb-list').classList.contains('is-dragging')) { e.preventDefault(); return; }
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const idx = listIndexAt(e.clientX);
      const p = placeholder(); p.classList.add('is-list'); p.style.height = ''; p.style.width = drag.w + 'px';
      const live = Array.prototype.filter.call(listsEl.querySelectorAll('.kb-list'), function (L) { return !L.classList.contains('is-dragging'); });
      if (idx >= live.length) listsEl.insertBefore(p, listsEl.querySelector('.kb-add-list')); else listsEl.insertBefore(p, live[idx]);
    });
    listsEl.addEventListener('drop', function (e) {
      if (!drag || drag.type !== 'list') return;
      e.preventDefault();
      const idx = ph && ph.parentNode === listsEl ? Array.prototype.filter.call(listsEl.children, function (x) { return x.classList.contains('kb-list') && !x.classList.contains('is-dragging') || x === ph; }).indexOf(ph) : -1;
      clearPlaceholder();
      if (idx < 0) return;
      const L = listById(drag.id);
      if (!L) return;
      mutate(function () {
        const visible = b.lists.filter(function (x) { return !x.archived && x !== L; });
        const target = idx >= visible.length ? null : visible[idx];
        b.lists.splice(b.lists.indexOf(L), 1);
        const at = target ? b.lists.indexOf(target) : b.lists.length;
        b.lists.splice(at, 0, L);
      });
    });
    listsEl.addEventListener('dragleave', function (e) {
      if (!listsEl.contains(e.relatedTarget)) clearPlaceholder();
    });

    // ---- 卡片背面 ----
    function openModal(id) {
      modalCardId = id;
      renderModal();
    }
    function closeModal() {
      modalCardId = null;
      closePop();
      if (modalEl) { modalEl.remove(); modalEl = null; }
    }
    function renderModal() {
      const found = modalCardId ? findCard(modalCardId) : null;
      if (!found) { closeModal(); return; }
      const c = found.card, L = found.list;
      if (!modalEl) {
        modalEl = el('div', 'kb-modal-overlay');
        modalEl.addEventListener('mousedown', function (e) { if (e.target === modalEl) closeModal(); });
        document.body.appendChild(modalEl);
      }
      const focusWas = document.activeElement && modalEl.contains(document.activeElement) ? (document.activeElement.getAttribute('data-f') || null) : null;
      modalEl.innerHTML = '';
      const m = el('div', 'kb-modal');
      m.setAttribute('role', 'dialog');
      // 標題列
      const head = el('div', 'kb-m-head');
      head.appendChild(el('span', 'kb-m-ic', ic('check-square')));
      const tt = el('textarea', 'kb-m-title'); tt.value = c.title; tt.rows = 1; tt.readOnly = ro; tt.maxLength = 500; tt.setAttribute('data-f', 'title');
      if (!ro) {
        tt.addEventListener('blur', function () { const v = tt.value.trim(); if (v && v !== c.title) mutate(function () { c.title = v; }); else tt.value = c.title; });
        tt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tt.blur(); } });
      }
      head.appendChild(tt);
      head.appendChild(el('div', 'kb-m-in', '在列表「<b>' + esc(L.name) + '</b>」中' + (c.archived ? '・<span class="kb-m-archived">已封存</span>' : '')));
      const x = el('button', 'kb-m-x', ic('x')); x.type = 'button'; x.title = '關閉（Esc）';
      x.addEventListener('click', closeModal);
      head.appendChild(x);
      m.appendChild(head);
      const body = el('div', 'kb-m-body');
      const main = el('div', 'kb-m-main');
      // 標籤、到期日
      const meta = el('div', 'kb-m-meta');
      const labels = c.labels.map(labelById).filter(Boolean);
      if (labels.length) {
        const sec = el('div', 'kb-m-sec');
        sec.appendChild(el('div', 'kb-m-sec-t', '標籤'));
        const row = el('div', 'kb-m-labels');
        labels.forEach(function (l) {
          const s = el('span', 'kb-chip kb-chip-lg', esc(l.name || '')); s.style.background = labelHex(l.color); s.style.color = darkText(l.color) ? '#172b4d' : '#fff';
          s.title = l.name || l.color;
          row.appendChild(s);
        });
        if (!ro) { const plus = el('button', 'kb-chip kb-chip-add', ic('plus')); plus.type = 'button'; plus.addEventListener('click', function () { labelsPop(plus, c); }); row.appendChild(plus); }
        sec.appendChild(row);
        meta.appendChild(sec);
      }
      if (c.due) {
        const sec = el('div', 'kb-m-sec');
        sec.appendChild(el('div', 'kb-m-sec-t', '到期日'));
        const row = el('div', 'kb-m-due');
        const chk = el('input'); chk.type = 'checkbox'; chk.checked = c.dueDone; chk.disabled = ro; chk.title = '標示為完成';
        chk.addEventListener('change', function () { mutate(function () { c.dueDone = chk.checked; }); });
        row.appendChild(chk);
        const pill = el('button', 'kb-due-pill is-' + dueState(c), esc(fmtDue(c.due)) + (dueState(c) === 'over' ? '<span class="kb-due-tag">已過期</span>' : dueState(c) === 'done' ? '<span class="kb-due-tag">完成</span>' : dueState(c) === 'soon' ? '<span class="kb-due-tag">即將到期</span>' : '') + ic('chevron-down'));
        pill.type = 'button';
        if (!ro) pill.addEventListener('click', function () { duePop(pill, c); });
        row.appendChild(pill);
        sec.appendChild(row);
        meta.appendChild(sec);
      }
      if (meta.children.length) main.appendChild(meta);
      // 描述
      const dsec = el('div', 'kb-m-sec kb-m-desc');
      dsec.appendChild(el('div', 'kb-m-h', ic('align-left') + '<span>描述</span>'));
      if (editingDesc) {
        const ta = el('textarea', 'kb-m-desc-ta'); ta.value = c.desc; ta.placeholder = '加入更詳細的描述…（支援 Markdown）'; ta.rows = 6; ta.setAttribute('data-f', 'desc');
        dsec.appendChild(ta);
        const row = el('div', 'kb-composer-row');
        const sv = el('button', 'kb-btn kb-btn-primary', '儲存'); sv.type = 'button';
        const cc = el('button', 'kb-btn', '取消'); cc.type = 'button';
        sv.addEventListener('click', function () { const v = ta.value.replace(/\s+$/, ''); editingDesc = false; if (v !== c.desc) mutate(function () { c.desc = v; }); else renderModal(); });
        cc.addEventListener('click', function () { editingDesc = false; renderModal(); });
        ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); editingDesc = false; renderModal(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { sv.click(); } });
        row.appendChild(sv); row.appendChild(cc);
        dsec.appendChild(row);
      } else if (c.desc) {
        const view = el('div', 'kb-m-desc-view markdown-body', global.MD && MD.render ? MD.render(c.desc) : esc(c.desc));
        if (!ro) view.addEventListener('click', function (e) { if (e.target.closest('a')) return; editingDesc = true; focusNext = 'desc'; renderModal(); });
        dsec.appendChild(view);
        if (!ro) { const eb = el('button', 'kb-btn kb-m-desc-edit', '編輯'); eb.type = 'button'; eb.addEventListener('click', function () { editingDesc = true; focusNext = 'desc'; renderModal(); }); dsec.querySelector('.kb-m-h').appendChild(eb); }
      } else if (!ro) {
        const ph2 = el('button', 'kb-m-desc-ph', '加入更詳細的描述…'); ph2.type = 'button';
        ph2.addEventListener('click', function () { editingDesc = true; focusNext = 'desc'; renderModal(); });
        dsec.appendChild(ph2);
      }
      main.appendChild(dsec);
      // 待辦清單
      if (c.checklist) {
        const cl = c.checklist;
        const csec = el('div', 'kb-m-sec kb-m-check');
        const ch = el('div', 'kb-m-h', ic('check-square') + '<span>' + esc(cl.title) + '</span>');
        if (!ro) { const del = el('button', 'kb-btn', '刪除'); del.type = 'button'; del.addEventListener('click', function () { mutate(function () { c.checklist = null; }); }); ch.appendChild(del); }
        csec.appendChild(ch);
        const done = cl.items.filter(function (i) { return i.done; }).length;
        const pct = cl.items.length ? Math.round(done / cl.items.length * 100) : 0;
        const prog = el('div', 'kb-prog', '<span class="kb-prog-n">' + pct + '%</span><span class="kb-prog-bar"><span class="kb-prog-fill' + (pct === 100 ? ' is-done' : '') + '" style="width:' + pct + '%"></span></span>');
        csec.appendChild(prog);
        const ul = el('div', 'kb-check-items');
        cl.items.forEach(function (it) {
          const row = el('label', 'kb-check-item' + (it.done ? ' is-done' : ''));
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = it.done; cb.disabled = ro;
          cb.addEventListener('change', function () { mutate(function () { it.done = cb.checked; }); });
          row.appendChild(cb);
          row.appendChild(el('span', 'kb-check-text', esc(it.text)));
          if (!ro) {
            const del = el('button', 'kb-check-del', ic('x')); del.type = 'button'; del.title = '刪除';
            del.addEventListener('click', function (e) { e.preventDefault(); mutate(function () { cl.items.splice(cl.items.indexOf(it), 1); }); });
            row.appendChild(del);
          }
          ul.appendChild(row);
        });
        csec.appendChild(ul);
        if (!ro) {
          if (addingItem) {
            const ta = el('textarea', 'kb-check-ta'); ta.placeholder = '新增項目'; ta.rows = 2; ta.setAttribute('data-f', 'item');
            csec.appendChild(ta);
            const row = el('div', 'kb-composer-row');
            const add = el('button', 'kb-btn kb-btn-primary', '新增'); add.type = 'button';
            const cc = el('button', 'kb-btn', '取消'); cc.type = 'button';
            const submit = function () { const v = ta.value.trim(); if (!v) return; focusNext = 'item'; mutate(function () { cl.items.push({ id: uid('i'), text: v, done: false }); }); };
            add.addEventListener('click', submit);
            cc.addEventListener('click', function () { addingItem = false; renderModal(); });
            ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { e.stopPropagation(); addingItem = false; renderModal(); } });
            row.appendChild(add); row.appendChild(cc);
            csec.appendChild(row);
          } else {
            const ab = el('button', 'kb-btn', '新增項目'); ab.type = 'button';
            ab.addEventListener('click', function () { addingItem = true; focusNext = 'item'; renderModal(); });
            csec.appendChild(ab);
          }
        }
        main.appendChild(csec);
      }
      body.appendChild(main);
      // 右欄
      const side = el('div', 'kb-m-side');
      if (!ro) {
        side.appendChild(el('div', 'kb-m-side-t', '新增至卡片'));
        const lb = el('button', 'kb-side-btn', ic('tag') + '<span>標籤</span>'); lb.type = 'button'; lb.addEventListener('click', function () { labelsPop(lb, c); }); side.appendChild(lb);
        const cb = el('button', 'kb-side-btn', ic('check-square') + '<span>待辦清單</span>'); cb.type = 'button';
        cb.addEventListener('click', function () {
          if (c.checklist) { addingItem = true; focusNext = 'item'; renderModal(); return; }
          const pop = popupAt(cb, '新增待辦清單');
          pop.appendChild(el('div', 'kb-pop-label', '標題'));
          const inp = el('input', 'kb-input'); inp.type = 'text'; inp.value = '待辦清單'; inp.maxLength = 200;
          pop.appendChild(inp);
          const go = el('button', 'kb-btn kb-btn-primary', '新增'); go.type = 'button';
          const doit = function () { const t = inp.value.trim() || '待辦清單'; closePop(); addingItem = true; focusNext = 'item'; mutate(function () { c.checklist = { title: t, items: [] }; }); };
          go.addEventListener('click', doit);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doit(); } });
          pop.appendChild(go);
          setTimeout(function () { inp.focus(); inp.select(); }, 0);
        });
        side.appendChild(cb);
        const db = el('button', 'kb-side-btn', ic('clock') + '<span>到期日</span>'); db.type = 'button'; db.addEventListener('click', function () { duePop(db, c); }); side.appendChild(db);
        side.appendChild(el('div', 'kb-m-side-t', '動作'));
        const mv = el('button', 'kb-side-btn', ic('arrow-right') + '<span>移動</span>'); mv.type = 'button'; mv.addEventListener('click', function () { movePop(mv, c); }); side.appendChild(mv);
        const cp = el('button', 'kb-side-btn', ic('copy') + '<span>複製</span>'); cp.type = 'button';
        cp.addEventListener('click', function () {
          mutate(function () {
            const f = findCard(c.id);
            const copy = Object.assign(JSON.parse(JSON.stringify(c)), { id: uid('c'), created: Date.now() });
            if (copy.checklist) copy.checklist.items.forEach(function (i) { i.id = uid('i'); });
            f.list.cards.splice(f.index + 1, 0, copy);
            modalCardId = copy.id;
          });
        });
        side.appendChild(cp);
        if (!c.archived) {
          const ar = el('button', 'kb-side-btn', ic('archive') + '<span>封存</span>'); ar.type = 'button';
          ar.addEventListener('click', function () { mutate(function () { c.archived = true; }); });
          side.appendChild(ar);
        } else {
          const back = el('button', 'kb-side-btn', ic('undo') + '<span>送回看板</span>'); back.type = 'button';
          back.addEventListener('click', function () { mutate(function () { c.archived = false; }); });
          side.appendChild(back);
          const del = el('button', 'kb-side-btn is-danger', ic('trash') + '<span>刪除</span>'); del.type = 'button';
          del.addEventListener('click', function () {
            confirmBox('刪除卡片「' + c.title + '」？刪除後無法復原。', function () {
              const f = findCard(c.id);
              closeModal();
              if (f) mutate(function () { f.list.cards.splice(f.index, 1); });
            });
          });
          side.appendChild(del);
        }
      }
      body.appendChild(side);
      m.appendChild(body);
      modalEl.appendChild(m);
      const want = focusNext || focusWas;
      focusNext = null;
      if (want) { const f = modalEl.querySelector('[data-f="' + want + '"]'); if (f) { f.focus(); if (f.tagName === 'TEXTAREA' && want === 'desc') f.setSelectionRange(f.value.length, f.value.length); } }
      autosize(tt);
    }
    let editingDesc = false, addingItem = false, focusNext = null;
    function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

    // 標籤彈窗（Trello：清單＋勾選，鉛筆改名，建立新標籤）
    function labelsPop(anchor, c) {
      const body = popupAt(anchor, '標籤', 'kb-pop-labels');
      let editing = null;      // 正在改的標籤 id，或 'new'
      function draw() {
        body.innerHTML = '';
        if (editing) {
          const l = editing === 'new' ? { id: 'new', name: '', color: 'green' } : labelById(editing);
          body.appendChild(el('div', 'kb-pop-label', '名稱'));
          const inp = el('input', 'kb-input'); inp.type = 'text'; inp.value = l.name; inp.maxLength = 60;
          body.appendChild(inp);
          body.appendChild(el('div', 'kb-pop-label', '選一個顏色'));
          let color = l.color;
          const grid = el('div', 'kb-color-grid');
          LABEL_COLORS.forEach(function (lc) {
            const s = el('button', 'kb-color-swatch' + (lc.key === color ? ' is-on' : '')); s.type = 'button'; s.style.background = lc.hex; s.title = lc.key;
            s.addEventListener('click', function () { color = lc.key; grid.querySelectorAll('.kb-color-swatch').forEach(function (q) { q.classList.toggle('is-on', q === s); }); });
            grid.appendChild(s);
          });
          body.appendChild(grid);
          const row = el('div', 'kb-composer-row');
          const sv = el('button', 'kb-btn kb-btn-primary', editing === 'new' ? '建立' : '儲存'); sv.type = 'button';
          sv.addEventListener('click', function () {
            const nm = inp.value.trim();
            mutate(function () {
              if (editing === 'new') { const nl = { id: uid('l'), name: nm, color: color }; b.labels.push(nl); c.labels.push(nl.id); }
              else { l.name = nm; l.color = color; }
            });
            editing = null; draw();
          });
          row.appendChild(sv);
          if (editing !== 'new') {
            const del = el('button', 'kb-btn kb-btn-danger', '刪除'); del.type = 'button';
            del.addEventListener('click', function () {
              mutate(function () {
                b.labels.splice(b.labels.indexOf(l), 1);
                b.lists.forEach(function (L) { L.cards.forEach(function (cc) { cc.labels = cc.labels.filter(function (id) { return id !== l.id; }); }); });
              });
              editing = null; draw();
            });
            row.appendChild(del);
          }
          const back = el('button', 'kb-btn', '返回'); back.type = 'button'; back.addEventListener('click', function () { editing = null; draw(); });
          row.appendChild(back);
          body.appendChild(row);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sv.click(); } });
          setTimeout(function () { inp.focus(); }, 0);
          return;
        }
        body.appendChild(el('div', 'kb-pop-label', '標籤'));
        b.labels.forEach(function (l) {
          const row = el('div', 'kb-label-row');
          const cb = el('input'); cb.type = 'checkbox'; cb.checked = c.labels.indexOf(l.id) >= 0;
          cb.addEventListener('change', function () { mutate(function () { if (cb.checked) { if (c.labels.indexOf(l.id) < 0) c.labels.push(l.id); } else c.labels = c.labels.filter(function (id) { return id !== l.id; }); }); });
          row.appendChild(cb);
          const chip = el('button', 'kb-label-pill', esc(l.name)); chip.type = 'button'; chip.style.background = labelHex(l.color); chip.style.color = darkText(l.color) ? '#172b4d' : '#fff'; chip.title = l.name || l.color;
          chip.addEventListener('click', function () { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
          row.appendChild(chip);
          const pen = el('button', 'kb-label-edit', ic('pencil')); pen.type = 'button'; pen.title = '編輯標籤';
          pen.addEventListener('click', function () { editing = l.id; draw(); });
          row.appendChild(pen);
          body.appendChild(row);
        });
        const nb = el('button', 'kb-btn kb-btn-wide', '建立新標籤'); nb.type = 'button';
        nb.addEventListener('click', function () { editing = 'new'; draw(); });
        body.appendChild(nb);
      }
      draw();
    }
    // 到期日彈窗
    function duePop(anchor, c) {
      const body = popupAt(anchor, '到期日');
      body.appendChild(el('div', 'kb-pop-label', '日期與時間'));
      const inp = el('input', 'kb-input'); inp.type = 'datetime-local';
      const base = c.due || (function () { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime(); })();
      inp.value = toLocalInput(base);
      body.appendChild(inp);
      const row = el('div', 'kb-composer-row');
      const sv = el('button', 'kb-btn kb-btn-primary', '儲存'); sv.type = 'button';
      sv.addEventListener('click', function () {
        const t = inp.value ? new Date(inp.value).getTime() : NaN;
        if (!isFinite(t)) return;
        closePop();
        mutate(function () { c.due = t; });
      });
      row.appendChild(sv);
      if (c.due) {
        const rm = el('button', 'kb-btn', '移除'); rm.type = 'button';
        rm.addEventListener('click', function () { closePop(); mutate(function () { c.due = null; c.dueDone = false; }); });
        row.appendChild(rm);
      }
      body.appendChild(row);
      setTimeout(function () { inp.focus(); }, 0);
    }
    // 移動卡片彈窗（Trello：選列表、選位置）
    function movePop(anchor, c) {
      const body = popupAt(anchor, '移動卡片');
      const f = findCard(c.id);
      body.appendChild(el('div', 'kb-pop-label', '列表'));
      const sel = el('select', 'kb-input');
      b.lists.filter(function (L) { return !L.archived; }).forEach(function (L) {
        const o = el('option', null, esc(L.name) + (L === f.list ? '（目前）' : '')); o.value = L.id; if (L === f.list) o.selected = true; sel.appendChild(o);
      });
      body.appendChild(sel);
      body.appendChild(el('div', 'kb-pop-label', '位置'));
      const pos = el('select', 'kb-input');
      const fillPos = function () {
        pos.innerHTML = '';
        const L = listById(sel.value);
        const n = L.cards.filter(function (x) { return !x.archived && x !== c; }).length;
        for (let i = 0; i <= n; i++) { const o = el('option', null, String(i + 1) + (L === f.list && i === f.list.cards.filter(function (x) { return !x.archived; }).indexOf(c) ? '（目前）' : '')); o.value = String(i); pos.appendChild(o); }
        if (L === f.list) pos.value = String(f.list.cards.filter(function (x) { return !x.archived; }).indexOf(c));
      };
      fillPos();
      sel.addEventListener('change', fillPos);
      body.appendChild(pos);
      const go = el('button', 'kb-btn kb-btn-primary', '移動'); go.type = 'button';
      go.addEventListener('click', function () {
        const L = listById(sel.value), p = parseInt(pos.value, 10);
        closePop();
        mutate(function () {
          f.list.cards.splice(f.list.cards.indexOf(c), 1);
          const vis = L.cards.filter(function (x) { return !x.archived; });
          const at = p >= vis.length ? L.cards.length : L.cards.indexOf(vis[p]);
          L.cards.splice(at, 0, c);
        });
      });
      body.appendChild(go);
    }

    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (popEl) { closePop(); e.stopPropagation(); return; }
      if (modalEl) { closeModal(); e.stopPropagation(); }
    }
    document.addEventListener('keydown', onKey, true);

    function teardown() {
      document.removeEventListener('keydown', onKey, true);
      closePop();
      if (modalEl) { modalEl.remove(); modalEl = null; }
      host.innerHTML = ''; host.style.background = ''; host.classList.remove('kb-page');
    }
    function close() { if (closed) return; closed = true; teardown(); if (opts.onClose) opts.onClose(); }
    function discard() { if (closed) return; closed = true; teardown(); }
    // 外面把筆記換掉（還原版本、別處改名）：重新讀一次
    function reload(n) { note = n; b = parse(payloadOf(n.content) || ''); render(); if (modalCardId) renderModal(); }

    render();
    return { close: close, requestClose: close, discard: discard, flush: function () { return Promise.resolve(); }, reload: reload, renderHead: renderHead };
  }

  global.Board = {
    isNote: isNote, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap,
    boardOf: boardOf, blockHTML: blockHTML, renderIndex: renderIndex, open: open, BG: BG, LABEL_COLORS: LABEL_COLORS
  };
})(window);
