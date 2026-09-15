/* embedswitch.js — the small「檔案｜預覽」/「連結｜預覽卡片」switch that appears
 * over an embedded PDF, a PDF attachment link, a link preview card or a web link
 * standing on its own line, in the preview and in Blog.
 *
 * None of it is in the rendered HTML: markdown.js emits no control for it, so
 * the PDF export, the published book and search never see one. A single bar is
 * appended to <body> (position: fixed — anything on <body> must be, see
 * CLAUDE.md) and follows whatever is hovered. Choosing the other option rewrites
 * the source with MD.switchEmbed, limited to the source lines of the hovered
 * block, which each host reports through rangeOf(el).
 *
 *   EmbedSwitch.attach(rootEl, {
 *     rangeOf(el)  -> { start, end } 1-based source lines, or null (no bar)
 *     getText()    -> the whole markdown source
 *     setText(t)   write the rewritten source back
 *     canEdit()    -> false in read-only notes
 *     onPdfPref(to) optional: remember 'file' | 'preview' for the next upload
 *   })
 */
(function (global) {
  'use strict';

  let bar = null;
  let cur = null;          // { host, t }
  let hideTimer = null;

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'embed-switch';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '顯示方式');
    bar.hidden = true;
    bar.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    bar.addEventListener('mouseleave', scheduleHide);
    // Keep the editor's focus and selection where they were.
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bar.addEventListener('click', onClick);
    document.body.appendChild(bar);
    global.addEventListener('scroll', hide, true);
    global.addEventListener('resize', hide);
    return bar;
  }

  function hide() {
    clearTimeout(hideTimer);
    if (bar) bar.hidden = true;
    cur = null;
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 220);
  }

  // A web link that is the whole of its paragraph — the only kind a card can
  // replace one-for-one. Links inside lists, quotes and tables are left alone:
  // their source line carries more than the link.
  function standalone(a) {
    if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) return false;
    if (a.classList.contains('note-link') || a.classList.contains('hashtag') || a.classList.contains('file-chip')) return false;
    const p = a.closest('p');
    if (!p || p.closest('li, blockquote, table, .callout, .finding, .link-card, .pdf-embed')) return false;
    if (p.querySelectorAll('a, img').length !== 1) return false;
    return p.textContent.trim() === a.textContent.trim();
  }

  function classify(el, root) {
    if (!el || !el.closest) return null;
    const inRoot = function (n) { return n && root.contains(n) ? n : null; };
    const card = inRoot(el.closest('.link-card'));
    if (card) return { el: card, kind: 'card', url: card.getAttribute('data-link-url') };
    const embed = inRoot(el.closest('.pdf-embed'));
    if (embed) {
      const f = embed.querySelector('[data-pdf-id]');
      return f ? { el: embed, kind: 'pdf', id: f.getAttribute('data-pdf-id'), state: 'preview' } : null;
    }
    const chip = inRoot(el.closest('a.file-chip[data-file-kind="pdf"]'));
    if (chip) return { el: chip, kind: 'pdf', id: chip.getAttribute('data-file-id'), state: 'file' };
    const a = inRoot(el.closest('a[href]'));
    if (a && standalone(a)) return { el: a, kind: 'link' };
    return null;
  }

  function show(host, t) {
    ensureBar();
    clearTimeout(hideTimer);
    if (cur && cur.t.el === t.el && !bar.hidden) return;
    cur = { host: host, t: t };
    const options = t.kind === 'pdf'
      ? [['file', '檔案'], ['preview', '預覽']]
      : [['link', '連結'], ['card', '預覽卡片']];
    const active = t.kind === 'pdf' ? t.state : t.kind;
    bar.textContent = '';
    options.forEach(function (o) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-to', o[0]);
      b.textContent = o[1];
      b.title = t.kind === 'pdf'
        ? (o[0] === 'file' ? '只顯示成一個檔案連結' : '直接在筆記裡預覽 PDF')
        : (o[0] === 'link' ? '一般連結' : '顯示網頁標題、摘要與縮圖');
      if (o[0] === active) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
      bar.appendChild(b);
    });
    bar.hidden = false;
    place(t.el);
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const w = bar.offsetWidth, h = bar.offsetHeight;
    let top = r.top - h - 4;
    if (top < 60) top = r.bottom + 4;
    const block = el.classList.contains('link-card') || el.classList.contains('pdf-embed');
    let left = block ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, global.innerWidth - w - 8));
    bar.style.top = Math.round(top) + 'px';
    bar.style.left = Math.round(left) + 'px';
  }

  function onClick(e) {
    const b = e.target.closest && e.target.closest('button[data-to]');
    if (!b || !cur) return;
    const host = cur.host, t = cur.t, to = b.getAttribute('data-to');
    if (b.classList.contains('on') || !host.o.canEdit()) { hide(); return; }
    const range = host.o.rangeOf(t.el);
    hide();
    if (!range) return;
    let spec;
    if (t.kind === 'pdf') spec = { type: 'pdf', id: t.id, to: to };
    else if (t.kind === 'card') {
      const title = t.el.classList.contains('is-loaded') ? (t.el.querySelector('.link-card-title') || {}).textContent : '';
      spec = { type: 'card', title: title || '' };
    } else spec = { type: 'link' };
    const text = host.o.getText();
    const next = MD.switchEmbed(text, range.start, range.end, spec);
    if (next === text) {
      if (global.App && App.toast) App.toast('這一行的寫法沒辦法自動切換');
      return;
    }
    host.o.setText(next);
    if (t.kind === 'pdf' && host.o.onPdfPref) host.o.onPdfPref(to);
  }

  function attach(root, o) {
    const host = { root: root, o: o };
    root.addEventListener('mouseover', function (e) {
      if (!o.canEdit()) return;
      const t = classify(e.target, root);
      if (t && o.rangeOf(t.el)) show(host, t);
      else if (cur && cur.host === host) scheduleHide();
    });
    root.addEventListener('mouseleave', function () { if (cur && cur.host === host) scheduleHide(); });
  }

  global.EmbedSwitch = { attach: attach, hide: hide };
})(window);
