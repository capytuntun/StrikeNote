/* versions.js — the dialogs that act on a whole note or a whole book:
 * version history, and public share links for an e-book.
 *
 * Two panels, one shape: a list of versions on the left, what changed on the
 * right. The diff is computed with Merge.diffLines, the same LCS the
 * collaborative merge uses, so "what changed" on screen is decided exactly the
 * way a save conflict is — there is not a second, subtly different idea of a
 * changed line anywhere in the app.
 *
 *   Versions.openNote(note, { onRestored })
 *   Versions.openBook(book, { onRestored })   // book = the object js/book.js builds
 *
 * Everything it needs comes in through those arguments and through Store, so
 * this module has no opinion about how notes are loaded or rendered.
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/') +
      (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function chars(n) {
    if (n == null) return '';
    return n >= 10000 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字';
  }

  function icon(name) {
    return global.Icons ? Icons.svg(name) : '';
  }

  // A modal shell shared by both panels.
  function shell(titleText, iconName) {
    const overlay = el('div', 'modal-overlay ver-overlay');
    const modal = el('div', 'modal ver-modal');
    const head = el('div', 'modal-title');
    head.innerHTML = icon(iconName);
    head.appendChild(el('span', null, titleText));
    const close = el('button', 'icon-btn ver-close');
    close.type = 'button';
    close.title = '關閉';
    close.innerHTML = icon('x');
    head.appendChild(el('span', 'ver-sp'));
    head.appendChild(close);
    modal.appendChild(head);
    const body = el('div', 'ver-body');
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function onKey(e) { if (e.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKey);
    return { overlay: overlay, modal: modal, body: body, close: dismiss };
  }

  function toast(msg) {
    if (global.App && App.toast) App.toast(msg);
  }

  // The app has its own modal prompt; the browser's would look nothing like the
  // rest of the UI and cannot be styled.
  function promptBox(opts) {
    if (global.App && App.prompt) return App.prompt(opts);
    return Promise.resolve(window.prompt(opts.title || '', opts.value || ''));
  }

  function confirmBox(title, message) {
    if (global.App && App.confirm) return App.confirm({ title: title, message: message });
    return Promise.resolve(true);
  }

  // ---- diff rendering ----------------------------------------------------
  //
  // Unchanged runs longer than this collapse to a single marker: a version panel
  // is for seeing what moved, and scrolling past a hundred identical lines to
  // find the one that changed defeats the point.
  const CONTEXT = 3;

  function renderDiff(oldText, newText) {
    const wrap = el('div', 'ver-diff');
    if (!global.Merge || !Merge.diffLines) {
      wrap.appendChild(el('div', 'ver-empty', '無法比對：缺少 merge 模組'));
      return wrap;
    }
    const rows = Merge.diffLines(oldText || '', newText || '');
    if (!rows.some(function (r) { return r.type !== 'ctx'; })) {
      wrap.appendChild(el('div', 'ver-empty', '這個版本的內容與目前完全相同'));
      return wrap;
    }

    // Mark which context lines are near a change and therefore worth showing.
    const keep = new Array(rows.length);
    rows.forEach(function (r, i) {
      if (r.type === 'ctx') return;
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) keep[j] = true;
    });

    let skipped = 0;
    rows.forEach(function (r, i) {
      if (r.type === 'ctx' && !keep[i]) { skipped++; return; }
      if (skipped) {
        wrap.appendChild(el('div', 'ver-gap', '⋯ 略過 ' + skipped + ' 行相同內容'));
        skipped = 0;
      }
      const line = el('div', 'ver-line ver-' + r.type);
      line.appendChild(el('span', 'ver-no', r.a == null ? '' : String(r.a)));
      line.appendChild(el('span', 'ver-no', r.b == null ? '' : String(r.b)));
      line.appendChild(el('span', 'ver-mark', r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '));
      line.appendChild(el('span', 'ver-text', r.text === '' ? ' ' : r.text));
      wrap.appendChild(line);
    });
    if (skipped) wrap.appendChild(el('div', 'ver-gap', '⋯ 略過 ' + skipped + ' 行相同內容'));
    return wrap;
  }

  /* =======================================================================
   * Note history
   * ===================================================================== */
  function openNote(note, opts) {
    const o = opts || {};
    const ui = shell('版本紀錄 — ' + (note.title || '未命名筆記'), 'history');
    const list = el('div', 'ver-list');
    const pane = el('div', 'ver-pane');
    ui.body.appendChild(list);
    ui.body.appendChild(pane);
    pane.appendChild(el('div', 'ver-empty', '從左邊選一個版本，這裡會顯示它和目前內容的差異。'));

    let data = null;
    let selectedId = null;

    function reload() {
      list.innerHTML = '';
      list.appendChild(el('div', 'ver-empty', '載入中…'));
      return Store.getVersions(note.id).then(function (res) {
        data = res;
        paint();
      }).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'ver-empty', '讀取失敗：' + e.message));
      });
    }

    function paint() {
      list.innerHTML = '';

      const now = el('button', 'ver-item ver-now' + (selectedId === null ? ' on' : ''));
      now.type = 'button';
      now.appendChild(el('span', 'ver-when', '目前版本'));
      now.appendChild(el('span', 'ver-meta',
        when(data.current.updatedAt) + ' · ' + chars(data.current.chars)));
      now.addEventListener('click', function () {
        selectedId = null;
        paint();
        pane.innerHTML = '';
        pane.appendChild(el('div', 'ver-empty', '這就是目前的內容。'));
      });
      list.appendChild(now);

      if (!data.versions.length) {
        list.appendChild(el('div', 'ver-empty',
          '這篇筆記還沒有任何歷史版本。編輯之後就會自動開始記錄。'));
      }

      data.versions.forEach(function (v) {
        const item = el('button', 'ver-item' + (v.id === selectedId ? ' on' : '') +
          (v.label ? ' ver-labelled' : ''));
        item.type = 'button';
        const top = el('span', 'ver-when', v.label || when(v.createdAt));
        item.appendChild(top);
        item.appendChild(el('span', 'ver-meta',
          (v.label ? when(v.createdAt) + ' · ' : '') +
          (v.author || '（不明）') + ' · ' + chars(v.chars)));
        item.addEventListener('click', function () { select(v); });
        list.appendChild(item);
      });

      const foot = el('div', 'ver-listfoot');
      const mark = el('button', 'btn btn-ghost');
      mark.type = 'button';
      mark.innerHTML = icon('git-commit');
      mark.appendChild(el('span', null, '標記目前版本'));
      mark.addEventListener('click', markCurrent);
      foot.appendChild(mark);
      list.appendChild(foot);
    }

    function markCurrent() {
      promptBox({ title: '標記目前版本', message: '替目前的內容取一個名字，之後就能一眼認出它。',
        placeholder: '例如：交件版' }).then(function (label) {
        if (label === null) return;
        return Store.createVersion(note.id, label.trim())
          .then(function () { toast('已標記目前版本'); return reload(); });
      }).catch(function (e) { toast('標記失敗：' + e.message); });
    }

    function select(v) {
      selectedId = v.id;
      paint();
      pane.innerHTML = '';
      pane.appendChild(el('div', 'ver-empty', '載入中…'));
      Store.getVersion(note.id, v.id).then(function (res) {
        pane.innerHTML = '';

        const bar = el('div', 'ver-actions');
        const label = el('div', 'ver-headline');
        label.appendChild(el('span', 'ver-headline-t', v.label || when(v.createdAt)));
        label.appendChild(el('span', 'ver-headline-m',
          '由 ' + (v.author || '（不明）') + ' 儲存 · 修訂 ' + v.rev));
        bar.appendChild(label);
        bar.appendChild(el('span', 'ver-sp'));

        if (data.perm !== 'read') {
          const restore = el('button', 'btn btn-primary');
          restore.type = 'button';
          restore.innerHTML = icon('rotate-ccw');
          restore.appendChild(el('span', null, '還原到這個版本'));
          restore.addEventListener('click', function () { doRestore(v); });
          bar.appendChild(restore);
        }
        if (data.perm === 'owner') {
          const ren = el('button', 'btn btn-ghost');
          ren.type = 'button';
          ren.textContent = v.label ? '改名' : '命名';
          ren.addEventListener('click', function () { doRename(v); });
          bar.appendChild(ren);
          const del = el('button', 'btn btn-ghost ver-delbtn');
          del.type = 'button';
          del.innerHTML = icon('trash');
          del.title = '刪除這個版本';
          del.addEventListener('click', function () { doDelete(v); });
          bar.appendChild(del);
        }
        pane.appendChild(bar);

        if (res.version.title !== res.current.title) {
          pane.appendChild(el('div', 'ver-titlediff',
            '標題：「' + res.version.title + '」 → 目前「' + res.current.title + '」'));
        }
        // drawio 圖表的內容是圖的 DSL（一行一個圖形或連線，滿滿的座標），逐行比對看不出
        // 圖哪裡變了；對人有意義的是兩張圖長什麼樣，所以並排放圖。
        const picTool = (global.DrawIO && DrawIO.isNote(note)) ? global.DrawIO : (global.XMind && XMind.isNote(note)) ? global.XMind : null;   // 心智圖同理：JSON 的逐行比對沒有意義
        if (picTool) {
          pane.appendChild(el('div', 'ver-diffhead', '左邊是這個版本的圖，右邊是目前的圖'));
          const pics = el('div', 'ver-pics');
          [res.version.content, res.current.content].forEach(function (c) {
            const box = el('div', 'ver-pic');
            box.innerHTML = picTool.blockHTML(picTool.payloadOf(c) || '');
            pics.appendChild(box);
          });
          pane.appendChild(pics);
          return;
        }
        pane.appendChild(el('div', 'ver-diffhead', '左欄是這個版本，右欄是目前內容'));
        pane.appendChild(renderDiff(res.version.content, res.current.content));
      }).catch(function (e) {
        pane.innerHTML = '';
        pane.appendChild(el('div', 'ver-empty', '讀取失敗：' + e.message));
      });
    }

    function doRestore(v) {
      confirmBox('還原版本',
        '要把這篇筆記還原成「' + (v.label || when(v.createdAt)) + '」的內容嗎？' +
        '目前的內容會先被保存成一個版本，所以還原之後仍然可以再還原回來。')
        .then(function (yes) {
          if (!yes) return;
          return Store.restoreVersion(note.id, v.id).then(function (fresh) {
            toast('已還原');
            if (o.onRestored) o.onRestored(fresh);
            ui.close();
          });
        })
        .catch(function (e) { toast('還原失敗：' + e.message); });
    }

    function doRename(v) {
      promptBox({ title: '版本名稱', message: '留空會把它變回一般的自動版本。',
        value: v.label || '' }).then(function (next) {
        if (next === null) return;
        return Store.renameVersion(note.id, v.id, next.trim())
          .then(function () { selectedId = v.id; return reload(); });
      }).catch(function (e) { toast('改名失敗：' + e.message); });
    }

    function doDelete(v) {
      confirmBox('刪除版本', '要永久刪除這個版本嗎？這個動作無法復原。')
        .then(function (yes) {
          if (!yes) return;
          return Store.deleteVersion(note.id, v.id).then(function () {
            selectedId = null;
            pane.innerHTML = '';
            pane.appendChild(el('div', 'ver-empty', '版本已刪除。'));
            return reload();
          });
        })
        .catch(function (e) { toast('刪除失敗：' + e.message); });
    }

    reload();
    return ui;
  }

  /* =======================================================================
   * E-book history
   * =====================================================================
   * A book is a folder, so a book version records which notes were chapters, in
   * what order, and which note version each was pinned to. That is the only part
   * of a book that can meaningfully be frozen.
   */
  function openBook(book, opts) {
    const o = opts || {};
    const folderId = book.folder && book.folder.id;
    const ui = shell('電子書版本 — ' + (book.title || '未命名'), 'book');
    const list = el('div', 'ver-list');
    const pane = el('div', 'ver-pane');
    ui.body.appendChild(list);
    ui.body.appendChild(pane);
    pane.appendChild(el('div', 'ver-empty', '從左邊選一個版本，這裡會列出它包含的章節。'));

    let selectedId = null;

    function reload() {
      list.innerHTML = '';
      list.appendChild(el('div', 'ver-empty', '載入中…'));
      return Store.getBookVersions(folderId).then(paint).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'ver-empty', '讀取失敗：' + e.message));
      });
    }

    function paint(versions) {
      list.innerHTML = '';
      const now = el('div', 'ver-item ver-now');
      now.appendChild(el('span', 'ver-when', '目前的書'));
      now.appendChild(el('span', 'ver-meta', book.chapters.length + ' 章'));
      list.appendChild(now);

      if (!versions.length) {
        list.appendChild(el('div', 'ver-empty',
          '還沒有任何版本。按下方的按鈕把這本書目前的樣子存成一個版本。'));
      }
      versions.forEach(function (v) {
        const item = el('button', 'ver-item' + (v.id === selectedId ? ' on' : '') +
          (v.label ? ' ver-labelled' : ''));
        item.type = 'button';
        item.appendChild(el('span', 'ver-when', v.label || when(v.createdAt)));
        item.appendChild(el('span', 'ver-meta',
          (v.label ? when(v.createdAt) + ' · ' : '') + v.chapters + ' 章'));
        item.addEventListener('click', function () { select(v); });
        list.appendChild(item);
      });

      const foot = el('div', 'ver-listfoot');
      const snap = el('button', 'btn btn-ghost');
      snap.type = 'button';
      snap.innerHTML = icon('git-commit');
      snap.appendChild(el('span', null, '建立版本'));
      snap.addEventListener('click', snapshot);
      foot.appendChild(snap);
      list.appendChild(foot);
    }

    function snapshot() {
      if (!book.chapters.length) { toast('這本書還沒有任何章節'); return; }
      promptBox({ title: '建立電子書版本',
        message: '會把每一章目前的內容都凍結起來，之後改動筆記也不會影響這個版本。',
        placeholder: '例如：送審版' }).then(function (label) {
        if (label === null) return;
        const ids = book.chapters.map(function (c) { return c.note.id; });
        return Store.createBookVersion(folderId, book.title || '未命名電子書', label.trim(), ids)
          .then(function () { toast('已建立電子書版本'); return reload(); });
      }).catch(function (e) { toast('建立失敗：' + e.message); });
    }

    function select(v) {
      selectedId = v.id;
      pane.innerHTML = '';
      pane.appendChild(el('div', 'ver-empty', '載入中…'));
      Store.getBookVersion(v.id).then(function (full) {
        // Repaint the list so the selection highlight follows.
        Store.getBookVersions(folderId).then(paint);
        pane.innerHTML = '';

        const bar = el('div', 'ver-actions');
        const head = el('div', 'ver-headline');
        head.appendChild(el('span', 'ver-headline-t', full.label || when(full.createdAt)));
        head.appendChild(el('span', 'ver-headline-m',
          when(full.createdAt) + ' · ' + full.chapters.length + ' 章'));
        bar.appendChild(head);
        bar.appendChild(el('span', 'ver-sp'));

        const restore = el('button', 'btn btn-primary');
        restore.type = 'button';
        restore.innerHTML = icon('rotate-ccw');
        restore.appendChild(el('span', null, '還原整本書'));
        restore.addEventListener('click', function () { doRestore(full); });
        bar.appendChild(restore);

        const del = el('button', 'btn btn-ghost ver-delbtn');
        del.type = 'button';
        del.innerHTML = icon('trash');
        del.title = '刪除這個版本';
        del.addEventListener('click', function () { doDelete(full); });
        bar.appendChild(del);
        pane.appendChild(bar);

        const missing = full.chapters.filter(function (c) { return c.missing; }).length;
        if (missing) {
          pane.appendChild(el('div', 'ver-titlediff',
            '有 ' + missing + ' 章的內容已經不在了，還原時會略過。'));
        }

        const table = el('div', 'ver-chapters');
        full.chapters.forEach(function (c, i) {
          const row = el('button', 'ver-chapter' + (c.missing ? ' ver-missing' : ''));
          row.type = 'button';
          row.appendChild(el('span', 'ver-chapter-n', String(i + 1)));
          row.appendChild(el('span', 'ver-chapter-t', c.title));
          row.appendChild(el('span', 'ver-chapter-m',
            c.missing ? '內容已遺失' : chars(c.chars)));
          if (!c.missing) row.addEventListener('click', function () { peek(full, c); });
          table.appendChild(row);
        });
        pane.appendChild(table);
      }).catch(function (e) {
        pane.innerHTML = '';
        pane.appendChild(el('div', 'ver-empty', '讀取失敗：' + e.message));
      });
    }

    // Compare one chapter as it was in this book version against the note today.
    function peek(full, c) {
      Store.getBookVersionChapter(full.id, c.noteId).then(function (chapter) {
        const live = (o.notes || []).filter(function (n) { return n.id === c.noteId; })[0];
        const sub = shell('章節比對 — ' + chapter.title, 'compare');
        sub.modal.classList.add('ver-modal-sub');
        const box = el('div', 'ver-pane ver-pane-solo');
        sub.body.appendChild(box);
        box.appendChild(el('div', 'ver-diffhead',
          live ? '左欄是版本中的內容，右欄是這篇筆記目前的內容'
               : '這篇筆記已經不在了，以下是版本中保存的內容'));
        if (live) box.appendChild(renderDiff(chapter.content, live.content || ''));
        else {
          const pre = el('pre', 'ver-plain');
          pre.textContent = chapter.content;
          box.appendChild(pre);
        }
      }).catch(function (e) { toast('讀取失敗：' + e.message); });
    }

    function doRestore(full) {
      confirmBox('還原整本電子書',
        '要把這本書的每一章都還原成「' + (full.label || when(full.createdAt)) + '」的內容嗎？' +
        '每一章目前的內容都會先各自保存成一個版本。')
        .then(function (yes) {
          if (!yes) return;
          return Store.restoreBookVersion(full.id).then(function (res) {
            toast('已還原 ' + res.restored + ' 章' +
              (res.skipped && res.skipped.length ? '，略過 ' + res.skipped.length + ' 章' : ''));
            if (o.onRestored) o.onRestored();
            ui.close();
          });
        })
        .catch(function (e) { toast('還原失敗：' + e.message); });
    }

    function doDelete(full) {
      confirmBox('刪除電子書版本',
        '要刪除這個電子書版本嗎？各章筆記本身不會被刪除，只會放掉這個版本為它們保留的舊內容。')
        .then(function (yes) {
          if (!yes) return;
          return Store.deleteBookVersion(full.id).then(function () {
            selectedId = null;
            pane.innerHTML = '';
            pane.appendChild(el('div', 'ver-empty', '版本已刪除。'));
            return reload();
          });
        })
        .catch(function (e) { toast('刪除失敗：' + e.message); });
    }

    reload();
    return ui;
  }

  /* =======================================================================
   * Public share links for an e-book
   * =====================================================================
   * The only thing in this app that anyone can open without an account, so the
   * dialog is blunt about what a link does. What gets shared is a snapshot: the
   * book is packed into one self-contained file at the moment the link is made,
   * and that file is what visitors see. Editing the notes afterwards changes
   * nothing until the owner presses 更新內容 — which also means a link can never
   * start leaking something that was added to the folder later.
   */
  const EXPIRY_CHOICES = [
    { days: 0, label: '不設期限' },
    { days: 7, label: '7 天後失效' },
    { days: 30, label: '30 天後失效' },
    { days: 90, label: '90 天後失效' }
  ];

  function shareUrl(token) { return location.origin + '/s/' + token; }

  function copyText(text, btn) {
    const done = function () {
      if (!btn) return;
      const was = btn.textContent;
      btn.textContent = '已複製';
      setTimeout(function () { btn.textContent = was; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('複製失敗，請手動選取連結'); }
      ta.remove();
    }
  }

  // 公開連結的對話框，電子書與單篇筆記共用。cfg：
  //   heading／warn／empty  文字
  //   list()                 → Promise<links>
  //   pack()                 → Promise<html>（打包現在的內容）
  //   create(html, days)     → Promise<link>
  //   update(lk, html)       → Promise<link>
  //   remove(lk)             → Promise
  //   bits(lk)               → 一列下面那行灰字的前幾段
  //   setAuto(lk, on)        → Promise；有給才會出現「自動更新」的勾選（單篇筆記才有）
  //   onChange()             建立／更新／取消之後叫一下（外面的清單要重畫）
  function openLinks(cfg) {
    const ui = shell(cfg.heading, 'link');
    ui.modal.classList.add('share-modal');
    // This dialog stacks vertically rather than using the two-column history
    // layout, so it swaps out the shell's body instead of filling it.
    const body = el('div', 'share-body');
    ui.body.replaceWith(body);

    const warn = el('div', 'share-warn');
    warn.appendChild(el('span', 'share-warn-ic', ''));
    warn.querySelector('.share-warn-ic').innerHTML = icon('alert-triangle');
    warn.appendChild(el('span', null, cfg.warn));
    body.appendChild(warn);

    const list = el('div', 'share-list');
    body.appendChild(list);

    const foot = el('div', 'share-foot');
    const sel = document.createElement('select');
    sel.className = 'share-expiry';
    EXPIRY_CHOICES.forEach(function (c) {
      const op = document.createElement('option');
      op.value = String(c.days);
      op.textContent = c.label;
      sel.appendChild(op);
    });
    foot.appendChild(sel);
    // 新連結要不要自動更新（預設要）。建好之後每個連結各自可以再改
    let autoBox = null;
    if (cfg.setAuto) {
      const lab = el('label', 'share-auto share-auto-new');
      autoBox = document.createElement('input');
      autoBox.type = 'checkbox';
      autoBox.checked = true;
      lab.appendChild(autoBox);
      lab.appendChild(el('span', null, '自動更新'));
      lab.title = '勾選：之後改了筆記，連結上的內容會自動跟著更新。不勾：連結停在現在這一版，要更新得自己按「更新內容」。';
      foot.appendChild(lab);
    }
    const make = el('button', 'btn btn-primary');
    make.type = 'button';
    make.innerHTML = icon('link');
    make.appendChild(el('span', null, '建立分享連結'));
    make.addEventListener('click', create);
    foot.appendChild(make);
    body.appendChild(foot);

    function busy(btn, on, label) {
      btn.disabled = on;
      if (on) { btn._was = btn.innerHTML; btn.textContent = label || '處理中…'; }
      else if (btn._was) { btn.innerHTML = btn._was; btn._was = null; }
    }

    function reload() {
      list.innerHTML = '';
      list.appendChild(el('div', 'ver-empty', '載入中…'));
      return cfg.list().then(paint).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'ver-empty', '讀取失敗：' + e.message));
      });
    }

    function paint(links) {
      list.innerHTML = '';
      if (!links.length) {
        list.appendChild(el('div', 'ver-empty', cfg.empty));
        return;
      }
      links.forEach(function (lk) {
        const manual = lk.autoUpdate === false;      // 不自動更新：內容停在最後一次更新，是本人要的，不是出錯
        const row = el('div', 'share-row' + (lk.expired ? ' is-expired' : '') + (lk.stale && !manual ? ' is-stale' : ''));

        const urlRow = el('div', 'share-urlrow');
        const field = document.createElement('input');
        field.className = 'share-url';
        field.type = 'text';
        field.readOnly = true;
        field.value = shareUrl(lk.token);
        field.addEventListener('focus', function () { field.select(); });
        urlRow.appendChild(field);
        const copy = el('button', 'btn', '複製');
        copy.type = 'button';
        copy.addEventListener('click', function () { copyText(field.value, copy); });
        urlRow.appendChild(copy);
        const openBtn = el('button', 'btn btn-ghost');
        openBtn.type = 'button';
        openBtn.title = '在新分頁開啟';
        openBtn.innerHTML = icon('external-link');
        openBtn.addEventListener('click', function () {
          window.open(shareUrl(lk.token), '_blank', 'noopener');
        });
        urlRow.appendChild(openBtn);
        row.appendChild(urlRow);

        const bits = (cfg.bits ? cfg.bits(lk) : []).concat(['建立於 ' + when(lk.createdAt)]);
        if (lk.updatedAt && lk.updatedAt !== lk.createdAt) bits.push('內容更新於 ' + when(lk.updatedAt));
        bits.push(lk.expiresAt ? (lk.expired ? '已過期' : when(lk.expiresAt) + ' 失效') : '不設期限');
        bits.push(lk.views + ' 次開啟');
        row.appendChild(el('div', 'share-meta', bits.join(' · ')));
        // 筆記在建立／更新連結之後又改過：連結上看到的還是舊的（單篇筆記才有這個判斷）
        if (lk.stale) {
          const st = el('div', 'share-stale' + (manual ? ' is-info' : ''));
          st.innerHTML = icon(manual ? 'clock' : 'alert-triangle');
          st.appendChild(el('span', null, manual
            ? '這個連結不自動更新：筆記在那之後改過，連結上還是當時的內容。要更新請按「更新內容」。'
            : '筆記在那之後改過，連結上看到的還是舊的內容——按「更新內容」。'));
          row.appendChild(st);
        }

        const acts = el('div', 'share-acts');
        if (cfg.setAuto) {
          const lab = el('label', 'share-auto');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !manual;
          lab.appendChild(cb);
          lab.appendChild(el('span', null, '自動更新'));
          lab.title = manual ? '現在不會自動更新。勾起來：之後改了筆記，這個連結會跟著更新。'
            : '現在會自動更新。取消勾選：這個連結停在現在的內容，要更新得自己按「更新內容」。';
          cb.addEventListener('change', function () {
            cb.disabled = true;
            cfg.setAuto(lk, cb.checked)
              .then(function () { toast(cb.checked ? '這個連結會自動更新' : '這個連結不再自動更新'); changed(); return reload(); })
              .catch(function (e) { cb.checked = !cb.checked; cb.disabled = false; toast('設定失敗：' + e.message); });
          });
          acts.appendChild(lab);
        }
        const refresh = el('button', 'btn btn-ghost');
        refresh.type = 'button';
        refresh.title = '把現在的內容重新打包到同一個網址';
        refresh.innerHTML = icon('rotate-ccw');
        refresh.appendChild(el('span', null, '更新內容'));
        refresh.addEventListener('click', function () { refreshLink(lk, refresh); });
        acts.appendChild(refresh);
        const revoke = el('button', 'btn btn-ghost ver-delbtn');
        revoke.type = 'button';
        revoke.innerHTML = icon('trash');
        revoke.appendChild(el('span', null, '取消分享'));
        revoke.addEventListener('click', function () { revokeLink(lk); });
        acts.appendChild(revoke);
        row.appendChild(acts);

        list.appendChild(row);
      });
    }

    // Packing takes a moment (every image is inlined), so both paths say so
    // rather than looking frozen.
    function changed() { if (cfg.onChange) { try { cfg.onChange(); } catch (e) { /* ignore */ } } }

    function create() {
      busy(make, true, '打包中…');
      cfg.pack()
        .then(function (html) { return cfg.create(html, Number(sel.value) || 0, autoBox ? autoBox.checked : true); })
        .then(function (lk) {
          copyText(shareUrl(lk.token));
          toast('已建立公開連結，網址已複製');
          changed();
          return reload();
        })
        .catch(function (e) { toast('建立失敗：' + e.message); })
        .then(function () { busy(make, false); });
    }

    function refreshLink(lk, btn) {
      busy(btn, true, '打包中…');
      cfg.pack()
        .then(function (html) { return cfg.update(lk, html); })
        .then(function () { toast('已更新這個連結的內容'); changed(); return reload(); })
        .catch(function (e) { toast('更新失敗：' + e.message); })
        .then(function () { busy(btn, false); });
    }

    function revokeLink(lk) {
      confirmBox('取消分享',
        '取消後這個網址會立刻失效，已經拿到連結的人也再也打不開。要繼續嗎？')
        .then(function (yes) {
          if (!yes) return;
          return cfg.remove(lk).then(function () {
            toast('已取消分享');
            changed();
            return reload();
          });
        })
        .catch(function (e) { toast('取消失敗：' + e.message); });
    }

    reload();
    return ui;
  }

  function openBookLinks(book, opts) {
    const o = opts || {};
    const folderId = book.folder && book.folder.id;
    return openLinks({
      heading: '分享電子書 — ' + (book.title || '未命名'),
      warn: '任何拿到連結的人都不需要帳號就能讀到這本書的全部內容。連結給出去的是「當下的快照」，' +
        '之後修改筆記不會影響已經分享出去的內容，除非你按下「更新內容」。',
      empty: '這本書還沒有公開連結。建立之後，任何拿到網址的人都能直接閱讀。',
      bits: function (lk) { return [lk.chapters + ' 章']; },
      list: function () { return Store.getBookLinks(folderId); },
      pack: function () {
        if (!global.Book || !Book.renderStandalone) return Promise.reject(new Error('請先開啟這本電子書'));
        return Book.renderStandalone();
      },
      create: function (html, days) {
        return Store.createBookLink(folderId, { title: book.title || '未命名電子書', html: html, chapters: book.chapters.length, expiresDays: days });
      },
      update: function (lk, html) {
        return Store.updateBookLink(lk.token, { title: book.title || '未命名電子書', html: html, chapters: book.chapters.length });
      },
      remove: function (lk) { return Store.deleteBookLink(lk.token); },
      onChange: o.onChange
    });
  }

  // 單篇筆記的公開連結（分享對話框 → 公開連結）。note 由 app.js 給，pack 也由它給——
  // 標題跟內容以它手上最新的為準（編輯器裡剛打的字可能還沒存）。
  function openNoteLinks(note, opts) {
    const o = opts || {};
    const live = function () { return (o.note ? o.note() : null) || note; };
    return openLinks({
      heading: '公開連結 — ' + (note.title || '未命名筆記'),
      warn: '任何拿到連結的人都不需要帳號就能讀到這篇筆記（唯讀）。每個連結可以各自決定要不要「自動更新」：' +
        '勾選的，你之後改了筆記、停手幾秒後內容就會跟上；沒勾的，連結停在你最後一次按「更新內容」的那一版。' +
        '取消分享後網址立刻失效。',
      empty: '這篇筆記還沒有公開連結。建立之後，任何拿到網址的人不用帳號就能直接閱讀。',
      list: function () { return Store.getNoteLinks(note.id); },
      pack: function () {
        if (!global.Book || !Book.renderNoteStandalone) return Promise.reject(new Error('打包功能還沒載入'));
        return Book.renderNoteStandalone(live());
      },
      create: function (html, days, auto) {
        const n = live();
        return Store.createNoteLink(note.id, { title: n.title || '未命名筆記', html: html, rev: n.rev || 0, expiresDays: days, autoUpdate: auto !== false });
      },
      // 關掉：只改開關，連結上的頁面原封不動。打開：如果連結已經落後，順便馬上更新成現在的
      // 內容——不然勾了「自動更新」卻要等到下一次改筆記才跟上，看起來像沒作用
      setAuto: function (lk, on) {
        if (!on || !lk.stale) return Store.updateNoteLink(lk.token, { autoUpdate: !!on });
        if (!global.Book || !Book.renderNoteStandalone) return Store.updateNoteLink(lk.token, { autoUpdate: true });
        const n = live();
        return Book.renderNoteStandalone(n).then(function (html) {
          return Store.updateNoteLink(lk.token, { title: n.title || '未命名筆記', html: html, rev: n.rev || 0, autoUpdate: true });
        });
      },
      update: function (lk, html) {
        const n = live();
        return Store.updateNoteLink(lk.token, { title: n.title || '未命名筆記', html: html, rev: n.rev || 0 });
      },
      remove: function (lk) { return Store.deleteNoteLink(lk.token); },
      onChange: o.onChange
    });
  }

  global.Versions = {
    openNoteLinks: openNoteLinks,
    openNote: openNote,
    openBook: openBook,
    openBookLinks: openBookLinks,
    renderDiff: renderDiff
  };
})(window);
