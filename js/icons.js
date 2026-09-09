/* icons.js — one consistent line-icon set for the whole UI.
 *
 * 24×24 grid, 2px stroke, currentColor, square corners (no rx) to match the
 * flat "tech" visual language. Every icon is a short inline SVG so the app
 * stays offline and dependency-free.
 *
 *   Icons.svg('folder')            → '<svg class="ic-svg" …>…</svg>'
 *   Icons.svg('folder', 'ic-lg')   → extra class on the <svg>
 *   Icons.el('folder')             → an <svg> element
 *   Icons.mount(root)              → fills every [data-icon="name"] element
 *                                    under root with its icon (idempotent)
 *
 * Unknown names produce an empty string, so a typo degrades to text-only
 * rather than throwing in the middle of a render.
 */
(function (global) {
  'use strict';

  const P = {
    /* chrome / navigation */
    'panel-left':      '<rect x="3" y="4" width="18" height="16"/><path d="M9 4v16"/>',
    menu:              '<path d="M4 6h16M4 12h16M4 18h16"/>',
    sun:               '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:              '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    'chevron-right':   '<path d="m9 6 6 6-6 6"/>',
    'chevron-left':    '<path d="m15 6-6 6 6 6"/>',
    'chevron-down':    '<path d="m6 9 6 6 6-6"/>',
    'chevron-up':      '<path d="m6 15 6-6 6 6"/>',
    'chevrons-left':   '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
    'chevrons-right':  '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>',
    'arrow-left':      '<path d="m12 19-7-7 7-7M19 12H5"/>',
    'arrow-right':     '<path d="M5 12h14M12 5l7 7-7 7"/>',
    'arrow-up-right':  '<path d="M7 17 17 7M7 7h10v10"/>',
    x:                 '<path d="M18 6 6 18M6 6l12 12"/>',
    plus:              '<path d="M12 5v14M5 12h14"/>',
    minus:             '<path d="M5 12h14"/>',
    check:             '<path d="M20 6 9 17l-5-5"/>',
    search:            '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    home:              '<path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/>',
    'external-link':   '<path d="M14 4h6v6M20 4l-9 9M18 13v7H4V6h7"/>',
    clock:             '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'alert-triangle':  '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    info:              '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 12v5"/>',
    hash:              '<path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18"/>',
    pin:               '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    'more-vertical':   '<circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>',
    template:          '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M9 21V9"/>',
    'folder-open':     '<path d="M3 5h6l2 2h8v3H3z"/><path d="m3 10 2 10h14l2-10z"/>',
    save:              '<path d="M4 4h12l4 4v12H4z"/><path d="M8 4v5h7"/><path d="M8 20v-6h8v6"/>',
    'hard-drive':      '<path d="m3 13 3-9h12l3 9"/><rect x="3" y="13" width="18" height="8"/><path d="M7 17h.01M11 17h.01"/>',
    globe:             '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
    'user-plus':       '<circle cx="10" cy="8" r="4"/><path d="M2 21c0-4 3.6-7 8-7s8 3 8 7"/><path d="M19 8v6M16 11h6"/>',

    /* objects */
    folder:            '<path d="M3 5h6l2 2h10v13H3z"/>',
    'folder-plus':     '<path d="M3 5h6l2 2h10v13H3z"/><path d="M12 10v6M9 13h6"/>',
    'file-text':       '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
    'file-plus':       '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>',
    files:             '<path d="M16 3H8v14h12V7z"/><path d="M16 3v4h4"/><path d="M4 7v14h12"/>',
    shield:            '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    'shield-check':    '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    chart:             '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-8"/>',
    'trending-up':     '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    lock:              '<rect x="4" y="11" width="16" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    'pen-line':        '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    pencil:            '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    users:             '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5c2 .8 3 2.6 3 5.5"/>',
    user:              '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    key:               '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/>',
    'log-out':         '<path d="M9 21H5V3h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    trash:             '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    copy:              '<rect x="9" y="9" width="12" height="12"/><path d="M5 15H3V3h12v2"/>',
    link:              '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    tag:               '<path d="M3 12V3h9l9 9-9 9z"/><path d="M7.5 7.5h.01"/>',
    'layout-grid':     '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    list:              '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    book:              '<path d="M4 3h16v18H6a2 2 0 0 1-2-2z"/><path d="M4 17a2 2 0 0 1 2-2h14"/>',
    'book-open':       '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    download:          '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v4h16v-4"/>',
    image:             '<rect x="3" y="3" width="18" height="18"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4-4L6 21"/>',
    table:             '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M12 3v18"/>',
    monitor:           '<rect x="2" y="3" width="20" height="14"/><path d="M8 21h8M12 17v4"/>',
    network:           '<rect x="9" y="2" width="6" height="6"/><rect x="2" y="16" width="6" height="6"/><rect x="16" y="16" width="6" height="6"/><path d="M12 8v4M5 16v-2h14v2"/>',
    award:             '<circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/>',
    columns:           '<rect x="3" y="3" width="18" height="18"/><path d="M12 3v18"/>',
    eye:               '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',

    /* text formatting */
    bold:              '<path d="M7 4h7a4 4 0 0 1 0 8H7z"/><path d="M7 12h8a4 4 0 0 1 0 8H7z"/>',
    italic:            '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
    strikethrough:     '<path d="M16 4H9a3 3 0 0 0-2.8 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
    code:              '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    'square-code':     '<rect x="3" y="3" width="18" height="18"/><path d="m10 9-3 3 3 3M14 15l3-3-3-3"/>',
    'heading-1':       '<path d="M4 12h8M4 18V6M12 18V6"/><path d="m17 12 3-2v8"/>',
    'heading-2':       '<path d="M4 12h8M4 18V6M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
    'heading-3':       '<path d="M4 12h8M4 18V6M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
    quote:             '<path d="M17 6H3M21 12H8M21 18H8M3 12v6"/>',
    'message-square':  '<path d="M21 4H3v12h4v4l5-4h9z"/>',
    'list-ordered':    '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    'list-checks':     '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>',
    type:              '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',

    /* table + annotation tools */
    'arrow-up-to-line':    '<path d="M5 3h14"/><path d="M12 21V7"/><path d="m6 13 6-6 6 6"/>',
    'arrow-down-to-line':  '<path d="M5 21h14"/><path d="M12 3v14"/><path d="m6 11 6 6 6-6"/>',
    'arrow-left-to-line':  '<path d="M3 19V5"/><path d="M21 12H7"/><path d="m13 6-6 6 6 6"/>',
    'arrow-right-to-line': '<path d="M21 5v14"/><path d="M3 12h14"/><path d="m11 18 6-6-6-6"/>',
    'align-left':      '<path d="M21 6H3M15 12H3M17 18H3"/>',
    'align-center':    '<path d="M21 6H3M17 12H7M19 18H5"/>',
    'align-right':     '<path d="M21 6H3M21 12H9M21 18H7"/>',
    wand:              '<path d="m3 21 11-11"/><path d="M15 3v4M13 5h4"/><path d="M19 12v3M17.5 13.5h3"/>',
    undo:              '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    redo:              '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
    square:            '<rect x="4" y="4" width="16" height="16"/>',
    'square-fill':     '<rect x="4" y="4" width="16" height="16" fill="currentColor"/>',
    grid:              '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',

    /* to-do, sub-pages, mind maps, version history */
    'check-square':    '<path d="M20 12v8H4V4h12"/><path d="m9 11 3 3 8-8"/>',
    'square-empty':    '<rect x="4" y="4" width="16" height="16"/>',
    'file-page':       '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="m10 12 3 3-3 3"/>',
    'mind-map':        '<rect x="2" y="10" width="6" height="4"/><rect x="16" y="3" width="6" height="4"/><rect x="16" y="10" width="6" height="4"/><rect x="16" y="17" width="6" height="4"/><path d="M8 12h4M12 5v14M12 5h4M12 12h4M12 19h4"/>',
    history:           '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
    'rotate-ccw':      '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    'git-commit':      '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
    compare:           '<path d="M5 3v14M19 7v14"/><path d="M5 17a3 3 0 0 0 3 3h2"/><path d="M19 7a3 3 0 0 0-3-3h-2"/><path d="m2 6 3-3 3 3"/><path d="m16 18 3 3 3-3"/>',
    graph:             '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8.5 10.5 7-3M8.5 13.5l7 3"/>'
  };

  function svg(name, cls) {
    const body = P[name];
    if (!body) return '';
    return '<svg class="ic-svg' + (cls ? ' ' + cls : '') + '" data-ic="' + name + '" viewBox="0 0 24 24"' +
      ' width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  }

  function el(name, cls) {
    const tpl = document.createElement('template');
    tpl.innerHTML = svg(name, cls);
    return tpl.content.firstChild;
  }

  // Fill declarative placeholders: <button data-icon="download">PDF</button>.
  // Safe to call repeatedly — an element that already holds its icon is skipped.
  function mount(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-icon]') : [];
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.querySelector(':scope > .ic-svg')) return;
      const markup = svg(node.getAttribute('data-icon'), node.getAttribute('data-icon-class') || '');
      if (markup) node.insertAdjacentHTML('afterbegin', markup);
    });
  }

  global.Icons = { svg: svg, el: el, mount: mount, has: function (n) { return !!P[n]; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(document); });
  else mount(document);
})(window);
