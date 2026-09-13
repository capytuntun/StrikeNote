/* linesync.js — click a line on either side, the MD editor or the preview,
 * and that line is underlined on BOTH sides: the editor row and the matching
 * text, image or code line in the preview.
 *
 * This is deliberately a companion pass that runs AFTER markdown.js has
 * already produced and sanitized the preview HTML — it never changes
 * markdown.js, MD.render(), or any renderer/extension, so it cannot affect
 * PDF export, the published e-book, or search, none of which call it. It
 * works by:
 *   1. Asking marked's own lexer — the same `marked` instance, carrying the
 *      callout / container / RISK / [toc] extensions markdown.js registered —
 *      for the note's top-level blocks, and finding each token's `raw` text in
 *      the source to get its start/end line. An earlier version re-scanned the
 *      source with its own regexes instead; everywhere those disagreed with
 *      marked (a raw-HTML line such as <br>, indented code, a setext heading,
 *      a lazy continuation line, text straight after a table) it counted one
 *      paragraph more than the preview had, and every paragraph after that
 *      paired with its neighbour. Lexing has no side effects: markdown.js's
 *      per-render counters live in its renderers, which this never calls.
 *   2. Collecting the ALREADY-RENDERED preview's blocks of each kind, in
 *      document order, and pairing them 1:1 with the tokens by position
 *      (heading #3 pairs with the 3rd heading, and so on) — the same "same
 *      type, same order" idea app.js uses for the scroll anchors (see
 *      editorBlocks()/previewBlocks() in app.js). A raw-HTML token renders as
 *      whatever it says, so the blocks it produces are counted and skipped.
 *   3. For paragraphs, list items and code blocks, splitting the block's own
 *      rendered HTML into one <span data-line0 data-line1> per source line —
 *      at each <br> in text (breaks:true turns every source newline into one),
 *      at each newline inside <code> — so a 5-line paragraph or a 20-line
 *      command block highlights exactly the line you clicked rather than the
 *      whole block. Line-numbered code already has one <li> per line.
 *   4. For blockquote/callout/RISK-finding and mindmap blocks, tagging the
 *      WHOLE block with one range instead — a `>` or `:::` block isn't
 *      addressable line-by-line the way plain text is, so clicking any line
 *      inside one highlights/underlines the whole thing.
 *
 * Every element gets `data-line0`/`data-line1` set directly (coarse
 * containers AND, where refined, the inner per-line spans within them), so
 * a preview click is always just `e.target.closest('[data-line0]')` — the
 * closest one is naturally the most specific match.
 *
 * The editor side has no per-line DOM of its own to attach attributes to —
 * but edithl.js already renders one `.cm-row` per source line (index i =
 * line i+1) for syntax highlighting, kept in step with the textarea. This
 * module reuses those same rows purely as a paint target for the underline,
 * without touching edithl.js; since edithl replaces every row on each input
 * and resize, a MutationObserver puts the underline back.
 */
(function (global) {
  'use strict';

  // ---- 1) top-level blocks, straight from marked's lexer ------------------
  // Token type -> the kind of rendered element it turns into. Types not listed
  // (space, def) render nothing. `html` renders as whatever the HTML says.
  const KIND_OF = {
    heading: 'heading', hr: 'hr', table: 'table', code: 'code', list: 'list',
    paragraph: 'para', blockquote: 'quote', callout: 'quote', container: 'quote',
    risk: 'quote', toc: 'toc', html: 'html'
  };

  function countNewlines(s, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }

  function trimNewlines(s) { return String(s || '').replace(/^\n+|\n+$/g, ''); }

  // First occurrence of `needle` at or after `from` that starts a line.
  function indexAtLineStart(src, needle, from) {
    let at = src.indexOf(needle, from);
    while (at > 0 && src.charCodeAt(at - 1) !== 10) at = src.indexOf(needle, at + 1);
    return at;
  }

  // Walk tokens (top-level blocks, or one list's items) through `src` from
  // offset `pos` / line `line`, giving each its 1-based start and end line.
  function locate(tokens, src, pos, line, fn) {
    tokens.forEach(function (t) {
      const raw = trimNewlines(t.raw);
      if (!raw) return;
      let at = indexAtLineStart(src, raw, pos);
      if (at < 0) { at = pos; while (src.charCodeAt(at) === 10) at++; }
      line += countNewlines(src, pos, at);
      const end = line + countNewlines(raw, 0, raw.length);
      fn(t, raw, at, line, end);
      pos = at + raw.length;
      line = end;
    });
  }

  function sourceBlocks(text) {
    if (!global.marked || !marked.lexer) return [];
    // marked normalises line endings and expands leading tabs before it
    // tokenizes, so `raw` is only findable in a copy given the same treatment.
    // Neither step adds or removes a newline, so line numbers still match.
    const src = String(text || '').replace(/\r\n|\r/g, '\n')
      .replace(/^( *)(\t+)/gm, function (m, sp, tabs) { return sp + '    '.repeat(tabs.length); });
    let tokens;
    try { tokens = marked.lexer(src); } catch (e) { return []; }

    const blocks = [];
    locate(tokens.filter(function (t) { return KIND_OF[t.type]; }), src, 0, 1, function (t, raw, at, start, end) {
      const b = { kind: KIND_OF[t.type], start: start, end: end, raw: raw, token: t };
      if (b.kind === 'list') {
        b.items = [];
        locate(t.items || [], src, at, start, function (it, itemRaw, itemAt, s, e) {
          b.items.push({ start: s, end: e, raw: itemRaw });
        });
      }
      blocks.push(b);
    });
    return blocks;
  }

  // The source line each <br>-separated piece of a block's rendered text came
  // from: every source newline is one <br> (breaks:true), and a literal <br>
  // typed into the text is one more on that same line.
  function brLines(raw, start) {
    const out = [];
    raw.split('\n').forEach(function (l, i) {
      const typed = (l.match(/<br\s*\/?>/gi) || []).length;
      for (let k = 0; k <= typed; k++) out.push(start + i);
    });
    return out;
  }

  // ---- 2) split a block's OWN rendered HTML into per-line spans ----------
  // Void elements (img, input — inline images, task checkboxes) are emitted
  // but never pushed onto the open-tag stack, since they have no closing tag
  // and would otherwise "leak" into every following line.
  const VOID_TAGS = { img: 1, input: 1, br: 1, hr: 1, area: 1, base: 1, col: 1, embed: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };

  // One HTML fragment per line, re-closing and re-opening any element that
  // straddles a break so each fragment is valid on its own. Text breaks at
  // each <br>; code (`inCode`) at each newline, where a <br> never appears
  // and hljs spans can run across lines.
  function splitLines(html, inCode) {
    const openTags = [];
    const lines = [];
    let cur = '';
    function breakLine() {
      for (let j = openTags.length - 1; j >= 0; j--) cur += '</' + openTags[j].name + '>';
      lines.push(cur);
      cur = '';
      for (let j = 0; j < openTags.length; j++) cur += openTags[j].open;
    }
    const re = /<br\s*\/?>|<([a-zA-Z][\w-]*)\b[^>]*>|<\/([a-zA-Z][\w-]*)>|[^<]+/g;
    let m;
    while ((m = re.exec(html))) {
      const tok = m[0];
      if (/^<br/i.test(tok)) {
        if (inCode) cur += tok; else breakLine();
      } else if (m[1]) {
        cur += tok;
        if (!VOID_TAGS[m[1].toLowerCase()]) openTags.push({ name: m[1], open: tok });
      } else if (m[2]) {
        cur += tok;
        openTags.pop();
      } else if (inCode) {
        tok.split('\n').forEach(function (part, i) { if (i) breakLine(); cur += part; });
      } else {
        cur += tok;
      }
    }
    lines.push(cur);
    return lines;
  }

  // Nested block-level content inside a top-level <li> (a sub-list, a code
  // block, a second paragraph) is left completely untouched — split only the
  // li's OWN text, up to that point.
  const NESTED_BLOCK_RE = /<(?:ul|ol|blockquote|pre|table|div|p|h[1-6]|hr|nav)[\s\/>]/i;

  function wrapLines(el, lineOf, inCode) {
    const html = el.innerHTML;
    const cut = inCode ? null : NESTED_BLOCK_RE.exec(html);
    const ownHtml = cut ? html.slice(0, cut.index) : html;
    if (!ownHtml.trim()) return;
    const restHtml = cut ? html.slice(cut.index) : '';
    el.innerHTML = splitLines(ownHtml, inCode).map(function (lineHtml, i) {
      const ln = i < lineOf.length ? lineOf[i] : lineOf[lineOf.length - 1];
      return '<span class="sync-ln" data-line0="' + ln + '" data-line1="' + ln + '">' + lineHtml + '</span>';
    }).join(inCode ? '\n' : '<br>') + restHtml;
  }

  // ---- 3) pair the tokens with the rendered preview DOM -------------------
  const SELECTOR = {
    heading: 'h1, h2, h3, h4, h5, h6',
    hr: 'hr',
    table: 'table',
    code: '.code-block, .mindmap-block',
    quote: 'blockquote, .callout, .finding',
    list: 'ul, ol',
    para: 'p, a.page-card',
    toc: '.md-toc'
  };
  const KINDS = Object.keys(SELECTOR);

  function kindOf(el) {
    for (let i = 0; i < KINDS.length; i++) if (el.matches(SELECTOR[KINDS[i]])) return KINDS[i];
    return null;
  }

  // Every block under `root`, by kind, in document order. The walk stops at
  // the first block on each path, so it finds the outermost blocks rather than
  // only direct children: a raw-HTML wrapper such as <details> or
  // <div align="center"> can enclose ordinary markdown blocks, while a <p>
  // inside a callout or a loose list item belongs to that block, not the page.
  function renderedBlocks(root) {
    const groups = {};
    KINDS.forEach(function (k) { groups[k] = []; });
    (function walk(parent) {
      for (let el = parent.firstElementChild; el; el = el.nextElementSibling) {
        const kind = kindOf(el);
        if (kind) groups[kind].push(el);
        else walk(el);
      }
    })(root);
    return groups;
  }

  function tag(el, start, end) {
    if (!el) return;
    el.setAttribute('data-line0', start);
    el.setAttribute('data-line1', end);
  }

  function pushSpans(ranges, el) {
    el.querySelectorAll(':scope > .sync-ln').forEach(function (sp) {
      const ln = parseInt(sp.getAttribute('data-line0'), 10);
      ranges.push({ start: ln, end: ln, el: sp });
    });
  }

  function buildRanges(previewEl, blocks) {
    const groups = renderedBlocks(previewEl);
    const idx = {};
    KINDS.forEach(function (k) { idx[k] = 0; });
    const ranges = [];

    blocks.forEach(function (b) {
      if (b.kind === 'html') {
        const tpl = document.createElement('template');
        tpl.innerHTML = b.raw;
        const inner = renderedBlocks(tpl.content);
        KINDS.forEach(function (k) { idx[k] += inner[k].length; });
        return;
      }
      const el = groups[b.kind][idx[b.kind]++];
      if (!el || b.kind === 'toc') return;

      if (b.kind === 'heading' || b.kind === 'hr') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el });
      } else if (b.kind === 'table') {
        el.querySelectorAll('tr').forEach(function (tr, i) {
          const ln = i === 0 ? b.start : (b.start + 1 + i);
          tag(tr, ln, ln);
          ranges.push({ start: ln, end: ln, el: tr });
        });
      } else if (b.kind === 'code') {
        // The whole block answers for its fence lines, and for a mind map.
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el });
        // `data-ln` is the GUTTER number the ```lang=N syntax asked to display
        // (often reset to 1, independent of where the fence actually sits in
        // the note) — not the source line. The real source line is simply the
        // fence's own start plus this <li>'s position among its siblings.
        const numbered = el.querySelectorAll('li[data-ln]');
        if (numbered.length) {
          numbered.forEach(function (li, i) {
            const ln = Math.min(b.start + 1 + i, b.end);
            tag(li, ln, ln); ranges.push({ start: ln, end: ln, el: li });
          });
        } else {
          const code = el.querySelector('pre > code');
          if (code) {
            // An indented block has no fence line above its first line of code.
            const first = b.token.codeBlockStyle === 'indented' ? b.start : b.start + 1;
            const count = String(b.token.text || '').split('\n').length;
            const lineOf = [];
            for (let i = 0; i < count; i++) lineOf.push(Math.min(first + i, b.end));
            wrapLines(code, lineOf, true);
            pushSpans(ranges, code);
          }
        }
      } else if (b.kind === 'quote') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el });
      } else if (b.kind === 'para') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el }); // fallback if the split below undercounts
        wrapLines(el, brLines(b.raw, b.start), false);
        pushSpans(ranges, el);
      } else if (b.kind === 'list') {
        const lis = el.querySelectorAll(':scope > li');
        b.items.forEach(function (item, i) {
          const li = lis[i];
          if (!li) return;
          tag(li, item.start, item.end);
          ranges.push({ start: item.start, end: item.end, el: li });
          // A loose list wraps each item's text in its own <p>.
          const own = li.firstChild && li.firstChild.nodeName === 'P' ? li.firstChild : li;
          wrapLines(own, brLines(item.raw, item.start), false);
          pushSpans(ranges, own);
        });
      }
    });

    ranges.sort(function (a, b) { return a.start - b.start || (a.end - a.start) - (b.end - b.start); });
    return ranges;
  }

  function rangeFor(ranges, line) {
    // Prefer the narrowest range that contains `line` (a refined single-line
    // span over the coarse block it sits inside).
    let best = null;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.start > line) break;
      if (r.end >= line) { if (!best || (r.end - r.start) < (best.end - best.start)) best = r; }
    }
    return best;
  }

  // ---- 4) wiring: whichever side is clicked, both sides get the underline --
  let editorEl = null, previewEl = null, ranges = [];
  let hitEls = [];                  // preview elements carrying .sync-hit
  let hitStart = -1, hitEnd = -1;   // source lines underlined in the editor
  let observedRows = null;

  function setRows(on) {
    const box = document.querySelector('#editor-backdrop .cm-lines');
    if (!box || hitStart < 1) return;
    if (box !== observedRows && global.MutationObserver) {
      // edithl.js replaces every row on each input and resize, which drops the
      // class; put it back whenever that happens.
      new MutationObserver(function () { setRows(true); }).observe(box, { childList: true });
      observedRows = box;
    }
    const rows = box.children;
    for (let i = hitStart - 1; i < hitEnd && i < rows.length; i++) rows[i].classList.toggle('sync-hit', on);
  }

  function clearHit() {
    hitEls.forEach(function (el) { el.classList.remove('sync-hit'); });
    hitEls = [];
    setRows(false);
    hitStart = hitEnd = -1;
  }

  // Underline source lines start..end in the editor, and every preview element
  // tagged with exactly that range — several when a literal <br> splits one
  // line. An element that contains another hit (a one-line <p> and its own
  // span share a range) is skipped: only the innermost carries the style.
  function showHit(start, end) {
    if (start === hitStart && end === hitEnd && hitEls.length && hitEls[0].isConnected) return;
    clearHit();
    const hits = ranges.filter(function (r) { return r.start === start && r.end === end; })
      .map(function (r) { return r.el; });
    hitEls = hits.filter(function (el) {
      return !hits.some(function (other) { return other !== el && el.contains(other); });
    });
    hitEls.forEach(function (el) { el.classList.add('sync-hit'); });
    hitStart = start;
    hitEnd = end;
    setRows(true);
  }

  function lineAtCaret() {
    const caret = editorEl.selectionStart;
    return (editorEl.value.slice(0, caret).match(/\n/g) || []).length + 1;
  }

  function onEditorMove() {
    const r = ranges.length ? rangeFor(ranges, lineAtCaret()) : null;
    if (r) showHit(r.start, r.end);
    else clearHit();
  }

  function onPreviewClick(e) {
    const hit = e.target.closest && e.target.closest('[data-line0]');
    if (!hit || !previewEl.contains(hit)) { clearHit(); return; }
    const start = parseInt(hit.getAttribute('data-line0'), 10);
    const end = parseInt(hit.getAttribute('data-line1'), 10) || start;
    showHit(start, end);
  }

  function rebuild(sourceText) {
    if (!previewEl) return;
    ranges = buildRanges(previewEl, sourceBlocks(sourceText));
    // The render replaced every preview element the underline was on. While
    // the editor has focus, re-derive both sides from the caret; otherwise drop
    // both, since the same line numbers may no longer hold the same text.
    hitEls = [];
    if (document.activeElement === editorEl) onEditorMove();
    else clearHit();
  }

  function init(ed, pv) {
    editorEl = ed; previewEl = pv;
    editorEl.addEventListener('click', onEditorMove);
    editorEl.addEventListener('keyup', onEditorMove);
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editorEl) onEditorMove();
    });
    previewEl.addEventListener('click', onPreviewClick);
  }

  global.LineSync = { init: init, rebuild: rebuild };
})(window);
