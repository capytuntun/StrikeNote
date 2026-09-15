/* imagelib.js — 圖片管理：上傳過的圖片與 PDF 集中在一個對話框，每個檔案都看得到
 * 用在哪些筆記（包含垃圾桶裡的），沒有任何筆記用到的也一眼挑得出來、可以整批清掉；
 * 也可以反過來挑一篇筆記，只看它用到的檔案。
 *
 *   ImageLib.open({ folders, onOpenNote })
 *     folders     app.js 的資料夾清單，用來顯示筆記在哪個資料夾
 *     onOpenNote  點「使用於」清單裡的筆記時呼叫（對話框會先關掉）
 *
 * 清單來自 GET /api/images（server/api.js listImages）：只有中繼資料與引用關係。
 * 「使用中」的判斷跟伺服器決定圖片可見性的規則一樣——筆記內容裡出現 img:<id> 或
 * pdf:<id>——而且看的是所有人的筆記：自己的圖被貼進別人的筆記也算使用中，只是
 * 看不到那篇筆記的標題（hiddenNotes）。依筆記篩選的選單也只列得出看得到的筆記，
 * 它就是 images[].notes 的聯集，不另外跟伺服器要。
 *
 * 縮圖直接拿 /api/images/<id> 當 <img src>，不經過 Store.getImageBlob：那是整個
 * session 都留著的位元組快取，圖庫一次瀏覽幾百張不該全部塞進去。卡片 DOM 每個 id
 * 只建一次，切換篩選或排序時只是搬動，縮圖不會重抓。
 */
(function (global) {
  'use strict';

  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'used', label: '使用中' },
    { key: 'unused', label: '未使用' },
    { key: 'trash', label: '僅在垃圾桶' }
  ];
  const SORTS = [
    { key: 'new', label: '最新上傳' },
    { key: 'old', label: '最早上傳' },
    { key: 'big', label: '檔案最大' },
    { key: 'uses', label: '使用最多' }
  ];
  const STATUS_LABEL = { used: '使用中', unused: '未使用', trash: '僅在垃圾桶' };
  const TYPES = [
    { key: 'all', label: '全部類型' },
    { key: 'image', label: '圖片' },
    { key: 'pdf', label: 'PDF' },
    { key: 'other', label: '其他檔案' }
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) { return global.Icons ? Icons.svg(name) : ''; }
  function button(cls, iconName, label) {
    const b = el('button', cls);
    b.type = 'button';
    if (iconName) b.innerHTML = icon(iconName);
    b.appendChild(document.createTextNode(label));
    return b;
  }
  function toast(msg) { if (global.App && App.toast) App.toast(msg); }
  function confirm(opts) {
    if (global.App && App.confirm) return App.confirm(opts);
    return Promise.resolve(window.confirm(opts.message));
  }

  function pad(x) { return x < 10 ? '0' + x : '' + x; }
  function shortDate(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fullDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function size(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function isPdf(img) { return img.mime === 'application/pdf'; }
  function isImage(img) { return String(img.mime || '').indexOf('image/') === 0; }
  function typeOf(img) { return isPdf(img) ? 'pdf' : isImage(img) ? 'image' : 'other'; }
  function nameExt(name) { return ((/\.([a-z0-9]{1,8})$/i.exec(String(name || '')) || [])[1] || '').toLowerCase(); }
  // 類型標籤：圖片與 PDF 看 MIME，其他檔案看副檔名
  function kind(img) {
    const m = String(img.mime || '');
    if (m === 'application/pdf') return 'PDF';
    if (m.indexOf('image/') === 0) {
      const sub = m.split('/')[1] || '';
      return sub === 'jpeg' ? 'JPEG' : sub === 'svg+xml' ? 'SVG' : sub.toUpperCase();
    }
    const ext = nameExt(img.name);
    return ext ? ext.toUpperCase() : '檔案';
  }
  function extOf(img) {
    const m = String(img.mime || '');
    if (m === 'application/pdf') return 'pdf';
    if (m.indexOf('image/') !== 0) return 'bin';
    const sub = m.split('/')[1] || 'bin';
    return sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub.replace(/[^a-z0-9]/gi, '');
  }
  function srcOf(id) { return '/api/images/' + encodeURIComponent(id); }
  function useCount(img) { return img.notes.length + img.hiddenNotes; }
  function compareText(a, b) { return String(a).localeCompare(String(b), 'zh-Hant', { numeric: true }); }

  // used：至少一篇還在的筆記在用（包括看不到標題的別人的筆記）；trash：只剩垃圾桶
  // 裡的筆記在用，那篇筆記一復原就會需要它；unused：沒有任何筆記內容提到它。
  function statusOf(img) {
    if (img.hiddenNotes > 0 || img.notes.some(function (n) { return !n.trashed; })) return 'used';
    return img.notes.length ? 'trash' : 'unused';
  }
  function displayName(img) {
    return img.name || (isPdf(img) ? '未命名 PDF' : isImage(img) ? '未命名圖片' : '未命名檔案');
  }
  function fileName(img) {
    const base = (img.name || img.id).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || img.id;
    return nameExt(base) ? base : base + '.' + extOf(img);
  }
  // 可以直接貼回筆記的語法；名稱裡的中括號會截斷語法，拿掉。圖片與 PDF 嵌進筆記，
  // 其他檔案是下載連結。
  function markdownOf(img) {
    const name = (img.name || '').replace(/[\[\]\r\n]/g, '');
    if (isImage(img)) return '![' + name + '](img:' + img.id + ')';
    if (isPdf(img)) return '![' + name + '](pdf:' + img.id + ')';
    return '[' + (name || '附件') + '](file:' + img.id + ')';
  }
  function folderPath(folders, id) {
    const names = [], seen = {};
    let cur = id;
    while (cur && !seen[cur]) {
      seen[cur] = true;
      const want = cur;
      const f = folders.find(function (x) { return x.id === want; });
      if (!f) break;
      names.unshift(f.name);
      cur = f.parentId;
    }
    return names.join(' / ');
  }
  function copyText(text) {
    function fallback() {
      return new Promise(function (resolve, reject) {
        const t = document.createElement('textarea');
        t.value = text;
        t.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(t);
        t.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        t.remove();
        if (ok) resolve(); else reject(new Error('copy failed'));
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  function open(opts) {
    const o = opts || {};
    const folders = o.folders || [];
    let images = [];
    let loaded = false;
    let filter = 'all', query = '', sort = 'new', typeFilter = 'all';
    let noteFilter = null, noteFilterTitle = '';   // 依筆記篩選：筆記 id 與標題
    let activeId = null;
    let visibleIds = [];
    let dimsEl = null;
    const selected = new Set();
    const cards = new Map();   // id → 卡片元素，只建一次
    const dims = {};           // id → 「寬 × 高」，圖載入後才知道

    function byId(id) { return images.find(function (x) { return x.id === id; }); }
    function inNote(img) {
      return !noteFilter || img.notes.some(function (n) { return n.id === noteFilter; });
    }
    // 選單分組：最上層 → 各資料夾 → 別人分享的 → 垃圾桶
    function groupOf(n) {
      if (n.trashed) return '垃圾桶';
      if (n.sharedBy) return n.sharedBy + ' 的筆記';
      return folderPath(folders, n.folderId) || '最上層';
    }
    function groupRank(n) { return n.trashed ? 3 : n.sharedBy ? 2 : n.folderId ? 1 : 0; }

    // ---- 外框 ----
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal imglib-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '檔案管理');

    const head = el('div', 'modal-title');
    head.innerHTML = icon('files');
    head.appendChild(el('span', null, '檔案管理'));
    const headCount = el('span', 'imglib-count');
    headCount.hidden = true;
    head.appendChild(headCount);
    head.appendChild(el('span', 'ver-sp'));
    // 直接上傳到這裡：之後用「複製語法」貼進任何筆記。還沒有筆記用到之前會列在「未使用」。
    const upBtn = button('btn imglib-upload', 'upload', '上傳檔案');
    upBtn.title = '上傳檔案到檔案管理，之後可以用「複製語法」貼進筆記';
    upBtn.addEventListener('click', function () {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.addEventListener('change', function () {
        const files = Array.prototype.slice.call(inp.files || []);
        if (!files.length) return;
        upBtn.disabled = true;
        toast('上傳 ' + files.length + ' 個檔案中…');
        Promise.all(files.map(function (f) {
          return Store.putImage(f, f.name, !f.type && /\.pdf$/i.test(f.name) ? 'application/pdf' : undefined);
        })).then(function () {
          toast('已上傳 ' + files.length + ' 個檔案');
          load();
        }, function (e) {
          toast('上傳失敗：' + (e && e.message || e));
          load();
        }).then(function () { upBtn.disabled = false; });
      });
      inp.click();
    });
    head.appendChild(upBtn);
    const close = el('button', 'icon-btn ver-close');
    close.type = 'button';
    close.title = '關閉（Esc）';
    close.innerHTML = icon('x');
    head.appendChild(close);

    const bar = el('div', 'imglib-bar');
    const seg = el('div', 'imglib-seg');
    seg.setAttribute('role', 'tablist');
    const segBtns = {};
    FILTERS.forEach(function (f) {
      const b = el('button', f.key === filter ? 'active' : '');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-f', f.key);
      b.appendChild(el('span', null, f.label));
      const n = el('span', 'n', '0');
      b.appendChild(n);
      b.addEventListener('click', function () {
        if (filter === f.key) return;
        filter = f.key;
        renderList();
      });
      segBtns[f.key] = { btn: b, n: n };
      seg.appendChild(b);
    });

    // 依筆記篩選：一顆下拉鈕 + 選好之後出現的清除鈕 + 可搜尋、依資料夾分組的選單
    const notesel = el('div', 'imglib-notesel');
    const noteBtn = el('button', 'imglib-notesel-btn');
    noteBtn.type = 'button';
    noteBtn.title = '依筆記篩選';
    noteBtn.setAttribute('aria-haspopup', 'listbox');
    noteBtn.setAttribute('aria-expanded', 'false');
    noteBtn.innerHTML = icon('filter');
    const noteLbl = el('span', 'lbl', '所有筆記');
    noteBtn.appendChild(noteLbl);
    const caret = el('span', 'caret');
    caret.innerHTML = icon('chevron-down');
    noteBtn.appendChild(caret);
    const noteClear = el('button', 'imglib-notesel-clear');
    noteClear.type = 'button';
    noteClear.title = '清除筆記篩選';
    noteClear.innerHTML = icon('x');
    noteClear.hidden = true;
    const pop = el('div', 'imglib-notepop');
    pop.hidden = true;
    const popSearch = el('label', 'imglib-notepop-search');
    popSearch.innerHTML = icon('search');
    const popInput = el('input');
    popInput.type = 'text';
    popInput.placeholder = '找筆記…';
    popInput.autocomplete = 'off';
    popInput.spellcheck = false;
    popInput.setAttribute('aria-label', '搜尋筆記');
    popSearch.appendChild(popInput);
    const popList = el('div', 'imglib-notepop-list');
    popList.setAttribute('role', 'listbox');
    pop.appendChild(popSearch);
    pop.appendChild(popList);
    notesel.appendChild(noteBtn);
    notesel.appendChild(noteClear);
    notesel.appendChild(pop);

    const search = el('label', 'imglib-search');
    search.innerHTML = icon('search');
    const input = el('input');
    input.type = 'search';
    input.placeholder = '搜尋檔名、筆記標題…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '搜尋檔案');
    search.appendChild(input);
    const typeSel = el('select', 'imglib-sort');
    typeSel.setAttribute('aria-label', '檔案類型');
    TYPES.forEach(function (t) {
      const op = el('option', null, t.label);
      op.value = t.key;
      typeSel.appendChild(op);
    });
    typeSel.addEventListener('change', function () {
      typeFilter = typeSel.value;
      renderList();
    });
    const sortSel = el('select', 'imglib-sort');
    sortSel.setAttribute('aria-label', '排序');
    SORTS.forEach(function (s) {
      const op = el('option', null, s.label);
      op.value = s.key;
      sortSel.appendChild(op);
    });
    bar.appendChild(seg);
    bar.appendChild(notesel);
    bar.appendChild(search);
    bar.appendChild(typeSel);
    bar.appendChild(sortSel);

    const body = el('div', 'imglib-body');
    const gridWrap = el('div', 'imglib-grid-wrap');
    const grid = el('div', 'imglib-grid');
    gridWrap.appendChild(grid);
    const detail = el('aside', 'imglib-detail');
    body.appendChild(gridWrap);
    body.appendChild(detail);

    const foot = el('div', 'imglib-foot');
    const sum = el('span', 'imglib-sum');
    const selUnusedBtn = button('btn', 'check-square', '選取所有未使用');
    const clearBtn = button('btn btn-ghost', null, '取消選取');
    const delBtn = el('button', 'btn btn-danger');
    delBtn.type = 'button';
    foot.appendChild(sum);
    foot.appendChild(selUnusedBtn);
    foot.appendChild(clearBtn);
    foot.appendChild(delBtn);

    modal.appendChild(head);
    modal.appendChild(bar);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    // 掛在 capture 階段：App.confirm 的確認框也是在 capture 聽 Esc，而且它先關掉自己，
    // 掛在 bubble 的話同一個 Esc 接著會輪到這裡，把圖片管理也一起關掉。
    function onKey(e) {
      const layers = document.querySelectorAll('.modal-overlay');
      if (layers[layers.length - 1] !== overlay) return;   // 確認框疊在上面，按鍵是它的
      if (!pop.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeNotePop(true); return; }
        if (!pop.contains(e.target)) return;
        const optEls = Array.from(popList.querySelectorAll('.imglib-noteopt'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const i = optEls.indexOf(document.activeElement);
          const j = e.key === 'ArrowDown' ? Math.min(optEls.length - 1, i + 1) : i - 1;
          if (j < 0) popInput.focus();
          else if (optEls[j]) optEls[j].focus();
          return;
        }
        if (e.key === 'Enter' && e.target === popInput) {
          e.preventDefault();
          const firstNote = optEls.find(function (b) { return b.getAttribute('data-id'); }) || optEls[0];
          if (firstNote) firstNote.click();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (e.target === input && input.value) return;     // 先讓搜尋框自己清空
        e.preventDefault();
        dismiss();
        return;
      }
      const card = e.target.closest ? e.target.closest('.imglib-card') : null;
      if (!card || !grid.contains(card)) return;
      const id = card.getAttribute('data-id');
      if (e.key === 'Enter') { e.preventDefault(); activate(id); return; }
      if (e.key === ' ') { e.preventDefault(); toggleSelect(id); return; }
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = visibleIds[visibleIds.indexOf(id) + step];
      if (!next) return;
      activate(next);
      cards.get(next).focus();
    }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) dismiss(); });
    modal.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !notesel.contains(e.target)) closeNotePop(false);
    });
    document.addEventListener('keydown', onKey, true);
    input.addEventListener('input', function () {
      query = input.value.trim().toLowerCase();
      renderList();
    });
    sortSel.addEventListener('change', function () {
      sort = sortSel.value;
      renderList();
    });
    selUnusedBtn.addEventListener('click', function () {
      images.forEach(function (img) { if (statusOf(img) === 'unused') selected.add(img.id); });
      filter = 'unused';
      query = '';
      input.value = '';
      setNoteFilter(null);
    });
    clearBtn.addEventListener('click', function () {
      selected.clear();
      renderList();
    });
    delBtn.addEventListener('click', function () { removeImages(Array.from(selected)); });

    // ---- 依筆記篩選 ----
    function noteIndex() {
      const map = new Map();
      images.forEach(function (img) {
        img.notes.forEach(function (n) {
          let entry = map.get(n.id);
          if (!entry) {
            entry = { id: n.id, title: n.title || '未命名筆記', folderId: n.folderId, sharedBy: n.sharedBy, trashed: n.trashed, count: 0 };
            map.set(n.id, entry);
          }
          entry.count++;
        });
      });
      return Array.from(map.values()).sort(function (a, b) {
        return groupRank(a) - groupRank(b) || compareText(groupOf(a), groupOf(b)) || compareText(a.title, b.title);
      });
    }
    function noteOption(n, label, count, iconName) {
      const on = (n ? n.id : null) === noteFilter;
      const b = el('button', 'imglib-noteopt' + (on ? ' is-on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (n) b.setAttribute('data-id', n.id);
      b.innerHTML = icon(iconName);
      b.appendChild(el('span', 'o-title', label));
      b.appendChild(el('span', 'o-n', String(count)));
      b.addEventListener('click', function () {
        setNoteFilter(n);
        closeNotePop(true);
      });
      return b;
    }
    function renderNoteOptions() {
      popList.textContent = '';
      const q = popInput.value.trim().toLowerCase();
      const all = noteIndex();
      const list = all.filter(function (n) { return !q || (n.title + '\n' + groupOf(n)).toLowerCase().indexOf(q) >= 0; });
      if (!q) popList.appendChild(noteOption(null, '所有筆記', images.length, 'layout-grid'));
      let lastGroup = null;
      list.forEach(function (n) {
        const g = groupOf(n);
        if (g !== lastGroup) {
          popList.appendChild(el('div', 'imglib-notepop-group', g));
          lastGroup = g;
        }
        popList.appendChild(noteOption(n, n.title, n.count, n.trashed ? 'trash' : 'file-text'));
      });
      if (!list.length) {
        popList.appendChild(el('div', 'imglib-notepop-empty', q ? '找不到符合「' + popInput.value.trim() + '」的筆記' : '還沒有任何筆記用到檔案'));
      }
    }
    function openNotePop() {
      popInput.value = '';
      renderNoteOptions();
      pop.hidden = false;
      noteBtn.setAttribute('aria-expanded', 'true');
      setTimeout(function () { popInput.focus(); }, 0);
    }
    function closeNotePop(focusBtn) {
      if (pop.hidden) return;
      pop.hidden = true;
      noteBtn.setAttribute('aria-expanded', 'false');
      if (focusBtn) noteBtn.focus();
    }
    function setNoteFilter(n) {
      noteFilter = n ? n.id : null;
      noteFilterTitle = n ? (n.title || '未命名筆記') : '';
      noteLbl.textContent = n ? noteFilterTitle : '所有筆記';
      noteBtn.title = n ? '只顯示「' + noteFilterTitle + '」用到的檔案' : '依筆記篩選';
      notesel.classList.toggle('is-filtered', !!n);
      noteClear.hidden = !n;
      renderList();
    }
    noteBtn.addEventListener('click', function () {
      if (pop.hidden) openNotePop(); else closeNotePop(false);
    });
    noteClear.addEventListener('click', function () { setNoteFilter(null); });
    popInput.addEventListener('input', renderNoteOptions);

    // ---- 卡片 ----
    function buildCard(img) {
      const card = el('div', 'imglib-card');
      card.setAttribute('data-id', img.id);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const thumb = el('div', 'imglib-thumb');
      if (!isImage(img)) {
        const p = el('div', 'imglib-pdf');
        p.innerHTML = icon(isPdf(img) ? 'file-text' : 'paperclip');
        p.appendChild(el('span', null, kind(img)));
        thumb.appendChild(p);
      } else {
        const im = el('img');
        im.alt = '';
        im.loading = 'lazy';
        im.decoding = 'async';
        im.draggable = false;
        im.addEventListener('load', function () {
          im.classList.add('loaded');
          dims[img.id] = im.naturalWidth + ' × ' + im.naturalHeight;
          if (dimsEl && activeId === img.id) dimsEl.textContent = dims[img.id];
        });
        im.addEventListener('error', function () {
          const broken = el('div', 'imglib-broken');
          broken.innerHTML = icon('alert-triangle');
          broken.appendChild(el('span', null, '無法載入'));
          im.replaceWith(broken);
        });
        im.src = srcOf(img.id);
        thumb.appendChild(im);
      }
      const st = statusOf(img);
      if (st !== 'used') thumb.appendChild(el('span', 'imglib-badge ' + st, STATUS_LABEL[st]));
      if (img.annotated) {
        const flag = el('span', 'imglib-flag');
        flag.innerHTML = icon('pen-line');
        flag.title = '已標註';
        thumb.appendChild(flag);
      }
      const check = el('button', 'imglib-check');
      check.type = 'button';
      check.tabIndex = -1;
      check.title = '選取（也可以 Ctrl／Shift＋點選，或按空白鍵）';
      check.innerHTML = icon('check');
      check.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleSelect(img.id);
      });
      thumb.appendChild(check);

      const cap = el('div', 'imglib-cap');
      const title = el('div', 'imglib-cap-title');
      const live = img.notes.filter(function (n) { return !n.trashed; });
      const first = live[0] || img.notes[0];
      if (first) {
        title.innerHTML = icon('file-text');
        title.appendChild(el('span', 't', first.title || '未命名筆記'));
        const extra = useCount(img) - 1;
        if (extra > 0) title.appendChild(el('span', 'more', '+' + extra));
      } else if (img.hiddenNotes) {
        title.innerHTML = icon('lock');
        title.appendChild(el('span', 't', img.hiddenNotes + ' 篇無法檢視的筆記'));
      } else {
        title.classList.add('none');
        title.appendChild(el('span', 't', '沒有筆記使用'));
      }
      cap.appendChild(title);
      cap.appendChild(el('div', 'imglib-cap-meta', kind(img) + ' · ' + size(img.bytes) + ' · ' + shortDate(img.createdAt)));
      card.appendChild(thumb);
      card.appendChild(cap);
      card.setAttribute('aria-label', displayName(img) + '，' +
        (first ? '使用於「' + (first.title || '未命名筆記') + '」' : STATUS_LABEL[st]));
      card._check = check;

      card.addEventListener('click', function (e) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelect(img.id); return; }
        activate(img.id);
      });
      return card;
    }
    function syncCard(card) {
      const id = card.getAttribute('data-id');
      const on = selected.has(id);
      card.classList.toggle('is-active', id === activeId);
      card.classList.toggle('is-selected', on);
      card._check.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function matches(img) {
      if (!inNote(img)) return false;
      if (filter !== 'all' && statusOf(img) !== filter) return false;
      if (typeFilter !== 'all' && typeOf(img) !== typeFilter) return false;
      if (!query) return true;
      const hay = [img.name, img.id, kind(img)];
      img.notes.forEach(function (n) { hay.push(n.title, n.sharedBy, folderPath(folders, n.folderId)); });
      return hay.join('\n').toLowerCase().indexOf(query) >= 0;
    }

    function emptyState() {
      const box = el('div', 'imglib-empty');
      let ic = 'image', msg;
      if (!images.length) msg = '還沒有上傳過任何檔案。\n在筆記裡貼上或拖進圖片、PDF 或其他檔案，或按右上角的「上傳檔案」，就會出現在這裡。';
      else if (query) { ic = 'search'; msg = '找不到符合「' + input.value.trim() + '」的檔案。'; }
      else if (noteFilter) {
        ic = 'file-text';
        msg = filter === 'all' ? '「' + noteFilterTitle + '」目前沒有用到任何檔案。'
                               : '「' + noteFilterTitle + '」用到的檔案裡，沒有' + STATUS_LABEL[filter] + '的。';
      }
      else if (filter === 'unused') { ic = 'check'; msg = '每個檔案都有筆記在使用，沒有需要清理的。'; }
      else if (filter === 'trash') { ic = 'check'; msg = '沒有只被垃圾桶裡的筆記使用的檔案。'; }
      else msg = '目前沒有被任何筆記使用的檔案。';
      box.innerHTML = icon(ic);
      box.appendChild(el('div', null, msg));
      return box;
    }

    function renderList() {
      // 狀態篩選的數字跟著「依筆記篩選」走，不跟著搜尋字
      const scoped = images.filter(inNote);
      const counts = { all: scoped.length, used: 0, unused: 0, trash: 0 };
      scoped.forEach(function (img) { counts[statusOf(img)]++; });
      FILTERS.forEach(function (f) {
        const s = segBtns[f.key], on = f.key === filter;
        s.n.textContent = counts[f.key];
        s.btn.classList.toggle('active', on);
        s.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      headCount.hidden = !images.length;
      headCount.textContent = images.length;

      const by = {
        new: function (a, b) { return b.createdAt - a.createdAt; },
        old: function (a, b) { return a.createdAt - b.createdAt; },
        big: function (a, b) { return b.bytes - a.bytes || b.createdAt - a.createdAt; },
        uses: function (a, b) { return useCount(b) - useCount(a) || b.createdAt - a.createdAt; }
      }[sort];
      const list = images.filter(matches).sort(by);
      visibleIds = list.map(function (img) { return img.id; });
      // 被篩掉、畫面上看不到的就不算選取，免得「刪除所選」刪到沒看見的檔案
      Array.from(selected).forEach(function (id) { if (visibleIds.indexOf(id) < 0) selected.delete(id); });

      grid.textContent = '';
      if (!list.length) grid.appendChild(emptyState());
      list.forEach(function (img) {
        let card = cards.get(img.id);
        if (!card) { card = buildCard(img); cards.set(img.id, card); }
        syncCard(card);
        grid.appendChild(card);
      });
      grid.classList.toggle('has-selection', selected.size > 0);
      renderFoot();
      if (activeId && visibleIds.indexOf(activeId) < 0) {
        activeId = null;
        renderDetail();
      }
    }

    function renderFoot() {
      sum.textContent = '';
      if (selected.size) {
        let bytes = 0;
        selected.forEach(function (id) { const img = byId(id); if (img) bytes += img.bytes; });
        sum.appendChild(el('b', null, '已選取 ' + selected.size + ' 個'));
        sum.appendChild(document.createTextNode(' · ' + size(bytes)));
      } else if (loaded) {
        const scoped = images.filter(inNote);
        let total = 0, unusedN = 0, unusedBytes = 0;
        scoped.forEach(function (img) {
          total += img.bytes;
          if (statusOf(img) === 'unused') { unusedN++; unusedBytes += img.bytes; }
        });
        sum.appendChild(el('b', null, noteFilter ? '「' + noteFilterTitle + '」用到 ' + scoped.length + ' 個檔案'
                                                 : images.length + ' 個檔案'));
        sum.appendChild(document.createTextNode(' · 共 ' + size(total)));
        if (unusedN) {
          sum.appendChild(document.createTextNode(' · '));
          sum.appendChild(el('span', 'warn', unusedN + ' 個沒有筆記在用，佔 ' + size(unusedBytes)));
        }
      }
      const anyUnused = images.some(function (img) { return statusOf(img) === 'unused'; });
      selUnusedBtn.hidden = !loaded || selected.size > 0 || !anyUnused || !!noteFilter;
      clearBtn.hidden = !selected.size;
      delBtn.innerHTML = icon('trash');
      delBtn.appendChild(document.createTextNode(selected.size ? '刪除所選（' + selected.size + '）' : '刪除所選'));
      delBtn.disabled = !selected.size;
    }

    function toggleSelect(id) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      const card = cards.get(id);
      if (card) syncCard(card);
      grid.classList.toggle('has-selection', selected.size > 0);
      renderFoot();
    }
    function activate(id) {
      if (activeId === id) return;
      const prev = activeId;
      activeId = id;
      [prev, id].forEach(function (x) {
        const c = x && cards.get(x);
        if (c) syncCard(c);
      });
      renderDetail();
    }

    // ---- 右側詳細資訊 ----
    function renderDetail() {
      detail.textContent = '';
      dimsEl = null;
      const img = activeId ? byId(activeId) : null;
      if (!img) {
        const ph = el('div', 'imglib-d-placeholder');
        ph.innerHTML = icon('image');
        ph.appendChild(el('div', null, images.length ? '點一個檔案，\n看它用在哪些筆記。' : '選取的檔案會在這裡顯示詳細資訊。'));
        detail.appendChild(ph);
        return;
      }
      const st = statusOf(img);

      const pv = el('div', 'imglib-d-preview' + (isImage(img) ? '' : ' is-pdf'));
      if (!isImage(img)) {
        pv.innerHTML = icon(isPdf(img) ? 'file-text' : 'paperclip');
        pv.appendChild(el('span', null, isPdf(img) ? 'PDF 文件' : kind(img) + ' 檔案'));
      } else {
        const im = el('img');
        im.alt = img.name || '';
        im.addEventListener('load', function () {
          dims[img.id] = im.naturalWidth + ' × ' + im.naturalHeight;
          if (dimsEl && activeId === img.id) dimsEl.textContent = dims[img.id];
        });
        im.src = srcOf(img.id);
        pv.appendChild(im);
      }
      const openLink = el('a', 'imglib-d-open');
      openLink.href = srcOf(img.id);
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      openLink.title = '在新分頁開啟原檔';
      openLink.innerHTML = icon('external-link');
      pv.appendChild(openLink);
      detail.appendChild(pv);

      const main = el('div', 'imglib-d-main');
      const top = el('div');
      top.appendChild(el('span', 'imglib-status ' + st, STATUS_LABEL[st]));
      top.appendChild(el('div', 'imglib-d-name', displayName(img)));
      top.appendChild(el('div', 'imglib-d-id', img.id));
      main.appendChild(top);

      const props = el('dl', 'imglib-props');
      function prop(k, v) {
        props.appendChild(el('dt', null, k));
        const dd = el('dd', null, v);
        props.appendChild(dd);
        return dd;
      }
      prop('類型', kind(img));
      prop('大小', size(img.bytes) + (img.annotated ? '（含標註前的原圖）' : ''));
      if (isImage(img)) dimsEl = prop('尺寸', dims[img.id] || '—');
      prop('上傳', fullDate(img.createdAt));
      main.appendChild(props);

      const uses = el('div');
      const total = useCount(img);
      uses.appendChild(el('div', 'imglib-d-sec', total ? '使用於 ' + total + ' 篇筆記' : '使用於'));
      if (total) {
        const ul = el('ul', 'imglib-uses');
        img.notes.forEach(function (n) {
          const li = el('li', 'imglib-use-row');
          const b = el('button', 'imglib-use');
          b.type = 'button';
          b.innerHTML = icon('file-text');
          const m = el('span', 'u-main');
          m.appendChild(el('span', 'u-title', n.title || '未命名筆記'));
          m.appendChild(el('span', 'u-path', n.sharedBy ? n.sharedBy + ' 的筆記' : (folderPath(folders, n.folderId) || '最上層')));
          b.appendChild(m);
          if (n.count > 1) b.appendChild(el('span', 'u-tag', '×' + n.count));
          if (n.trashed) {
            b.appendChild(el('span', 'u-tag trash', '垃圾桶'));
            b.disabled = true;
            b.title = '這篇筆記在垃圾桶裡，先從垃圾桶復原才能開啟';
          } else {
            const go = el('span', 'u-go');
            go.innerHTML = icon('chevron-right');
            b.appendChild(go);
            b.title = '開啟這篇筆記';
            b.addEventListener('click', function () {
              dismiss();
              if (o.onOpenNote) o.onOpenNote(n.id);
            });
          }
          li.appendChild(b);
          const on = noteFilter === n.id;
          const fb = el('button', 'imglib-use-filter' + (on ? ' is-on' : ''));
          fb.type = 'button';
          fb.title = on ? '取消只看這篇筆記' : '只看這篇筆記用到的檔案';
          fb.setAttribute('aria-pressed', on ? 'true' : 'false');
          fb.innerHTML = icon('filter');
          fb.addEventListener('click', function () {
            setNoteFilter(on ? null : { id: n.id, title: n.title });
            renderDetail();
          });
          li.appendChild(fb);
          ul.appendChild(li);
        });
        if (img.hiddenNotes) {
          const li = el('li', 'imglib-use-row');
          const row = el('div', 'imglib-use is-hidden');
          row.innerHTML = icon('lock');
          const m = el('span', 'u-main');
          m.appendChild(el('span', 'u-title', '另有 ' + img.hiddenNotes + ' 篇你無法檢視的筆記'));
          m.appendChild(el('span', 'u-path', '別人的筆記裡也貼了這個檔案'));
          row.appendChild(m);
          li.appendChild(row);
          ul.appendChild(li);
        }
        uses.appendChild(ul);
      } else {
        const none = el('div', 'imglib-d-none');
        none.innerHTML = icon('info');
        none.appendChild(el('span', null, '目前沒有任何筆記用到這個檔案。舊的版本紀錄如果有用到，還原那個版本後會缺圖。'));
        uses.appendChild(none);
      }
      main.appendChild(uses);

      const acts = el('div', 'imglib-d-acts');
      const copyBtn = button('btn', 'copy', '複製語法');
      copyBtn.title = '複製可以貼進筆記的 Markdown：' + markdownOf(img);
      copyBtn.addEventListener('click', function () {
        copyText(markdownOf(img)).then(function () { toast('已複製，可以直接貼進筆記'); },
          function () { toast('複製失敗'); });
      });
      const dl = el('a', 'btn');
      dl.href = srcOf(img.id);
      dl.download = fileName(img);
      dl.innerHTML = icon('download');
      dl.appendChild(document.createTextNode('下載'));
      const del = button('btn imglib-del', 'trash', '刪除檔案');
      del.addEventListener('click', function () { removeImages([img.id]); });
      acts.appendChild(copyBtn);
      acts.appendChild(dl);
      acts.appendChild(del);
      main.appendChild(acts);
      detail.appendChild(main);
    }

    // ---- 刪除 ----
    function removeImages(ids) {
      const list = ids.map(byId).filter(Boolean);
      if (!list.length) return;
      const one = list.length === 1;
      let bytes = 0;
      list.forEach(function (img) { bytes += img.bytes; });
      const inUse = list.filter(function (img) { return statusOf(img) === 'used'; }).length;
      const inBin = list.filter(function (img) { return statusOf(img) === 'trash'; }).length;
      const lines = [one ? '確定永久刪除「' + displayName(list[0]) + '」？'
                         : '確定永久刪除這 ' + list.length + ' 個檔案（' + size(bytes) + '）？'];
      if (inUse) lines.push((one ? '它' : '其中 ' + inUse + ' 個') + '還有筆記在使用，刪除後那些筆記會缺圖。');
      if (inBin) lines.push((one ? '它' : '其中 ' + inBin + ' 個') + '只被垃圾桶裡的筆記使用，那些筆記復原後會缺圖。');
      lines.push('檔案沒有垃圾桶，刪除後無法復原。');
      confirm({ title: '刪除檔案', message: lines.join('\n'), ok: '永久刪除', danger: true }).then(function (ok) {
        if (!ok) return;
        let done = 0, failed = 0;
        let chain = Promise.resolve();
        list.forEach(function (img) {
          chain = chain.then(function () {
            return Store.deleteImage(img.id).then(function () {
              done++;
              images = images.filter(function (x) { return x.id !== img.id; });
              selected.delete(img.id);
              const card = cards.get(img.id);
              if (card) card.remove();
              cards.delete(img.id);
              if (activeId === img.id) activeId = null;
              if (global.MD && MD.invalidateImage) MD.invalidateImage(img.id);
            }, function () { failed++; });
          });
        });
        chain.then(function () {
          renderList();
          renderDetail();
          toast(failed ? '已刪除 ' + done + ' 個，' + failed + ' 個刪除失敗' : '已刪除 ' + done + ' 個檔案');
        });
      });
    }

    function load() {
      grid.textContent = '';
      const wait = el('div', 'imglib-empty');
      wait.innerHTML = icon('clock');
      wait.appendChild(el('div', null, '載入中…'));
      grid.appendChild(wait);
      renderFoot();
      renderDetail();
      Store.listImages().then(function (data) {
        images = (data && data.images) || [];
        loaded = true;
        renderList();
        renderDetail();
      }).catch(function (e) {
        grid.textContent = '';
        const err = el('div', 'imglib-empty');
        err.innerHTML = icon('alert-triangle');
        err.appendChild(el('div', null, '讀取圖片清單失敗：' + (e && e.message || e)));
        grid.appendChild(err);
      });
    }

    load();
    setTimeout(function () { input.focus(); }, 30);
  }

  global.ImageLib = { open: open };
})(window);
