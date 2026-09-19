/* blogwyg.js — Blog 模式的所見即所得（WYSIWYG）編輯，像 Notion／Obsidian。
 *
 * Blog 以前點一個區塊會換成顯示原始 Markdown 的 textarea；散文區塊（標題、內文、清單、
 * 引言）改成直接在排版好的內容上編輯：看不到 #、>、-、**，粗體就是粗體、連結就是藍字，
 * 用 / 指令或反白工具列改格式與區塊類型。
 *
 * 筆記本身仍然是 Markdown、#editor 的值仍是唯一真實來源：每次改動就把這個 contentEditable
 * 的 DOM 序列化回 Markdown，交回 blogmode（只動這一塊佔的那幾行），自動存檔／協作合併／搜尋／
 * PDF／版本歷史全部照舊。
 *
 * ── 安全底線 ────────────────────────────────────────────────────────────────
 * 序列化錯了會弄壞真實筆記，所以進 WYSIWYG 前先過一道「往返測試」：把這一塊的 Markdown
 * 渲染成 DOM、序列化回 Markdown、再渲染一次，兩次的 HTML 要一模一樣才用 WYSIWYG；只要有一點
 * 對不上（不支援的語法、跳脫沒處理好…）就退回原本的 textarea 編原始碼，絕不硬幹。序列化涵蓋不到
 * 的區塊（程式碼、表格、callout、心智圖、圖片、[toc]…）本來就走這條退路。
 */
(function (global) {
  'use strict';

  // ---- 行內：DOM → Markdown ------------------------------------------------
  // 純文字裡會被 Markdown 當成語法的字元前面加反斜線。往返測試會抓漏，所以這裡從嚴一點無妨。
  function escapeText(s) {
    return String(s)
      .replace(/([\\`*_{}\[\]<>#+\-.!~|])/g, function (m, ch, i, str) {
        // - . # 只有在行首（或前面全是空白）才是區塊語法；行內就不用跳脫，免得每個句點都變成 \.
        if ((ch === '-' || ch === '+' || ch === '#' || ch === '>') && !/^\s*$/.test(str.slice(0, i))) return ch;
        if (ch === '.' && !/^\s*\d+$/.test(str.slice(0, i))) return ch;
        return '\\' + ch;
      });
  }

  function inlineOf(node) {
    let s = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      if (ch.nodeType === 3) { s += escapeText(ch.nodeValue); continue; }
      if (ch.nodeType !== 1) continue;
      const tag = ch.tagName;
      if (tag === 'BR') { s += '\n'; continue; }
      if (tag === 'STRONG' || tag === 'B') { s += '**' + inlineOf(ch) + '**'; continue; }
      if (tag === 'EM' || tag === 'I') { s += '*' + inlineOf(ch) + '*'; continue; }
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { s += '~~' + inlineOf(ch) + '~~'; continue; }
      if (tag === 'CODE') { s += '`' + ch.textContent + '`'; continue; }
      if (tag === 'A') {
        if (ch.classList.contains('hashtag')) { s += ch.textContent; continue; }   // #標籤
        if (ch.classList.contains('note-link')) {
          const title = ch.getAttribute('data-note-title') || ch.textContent;
          const txt = ch.textContent;
          s += (title === txt) ? '[[' + title + ']]' : '[[' + title + '|' + txt + ']]';
          continue;
        }
        s += '[' + inlineOf(ch) + '](' + (ch.getAttribute('href') || '') + ')';
        continue;
      }
      if (tag === 'INPUT') continue;   // 待辦勾選框，另外在 li 處理
      s += inlineOf(ch);   // 不認得的行內元素：取其文字（往返測試會擋下真的有影響的情況）
    }
    return s;
  }

  // ---- 區塊：DOM → Markdown -------------------------------------------------
  // 空的清單項目、空引言在原始碼裡放一個零寬空格（EMPTY）當佔位：只有「- 」的一行 marked 會
  // 排成一段字面上的「-」，「> 」會排成裡面沒有 <p> 的 <blockquote>，兩種都沒地方放游標——
  // 前者打的字黏在「-」後面被跳脫成 \-，後者打的字落在序列化不讀的地方，整個不見。
  // 一打字佔位就拿掉；原本內文裡就有零寬空格的區塊會在往返檢查被擋下，走純文字框，不會被改動。
  const EMPTY = '\u200b';
  function dropPlaceholder(t) { return t === EMPTY ? t : t.replace(/\u200b/g, ''); }
  function prefixLines(text, prefix) {
    return text.split('\n').map(function (l) { return prefix + l; }).join('\n');
  }

  // 序列化一個容器裡的每個區塊子元素，回傳以 \n\n 分隔的 Markdown。
  function blocksOf(container, indent) {
    const out = [];
    const kids = container.children;
    for (let i = 0; i < kids.length; i++) {
      const md = blockOf(kids[i], indent);
      if (md != null) out.push(md);
    }
    return out;
  }

  function listItem(li, ordered, num, indent) {
    // 直接子 ul/ol = 巢狀清單；其餘子節點 = 這一項自己的內容
    const inline = document.createElement('span');
    const subs = [];
    Array.prototype.forEach.call(li.childNodes, function (c) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { subs.push(c); return; }
      inline.appendChild(c.cloneNode(true));
    });
    const marker = ordered ? (num + '. ') : '- ';
    // li 內文兩端的空白要去掉——巢狀 list 被拆走後常留下換行文字節點，不去掉會多一個空行，
    // 把巢狀清單斷成兩塊（往返測試抓到過）。
    let body;
    if (li.classList.contains('task-item')) {
      const box = li.querySelector('input.task-check');
      const cb = inline.querySelector('input.task-check');
      if (cb) cb.remove();
      body = marker + '[' + (box && box.checked ? 'x' : ' ') + '] ' + dropPlaceholder(inlineOf(inline).replace(/^\s+|\s+$/g, ''));
    } else {
      body = marker + dropPlaceholder(inlineOf(inline).replace(/^\s+|\s+$/g, ''));
    }
    let text = indent + body;
    subs.forEach(function (sub) { text += '\n' + listMd(sub, indent + '  '); });   // 巢狀縮排 +2
    return text;
  }

  function listMd(list, indent) {
    const ordered = list.tagName === 'OL';
    const items = [];
    let n = 1;
    Array.prototype.forEach.call(list.children, function (li) {
      if (li.tagName !== 'LI') return;
      items.push(listItem(li, ordered, n, indent));
      n++;
    });
    return items.join('\n');
  }

  function blockOf(el, indent) {
    indent = indent || '';
    const tag = el.tagName;
    // 結尾的 <br> 是 contentEditable 讓空段落能放游標的佔位（<p><br></p>），不是內容
    if (/^H[1-6]$/.test(tag)) return indent + '#'.repeat(+tag[1]) + ' ' + dropPlaceholder(inlineOf(el).replace(/\n+$/, ''));
    if (tag === 'P') return prefixLines(dropPlaceholder(inlineOf(el).replace(/\n+$/, '')), indent);
    if (tag === 'BLOCKQUOTE') return prefixLines(blocksOf(el, '').join('\n\n'), indent + '> ');
    if (tag === 'UL' || tag === 'OL') return listMd(el, indent);
    return null;   // 不支援 → 交給往返測試擋下
  }

  // 一個 .blog-block 容器（裝著單一 h/p/ul/blockquote）→ Markdown。
  function serialize(blockEl) {
    const parts = blocksOf(blockEl, '');
    return parts.join('\n\n');
  }

  // ---- 安全閘：這一塊能不能用 WYSIWYG ---------------------------------------
  // 只針對散文類（heading/para/list/quote）；其餘一律 false（走原本的 textarea）。
  // 判準：render(md) 建成 DOM → serialize → 再 render，兩次 HTML 必須相同。
  const WYSIWYG_KINDS = { heading: 1, para: 1, list: 1, quote: 1 };
  function normHtml(h) { return String(h).replace(/\s+/g, ' ').trim(); }

  function renderToBlock(md) {
    const tpl = document.createElement('div');
    tpl.className = 'blog-block';
    tpl.innerHTML = global.MD ? MD.render(md) : '';
    return tpl;
  }

  function canEdit(kind, md) {
    if (!WYSIWYG_KINDS[kind] || !global.MD) return false;
    let el, md2;
    try {
      el = renderToBlock(md);
      // callout / 容器 / RISK 也算 quote：出現這些結構就不支援
      if (el.querySelector('.callout, .md-risk, table, pre, img, .link-card, .mm-wrap, hr, .md-toc, input:not(.task-check)')) return false;
      md2 = serialize(el);
      if (md2 == null) return false;
      const a = normHtml(el.innerHTML);
      const b = normHtml(renderToBlock(md2).innerHTML);
      return a === b;
    } catch (e) { return false; }
  }

  // =========================================================================
  //  就地編輯：把一個已排版的 .blog-block 變成 contentEditable，直接編排版好的內容。
  //  區塊之間的事（Enter 開新塊、Backspace 併回上一塊、切換類型、上下移出）都回報給
  //  blogmode 處理（它掌握原始碼的行範圍）；行內格式、清單內的 Enter/Tab、/ 指令在這裡做。
  // =========================================================================

  function firstEl(block) {   // 這個 .blog-block 裡的單一區塊元素（h/p/ul/blockquote）
    for (let i = 0; i < block.children.length; i++) {
      const t = block.children[i].tagName;
      if (/^(H[1-6]|P|UL|OL|BLOCKQUOTE)$/.test(t)) return block.children[i];
    }
    return block;
  }

  // 游標放到排版後純文字的第 n 個字（跟 Range.toString 同一種數法）。超過就放到最後。
  function setTextOffset(el, n) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, left = Math.max(0, n);
    while ((node = walk.nextNode())) {
      if (left <= node.nodeValue.length) {
        const r = document.createRange();
        r.setStart(node, left); r.collapse(true); sel(r);
        return;
      }
      left -= node.nodeValue.length;
    }
    caretToEnd(el);
  }
  function caretToStart(el) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); sel(r); }
  function caretToEnd(el) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel(r); }
  function sel(range) { const s = global.getSelection(); s.removeAllRanges(); s.addRange(range); }

  function atStart(block) {
    const s = global.getSelection();
    if (!s.rangeCount) return false;
    const r = s.getRangeAt(0);
    if (!r.collapsed) return false;
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(r.startContainer, r.startOffset);
    return probe.toString().length === 0;
  }
  function atEnd(block) {
    const s = global.getSelection();
    if (!s.rangeCount) return false;
    const r = s.getRangeAt(0);
    if (!r.collapsed) return false;
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setStart(r.startContainer, r.startOffset);
    return probe.toString().length === 0;
  }

  // 游標到區塊尾的行內內容切出來（Enter 用）。回傳被切下那段的 Markdown（純行內）。
  function splitInlineAfterCaret(block) {
    const s = global.getSelection();
    if (!s.rangeCount) return '';
    const r = s.getRangeAt(0);
    if (!r.collapsed) r.deleteContents();
    const tail = r.cloneRange();
    tail.setEndAfter(block.lastChild || block);
    tail.setStart(r.endContainer, r.endOffset);
    const frag = tail.extractContents();
    const holder = document.createElement('span');
    holder.appendChild(frag);
    return inlineOf(holder);
  }

  let slash = null;
  function closeSlash() { if (slash) { slash.el.remove(); document.removeEventListener('mousedown', slash.out, true); slash = null; } }

  // ---- 反白格式工具列（像 Notion）：目前掛著的區塊裡反白文字就浮出來 -----------------
  // 行內：粗體／斜體／刪除線／行內碼／連結；區塊：內文／H1／H2／H3／引言／項目清單／編號清單／
  // 待辦清單。在清單區塊上只出現「內文」跟三種清單（清單之間互換，或攤平回內文）——多個項目
  // 沒有單一對應的標題或引言。
  let active = null;   // { block, kind, fireChange, retype }
  let fmt = null, link = null;
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  function ensureFmt() {
    if (fmt) return fmt;
    fmt = document.createElement('div');
    fmt.className = 'blog-fmt wyg-fmt';
    fmt.hidden = true;
    function add(spec) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'blog-fmt-btn' + (spec.block ? ' wyg-fmt-block' : '');
      if (spec.block) b.dataset.scope = spec.scope || 'text';
      b.title = spec.title;
      b.innerHTML = ic(spec.icon) || spec.title;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 不搶焦點，選取才不會消失
      b.addEventListener('click', function (e) { e.preventDefault(); spec.run(); });
      fmt.appendChild(b);
      return b;
    }
    add({ icon: 'bold', title: '粗體', run: function () { cmd('bold'); } });
    add({ icon: 'italic', title: '斜體', run: function () { cmd('italic'); } });
    add({ icon: 'strikethrough', title: '刪除線', run: function () { cmd('strikeThrough'); } });
    add({ icon: 'code', title: '行內程式碼', run: toggleCode });
    add({ icon: 'link', title: '連結', run: openLink });
    const sep = document.createElement('span'); sep.className = 'blog-fmt-sep'; fmt.appendChild(sep);
    add({ icon: 'type', title: '內文', block: true, scope: 'both', run: function () { retypeTo('para'); } });
    add({ icon: 'heading-1', title: '標題 1', block: true, run: function () { retypeTo('h1'); } });
    add({ icon: 'heading-2', title: '標題 2', block: true, run: function () { retypeTo('h2'); } });
    add({ icon: 'heading-3', title: '標題 3', block: true, run: function () { retypeTo('h3'); } });
    add({ icon: 'quote', title: '引言', block: true, run: function () { retypeTo('quote'); } });
    add({ icon: 'list', title: '項目清單', block: true, scope: 'both', run: function () { retypeTo('ul'); } });
    add({ icon: 'list-ordered', title: '編號清單', block: true, scope: 'both', run: function () { retypeTo('ol'); } });
    add({ icon: 'check-square', title: '待辦清單', block: true, scope: 'both', run: function () { retypeTo('todo'); } });
    document.body.appendChild(fmt);   // body 子元素一律 fixed
    return fmt;
  }
  function cmd(name) {
    if (!active) return;
    document.execCommand(name);
    active.fireChange();
    positionFmt();
  }
  function selRange() {
    const s = global.getSelection();
    return (s && s.rangeCount) ? s.getRangeAt(0) : null;
  }
  function toggleCode() {
    if (!active) return;
    const r = selRange();
    if (!r || r.collapsed) return;
    let n = r.commonAncestorContainer;
    if (n.nodeType === 3) n = n.parentNode;
    const inCode = n.closest && n.closest('code');
    if (inCode && active.block.contains(inCode)) {   // 已是行內碼 → 拆掉
      const txt = document.createTextNode(inCode.textContent);
      inCode.parentNode.replaceChild(txt, inCode);
      const nr = document.createRange(); nr.selectNodeContents(txt); sel(nr);
    } else {
      const code = document.createElement('code');
      try { r.surroundContents(code); }
      catch (e) { const txt = r.toString(); r.deleteContents(); code.textContent = txt; r.insertNode(code); }
      const nr = document.createRange(); nr.selectNodeContents(code); sel(nr);
    }
    active.fireChange();
    positionFmt();
  }
  // 連結：在工具列下方開一個小輸入框填網址（不用會卡住畫面的 prompt）
  function openLink() {
    if (!active) return;
    const r = selRange();
    if (!r || r.collapsed) return;
    closeLink();
    const saved = r.cloneRange();
    let n = r.commonAncestorContainer; if (n.nodeType === 3) n = n.parentNode;
    const a = n.closest && n.closest('a');
    const cur = (a && active.block.contains(a)) ? (a.getAttribute('href') || '') : '';
    const box = document.createElement('div');
    box.className = 'wyg-link';
    box.innerHTML = '<input type="text" placeholder="https://…" spellcheck="false"><button type="button" class="btn btn-primary">套用</button>';
    const input = box.querySelector('input'), ok = box.querySelector('button');
    input.value = cur;
    function apply() {
      const url = input.value.trim();
      closeLink();
      sel(saved);
      if (url) document.execCommand('createLink', false, url);
      else document.execCommand('unlink');
      active.fireChange();
      hideFmt();
    }
    ok.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ok.addEventListener('click', apply);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); closeLink(); sel(saved); }
    });
    document.body.appendChild(box);
    const fr = fmt.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(fr.left, global.innerWidth - box.offsetWidth - 8)) + 'px';
    box.style.top = (fr.bottom + 6) + 'px';
    link = { el: box, out: function (e) { if (!box.contains(e.target) && !fmt.contains(e.target)) closeLink(); } };
    setTimeout(function () { document.addEventListener('mousedown', link.out, true); }, 0);
    input.focus(); input.select();
  }
  function closeLink() { if (link) { link.el.remove(); document.removeEventListener('mousedown', link.out, true); link = null; } }

  // 把目前這個區塊換成另一種類型（行內內容保留）。type：para／h1–h3／quote／ul／ol／todo。
  const LIST_ITEM = /^((?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?(.*)$/;   // 最外層的一項（行首沒有縮排）
  function listMarker(type, n, box) {
    if (type === 'ol') return n + '. ';
    if (type === 'todo') return '- ' + (box && /x/i.test(box) ? '[x] ' : '[ ] ');
    return '- ';
  }
  function retypeTo(type) {
    if (!active) return;
    const raw = serialize(active.block).split('\n');
    const toList = type === 'ul' || type === 'ol' || type === 'todo';
    let md, kind;
    if (active.kind === 'list') {
      if (type === 'para') {
        // 攤平：每一項（含巢狀）變成內文的一行
        md = raw.map(function (l) { return l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''); })
          .filter(function (l) { return l.trim() !== ''; }).join('\n');
        kind = 'para';
      } else if (toList) {
        // 換清單種類：只換最外層的記號，巢狀的維持原樣；待辦的勾選狀態保留
        let n = 0;
        md = raw.map(function (l) {
          const m = l.match(LIST_ITEM);
          if (!m) return l;
          n++;
          return listMarker(type, n, m[2]) + m[3];
        }).join('\n');
        kind = 'list';
      } else return;
    } else {
      const lines = raw.map(function (l) { return l.replace(/^(#{1,6}\s+|>\s?)/, ''); });
      const one = lines.join(' ').trim(), all = lines.join('\n');
      if (type === 'para') { md = all; kind = 'para'; }
      else if (type === 'quote') {
        md = (all.trim() === '' ? [EMPTY] : lines).map(function (l) { return '> ' + l; }).join('\n');
        kind = 'quote';
      }
      else if (toList) {
        // 一行一項（內文裡用 Shift+Enter 換的行、原始碼裡的單一換行都算一行）；空行不成項
        const items = lines.map(function (l) { return l.trim(); }).filter(Boolean);
        if (!items.length) items.push(EMPTY);
        md = items.map(function (l, i) { return listMarker(type, i + 1) + l; }).join('\n');
        kind = 'list';
      }
      else { md = '#'.repeat(+type[1]) + ' ' + one; kind = 'heading'; }
    }
    hideFmt();
    active.retype(md, kind);
  }

  function positionFmt() {
    if (!fmt || fmt.hidden) return;
    const r = selRange();
    if (!r) return;
    const rc = r.getBoundingClientRect();
    const w = fmt.offsetWidth, h = fmt.offsetHeight;
    let left = Math.max(8, Math.min(rc.left + rc.width / 2 - w / 2, global.innerWidth - w - 8));
    let top = rc.top - h - 8;
    if (top < 56) top = rc.bottom + 8;   // 上面被頂列擋住就放到選取下方
    fmt.style.left = Math.round(left) + 'px';
    fmt.style.top = Math.round(top) + 'px';
  }
  function updateFmt() {
    if (!active || link) { if (!link) hideFmt(); return; }
    const r = selRange();
    if (!r || r.collapsed || !active.block.contains(r.commonAncestorContainer) || document.querySelector('.wyg-slash')) { hideFmt(); return; }
    const el = ensureFmt();
    el.hidden = false;
    // 清單區塊：只有「內文」跟三種清單（多個項目沒有單一對應的標題／引言）
    const isList = active.kind === 'list';
    el.querySelectorAll('.wyg-fmt-block').forEach(function (b) { b.hidden = isList && b.dataset.scope !== 'both'; });
    el.querySelector('.blog-fmt-sep').hidden = false;
    positionFmt();
  }
  function hideFmt() { if (fmt) fmt.hidden = true; }
  document.addEventListener('selectionchange', function () { updateFmt(); });

  // opts: onChange, onSplit(afterMd,newKind), onMerge, onLeave(dir), onSave,
  //       onRetype(newMd, caret), kind
  function mount(block, opts, caret) {
    const inner = firstEl(block);
    const kind = opts.kind;
    block.setAttribute('contenteditable', 'true');
    block.classList.add('wyg-editing');
    block.spellcheck = false;
    let composing = false;

    function fireChange() { if (!composing) opts.onChange(serialize(block)); }
    active = { block: block, kind: kind, fireChange: fireChange, retype: function (md, k) { opts.onRetype(md, k); } };

    function onInput(e) {
      // execCommand／貼上可能塞進 <div><font><span style>，這些序列化不認得。這裡不重排
      // （會掉游標），交給往返：離開時 blogmode 會用序列化的 Markdown 重新排版。
      closeSlash();
      if (e && e.inputType === 'insertText' && (e.data === ' ' || e.data === '\u00a0') && tryShortcut()) return;
      fireChange();
    }
    // 內文第一行開頭打了「記號 + 空白」→ 換成對應的區塊。沒有這個，打「- 」只會得到一段字面上的
    // 「- 」（序列化時還會被跳脫成 \-，免得它意外變成清單），Blog 裡就沒辦法用打字的方式開清單。
    const SHORTCUTS = [
      { re: /^[-*+]$/, type: 'ul' }, { re: /^\d+[.)]$/, type: 'ol' }, { re: /^\[ ?\]$/, type: 'todo' },
      { re: /^#$/, type: 'h1' }, { re: /^##$/, type: 'h2' }, { re: /^###$/, type: 'h3' }, { re: /^>$/, type: 'quote' }
    ];
    function tryShortcut() {
      if (kind !== 'para' || !active || active.block !== block) return false;
      const s = global.getSelection();
      if (!s.rangeCount || !s.isCollapsed) return false;
      const probe = document.createRange();
      probe.selectNodeContents(inner);
      probe.setEnd(s.anchorNode, s.anchorOffset);
      const m = probe.toString().match(/^([^\s\u00a0]+)[ \u00a0]$/);
      if (!m) return false;
      const sc = SHORTCUTS.filter(function (x) { return x.re.test(m[1]); })[0];
      if (!sc) return false;
      probe.deleteContents();   // 記號跟空白本身不留下來
      retypeTo(sc.type);
      return true;
    }

    function insertText(t) { document.execCommand('insertText', false, t); }

    function onKey(e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); if (opts.onSave) opts.onSave(); return; }
        if (k === 'b') { e.preventDefault(); document.execCommand('bold'); fireChange(); return; }
        if (k === 'i') { e.preventDefault(); document.execCommand('italic'); fireChange(); return; }
      }
      if (slash) {   // 讓 / 選單先吃方向鍵、Enter、Esc
        if (slashKey(e)) return;
      }
      if (e.key === 'Escape') { e.preventDefault(); opts.onLeave(0); return; }
      const inList = /^(UL|OL)$/.test(inner.tagName);

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inList) { listEnter(); return; }
        // 標題／內文／引言：切成兩塊，游標後面的內容移到新塊
        const afterMd = splitInlineAfterCaret(inner);
        fireChange();
        opts.onSplit(afterMd, kind === 'heading' ? 'para' : (kind === 'quote' ? 'para' : 'para'));
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) {   // 軟換行
        e.preventDefault();
        document.execCommand('insertHTML', false, '<br>');
        fireChange();
        return;
      }
      if (e.key === 'Tab' && inList) {
        e.preventDefault();
        listIndent(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Backspace' && atStart(inner)) {
        if (inList) { if (listOutdentOrExit()) { e.preventDefault(); return; } }
        e.preventDefault();
        opts.onMerge();
        return;
      }
      if (e.key === 'ArrowUp' && atStart(inner)) { if (opts.onLeave(-1)) e.preventDefault(); return; }
      if (e.key === 'ArrowDown' && atEnd(inner)) { if (opts.onLeave(1)) e.preventDefault(); return; }
      if (e.key === '/' ) {
        // 空區塊開頭打 / → 類型選單
        if (serialize(block).trim() === '') setTimeout(openSlash, 0);
      }
    }

    // ---- 清單內：Enter / Tab ----
    function currentLi() {
      const s = global.getSelection();
      let n = s.anchorNode;
      while (n && n !== block) { if (n.nodeType === 1 && n.tagName === 'LI') return n; n = n.parentNode; }
      return null;
    }
    function listEnter() {
      const li = currentLi();
      if (!li) { document.execCommand('insertParagraph'); fireChange(); return; }
      if (li.textContent.trim() === '' && !li.querySelector('ul,ol')) {
        // 空項目 → 跳出清單，開一個段落
        const parentList = li.parentNode;
        li.remove();
        if (!parentList.children.length) parentList.remove();
        fireChange();
        opts.onSplit('', 'para');
        return;
      }
      const tail = splitInlineAfterCaret(li);
      const nli = document.createElement('li');
      nli.innerHTML = tail || '';
      if (li.nextSibling) li.parentNode.insertBefore(nli, li.nextSibling); else li.parentNode.appendChild(nli);
      caretToStart(nli);
      fireChange();
    }
    function listIndent(dir) {
      const li = currentLi();
      if (!li) return;
      if (dir > 0) {
        const prev = li.previousElementSibling;
        if (!prev || prev.tagName !== 'LI') return;   // 第一項不能再縮
        let sub = prev.querySelector(':scope > ul, :scope > ol');
        if (!sub) { sub = document.createElement(li.parentNode.tagName); prev.appendChild(sub); }
        sub.appendChild(li);
      } else {
        const parentList = li.parentNode;
        const grandLi = parentList.parentNode;
        if (!grandLi || grandLi.tagName !== 'LI') return;   // 已在最外層
        const outer = grandLi.parentNode;
        if (grandLi.nextSibling) outer.insertBefore(li, grandLi.nextSibling); else outer.appendChild(li);
        if (!parentList.children.length) parentList.remove();
      }
      caretToEnd(li);
      fireChange();
    }
    function listOutdentOrExit() {
      const li = currentLi();
      if (!li) return false;
      const parentList = li.parentNode;
      if (parentList.parentNode && parentList.parentNode.tagName === 'LI') { listIndent(-1); return true; }
      // 最外層第一項在開頭按 Backspace：把它變成段落
      if (li === parentList.firstElementChild && li.textContent.trim() === '' && parentList.children.length === 1) {
        return false;   // 空清單整個交給 onMerge
      }
      return false;
    }

    // ---- / 類型選單 ----
    const SLASH_ITEMS = [
      { t: '內文', k: 'para', icon: 'type', md: function (x) { return x; } },
      { t: '標題 1', k: 'heading', icon: 'heading-1', md: function (x) { return '# ' + x; } },
      { t: '標題 2', k: 'heading', icon: 'heading-2', md: function (x) { return '## ' + x; } },
      { t: '標題 3', k: 'heading', icon: 'heading-3', md: function (x) { return '### ' + x; } },
      { t: '項目清單', k: 'list', icon: 'list', md: function (x) { return '- ' + x; } },
      { t: '編號清單', k: 'list', icon: 'list-ordered', md: function (x) { return '1. ' + x; } },
      { t: '待辦清單', k: 'list', icon: 'check-square', md: function (x) { return '- [ ] ' + x; } },
      { t: '引言', k: 'quote', icon: 'quote', md: function (x) { return '> ' + x; } },
      { t: '程式碼', k: 'code', icon: 'code', md: function () { return '```\n\n```'; } },
      { t: '表格', k: 'table', icon: 'table', md: function () { return '| 欄位 A | 欄位 B |\n| --- | --- |\n|  |  |'; } },
      { t: '分隔線', k: 'hr', icon: 'minus', md: function () { return '---'; } }
    ];
    function openSlash() {
      closeSlash();
      const el = document.createElement('div');
      el.className = 'wyg-slash';
      let q = '';
      function draw() {
        const items = SLASH_ITEMS.filter(function (it) { return !q || it.t.indexOf(q) >= 0; });
        el.innerHTML = '';
        items.forEach(function (it, i) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'wyg-slash-item' + (i === 0 ? ' active' : '');
          btn.innerHTML = ((global.Icons && Icons.svg(it.icon)) || '') + '<span>' + it.t + '</span>';
          btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
          btn.addEventListener('click', function () { pick(it); });
          el.appendChild(btn);
        });
        slash.items = items;
      }
      document.body.appendChild(el);
      const out = function (e) { if (!el.contains(e.target)) closeSlash(); };
      slash = { el: el, out: out, draw: draw, get q() { return q; }, set q(v) { q = v; }, index: 0, items: [] };
      draw();
      positionSlash();
      setTimeout(function () { document.addEventListener('mousedown', out, true); }, 0);
    }
    function positionSlash() {
      if (!slash) return;
      const s = global.getSelection();
      if (!s.rangeCount) return;
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const r = (rect.top || rect.bottom) ? rect : block.getBoundingClientRect();
      const w = slash.el.offsetWidth, h = slash.el.offsetHeight;
      let left = Math.min(r.left, global.innerWidth - w - 8);
      let top = r.bottom + 4;
      if (top + h > global.innerHeight) top = r.top - h - 4;
      slash.el.style.left = Math.max(6, left) + 'px';
      slash.el.style.top = Math.max(6, top) + 'px';
    }
    function slashKey(e) {
      const items = slash.items;
      if (e.key === 'ArrowDown') { e.preventDefault(); slash.index = Math.min(items.length - 1, slash.index + 1); markActive(); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slash.index = Math.max(0, slash.index - 1); markActive(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); if (items[slash.index]) pick(items[slash.index]); return true; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return true; }
      if (e.key === 'Backspace' && slash.q === '') { closeSlash(); return false; }
      if (e.key.length === 1) { setTimeout(function () { if (slash) { slash.q += e.key; slash.index = 0; slash.draw(); markActive(); positionSlash(); } }, 0); return false; }
      return false;
    }
    function markActive() {
      if (!slash) return;
      const btns = slash.el.querySelectorAll('.wyg-slash-item');
      btns.forEach(function (b, i) { b.classList.toggle('active', i === slash.index); });
    }
    function pick(it) {
      closeSlash();
      // 這個區塊目前的行內內容（去掉可能打進去的 /）
      const cur = serialize(block).replace(/\/+\s*$/, '').replace(/^\/+/, '').trim();
      const needsSlot = cur === '' && (it.k === 'quote' || (it.k === 'list' && it.md('').indexOf('[ ]') < 0));
      opts.onRetype(it.md(needsSlot ? EMPTY : cur), it.k);
    }

    block.addEventListener('input', onInput);
    block.addEventListener('keydown', onKey);
    block.addEventListener('compositionstart', function () { composing = true; });
    block.addEventListener('compositionend', function () { composing = false; fireChange(); });
    block.addEventListener('paste', function (e) {
      e.preventDefault();
      const cd = e.clipboardData || global.clipboardData;
      const files = [];
      if (cd && cd.items) for (let k = 0; k < cd.items.length; k++) { if (cd.items[k].kind === 'file') { const f = cd.items[k].getAsFile(); if (f) files.push(f); } }
      // 貼上圖片／檔案：跟一般編輯一樣直接顯示成圖片，不留一行 ![…](img:…) 語法；
      // 交給 blogmode（它才有上傳與插入區塊的路徑），這裡只認得是不是檔案。
      if (files.length && opts.onFiles) { opts.onFiles(files); return; }
      const t = cd.getData('text/plain');
      insertText(t);
      fireChange();
    });

    try { block.focus({ preventScroll: true }); } catch (e) { block.focus(); }
    if (caret === 'start') caretToStart(inner);
    else if (caret === 'end') caretToEnd(inner);
    else if (caret && typeof caret === 'object' && typeof caret.textOffset === 'number') {
      setTextOffset(inner, caret.textOffset);   // 協作：別人的修改進來、重排之後放回原本那個字
    }
    else if (caret && typeof caret === 'object' && document.caretRangeFromPoint) {
      // 點在排版好的哪個字上，游標就放哪
      const r = document.caretRangeFromPoint(caret.x, caret.y);
      if (r && block.contains(r.startContainer)) sel(r); else caretToEnd(inner);
    }

    return {
      block: block,
      getMd: function () { return serialize(block); },
      // 協作重排用：這一塊排版後的純文字，以及游標在其中的位置（跟 setTextOffset 同一種算法）
      text: function () { const r = document.createRange(); r.selectNodeContents(inner); return r.toString(); },
      setCaretOffset: function (n) { setTextOffset(inner, n); },
      caretOffset: function () {
        const s = global.getSelection();
        if (!s.rangeCount || !block.contains(s.anchorNode)) return null;
        const r = document.createRange();
        r.selectNodeContents(inner);
        r.setEnd(s.anchorNode, s.anchorOffset);
        return r.toString().length;
      },
      focus: function () { try { block.focus({ preventScroll: true }); } catch (e) { block.focus(); } },
      destroy: function () {
        closeSlash();
        if (active && active.block === block) { active = null; hideFmt(); closeLink(); }
        block.removeEventListener('input', onInput);
        block.removeEventListener('keydown', onKey);
        block.removeAttribute('contenteditable');
        block.classList.remove('wyg-editing');
      }
    };
  }

  global.BlogWyg = {
    serialize: serialize,
    canEdit: canEdit,
    mount: mount,
    closeSlash: closeSlash,
    _inlineOf: inlineOf,
    _escapeText: escapeText
  };
})(window);
