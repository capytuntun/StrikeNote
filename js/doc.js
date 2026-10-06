/* doc.js — 文件：所見即所得的編輯器，長得像 Google 文件。
 *
 * 一份文件是一篇 meta.doc 的筆記，內容直接存 HTML（不是 Markdown——使用者要的是「所見即所得、
 * 工具列排版、不用 Markdown」）。存進去之前先過 DOMPurify，讀回來也過一次；圖片存成
 * <img data-img-id="<id>" src="img:<id>">：src 裡那個 img:<id> 是伺服器判斷「誰看得到這張圖」的
 * 依據（跟 Markdown 筆記的 ![](img:id) 同一條規則），預覽時 DOMPurify 會把這個不合法的 src 拿掉、
 * 留下 data-img-id，markdown.js 的 resolveImages 就照常把圖補上；在編輯器裡則換成 /api/images/<id>
 * 直接顯示。預覽、PDF、電子書走 MD.render()：一整段 HTML，marked 原樣放行、DOMPurify 清過。
 *
 * 工具列照 Google 文件：復原／重做、樣式（一般文字、標題 1–4、引言）、字型、字級（− 數字 ＋）、
 * 粗體／斜體／底線／刪除線、文字顏色／螢光筆、連結、圖片、對齊（左／中／右／兩端）、項目符號／
 * 編號、縮排／減少縮排、表格、分隔線、清除格式。頁面是一張白紙（816px、1 吋邊界）放在灰底上。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  // 字型：v 是寫進 style 的 font-family，label 給人看。標楷體在 Windows 是 DFKai-SB，macOS 是 BiauKai，
  // 都沒有時退到 serif（至少看得出是楷體那一類）
  const FONTS = [
    { v: 'Arial', label: 'Arial' }, { v: 'Times New Roman', label: 'Times New Roman' }, { v: 'Georgia', label: 'Georgia' },
    { v: 'Verdana', label: 'Verdana' }, { v: 'Courier New', label: 'Courier New' },
    { v: 'Noto Sans TC', label: 'Noto Sans TC' }, { v: 'Microsoft JhengHei', label: '微軟正黑體' },
    { v: 'DFKai-SB, BiauKai, 標楷體, serif', label: '標楷體' }, { v: 'PMingLiU, 新細明體, serif', label: '新細明體' }
  ];
  const CM = 96 / 2.54;   // 一公分幾個像素（CSS 的 1in = 96px）
  const PAPER_W = 816, MARGIN_DEF = 96;
  const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36];
  const STYLES = [['p', '一般文字'], ['h1', '標題 1'], ['h2', '標題 2'], ['h3', '標題 3'], ['h4', '標題 4'], ['blockquote', '引言']];
  // Google 文件調色盤的前兩排＋一排常用色
  const COLORS = ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
    '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
    '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'];
  const HILITES = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff9900', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3', 'none'];

  const IMG_RE = /^img:([A-Za-z0-9_][\w.-]{0,63})$/;
  function sanitize(html) {
    if (!global.DOMPurify) return String(html || '');
    return DOMPurify.sanitize(String(html || ''), {
      ADD_ATTR: ['target', 'data-img-id'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
      ALLOW_DATA_ATTR: true
    });
  }
  function isNote(note) { return !!(note && note.meta && note.meta.doc); }
  function generate() { return ''; }
  // 存檔前：圖片的 src 換回 img:<id>（伺服器靠它判斷可見性），把編輯器自己加的東西拿掉
  function toStored(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('img').forEach(function (img) {
      let id = img.getAttribute('data-img-id');
      if (!id) { const m = /\/api\/images\/([A-Za-z0-9_][\w.-]{0,63})$/.exec(img.getAttribute('src') || ''); if (m) id = m[1]; }
      if (id) { img.setAttribute('data-img-id', id); img.setAttribute('src', 'img:' + id); }
    });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    return clone.innerHTML;
  }
  // 讀進編輯器：清過，圖片換成看得到的網址
  function toLive(html) {
    const box = document.createElement('div');
    box.innerHTML = sanitize(html);
    box.querySelectorAll('img').forEach(function (img) {
      const id = img.getAttribute('data-img-id') || (IMG_RE.exec(img.getAttribute('src') || '') || [])[1];
      if (id) { img.setAttribute('data-img-id', id); img.setAttribute('src', '/api/images/' + id); }
    });
    box.querySelectorAll('a').forEach(function (a) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); });
    return box.innerHTML;
  }
  function textOf(html) { const d = document.createElement('div'); d.innerHTML = sanitize(html); return d.textContent || ''; }

  // ---------------- 彈窗 ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function popupAt(anchor, cls) {
    closePop();
    const p = el('div', 'gd-pop' + (cls ? ' ' + cls : ''));
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - 300)) + 'px';
    p.style.top = (r.bottom + 4) + 'px';
    popEl = p;
    return p;
  }
  document.addEventListener('mousedown', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); }, true);

  // ---------------- 編輯器 ----------------
  // opts: { container, readOnly, banner, onChange(html), onUpload(files) → Promise<[{ id, alt }]> }
  function open(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    const ro = !!opts.readOnly;
    let closed = false, dirty = false, saveTimer = null, savedRange = null;

    host.classList.add('gd-page');
    host.innerHTML =
      (opts.banner ? '<div class="gd-ro">' + ic('lock') + '<span>' + esc(opts.banner) + '</span></div>' : '') +
      (ro ? '' :
      '<div class="gd-toolbar">' +
      tb('undo', 'undo', '復原 (Ctrl+Z)') + tb('redo', 'redo', '重做 (Ctrl+Y)') + sep() +
      '<select class="gd-sel gd-sel-style" data-sel="style" title="樣式">' + STYLES.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') + '</select>' + sep() +
      '<select class="gd-sel gd-sel-font" data-sel="font" title="字型">' + FONTS.map(function (f) { return '<option value="' + esc(f.v) + '" style="font-family:' + esc(f.v) + '">' + esc(f.label) + '</option>'; }).join('') + '</select>' + sep() +
      '<button class="gd-tb gd-size-btn" type="button" data-act="size-" title="縮小字級">' + ic('minus') + '</button>' +
      '<input class="gd-size" type="text" inputmode="numeric" value="11" title="字級（pt）" aria-label="字級">' +
      '<button class="gd-tb gd-size-btn" type="button" data-act="size+" title="放大字級">' + ic('plus') + '</button>' + sep() +
      tb('bold', 'bold', '粗體 (Ctrl+B)') + tb('italic', 'italic', '斜體 (Ctrl+I)') + tb('underline', 'underline', '底線 (Ctrl+U)') + tb('strikeThrough', 'strikethrough', '刪除線') +
      '<button class="gd-tb gd-color-btn" type="button" data-act="color" title="文字顏色">' + ic('type') + '<span class="gd-color-bar" style="background:#000"></span></button>' +
      '<button class="gd-tb gd-color-btn" type="button" data-act="hilite" title="螢光筆顏色">' + ic('highlighter') + '<span class="gd-color-bar" style="background:#ffff00"></span></button>' + sep() +
      tb('link', 'link', '插入連結 (Ctrl+K)') + tb('image', 'image', '插入圖片') + sep() +
      tb('justifyLeft', 'align-left', '靠左對齊') + tb('justifyCenter', 'align-center', '置中對齊') + tb('justifyRight', 'align-right', '靠右對齊') + tb('justifyFull', 'align-justify', '左右對齊') + tb('distribute', 'align-distribute', '分散對齊（字與字拉開撐滿整行，最後一行也是）') + sep() +
      tb('insertUnorderedList', 'list', '項目符號清單') + tb('insertOrderedList', 'list-ordered', '編號清單') + tb('outdent', 'outdent', '減少縮排') + tb('indent', 'indent', '增加縮排') + sep() +
      tb('table', 'table', '插入表格') + tb('hr', 'minus', '分隔線') + tb('removeFormat', 'eraser', '清除格式') +
      '<span class="gd-tb-sp"></span><span class="gd-count"></span><span class="gd-status" aria-live="polite"></span>' +
      '</div>') +
      '<div class="gd-scroll">' + (ro ? '' : '<div class="gd-ruler" aria-hidden="true"><div class="gd-ruler-in"><div class="gd-ruler-shade gd-ruler-shade-l"></div><div class="gd-ruler-shade gd-ruler-shade-r"></div><div class="gd-ruler-scale"></div>' +
      '<div class="gd-rm gd-rm-margin-l" data-rm="ml" title="左邊界"></div><div class="gd-rm gd-rm-margin-r" data-rm="mr" title="右邊界"></div>' +
      '<div class="gd-rm gd-rm-first" data-rm="first" title="首行縮排"></div><div class="gd-rm gd-rm-indent" data-rm="indent" title="左縮排"></div></div></div>') +
      '<div class="gd-paper markdown-body"' + (ro ? '' : ' contenteditable="true" spellcheck="true"') + '></div></div>';
    function tb(act, icon, title) { return '<button class="gd-tb" type="button" data-act="' + act + '" title="' + title + '">' + ic(icon) + '</button>'; }
    function sep() { return '<span class="gd-tb-sep"></span>'; }

    const paper = host.querySelector('.gd-paper');
    const toolbar = host.querySelector('.gd-toolbar');
    const statusEl = host.querySelector('.gd-status');
    const countEl = host.querySelector('.gd-count');
    const sizeEl = host.querySelector('.gd-size');
    const styleSel = host.querySelector('[data-sel="style"]');
    const fontSel = host.querySelector('[data-sel="font"]');
    paper.innerHTML = toLive(content) || '<p><br></p>';
    // 邊界（meta.docMargins，px）：紙的左右 padding；尺規上的兩個灰色邊界標記拖它
    let margins = Object.assign({ l: MARGIN_DEF, r: MARGIN_DEF }, opts.margins || {});
    function applyMargins() {
      margins.l = Math.max(24, Math.min(PAPER_W / 2 - 60, Math.round(margins.l)));
      margins.r = Math.max(24, Math.min(PAPER_W / 2 - 60, Math.round(margins.r)));
      paper.style.paddingLeft = margins.l + 'px'; paper.style.paddingRight = margins.r + 'px';
      drawRuler();
    }
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, true); } catch (e) { /* */ }

    function setStatus(t, cls) { if (statusEl) { statusEl.textContent = t || ''; statusEl.className = 'gd-status' + (cls ? ' ' + cls : ''); } }
    function count() { if (countEl) { const n = (paper.textContent || '').replace(/\s+/g, '').length; countEl.textContent = n ? n + ' 字' : ''; } }
    function emit() {
      clearTimeout(saveTimer);
      if (!dirty || !opts.onChange) return Promise.resolve();
      dirty = false;
      setStatus('儲存中…');
      return Promise.resolve(opts.onChange(toStored(paper))).then(function () { if (!closed && !dirty) setStatus('已儲存', 'is-ok'); }, function () { if (!closed) setStatus('儲存失敗', 'is-err'); });
    }
    function changed() { dirty = true; setStatus('尚未儲存'); clearTimeout(saveTimer); saveTimer = setTimeout(emit, 500); count(); }

    // ---- 選取範圍：工具列按下去會搶焦點，先記住再還回去 ----
    function saveRange() {
      const s = window.getSelection();
      if (s && s.rangeCount && paper.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    }
    // 選取還在紙上（按鈕的 mousedown 有 preventDefault，焦點沒跑）就用現在這個；焦點跑到 select／輸入框
    // 去了才把記住的那個放回來
    function restoreRange() {
      const s = window.getSelection();
      if (s && s.rangeCount && paper.contains(s.anchorNode) && document.activeElement === paper) return;
      paper.focus();
      if (!savedRange) return;
      s.removeAllRanges(); s.addRange(savedRange);
    }
    function exec(cmd, val) {
      restoreRange();
      try { document.execCommand(cmd, false, val); } catch (e) { /* */ }
      saveRange();
      changed(); refresh();
    }
    // 字級：execCommand 只認 1–7，先打 7 再把 <font size="7"> 換成 span style（Google 文件的字級單位是 pt）
    const FONT_SIZE_PT = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 24, 7: 36 };
    let pendingPt = null;
    // Chrome 偶爾還是會留下 <font size=N>（例如改字級後才打的字）：一律換成 span style
    function normalizeFonts() {
      let changedAny = false;
      paper.querySelectorAll('font[size]').forEach(function (f) {
        const span = document.createElement('span');
        const n = parseInt(f.getAttribute('size'), 10);
        span.style.fontSize = ((n === 7 && pendingPt) ? pendingPt : (FONT_SIZE_PT[n] || 11)) + 'pt';
        if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
        if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
        while (f.firstChild) span.appendChild(f.firstChild);
        f.parentNode.replaceChild(span, f);
        changedAny = true;
      });
      return changedAny;
    }
    function setFontSize(pt) {
      pt = Math.max(6, Math.min(96, Math.round(pt)));
      restoreRange();
      pendingPt = pt;
      const sel0 = window.getSelection();
      if (sel0 && sel0.isCollapsed) {
        // 沒選字：放一個帶字級的 span，游標進去，接下來打的字就是這個大小
        document.execCommand('insertHTML', false, '<span style="font-size:' + pt + 'pt">\u200B</span>');
        const s2 = window.getSelection();
        let n = s2 && s2.anchorNode;
        if (n && n.nodeType === 3 && n.nodeValue === '\u200B') { const r = document.createRange(); r.setStart(n, 1); r.collapse(true); s2.removeAllRanges(); s2.addRange(r); }
        saveRange(); changed(); refresh();
        if (sizeEl) sizeEl.value = String(pt);
        return;
      }
      try {
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontSize', false, '7');
      } finally { try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* */ } }
      const spans = [];
      paper.querySelectorAll('font[size="7"]').forEach(function (f) {
        const span = document.createElement('span');
        span.style.fontSize = pt + 'pt';
        while (f.firstChild) span.appendChild(f.firstChild);
        f.parentNode.replaceChild(span, f);
        spans.push(span);
      });
      // 選取改成剛換好的那幾個 span，之後量字級量到的才是它們（不是外面的標題）
      if (spans.length) {
        const r = document.createRange();
        r.setStart(spans[0], 0); r.setEnd(spans[spans.length - 1], spans[spans.length - 1].childNodes.length);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
      saveRange(); changed(); refresh();
      if (sizeEl) sizeEl.value = String(pt);
    }
    function currentSizePt() {
      const s = window.getSelection();
      let n = s && s.anchorNode;
      if (!n || !paper.contains(n)) return 11;
      if (n.nodeType === 3) n = n.parentNode;
      const px = parseFloat(getComputedStyle(n).fontSize) || 14.67;
      return Math.round(px * 0.75);
    }
    function blockOf() {
      const s = window.getSelection();
      let n = s && s.anchorNode;
      if (!n || !paper.contains(n)) return 'p';
      if (n.nodeType === 3) n = n.parentNode;
      const b = n.closest('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre');
      if (!b || b === paper) return 'p';
      const t = b.tagName.toLowerCase();
      return STYLES.some(function (x) { return x[0] === t; }) ? t : 'p';
    }
    // 選取範圍碰到的區塊元素（段落、標題、清單項目…）：對齊、縮排都是作用在它們上
    function blockOf1(n) {
      if (!n) return null;
      if (n.nodeType === 3) n = n.parentNode;
      const b = n.closest ? n.closest('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre,td,th') : null;
      return b && b !== paper && paper.contains(b) ? b : null;
    }
    function blocksInSelection() {
      const s = window.getSelection();
      if (!s || !s.rangeCount || !paper.contains(s.anchorNode)) return [];
      const r = s.getRangeAt(0);
      const a = blockOf1(r.startContainer), z = blockOf1(r.endContainer);
      if (!a) return [];
      if (a === z || !z) return [a];
      const out = [];
      const all = paper.querySelectorAll('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre,td,th');
      let on = false;
      for (let i = 0; i < all.length; i++) {
        if (all[i] === a) on = true;
        if (on && r.intersectsNode(all[i]) && !all[i].querySelector('p,li,h1,h2,h3,h4,h5,h6')) out.push(all[i]);
        if (all[i] === z) break;
      }
      return out.length ? out : [a];
    }
    // 分散對齊：Google 文件的「分散對齊」是連最後一行也撐滿（text-align-last），跟左右對齊不同
    function distribute() {
      restoreRange();
      const bs = blocksInSelection();
      if (!bs.length) return;
      bs.forEach(function (b) { b.style.textAlign = 'justify'; b.style.textAlignLast = 'justify'; b.style.textJustify = 'inter-character'; });
      saveRange(); changed(); refresh();
    }

    // ---- 尺規：公分刻度、左右邊界（紙的 padding）、目前段落的左縮排與首行縮排 ----
    let rulerListeners = null;
    const ruler = host.querySelector('.gd-ruler'), rulerIn = host.querySelector('.gd-ruler-in');
    function drawRuler() {
      if (!rulerIn) return;
      const scale = rulerIn.querySelector('.gd-ruler-scale');
      if (!scale.children.length) {
        // 刻度從左邊界的 0 往兩邊數；左邊界會動，所以刻度用 transform 整排平移
        let h = '';
        for (let cm = -6; cm <= 30; cm++) {
          for (let q = 0; q < 2; q++) {
            const x = (cm + q / 2) * CM;
            h += '<i class="gd-tick' + (q ? ' is-half' : ' is-cm') + '" style="left:' + x.toFixed(1) + 'px">' + (q ? '' : '<b>' + Math.abs(cm) + '</b>') + '</i>';
          }
        }
        scale.innerHTML = h;
      }
      scale.style.transform = 'translateX(' + margins.l + 'px)';
      rulerIn.querySelector('.gd-ruler-shade-l').style.width = margins.l + 'px';
      rulerIn.querySelector('.gd-ruler-shade-r').style.width = margins.r + 'px';
      rulerIn.querySelector('[data-rm="ml"]').style.left = margins.l + 'px';
      rulerIn.querySelector('[data-rm="mr"]').style.left = (PAPER_W - margins.r) + 'px';
      // 段落縮排：看游標所在的那一個區塊
      const bs = blocksInSelection();
      const b = bs[0];
      const ml = b ? (parseFloat(b.style.marginLeft) || 0) : 0, ti = b ? (parseFloat(b.style.textIndent) || 0) : 0;
      rulerIn.querySelector('[data-rm="indent"]').style.left = (margins.l + ml) + 'px';
      rulerIn.querySelector('[data-rm="first"]').style.left = (margins.l + ml + ti) + 'px';
    }
    if (ruler) {
      let rdrag = null;
      ruler.addEventListener('mousedown', function (e) {
        const m = e.target.closest('[data-rm]');
        if (!m) return;
        e.preventDefault();
        const rect = rulerIn.getBoundingClientRect();
        const bs = blocksInSelection();
        rdrag = { kind: m.getAttribute('data-rm'), x0: e.clientX, rect: rect, m0: Object.assign({}, margins), blocks: bs,
          ml0: bs[0] ? (parseFloat(bs[0].style.marginLeft) || 0) : 0, ti0: bs[0] ? (parseFloat(bs[0].style.textIndent) || 0) : 0 };
        ruler.classList.add('is-dragging');
      });
      const onRulerMove = function (e) {
        if (!rdrag) return;
        const dx = e.clientX - rdrag.x0;
        if (rdrag.kind === 'ml') { margins.l = rdrag.m0.l + dx; applyMargins(); }
        else if (rdrag.kind === 'mr') { margins.r = rdrag.m0.r - dx; applyMargins(); }
        else if (rdrag.kind === 'indent') {
          const v = Math.max(0, Math.min(PAPER_W - margins.l - margins.r - 40, rdrag.ml0 + dx));
          rdrag.blocks.forEach(function (b) { b.style.marginLeft = Math.round(v) + 'px'; });
          drawRuler();
        } else if (rdrag.kind === 'first') {
          const v = Math.max(-rdrag.ml0, Math.min(PAPER_W / 2, rdrag.ti0 + dx));
          rdrag.blocks.forEach(function (b) { b.style.textIndent = Math.round(v) + 'px'; });
          drawRuler();
        }
      };
      const onRulerUp = function () {
        if (!rdrag) return;
        const k = rdrag.kind; rdrag = null;
        ruler.classList.remove('is-dragging');
        if (k === 'ml' || k === 'mr') { if (opts.onMargins) opts.onMargins({ l: margins.l, r: margins.r }); }
        else changed();
      };
      document.addEventListener('mousemove', onRulerMove);
      document.addEventListener('mouseup', onRulerUp);
      rulerListeners = function () { document.removeEventListener('mousemove', onRulerMove); document.removeEventListener('mouseup', onRulerUp); };
    }

    // ---- 表格：拖格線改欄寬（Google 文件的做法：游標靠近直的格線變成 ↔，拖了只動相鄰兩欄） ----
    let colHit = null, colDrag = null;
    function cellAt(e) {
      const td = e.target.closest ? e.target.closest('td,th') : null;
      if (!td || !paper.contains(td)) return null;
      const r = td.getBoundingClientRect();
      const row = td.parentNode;
      let idx = Array.prototype.indexOf.call(row.children, td);
      // 格線是兩格共用的：游標落在這格的右緣，或下一格的左緣（border-collapse 下那 1px 常常算在右邊那格）
      if (Math.abs(e.clientX - r.right) <= 5) { if (idx >= row.children.length - 1) return null; }   // 最右邊那條是表格外框，不動
      else if (Math.abs(e.clientX - r.left) <= 5 && idx > 0) idx -= 1;
      else return null;
      return { table: td.closest('table'), idx: idx };
    }
    paper.addEventListener('mousemove', function (e) {
      if (ro || colDrag) return;
      colHit = cellAt(e);
      paper.classList.toggle('is-colresize', !!colHit);
    });
    paper.addEventListener('mousedown', function (e) {
      if (ro || !colHit || e.button !== 0) return;
      e.preventDefault();
      const t = colHit.table, first = t.rows[0];
      const widths = Array.prototype.map.call(first.children, function (c) { return c.getBoundingClientRect().width; });
      colDrag = { table: t, idx: colHit.idx, x0: e.clientX, widths: widths };
      t.style.tableLayout = 'fixed';
      t.style.width = Math.round(widths.reduce(function (a, b) { return a + b; }, 0)) + 'px';
      Array.prototype.forEach.call(first.children, function (c, i) { c.style.width = Math.round(widths[i]) + 'px'; });
      paper.classList.add('is-colresize');
    });
    const onColMove = function (e) {
      if (!colDrag) return;
      const d = e.clientX - colDrag.x0, i = colDrag.idx, w = colDrag.widths;
      const a = Math.max(24, Math.min(w[i] + w[i + 1] - 24, w[i] + d)), b = w[i] + w[i + 1] - a;
      const first = colDrag.table.rows[0];
      first.children[i].style.width = Math.round(a) + 'px';
      first.children[i + 1].style.width = Math.round(b) + 'px';
    };
    const onColUp = function () {
      if (!colDrag) return;
      colDrag = null; colHit = null;
      paper.classList.remove('is-colresize');
      changed();
    };
    document.addEventListener('mousemove', onColMove);
    document.addEventListener('mouseup', onColUp);

    function refresh() {
      if (!toolbar) return;
      const cur = blocksInSelection()[0];
      const dist = !!(cur && cur.style.textAlignLast === 'justify');
      ['bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList'].forEach(function (c) {
        const b = toolbar.querySelector('[data-act="' + c + '"]');
        let on = false;
        try { on = document.queryCommandState(c); } catch (e) { on = false; }
        if (c === 'justifyFull' && dist) on = false;
        if (b) b.classList.toggle('on', !!on);
      });
      const db = toolbar.querySelector('[data-act="distribute"]');
      if (db) db.classList.toggle('on', dist);
      drawRuler();
      if (styleSel) styleSel.value = blockOf();
      if (fontSel) {
        let f = '';
        try { f = (document.queryCommandValue('fontName') || '').replace(/^["']|["']$/g, '').split(',')[0].trim(); } catch (e) { f = ''; }
        const hit = FONTS.find(function (x) { return x.v.split(',')[0].trim().toLowerCase() === f.toLowerCase(); });
        fontSel.value = hit ? hit.v : FONTS[0].v;
      }
      if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = String(currentSizePt());
      count();
    }

    // ---- 工具列 ----
    if (toolbar) {
      toolbar.addEventListener('mousedown', function (e) {
        // 按鈕不搶焦點（select／輸入框要）
        if (e.target.closest('button')) { e.preventDefault(); saveRange(); }
      });
      toolbar.addEventListener('click', function (e) {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const a = b.getAttribute('data-act');
        if (a === 'size-') setFontSize(currentSizePt() - 1);
        else if (a === 'size+') setFontSize(currentSizePt() + 1);
        else if (a === 'color' || a === 'hilite') colorPop(b, a);
        else if (a === 'link') linkPop(b);
        else if (a === 'image') pickImage();
        else if (a === 'table') tablePop(b);
        else if (a === 'hr') exec('insertHorizontalRule');
        else if (a === 'removeFormat') { exec('removeFormat'); exec('formatBlock', 'p'); }
        else if (a === 'distribute') distribute();
        else if (a.indexOf('justify') === 0) { restoreRange(); blocksInSelection().forEach(function (b) { b.style.textAlignLast = ''; b.style.textJustify = ''; }); exec(a); }
        else exec(a);
      });
      styleSel.addEventListener('mousedown', saveRange);
      styleSel.addEventListener('change', function () { exec('formatBlock', styleSel.value); });
      fontSel.addEventListener('mousedown', saveRange);
      fontSel.addEventListener('change', function () { exec('fontName', fontSel.value); });
      sizeEl.addEventListener('focus', saveRange);
      sizeEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); setFontSize(parseInt(sizeEl.value, 10) || 11); }
        if (e.key === 'Escape') { e.preventDefault(); restoreRange(); }
        e.stopPropagation();
      });
      sizeEl.addEventListener('change', function () { setFontSize(parseInt(sizeEl.value, 10) || 11); });
    }
    function colorPop(anchor, which) {
      const p = popupAt(anchor, 'gd-pop-colors');
      const list = which === 'color' ? COLORS : HILITES;
      list.forEach(function (c) {
        const b = el('button', 'gd-swatch' + (c === 'none' ? ' is-none' : '')); b.type = 'button'; b.title = c === 'none' ? '無' : c;
        if (c !== 'none') b.style.background = c;
        b.setAttribute('data-color', c);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          closePop();
          if (which === 'color') exec('foreColor', c);
          else exec('hiliteColor', c === 'none' ? 'transparent' : c);
          const bar = anchor.querySelector('.gd-color-bar');
          if (bar) bar.style.background = c === 'none' ? 'transparent' : c;
        });
        p.appendChild(b);
      });
    }
    function linkPop(anchor) {
      const p = popupAt(anchor, 'gd-pop-link');
      const s = window.getSelection();
      const a = s && s.anchorNode && paper.contains(s.anchorNode) ? (s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode).closest('a') : null;
      p.appendChild(el('div', 'gd-pop-label', '網址'));
      const inp = el('input', 'gd-input'); inp.type = 'url'; inp.placeholder = 'https://…'; inp.value = a ? a.getAttribute('href') : '';
      p.appendChild(inp);
      const row = el('div', 'gd-pop-row');
      const ok = el('button', 'gd-btn gd-btn-primary', '套用'); ok.type = 'button';
      const rm = el('button', 'gd-btn', '移除連結'); rm.type = 'button';
      row.appendChild(ok); row.appendChild(rm);
      p.appendChild(row);
      const apply = function () {
        let u = inp.value.trim();
        if (!u) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
        if (!/^(https?:|mailto:)/i.test(u)) return;
        closePop();
        restoreRange();
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && !a) {
          document.execCommand('insertHTML', false, '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>');
        } else {
          document.execCommand('createLink', false, u);
          paper.querySelectorAll('a[href="' + u.replace(/"/g, '\\"') + '"]').forEach(function (x) { x.setAttribute('target', '_blank'); x.setAttribute('rel', 'noopener noreferrer'); });
        }
        saveRange(); changed(); refresh();
      };
      ok.addEventListener('click', apply);
      rm.addEventListener('click', function () { closePop(); exec('unlink'); });
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') { closePop(); restoreRange(); } });
      setTimeout(function () { inp.focus(); inp.select(); }, 0);
    }
    function tablePop(anchor) {
      const p = popupAt(anchor, 'gd-pop-table');
      p.appendChild(el('div', 'gd-pop-label', '表格大小'));
      const grid = el('div', 'gd-table-grid');
      const hint = el('div', 'gd-pop-hint', '3 × 3');
      for (let r = 1; r <= 6; r++) for (let c = 1; c <= 6; c++) {
        const cell = el('button', 'gd-table-cell'); cell.type = 'button'; cell.setAttribute('data-r', r); cell.setAttribute('data-c', c); cell.title = r + ' × ' + c;
        cell.addEventListener('mouseenter', function () {
          grid.querySelectorAll('.gd-table-cell').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-r') <= r && +x.getAttribute('data-c') <= c); });
          hint.textContent = r + ' × ' + c;
        });
        cell.addEventListener('mousedown', function (e) { e.preventDefault(); });
        cell.addEventListener('click', function () { closePop(); insertTable(r, c); });
        grid.appendChild(cell);
      }
      p.appendChild(grid); p.appendChild(hint);
    }
    function insertTable(rows, cols) {
      let h = '<table class="gd-table"><tbody>';
      for (let r = 0; r < rows; r++) { h += '<tr>'; for (let c = 0; c < cols; c++) h += '<td><br></td>'; h += '</tr>'; }
      h += '</tbody></table><p><br></p>';
      exec('insertHTML', h);
    }
    function pickImage() {
      if (!opts.onUpload) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.addEventListener('change', function () { insertFiles(inp.files); });
      inp.click();
    }
    function insertFiles(files) {
      const list = Array.prototype.filter.call(files || [], function (f) { return (f.type || '').indexOf('image/') === 0; });
      if (!list.length || !opts.onUpload) return;
      setStatus('上傳圖片中…');
      Promise.resolve(opts.onUpload(list)).then(function (imgs) {
        const html = (imgs || []).map(function (i) { return '<img data-img-id="' + esc(i.id) + '" src="/api/images/' + esc(i.id) + '" alt="' + esc(i.alt || '') + '">'; }).join('');
        if (html) exec('insertHTML', html);
        else setStatus('已儲存', 'is-ok');
      }, function () { setStatus('上傳失敗', 'is-err'); });
    }

    // ---- 編輯區事件 ----
    paper.addEventListener('input', function () { if (normalizeFonts()) { /* 換掉的 <font> 已經在 DOM 裡 */ } changed(); });
    paper.addEventListener('keyup', refresh);
    paper.addEventListener('mouseup', function () { saveRange(); refresh(); });
    document.addEventListener('selectionchange', onSel);
    function onSel() { if (!closed && document.activeElement === paper) { saveRange(); refresh(); } }
    paper.addEventListener('keydown', function (e) {
      if (ro) return;
      if (e.key === 'Tab') { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); saveRange(); linkPop(toolbar.querySelector('[data-act="link"]')); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); return; }
      if (e.key === 'Escape' && popEl) { closePop(); return; }
      e.stopPropagation();   // 別讓 app 的快捷鍵接到打字
    });
    // 貼上：有圖就上傳；HTML 清過再放進來；都沒有就是純文字
    paper.addEventListener('paste', function (e) {
      if (ro) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = Array.prototype.filter.call(dt.files || [], function (f) { return (f.type || '').indexOf('image/') === 0; });
      if (files.length) { e.preventDefault(); insertFiles(files); return; }
      const html = dt.getData('text/html');
      e.preventDefault();
      if (html) document.execCommand('insertHTML', false, toLive(html));
      else document.execCommand('insertText', false, dt.getData('text/plain') || '');
      changed();
    });
    paper.addEventListener('drop', function (e) {
      if (ro) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) { e.preventDefault(); paper.focus(); insertFiles(files); }
    });
    paper.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
    // 連結：Ctrl＋點開新分頁（編輯中點一下是把游標放上去）
    paper.addEventListener('click', function (e) {
      const a = e.target.closest('a[href]');
      if (!a) return;
      if (ro || e.ctrlKey || e.metaKey) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
      else e.preventDefault();
    });

    function flush() {
      if (closed) return Promise.resolve();
      if (!dirty) return Promise.resolve();
      return emit();
    }
    function teardown() {
      clearTimeout(saveTimer);
      closePop();
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('mousemove', onColMove);
      document.removeEventListener('mouseup', onColUp);
      if (rulerListeners) rulerListeners();
      host.innerHTML = ''; host.classList.remove('gd-page');
    }
    function close() { if (closed) return; emit(); closed = true; teardown(); if (opts.onClose) opts.onClose(); }
    function discard() { if (closed) return; closed = true; dirty = false; teardown(); }
    function setContent(html) { paper.innerHTML = toLive(html) || '<p><br></p>'; dirty = false; setStatus('已儲存', 'is-ok'); count(); }

    applyMargins();
    count(); refresh();
    if (content) setStatus('已儲存', 'is-ok');
    setTimeout(function () { if (!closed && !ro) paper.focus(); }, 30);
    return { close: close, requestClose: close, discard: discard, flush: flush, setContent: setContent };
  }

  global.Doc = { isNote: isNote, generate: generate, open: open, sanitize: sanitize, textOf: textOf, toStored: toStored, toLive: toLive };
})(window);
