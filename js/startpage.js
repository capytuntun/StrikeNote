/* startpage.js — 起始頁：照著 start.me 做的書籤起始頁。
 *
 * 一頁起始頁就是一篇筆記（area:'start'，meta.startpage = true），內容是一個 ```startpage 圍欄，
 * 裡面是這一頁的 JSON——跟看板、關聯分析一樣「文字就是真相」：版本、備份、搜尋、垃圾桶都
 * 照舊；markdown.js 遇到 ```startpage 就用 blockHTML() 畫成靜態的欄位與書籤（預覽、PDF）。
 *
 * 照 start.me 做的部分：
 *   - 最上面一列：頁面分頁（可以有好幾頁起始頁，點切換、雙擊改名、右鍵更多、＋ 新增），
 *     中間一個搜尋框（Google／Bing／DuckDuckGo，Enter 開新分頁搜尋）。
 *   - 底下是幾欄（2–5 欄，頁面選單裡改）小工具：書籤小工具（一排排的 favicon＋名稱，點了
 *     開新分頁；滑過去有編輯／刪除；底下「＋ 新增書籤」貼網址就會自己抓標題跟圖示）和
 *     便條小工具（一塊自由打字的文字）。小工具可以拖到別欄、換順序；書籤可以在小工具之間拖。
 *   - 每欄底下「＋ 新增小工具」；小工具標題點一下改名，⋯ 選單有搬移與刪除。
 *   - 頁面有底色可以換。
 *
 * favicon 走 /api/link-preview（抓標題時一起拿到圖示網址）與 /api/link-preview/image（代理，CSP 只准
 * 同源圖片）；抓不到就用網域第一個字母的色塊。
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

  const BG = [
    { key: 'grey', hex: '#eef1f5' }, { key: 'white', hex: '#ffffff' }, { key: 'blue', hex: '#dbe8f5' },
    { key: 'green', hex: '#dff0e3' }, { key: 'sand', hex: '#f3ecdc' }, { key: 'rose', hex: '#f5e1e6' },
    { key: 'slate', hex: '#2b3440' }, { key: 'navy', hex: '#1c2b45' }, { key: 'black', hex: '#15171b' }
  ];
  const DARK_BG = ['slate', 'navy', 'black'];
  const ENGINES = {
    google: { name: 'Google', url: 'https://www.google.com/search?q=' },
    bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
    ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' }
  };
  function bgHex(key) { const b = BG.find(function (x) { return x.key === key; }); return (b || BG[0]).hex; }

  // ---------------- 資料 ----------------
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 4000) : ''; }
  function safeUrl(u) {
    u = str(u, 2000).trim();
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    return /^https?:\/\//i.test(u) ? u : '';
  }
  function newPage(bg) { return { bg: bg || 'grey', columns: 4, search: 'google', widgets: [] }; }
  function newWidget(type, title, col) { return { id: uid('w'), col: col || 0, type: type === 'note' ? 'note' : 'links', title: title, items: [], text: '' }; }
  function parse(text) {
    let raw = null;
    try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') raw = {};
    const p = {
      bg: BG.some(function (x) { return x.key === raw.bg; }) ? raw.bg : 'grey',
      columns: Math.min(5, Math.max(2, parseInt(raw.columns, 10) || 4)),
      search: ENGINES[raw.search] ? raw.search : (raw.search === 'none' ? 'none' : 'google'),
      widgets: []
    };
    const seen = {};
    (Array.isArray(raw.widgets) ? raw.widgets : []).forEach(function (w) {
      if (!w || typeof w.id !== 'string' || seen[w.id]) return;
      seen[w.id] = 1;
      const widget = { id: w.id.slice(0, 40), col: Math.min(p.columns - 1, Math.max(0, parseInt(w.col, 10) || 0)), type: w.type === 'note' ? 'note' : 'links', title: str(w.title, 200), items: [], text: str(w.text, 20000) };
      (Array.isArray(w.items) ? w.items : []).forEach(function (it) {
        if (!it || typeof it.id !== 'string' || seen[it.id]) return;
        const url = safeUrl(it.url);
        if (!url) return;
        seen[it.id] = 1;
        widget.items.push({ id: it.id.slice(0, 40), title: str(it.title, 300), url: url, icon: safeUrl(it.icon) });
      });
      p.widgets.push(widget);
    });
    return p;
  }
  function serialize(p) { return JSON.stringify(p, null, 1); }
  function payloadOf(content) {
    const m = /^```startpage[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || ''));
    return m ? m[1] : null;
  }
  function wrap(json) { return '```startpage\n' + json + '\n```\n'; }
  function generate(bg) { return wrap(serialize(newPage(bg))); }
  function isNote(note) { return !!(note && note.meta && note.meta.startpage); }
  function pageOf(note) { return parse(payloadOf(note && note.content) || ''); }

  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  const LETTER_COLORS = ['#0079bf', '#d29034', '#519839', '#b04632', '#89609e', '#cd5a91', '#4bbf6b', '#00aecc'];
  function letterColor(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return LETTER_COLORS[h % LETTER_COLORS.length]; }
  function proxied(u) { return '/api/link-preview/image?url=' + encodeURIComponent(u); }
  function favEl(item) {
    const host = hostOf(item.url);
    const box = el('span', 'sp-fav');
    const letter = el('span', 'sp-fav-letter', esc((host || '?').charAt(0).toUpperCase()));
    letter.style.background = letterColor(host);
    box.appendChild(letter);
    if (item.icon) {
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy';
      img.addEventListener('load', function () { box.classList.add('has-img'); });
      img.addEventListener('error', function () { img.remove(); });
      img.src = proxied(item.icon);
      box.appendChild(img);
    }
    return box;
  }

  // ---------------- 靜態渲染 ----------------
  function blockHTML(payload) {
    const p = parse(payload);
    if (!p.widgets.length) return '<div class="sps-page is-empty">' + ic('layout-grid') + '<span>空白的起始頁</span></div>';
    const cols = [];
    for (let i = 0; i < p.columns; i++) cols.push([]);
    p.widgets.forEach(function (w) { cols[Math.min(w.col, p.columns - 1)].push(w); });
    return '<div class="sps-page' + (DARK_BG.indexOf(p.bg) >= 0 ? ' is-dark' : '') + '" style="background:' + bgHex(p.bg) + ';grid-template-columns:repeat(' + p.columns + ',1fr)">' + cols.map(function (ws) {
      return '<div class="sps-col">' + ws.map(function (w) {
        let h = '<div class="sps-widget"><div class="sps-widget-t">' + esc(w.title) + '</div>';
        if (w.type === 'note') h += '<div class="sps-note">' + esc(w.text).replace(/\n/g, '<br>') + '</div>';
        else h += '<ul class="sps-links">' + w.items.map(function (it) {
          return '<li><span class="sps-fav" style="background:' + letterColor(hostOf(it.url)) + '">' + esc((hostOf(it.url) || '?').charAt(0).toUpperCase()) + '</span><a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title || hostOf(it.url) || it.url) + '</a></li>';
        }).join('') + '</ul>';
        return h + '</div>';
      }).join('') + '</div>';
    }).join('') + '</div>';
  }

  // ---------------- 彈窗 ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function popupAt(anchor, title, cls) {
    closePop();
    const p = el('div', 'sp-pop' + (cls ? ' ' + cls : ''));
    const head = el('div', 'sp-pop-head');
    head.appendChild(el('span', 'sp-pop-title', esc(title)));
    const x = el('button', 'sp-pop-x', ic('x')); x.type = 'button'; x.title = '關閉';
    x.addEventListener('click', closePop);
    head.appendChild(x);
    p.appendChild(head);
    const body = el('div', 'sp-pop-body');
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
  document.addEventListener('mousedown', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); }, true);
  function menu(anchor, title, items, onPick) {
    const body = popupAt(anchor, title, 'sp-pop-menu');
    items.forEach(function (it) {
      if (!it) { body.appendChild(el('div', 'sp-pop-sep')); return; }
      const b = el('button', 'sp-pop-item' + (it[2] === 'danger' ? ' is-danger' : ''), esc(it[1]));
      b.type = 'button';
      if (it[2] === true) b.disabled = true;
      b.addEventListener('click', function () { closePop(); onPick(it[0]); });
      body.appendChild(b);
    });
  }

  // ---------------- 整頁 ----------------
  // opts: { container, pages: [note], current: id, onSelect(id), onCreate({title,bg}), onRename(note, title),
  //         onChange(note, content), onDelete(note), readOnly(note) }
  function render(container, opts) {
    const pages = (opts.pages || []).slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    let note = pages.find(function (n) { return n.id === opts.current; }) || pages[0] || null;
    container.innerHTML = '';
    container.classList.add('sp-page');
    const head = el('div', 'sp-head');
    // 分頁
    const tabs = el('div', 'sp-tabs');
    pages.forEach(function (n) {
      const t = el('button', 'sp-tab' + (note && n.id === note.id ? ' on' : ''), esc(n.title || '起始頁'));
      t.type = 'button'; t.setAttribute('data-page', n.id); t.title = n.title + '（雙擊改名、右鍵更多）';
      t.addEventListener('click', function (e) {
        if (e.detail === 2) { rename(n); return; }
        if (!note || n.id !== note.id) opts.onSelect(n.id);
      });
      t.addEventListener('contextmenu', function (e) { e.preventDefault(); pageMenu(t, n); });
      tabs.appendChild(t);
    });
    const add = el('button', 'sp-tab-add', ic('plus')); add.type = 'button'; add.title = '新增一頁起始頁';
    add.addEventListener('click', function () { createPop(add); });
    tabs.appendChild(add);
    head.appendChild(tabs);
    const p = note ? pageOf(note) : null;
    const ro = !!(note && opts.readOnly && opts.readOnly(note));
    // 搜尋框（start.me 最上面那個）
    if (p && p.search !== 'none') {
      const form = el('form', 'sp-search');
      const sel = el('select', 'sp-search-engine');
      Object.keys(ENGINES).forEach(function (k) { const o = el('option', null, ENGINES[k].name); o.value = k; if (k === p.search) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { if (ro) return; p.search = sel.value; save(); });
      form.appendChild(sel);
      const inp = el('input', 'sp-search-input'); inp.type = 'search'; inp.placeholder = '搜尋…'; inp.autocomplete = 'off';
      form.appendChild(inp);
      const go = el('button', 'sp-search-go', ic('arrow-right')); go.type = 'submit'; go.title = '搜尋（開新分頁）';
      form.appendChild(go);
      const doSearch = function () {
        const q = inp.value.trim();
        if (!q) return;
        const eng = ENGINES[sel.value] || ENGINES.google;
        window.open(eng.url + encodeURIComponent(q), '_blank', 'noopener');
      };
      form.addEventListener('submit', function (e) { e.preventDefault(); doSearch(); });
      // Enter 自己接（不靠瀏覽器的隱含送出，鍵盤事件沒帶 char 時它不會發）
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
      head.appendChild(form);
    } else head.appendChild(el('div', 'sp-head-sp'));
    if (note && !ro) {
      const more = el('button', 'sp-head-btn', ic('more-horizontal') + '<span>頁面</span>'); more.type = 'button';
      more.addEventListener('click', function () { pageMenu(more, note); });
      head.appendChild(more);
    }
    container.appendChild(head);
    if (!note) {
      const empty = el('div', 'sp-empty', ic('layout-grid') + '<p>還沒有起始頁。按上面的「＋」建立第一頁，把常用的網站整理成書籤。</p>');
      const b = el('button', 'sp-btn sp-btn-primary', '建立起始頁'); b.type = 'button';
      b.addEventListener('click', function () { createPop(b); });
      empty.appendChild(b);
      container.appendChild(empty);
      container.style.background = '';
      container.classList.remove('is-dark');
      return;
    }
    container.style.background = bgHex(p.bg);
    container.classList.toggle('is-dark', DARK_BG.indexOf(p.bg) >= 0);

    function save() { if (ro) return; opts.onChange(note, wrap(serialize(p))); }
    function mutate(fn) { fn(); save(); drawColumns(); }
    function rename(n) {
      if (opts.readOnly && opts.readOnly(n)) return;
      const ask = global.App && App.prompt ? App.prompt({ title: '重新命名頁面', placeholder: '頁面名稱', value: n.title, ok: '確定' }) : Promise.resolve(window.prompt('頁面名稱', n.title));
      ask.then(function (t) { t = String(t || '').trim().slice(0, 200); if (t && t !== n.title) opts.onRename(n, t); });
    }
    function pageMenu(anchor, n) {
      if (opts.readOnly && opts.readOnly(n)) return;
      const cur = n.id === note.id;
      menu(anchor, '頁面', [['rename', '重新命名'], ['bg', '背景顏色', !cur], ['cols', '欄數', !cur], ['search', p && p.search === 'none' ? '顯示搜尋框' : '隱藏搜尋框', !cur], null, ['del', '移到垃圾桶', 'danger']], function (a) {
        if (a === 'rename') rename(n);
        else if (a === 'bg') {
          const body = popupAt(anchor, '背景顏色');
          const grid = el('div', 'sp-bg-grid');
          BG.forEach(function (bgc) {
            const b = el('button', 'sp-bg-swatch' + (bgc.key === p.bg ? ' is-on' : '')); b.type = 'button'; b.style.background = bgc.hex; b.title = bgc.key; b.setAttribute('data-bg', bgc.key);
            b.addEventListener('click', function () { closePop(); p.bg = bgc.key; save(); container.style.background = bgc.hex; container.classList.toggle('is-dark', DARK_BG.indexOf(bgc.key) >= 0); });
            grid.appendChild(b);
          });
          body.appendChild(grid);
        } else if (a === 'cols') {
          const body = popupAt(anchor, '欄數');
          const row = el('div', 'sp-cols-row');
          [2, 3, 4, 5].forEach(function (k) {
            const b = el('button', 'sp-btn' + (k === p.columns ? ' sp-btn-primary' : ''), k + ' 欄'); b.type = 'button';
            b.addEventListener('click', function () { closePop(); mutate(function () { p.columns = k; p.widgets.forEach(function (w) { if (w.col >= k) w.col = k - 1; }); }); });
            row.appendChild(b);
          });
          body.appendChild(row);
        } else if (a === 'search') { p.search = p.search === 'none' ? 'google' : 'none'; save(); opts.onSelect(note.id); }
        else if (a === 'del') opts.onDelete(n);
      });
    }
    function createPop(anchor) {
      const body = popupAt(anchor, '新增起始頁');
      body.appendChild(el('div', 'sp-pop-label', '名稱'));
      const inp = el('input', 'sp-input'); inp.type = 'text'; inp.placeholder = '例如：工作、滲透測試工具'; inp.maxLength = 200;
      body.appendChild(inp);
      const go = el('button', 'sp-btn sp-btn-primary sp-btn-wide', '建立'); go.type = 'button';
      const doit = function () { const t = inp.value.trim(); if (!t) { inp.focus(); return; } closePop(); opts.onCreate({ title: t, bg: 'grey' }); };
      go.addEventListener('click', doit);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doit(); } if (e.key === 'Escape') closePop(); });
      body.appendChild(go);
      setTimeout(function () { inp.focus(); }, 0);
    }

    // ---- 欄位與小工具 ----
    const colsEl = el('div', 'sp-cols');
    container.appendChild(colsEl);
    let drag = null, ph = null;
    function placeholder(h) { if (!ph) ph = el('div', 'sp-placeholder'); ph.style.height = (h || 48) + 'px'; return ph; }
    function clearPh() { if (ph && ph.parentNode) ph.parentNode.removeChild(ph); }
    function widgetsIn(col) { return p.widgets.filter(function (w) { return w.col === col; }); }
    function widgetById(id) { return p.widgets.find(function (w) { return w.id === id; }); }
    function findItem(id) {
      for (let i = 0; i < p.widgets.length; i++) { const w = p.widgets[i]; for (let k = 0; k < w.items.length; k++) if (w.items[k].id === id) return { w: w, item: w.items[k], index: k }; }
      return null;
    }
    function drawColumns() {
      colsEl.innerHTML = '';
      colsEl.style.gridTemplateColumns = 'repeat(' + p.columns + ', minmax(0, 1fr))';
      for (let c = 0; c < p.columns; c++) {
        const col = el('div', 'sp-col');
        col.setAttribute('data-col', c);
        widgetsIn(c).forEach(function (w) { col.appendChild(widgetEl(w)); });
        if (!ro) {
          const addW = el('button', 'sp-add-widget', ic('plus') + '<span>新增小工具</span>'); addW.type = 'button';
          addW.addEventListener('click', function () { addWidgetPop(addW, c); });
          col.appendChild(addW);
          col.addEventListener('dragover', function (e) {
            if (!drag || drag.type !== 'widget') return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            const ws = Array.prototype.filter.call(col.querySelectorAll('.sp-widget'), function (x) { return !x.classList.contains('is-dragging'); });
            let idx = ws.length;
            for (let i = 0; i < ws.length; i++) { const r = ws[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { idx = i; break; } }
            const pl = placeholder(drag.h);
            if (idx >= ws.length) col.insertBefore(pl, addW); else col.insertBefore(pl, ws[idx]);
          });
          col.addEventListener('drop', function (e) {
            if (!drag || drag.type !== 'widget') return;
            e.preventDefault();
            const ws = Array.prototype.filter.call(col.querySelectorAll('.sp-widget'), function (x) { return !x.classList.contains('is-dragging'); });
            const idx = ph && ph.parentNode === col ? Array.prototype.indexOf.call(col.children, ph) : ws.length;
            clearPh();
            const w = widgetById(drag.id);
            if (!w) return;
            // 把它插到這一欄「畫面上第 idx 個」小工具之前：先從 widgets 拿掉，再算目標位置
            mutate(function () {
              p.widgets.splice(p.widgets.indexOf(w), 1);
              const here = p.widgets.filter(function (x) { return x.col === c; });
              let visible = 0, target = null;
              for (let i = 0; i < here.length; i++) { if (visible === idx) { target = here[i]; break; } visible++; }
              w.col = c;
              const at = target ? p.widgets.indexOf(target) : p.widgets.length;
              p.widgets.splice(at, 0, w);
            });
          });
        }
        colsEl.appendChild(col);
      }
    }
    function widgetEl(w) {
      const box = el('div', 'sp-widget sp-widget-' + w.type);
      box.setAttribute('data-widget', w.id);
      const head = el('div', 'sp-widget-head');
      head.draggable = !ro;
      const title = el('button', 'sp-widget-title', esc(w.title || (w.type === 'note' ? '便條' : '書籤'))); title.type = 'button';
      if (!ro) title.addEventListener('click', function () {
        const inp = el('input', 'sp-widget-title-input'); inp.type = 'text'; inp.value = w.title; inp.maxLength = 200;
        head.replaceChild(inp, title); inp.focus(); inp.select();
        const done = function () { const v = inp.value.trim(); if (v !== w.title) mutate(function () { w.title = v; }); else drawColumns(); };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') { inp.value = w.title; inp.blur(); } });
      });
      head.appendChild(title);
      if (!ro) {
        const more = el('button', 'sp-widget-more', ic('more-horizontal')); more.type = 'button'; more.title = '小工具動作';
        more.addEventListener('click', function () {
          menu(more, w.title || '小工具', [['rename', '重新命名'], ['left', '往左欄移', w.col === 0], ['right', '往右欄移', w.col >= p.columns - 1], null, ['del', '刪除小工具', 'danger']], function (a) {
            if (a === 'rename') title.click();
            else if (a === 'left' || a === 'right') mutate(function () { w.col += a === 'left' ? -1 : 1; });
            else if (a === 'del') {
              const n = w.type === 'links' ? w.items.length + ' 個書籤' : '這段文字';
              const ask = global.App && App.confirm ? App.confirm({ title: '刪除小工具', message: '刪除「' + (w.title || '小工具') + '」和裡面的 ' + n + '？', ok: '刪除', danger: true }) : Promise.resolve(window.confirm('刪除？'));
              ask.then(function (yes) { if (yes) mutate(function () { p.widgets.splice(p.widgets.indexOf(w), 1); }); });
            }
          });
        });
        head.appendChild(more);
        head.addEventListener('dragstart', function (e) {
          if (e.target.closest('.sp-widget-more')) { e.preventDefault(); return; }
          drag = { type: 'widget', id: w.id, h: box.offsetHeight };
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', w.title); } catch (err) { /* */ }
          setTimeout(function () { box.classList.add('is-dragging'); }, 0);
        });
        head.addEventListener('dragend', function () { box.classList.remove('is-dragging'); clearPh(); drag = null; });
      }
      box.appendChild(head);
      if (w.type === 'note') {
        const ta = el('textarea', 'sp-note'); ta.value = w.text; ta.placeholder = '在這裡打字…'; ta.readOnly = ro; ta.rows = 4;
        const fit = function () { ta.style.height = 'auto'; ta.style.height = Math.max(80, ta.scrollHeight) + 'px'; };
        let timer = null;
        ta.addEventListener('input', function () { fit(); if (ro) return; w.text = ta.value; clearTimeout(timer); timer = setTimeout(save, 600); });
        ta.addEventListener('blur', function () { if (timer) { clearTimeout(timer); timer = null; save(); } });
        box.appendChild(ta);
        setTimeout(fit, 0);
      } else {
        const list = el('div', 'sp-links');
        w.items.forEach(function (it) { list.appendChild(linkEl(it, w)); });
        if (!w.items.length) list.appendChild(el('div', 'sp-links-empty', ro ? '沒有書籤。' : '還沒有書籤，按下面的「＋ 新增書籤」。'));
        if (!ro) {
          list.addEventListener('dragover', function (e) {
            if (!drag || drag.type !== 'link') return;
            e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
            const rows = Array.prototype.filter.call(list.querySelectorAll('.sp-link'), function (x) { return !x.classList.contains('is-dragging'); });
            let idx = rows.length;
            for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { idx = i; break; } }
            const pl = placeholder(32);
            if (idx >= rows.length) list.appendChild(pl); else list.insertBefore(pl, rows[idx]);
          });
          list.addEventListener('drop', function (e) {
            if (!drag || drag.type !== 'link') return;
            e.preventDefault(); e.stopPropagation();
            const rows = Array.prototype.filter.call(list.querySelectorAll('.sp-link'), function (x) { return !x.classList.contains('is-dragging'); });
            let idx = rows.length;
            if (ph && ph.parentNode === list) { idx = 0; for (let i = 0; i < list.children.length; i++) { if (list.children[i] === ph) break; if (list.children[i].classList.contains('sp-link') && !list.children[i].classList.contains('is-dragging')) idx++; } }
            clearPh();
            const src = findItem(drag.id);
            if (!src) return;
            mutate(function () {
              src.w.items.splice(src.index, 1);
              if (src.w === w && src.index < idx) idx--;
              w.items.splice(Math.min(idx, w.items.length), 0, src.item);
            });
          });
        }
        box.appendChild(list);
        if (!ro) box.appendChild(addLinkEl(w));
      }
      return box;
    }
    function linkEl(it, w) {
      const row = el('div', 'sp-link');
      row.setAttribute('data-link', it.id);
      row.draggable = !ro;
      const a = el('a', 'sp-link-a');
      a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = it.url;
      a.appendChild(favEl(it));
      a.appendChild(el('span', 'sp-link-t', esc(it.title || hostOf(it.url) || it.url)));
      row.appendChild(a);
      if (!ro) {
        const acts = el('span', 'sp-link-acts');
        const ed = el('button', 'sp-link-btn', ic('pencil')); ed.type = 'button'; ed.title = '編輯';
        ed.addEventListener('click', function (e) { e.preventDefault(); editLinkPop(ed, it, w); });
        const del = el('button', 'sp-link-btn', ic('x')); del.type = 'button'; del.title = '刪除';
        del.addEventListener('click', function (e) { e.preventDefault(); mutate(function () { w.items.splice(w.items.indexOf(it), 1); }); });
        acts.appendChild(ed); acts.appendChild(del);
        row.appendChild(acts);
        row.addEventListener('dragstart', function (e) {
          drag = { type: 'link', id: it.id };
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/uri-list', it.url); e.dataTransfer.setData('text/plain', it.url); } catch (err) { /* */ }
          e.stopPropagation();
          setTimeout(function () { row.classList.add('is-dragging'); }, 0);
        });
        row.addEventListener('dragend', function () { row.classList.remove('is-dragging'); clearPh(); drag = null; });
      }
      return row;
    }
    // 貼網址就自己抓標題跟 favicon（start.me 也是）：走 /api/link-preview
    function fetchMeta(url) {
      if (!global.Store || !Store.getLinkPreview) return Promise.resolve(null);
      return Store.getLinkPreview(url).then(function (info) { return info && !info.error ? info : null; }, function () { return null; });
    }
    function addLinkEl(w) {
      const foot = el('div', 'sp-widget-foot');
      const btn = el('button', 'sp-add-link', ic('plus') + '<span>新增書籤</span>'); btn.type = 'button';
      btn.addEventListener('click', function () {
        foot.innerHTML = '';
        const form = el('div', 'sp-link-form');
        const url = el('input', 'sp-input'); url.type = 'url'; url.placeholder = '貼上網址…'; url.setAttribute('data-f', 'url');
        const ttl = el('input', 'sp-input'); ttl.type = 'text'; ttl.placeholder = '名稱（空著會自己抓）'; ttl.maxLength = 300;
        const row = el('div', 'sp-form-row');
        const ok = el('button', 'sp-btn sp-btn-primary', '新增'); ok.type = 'button';
        const x = el('button', 'sp-link-btn', ic('x')); x.type = 'button'; x.title = '取消（Esc）';
        row.appendChild(ok); row.appendChild(x);
        form.appendChild(url); form.appendChild(ttl); form.appendChild(row);
        foot.appendChild(form);
        let fetched = null;
        const look = function () {
          const u = safeUrl(url.value);
          if (!u || (fetched && fetched.url === u)) return;
          fetched = { url: u, info: null, pending: fetchMeta(u) };
          fetched.pending.then(function (info) { if (fetched && fetched.url === u) { fetched.info = info; if (info && info.title && !ttl.value.trim()) ttl.placeholder = info.title; } });
        };
        url.addEventListener('change', look); url.addEventListener('blur', look);
        url.addEventListener('paste', function () { setTimeout(look, 0); });
        const submit = function () {
          const u = safeUrl(url.value);
          if (!u) { url.focus(); return; }
          ok.disabled = true;
          look();
          (fetched && fetched.url === u ? fetched.pending : Promise.resolve(null)).then(function (info) {
            const item = { id: uid('b'), url: u, title: ttl.value.trim() || (info && info.title) || hostOf(u), icon: (info && info.icon) || '' };
            mutate(function () { w.items.push(item); });
            // 重畫之後再開一次表單，繼續貼下一個
            const again = colsEl.querySelector('.sp-widget[data-widget="' + w.id + '"] .sp-add-link');
            if (again) { again.click(); const f = colsEl.querySelector('.sp-widget[data-widget="' + w.id + '"] .sp-link-form input'); if (f) f.focus(); }
          });
        };
        const cancel = function () { drawColumns(); };
        ok.addEventListener('click', submit);
        x.addEventListener('click', cancel);
        [url, ttl].forEach(function (f) { f.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }); });
        setTimeout(function () { url.focus(); }, 0);
      });
      foot.appendChild(btn);
      return foot;
    }
    function editLinkPop(anchor, it, w) {
      const body = popupAt(anchor, '編輯書籤');
      body.appendChild(el('div', 'sp-pop-label', '名稱'));
      const ttl = el('input', 'sp-input'); ttl.type = 'text'; ttl.value = it.title; ttl.maxLength = 300;
      body.appendChild(ttl);
      body.appendChild(el('div', 'sp-pop-label', '網址'));
      const url = el('input', 'sp-input'); url.type = 'url'; url.value = it.url;
      body.appendChild(url);
      const row = el('div', 'sp-form-row');
      const ok = el('button', 'sp-btn sp-btn-primary', '儲存'); ok.type = 'button';
      ok.addEventListener('click', function () {
        const u = safeUrl(url.value);
        if (!u) { url.focus(); return; }
        closePop();
        const changedUrl = u !== it.url;
        mutate(function () { it.title = ttl.value.trim() || it.title; it.url = u; if (changedUrl) it.icon = ''; });
        if (changedUrl) fetchMeta(u).then(function (info) { if (info && info.icon) mutate(function () { it.icon = info.icon; }); });
      });
      const del = el('button', 'sp-btn sp-btn-danger', '刪除'); del.type = 'button';
      del.addEventListener('click', function () { closePop(); mutate(function () { w.items.splice(w.items.indexOf(it), 1); }); });
      row.appendChild(ok); row.appendChild(del);
      body.appendChild(row);
      [ttl, url].forEach(function (f) { f.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } }); });
      setTimeout(function () { ttl.focus(); ttl.select(); }, 0);
    }
    function addWidgetPop(anchor, col) {
      const body = popupAt(anchor, '新增小工具');
      body.appendChild(el('div', 'sp-pop-label', '類型'));
      let type = 'links';
      const seg = el('div', 'sp-seg');
      [['links', '書籤'], ['note', '便條']].forEach(function (t) {
        const b = el('button', 'sp-seg-btn' + (t[0] === type ? ' on' : ''), esc(t[1])); b.type = 'button'; b.setAttribute('data-type', t[0]);
        b.addEventListener('click', function () { type = t[0]; seg.querySelectorAll('.sp-seg-btn').forEach(function (q) { q.classList.toggle('on', q === b); }); });
        seg.appendChild(b);
      });
      body.appendChild(seg);
      body.appendChild(el('div', 'sp-pop-label', '標題'));
      const inp = el('input', 'sp-input'); inp.type = 'text'; inp.placeholder = '例如：工具、情資'; inp.maxLength = 200;
      body.appendChild(inp);
      const go = el('button', 'sp-btn sp-btn-primary sp-btn-wide', '新增'); go.type = 'button';
      const doit = function () { closePop(); mutate(function () { p.widgets.push(newWidget(type, inp.value.trim() || (type === 'note' ? '便條' : '書籤'), col)); }); };
      go.addEventListener('click', doit);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doit(); } });
      body.appendChild(go);
      setTimeout(function () { inp.focus(); }, 0);
    }
    drawColumns();
  }

  function onKey(e) { if (e.key === 'Escape' && popEl) { closePop(); e.stopPropagation(); } }
  document.addEventListener('keydown', onKey, true);
  function teardown(container) { closePop(); container.innerHTML = ''; container.style.background = ''; container.classList.remove('sp-page', 'is-dark'); }

  global.StartPage = {
    isNote: isNote, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, pageOf: pageOf,
    blockHTML: blockHTML, render: render, teardown: teardown, closePop: closePop, BG: BG, ENGINES: ENGINES
  };
})(window);
