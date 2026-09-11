/* markdown.js — GitHub-flavored markdown + callouts + syntax highlight + image refs */
(function (global) {
  'use strict';

  const CALLOUTS = {
    note:      { title: 'Note' },
    tip:       { title: 'Tip' },
    important: { title: 'Important' },
    warning:   { title: 'Warning' },
    caution:   { title: 'Caution' }
  };

  // CodiMD/HackMD `:::` container names mapped onto the callout types above, so
  // `:::info` renders identically to `> [!NOTE]`. The GitHub names also pass
  // straight through, so `:::tip` etc. work too.
  const CONTAINER_ALIAS = {
    info: 'note', success: 'tip', warning: 'warning', danger: 'caution',
    note: 'note', tip: 'tip', important: 'important', caution: 'caution'
  };

  // The one place callout HTML is built, shared by both the `> [!NOTE]` block
  // and the `:::info` container so the two syntaxes are pixel-identical.
  function calloutHTML(calloutType, title, innerHTML) {
    const meta = CALLOUTS[calloutType] || CALLOUTS.note;
    const label = title ? title : meta.title;
    return '<div class="callout callout-' + calloutType + '">' +
      '<div class="callout-title">' + escapeHtml(label) + '</div>' +
      '<div class="callout-content">' + innerHTML + '</div></div>\n';
  }

  // Findings written as `> [!RISK:HIGH] Title`. rank drives the summary sort.
  const RISK_LEVELS = {
    critical: { label: 'Critical', rank: 0 },
    high:     { label: 'High',     rank: 1 },
    medium:   { label: 'Medium',   rank: 2 },
    low:      { label: 'Low',      rank: 3 },
    info:     { label: 'Info',     rank: 4 }
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(text) {
    let slug = String(text)
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w一-鿿\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
    // Ensure the id is a valid CSS selector (must not start with a digit or '-'),
    // otherwise paged.js target-counter resolution (querySelector('#'+id)) throws.
    if (/^[0-9-]/.test(slug)) slug = 'sec-' + slug;
    return slug;
  }

  // ---- Callout block extension -------------------------------------------
  const calloutExtension = {
    name: 'callout',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}> ?\[!/m);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const rule = /^( {0,3}> ?\[!(note|tip|important|warning|caution)\]([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*))/i;
      const match = rule.exec(src);
      if (!match) return;
      const type = match[2].toLowerCase();
      const title = (match[3] || '').trim();
      const lines = match[0].replace(/\n+$/, '').split('\n');
      lines.shift(); // drop the [!TYPE] marker line
      const body = lines.map(function (l) { return l.replace(/^ {0,3}> ?/, ''); }).join('\n');
      const token = {
        type: 'callout',
        raw: match[0],
        calloutType: type,
        title: title,
        tokens: []
      };
      this.lexer.blockTokens(body, token.tokens);
      return token;
    },
    renderer: function (token) {
      return calloutHTML(token.calloutType, token.title, this.parser.parse(token.tokens));
    }
  };

  // ---- Container block: :::info … ::: (CodiMD/HackMD) ---------------------
  // Same output as the callout above. Supports an optional title on the marker
  // line (`:::info 標題`), nested containers, and an unclosed block runs to EOF.
  const containerExtension = {
    name: 'container',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}:::/m);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const nl0 = src.indexOf('\n');
      const first = nl0 < 0 ? src : src.slice(0, nl0);
      const open = /^ {0,3}:::[ \t]*([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(first);
      if (!open) return;
      const mapped = CONTAINER_ALIAS[open[1].toLowerCase()];
      if (!mapped) return;                     // unknown container: leave it alone
      const title = (open[2] || '').trim();

      // Walk the following lines to the matching bare `:::`, tracking nesting.
      const bodyStart = nl0 < 0 ? src.length : nl0 + 1;
      let idx = bodyStart, depth = 1, bodyEnd = -1, rawEnd = src.length;
      while (idx < src.length) {
        const nl = src.indexOf('\n', idx);
        const lineEnd = nl < 0 ? src.length : nl;
        const next = nl < 0 ? src.length : nl + 1;
        const line = src.slice(idx, lineEnd);
        if (/^ {0,3}:::[ \t]*$/.test(line)) {                 // bare ::: → close
          if (--depth === 0) { bodyEnd = idx; rawEnd = next; break; }
        } else if (/^ {0,3}:::[ \t]*[A-Za-z]/.test(line)) {   // nested open
          depth++;
        }
        idx = next;
      }
      if (bodyEnd < 0) { bodyEnd = src.length; rawEnd = src.length; }   // unclosed → EOF
      const token = {
        type: 'container',
        raw: src.slice(0, rawEnd),
        calloutType: mapped,
        title: title,
        tokens: []
      };
      this.lexer.blockTokens(src.slice(bodyStart, bodyEnd), token.tokens);
      return token;
    },
    renderer: function (token) {
      return calloutHTML(token.calloutType, token.title, this.parser.parse(token.tokens));
    }
  };

  // ---- Risk finding block: > [!RISK:HIGH] Title ---------------------------
  // Each finding gets a stable id so the PDF summary table can point at it and
  // resolve its page number with target-counter().
  let findingSeq = 0;   // reset per render, like usedSlugs below
  // Position of each to-do checkbox in document order. app.js uses it to find
  // the matching `- [ ]` line in the source when someone ticks one off.
  let taskSeq = 0;      // reset per render

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  const riskExtension = {
    name: 'risk',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}> ?\[!RISK:/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const rule = /^( {0,3}> ?\[!RISK:(critical|high|medium|low|info)\]([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*))/i;
      const match = rule.exec(src);
      if (!match) return;
      const level = match[2].toLowerCase();
      const lines = match[0].replace(/\n+$/, '').split('\n');
      lines.shift(); // drop the [!RISK:x] marker line
      const body = lines.map(function (l) { return l.replace(/^ {0,3}> ?/, ''); }).join('\n');
      const token = {
        type: 'risk',
        raw: match[0],
        level: level,
        title: (match[3] || '').trim(),
        tokens: []
      };
      this.lexer.blockTokens(body, token.tokens);
      return token;
    },
    renderer: function (token) {
      const meta = RISK_LEVELS[token.level] || RISK_LEVELS.info;
      const n = ++findingSeq;
      const id = 'finding-' + n;
      const title = token.title || (meta.label + ' finding');
      const inner = this.parser.parse(token.tokens);
      return '<div class="finding finding-' + token.level + '" id="' + id + '"' +
        ' data-risk="' + token.level + '" data-finding="' + n + '">' +
        '<div class="finding-head">' +
        '<span class="risk-badge">' + escapeHtml(meta.label.toUpperCase()) + '</span>' +
        '<span class="finding-no">F-' + pad2(n) + '</span>' +
        '<span class="finding-title">' + escapeHtml(title) + '</span>' +
        '</div>' +
        '<div class="finding-content">' + inner + '</div></div>\n';
    }
  };

  // Pull the findings out of rendered HTML: [{id, level, rank, no, title}]
  function extractFindings(container) {
    return Array.prototype.map.call(container.querySelectorAll('.finding'), function (f) {
      const level = f.getAttribute('data-risk') || 'info';
      const meta = RISK_LEVELS[level] || RISK_LEVELS.info;
      const titleEl = f.querySelector('.finding-title');
      return {
        id: f.id,
        level: level,
        label: meta.label,
        rank: meta.rank,
        no: parseInt(f.getAttribute('data-finding'), 10) || 0,
        title: titleEl ? titleEl.textContent : ''
      };
    });
  }

  // ---- Wiki-link extension: [[筆記標題]] / [[筆記標題|顯示文字]] ------------
  // Resolution needs the live note list, which lives in app.js. It hands us a
  // lookup(title) -> note|null here; without one, links render as unresolved.
  let noteLookup = null;
  function setNoteLookup(fn) { noteLookup = fn; }

  const WIKI_RE = /^\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/;

  const wikiLinkExtension = {
    name: 'wikilink',
    level: 'inline',
    start: function (src) {
      const m = src.match(/\[\[/);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const m = WIKI_RE.exec(src);
      if (!m) return;
      return {
        type: 'wikilink',
        raw: m[0],
        target: m[1].trim(),
        alias: (m[2] || '').trim()
      };
    },
    renderer: function (token) {
      const text = escapeHtml(token.alias || token.target);
      const note = noteLookup ? noteLookup(token.target) : null;
      if (note) {
        return '<a class="note-link" href="#" data-note-id="' + escapeHtml(note.id) + '"' +
          ' title="' + escapeHtml(note.title || '') + '">' + text + '</a>';
      }
      return '<a class="note-link missing" href="#" data-note-title="' + escapeHtml(token.target) + '"' +
        ' title="筆記「' + escapeHtml(token.target) + '」不存在——點擊建立">' + text + '</a>';
    }
  };

  // ---- Hashtag extension: #標籤 / #tag ------------------------------------
  // 標籤字元：英數、底線、連字號、斜線，以及中日文。須至少含一個「字母」，
  // 以排除 #123 這類純數字（純數字通常是 issue 編號而非標籤）。
  const TAG_CH = '0-9A-Za-z_/\\-\\u00c0-\\u024f\\u4e00-\\u9fff\\u3040-\\u30ff';
  const TAG_L  = 'A-Za-z_\\u00c0-\\u024f\\u4e00-\\u9fff\\u3040-\\u30ff';
  const HASHTAG_RE = new RegExp('^#([' + TAG_CH + ']*[' + TAG_L + '][' + TAG_CH + ']*)');

  const hashtagExtension = {
    name: 'hashtag',
    level: 'inline',
    start: function (src) {
      const m = src.match(/#/);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const m = HASHTAG_RE.exec(src);
      if (!m) return;
      return { type: 'hashtag', raw: m[0], tag: m[1] };
    },
    renderer: function (token) {
      const t = escapeHtml(token.tag);
      return '<a class="hashtag" href="#" data-tag="' + t + '">#' + t + '</a>';
    }
  };

  // Collect every #tag in a markdown source (deduped, in first-seen order).
  // Requires a boundary before '#' so mid-word '#' (URLs, C#) is ignored.
  function extractTags(md) {
    const stripped = String(md || '')
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`/g, '');
    const re = new RegExp('(^|[\\s(\\[（【「\'"])#([' + TAG_CH + ']*[' + TAG_L + '][' + TAG_CH + ']*)', 'g');
    const out = [], seen = {};
    let m;
    while ((m = re.exec(stripped))) {
      const tag = m[2];
      const key = tag.toLowerCase();
      if (!seen[key]) { seen[key] = true; out.push(tag); }
    }
    return out;
  }

  // Collect every [[target]] in a markdown source, in document order.
  // Fenced / inline code is stripped first so sample code never yields links.
  function extractLinks(md) {
    const stripped = String(md || '')
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`/g, '');
    const re = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]+)?\]\]/g;
    const out = [];
    let m;
    while ((m = re.exec(stripped))) out.push(m[1].trim());
    return out;
  }

  // Split hljs-highlighted HTML into one fragment per source line, re-closing
  // and re-opening any <span> that straddles a line break so each fragment is
  // valid on its own. hljs's HTML renderer only ever emits <span class="...">,
  // so a small tag-aware scan is enough here — no general HTML parser needed.
  function splitHighlightedLines(html) {
    const openTags = [];
    const lines = [];
    let cur = '';
    const re = /<span([^>]*)>|<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[2] !== undefined) {
        const parts = m[2].split('\n');
        parts.forEach(function (part, i) {
          cur += part;
          if (i < parts.length - 1) {
            for (let j = openTags.length - 1; j >= 0; j--) cur += '</span>';
            lines.push(cur);
            cur = '';
            for (let j = 0; j < openTags.length; j++) cur += '<span' + openTags[j] + '>';
          }
        });
      } else if (m[0] === '</span>') {
        cur += m[0];
        openTags.pop();
      } else {
        cur += m[0];
        openTags.push(m[1]);
      }
    }
    lines.push(cur);
    return lines;
  }

  // ---- [toc] extension: inline table of contents --------------------------
  // A line holding just `[toc]` (CodiMD / HackMD style) turns into a nested list
  // of every h1–h3 in the note — the same levels the sidebar and the PDF use.
  // The headings after the marker are not known yet when it is rendered, so the
  // renderer leaves a placeholder and render() swaps the real list in once the
  // whole document has been parsed.
  const TOC_PLACEHOLDER = '<!--md-toc-placeholder-->';
  const TOC_MAX_LEVEL = 3;
  let headingList = [];   // [{ level, text, id }] in document order, reset per render

  const tocExtension = {
    name: 'toc',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}\[toc\][ \t]*$/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const match = /^ {0,3}\[toc\][ \t]*(?:\n+|$)/i.exec(src);
      if (match) return { type: 'toc', raw: match[0] };
    },
    renderer: function () { return TOC_PLACEHOLDER + '\n'; }
  };

  // Inline [toc]: only the note's top heading level is listed (normally `#`).
  // Everything deeper is tucked into a collapsed sub-list under its parent and
  // appears only when the reader opens it. The toggle is a plain <button> —
  // app.js delegates the click, keys the open state by the *parent's* id (so the
  // side panel and this list stay in step) and restores it after each re-render.
  function buildInlineTOC() {
    const items = headingList.filter(function (h) { return h.level <= TOC_MAX_LEVEL; });
    if (!items.length) {
      return '<nav class="md-toc md-toc-empty">這份筆記還沒有標題，加上 # 標題後會自動列在這裡</nav>';
    }
    // A note that starts at ## (no h1 at all) should still show something, so
    // the always-visible level is whatever the shallowest heading happens to be.
    let top = 6;
    items.forEach(function (h) { if (h.level < top) top = h.level; });

    // Build a proper tree first: rendering straight from the flat list makes the
    // "1.1.1" numbering lie as soon as a level is skipped.
    const roots = [];
    const stack = [];
    items.forEach(function (h) {
      const node = { h: h, kids: [] };
      while (stack.length && stack[stack.length - 1].h.level >= h.level) stack.pop();
      if (stack.length) stack[stack.length - 1].kids.push(node);
      else roots.push(node);
      stack.push(node);
    });

    function renderList(nodes, cls) {
      let s = '<ul' + (cls ? ' class="' + cls + '"' : '') + '>';
      nodes.forEach(function (n) {
        s += '<li class="toc-l' + n.h.level + '"><a href="#' + n.h.id + '">' + n.h.text + '</a>';
        if (n.kids.length) {
          // Only the top level is shown; its whole subtree hides behind a toggle.
          if (n.h.level === top) {
            s += '<button type="button" class="md-toc-toggle" data-toc="' + n.h.id + '" ' +
              'aria-label="展開子標題"></button>' + renderList(n.kids, 'md-toc-kids');
          } else {
            s += renderList(n.kids, '');
          }
        }
        s += '</li>';
      });
      return s + '</ul>';
    }
    return '<nav class="md-toc">' + renderList(roots, 'md-toc-top') + '</nav>';
  }

  // ---- Custom renderer overrides -----------------------------------------
  const usedSlugs = {};
  const renderer = {
    heading: function (text, level) {
      let base = slugify(text);
      let slug = base, i = 1;
      while (usedSlugs[slug]) { slug = base + '-' + (i++); }
      usedSlugs[slug] = true;
      // Plain-text copy (already HTML-escaped by marked) for the inline [toc]
      headingList.push({ level: level, text: text.replace(/<[^>]*>/g, ''), id: slug });
      return '<h' + level + ' id="' + slug + '">' + text + '</h' + level + '>\n';
    },
    // Notion-style to-do items. marked's default emits a disabled checkbox with
    // no hook back to the source; ours carries the index of the task in document
    // order, which is all app.js needs to find and flip the matching `- [ ]` in
    // the textarea. The counter is reset per render, in render() below.
    checkbox: function (checked) {
      return '<input class="task-check" type="checkbox" data-task="' + (taskSeq++) + '"' +
        (checked ? ' checked' : '') + '>';
    },
    listitem: function (text, task, checked) {
      if (!task) return '<li>' + text + '</li>\n';
      return '<li class="task-item' + (checked ? ' task-done' : '') + '">' + text + '</li>\n';
    },

    // A wiki link alone on its own line is a sub-page, the way Notion separates
    // an inline page mention from a sub-page block. Inline `[[x]]` inside a
    // sentence is untouched, and the markup stays a plain `[[標題]]` in the
    // source, so nothing new has to be understood to read the raw note.
    paragraph: function (text) {
      const m = String(text).trim().match(
        /^<a class="note-link( missing)?" href="#" (data-note-id|data-note-title)="([^"]*)"[^>]*>([\s\S]*)<\/a>$/);
      if (!m) return '<p>' + text + '</p>\n';
      const missing = !!m[1];
      return '<a class="page-card note-link' + (missing ? ' missing' : '') + '" href="#" ' +
        m[2] + '="' + m[3] + '">' +
        '<span class="page-card-ic">' + (global.Icons ? Icons.svg(missing ? 'file-plus' : 'file-page') : '') + '</span>' +
        '<span class="page-card-t">' + m[4] + '</span>' +
        '<span class="page-card-hint">' + (missing ? '點擊建立' : '子頁面') + '</span></a>\n';
    },

    code: function (code, infostring) {
      // CodiMD-style options in the info string: ```js=  or  ```js=10  (line numbers, optional start)
      const info = (infostring || '').trim();
      // ```mindmap holds an indented outline, rendered as a diagram. The outline
      // stays the source of truth — searchable, mergeable, and readable as text
      // if anything ever fails to draw.
      if (info === 'mindmap' && global.MindMap) {
        let svg = '';
        try { svg = MindMap.renderSVG(code); } catch (e) { svg = ''; }
        if (svg) {
          return '<div class="mindmap-block" data-mindmap="' + escapeHtml(code) + '">' +
            '<button class="mm-edit-btn" type="button" title="在全螢幕編輯器裡打開">' +
            (global.Icons ? Icons.svg('mind-map') : '') + ' 全螢幕</button>' + svg +
            '<div class="mm-hint">點節點選取，再按 Tab 加子項目、Enter 加同層、F2 改字，' +
            '直接拖曳可換上層</div></div>';
        }
      }
      let requested = info, lineNumbers = false, startLine = 1;
      const opt = info.match(/^([^\s=]*)=(\d*)$/);
      if (opt) {
        requested = opt[1];
        lineNumbers = true;
        if (opt[2]) startLine = parseInt(opt[2], 10);
      }
      // ```linux（含 linux=）當成 shell 高亮，並標記 code-linux 讓 CSS 套用 Kali 終端配色。
      const ALIAS = { linux: 'bash', kali: 'bash' };
      const isKali = requested === 'linux' || requested === 'kali';
      const hlLang = ALIAS[requested] || requested;
      // 只依使用者標明的語言上色；沒標語言（或 hljs 不認得）就是純文字，不自動猜——
      // 猜錯會把終端輸出塗成別種語言的顏色，右上角的標籤也跟著錯。
      const lang = requested;   // 標籤永遠顯示使用者寫的字（例如 linux）
      let out;
      try {
        if (hlLang && global.hljs && global.hljs.getLanguage(hlLang)) {
          out = global.hljs.highlight(code, { language: hlLang }).value;
        } else {
          out = escapeHtml(code);
        }
      } catch (e) {
        out = escapeHtml(code);
      }
      const langSpan = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '';
      const tools = '<div class="code-tools">' +
        '<button class="code-copy" type="button" title="複製程式碼">複製</button>' + langSpan + '</div>';
      const kaliCls = isKali ? ' code-linux' : '';
      if (lineNumbers) {
        // Each source line becomes its own <li data-ln="N">, gutter number and
        // code sharing one CSS grid row — so a long line can wrap (needed in
        // print, which has no horizontal scroll) without pulling the numbers
        // out of sync with the lines after it, the way a single shared gutter
        // column would.
        const count = code.replace(/\n$/, '').split('\n').length;
        let htmlLines = splitHighlightedLines(out);
        if (htmlLines.length > count) htmlLines = htmlLines.slice(0, count);
        while (htmlLines.length < count) htmlLines.push('');
        const items = htmlLines.map(function (lineHtml, i) {
          return '<li data-ln="' + (startLine + i) + '"><code class="hljs language-' +
            escapeHtml(lang || 'plaintext') + '">' + lineHtml + '</code></li>';
        }).join('');
        return '<div class="code-block code-ln' + kaliCls + '">' + tools +
          '<pre class="code-pre"><ol class="code-lines">' + items + '</ol></pre></div>\n';
      }
      return '<div class="code-block' + kaliCls + '">' + tools +
        '<pre><code class="hljs language-' + escapeHtml(lang || 'plaintext') + '">' + out + '</code></pre></div>\n';
    },
    image: function (href, title, text) {
      // Embedded PDF attachment: ![檔名](pdf:<id>) → same-origin <iframe> viewer.
      if (href && href.indexOf('pdf:') === 0) {
        const id = href.slice(4);
        const name = escapeHtml(text || 'PDF');
        return '<span class="pdf-embed">' +
          '<span class="pdf-embed-bar">' +
          '<span class="pdf-embed-name">📎 ' + name + '</span>' +
          '<a class="pdf-embed-open" data-pdf-id="' + escapeHtml(id) + '" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>' +
          '</span>' +
          '<iframe class="pdf-embed-frame" data-pdf-id="' + escapeHtml(id) + '" title="' + name + '" loading="lazy"></iframe>' +
          '</span>';
      }
      if (href && href.indexOf('img:') === 0) {
        const id = href.slice(4);
        const isLogo = (text === '__cover_logo__');
        const img = '<img data-img-id="' + escapeHtml(id) + '"' + (isLogo ? ' class="cover-logo"' : '') +
          ' alt="' + escapeHtml(text || '') + '"' +
          (title ? ' title="' + escapeHtml(title) + '"' : '') + '>';
        // The cover logo is centred as a block and never annotated, so leave it bare.
        if (isLogo) return img;
        // Stored images get a wrapper so the annotate button can sit over them.
        return '<span class="img-wrap">' + img +
          '<button class="img-annotate" type="button" data-annotate="' + escapeHtml(id) +
          '" title="標註這張圖片">✎ 標註</button></span>';
      }
      return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text || '') + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + '>';
    }
  };

  // breaks: true — HackMD semantics, which this editor is modelled on: a newline in
  // the source is a <br> in the output, so "one sentence per line" reads the same
  // in the preview as in the editor. CommonMark's default (a single newline is a
  // soft break that collapses to a space) is what people switching from HackMD
  // report as "the preview merged my lines".
  marked.use({
    gfm: true, breaks: true,
    extensions: [tocExtension, riskExtension, calloutExtension, containerExtension, wikiLinkExtension, hashtagExtension],
    renderer: renderer
  });

  // <iframe> is only in the sanitizer's tag allow-list (below) for the PDF-embed
  // feature, and that markup never carries its own `src` — js/pdf.js's viewer sets
  // `.src` from a validated `data-pdf-id` *after* sanitizing. If a note author instead
  // types a literal `<iframe src="...">` in raw markdown, DOMPurify's URL check blocks
  // javascript:/data: but happily keeps a plain same-origin src — and CSP's
  // `frame-src 'self'` explicitly allows framing this app's own pages, so `src="/"`
  // would nest the whole authenticated app inside another user's note (clickjacking:
  // the note owner/editor could overlay it to trick a viewer into clicking real
  // buttons in their own session). Strip src/srcdoc from every <iframe> unconditionally
  // so a typed-in one is always inert, regardless of what the raw markdown asked for.
  if (global.DOMPurify) {
    DOMPurify.addHook('uponSanitizeElement', function (node, data) {
      if (data.tagName === 'iframe' && node.removeAttribute) {
        node.removeAttribute('src');
        node.removeAttribute('srcdoc');
      }
    });
  }

  // ---- Public render -----------------------------------------------------
  function render(md) {
    for (const k in usedSlugs) delete usedSlugs[k]; // reset per render
    findingSeq = 0;
    taskSeq = 0;
    headingList = [];
    let raw = marked.parse(md || '');
    // Every [toc] gets the same full list, built now that all headings are known.
    if (raw.indexOf(TOC_PLACEHOLDER) >= 0) raw = raw.split(TOC_PLACEHOLDER).join(buildInlineTOC());
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['id', 'data-img-id', 'data-note-id', 'data-note-title', 'data-annotate',
        'data-risk', 'data-finding', 'type', 'target', 'data-pdf-id', 'loading', 'data-tag',
        'data-toc',    // [toc] 的展開鈕
        'data-task',   // 待辦清單：勾選框在文件中的序號，用來回寫原始 markdown
        'data-mindmap', 'data-i'],   // 心智圖：原始大綱文字，以及節點索引
      ADD_TAGS: ['input', 'button', 'iframe'] // checkboxes, annotate button, PDF embed
    });
  }

  // Resolve <img data-img-id> placeholders to object URLs from IndexedDB.
  const urlCache = {}; // id -> objectURL

  // Drop a cached object URL so the next render re-reads the blob. The
  // annotation editor calls this after saving, otherwise the stale URL would
  // keep showing the un-annotated picture.
  function invalidateImage(id) {
    // Drop the shared blob too, or the next fetch returns the pre-annotation bytes.
    if (global.Store && Store.invalidateImage) Store.invalidateImage(id);
    if (!urlCache[id]) return;
    try { URL.revokeObjectURL(urlCache[id]); } catch (e) {}
    delete urlCache[id];
  }

  function resolveImages(container) {
    const imgs = container.querySelectorAll('img[data-img-id]');
    imgs.forEach(function (img) {
      const id = img.getAttribute('data-img-id');
      if (!id) return;
      if (urlCache[id]) { img.src = urlCache[id]; return; }
      Store.getImageBlob(id).then(function (blob) {
        if (blob) {
          const url = URL.createObjectURL(blob);
          urlCache[id] = url;
          img.src = url;
        } else {
          img.alt = '[Missing image]';
        }
      });
    });
    // Embedded PDFs load straight from the same-origin API URL (works with the
    // frame-src 'self' CSP; the browser sends the session cookie automatically).
    container.querySelectorAll('iframe[data-pdf-id]').forEach(function (f) {
      const id = f.getAttribute('data-pdf-id');
      if (id && !f.src) f.src = '/api/images/' + encodeURIComponent(id);
    });
    container.querySelectorAll('a[data-pdf-id]').forEach(function (a) {
      const id = a.getAttribute('data-pdf-id');
      if (id) a.href = '/api/images/' + encodeURIComponent(id);
    });
  }

  // Build TOC entries from rendered container: [{level, text, id}]
  function extractHeadings(container) {
    const nodes = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const list = [];
    nodes.forEach(function (h) {
      list.push({ level: parseInt(h.tagName.slice(1), 10), text: h.textContent, id: h.id });
    });
    return list;
  }

  // Convert data-img-id images inside a cloned node to data: URLs (for PDF export)
  function inlineImagesAsDataURL(container) {
    const imgs = Array.prototype.slice.call(container.querySelectorAll('img[data-img-id]'));
    return Promise.all(imgs.map(function (img) {
      const id = img.getAttribute('data-img-id');
      return Store.getImageBlob(id).then(function (blob) {
        if (!blob) return;
        return blobToDataURL(blob).then(function (durl) {
          img.setAttribute('src', durl);
          img.removeAttribute('data-img-id');
        });
      });
    }));
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  global.MD = {
    render: render,
    resolveImages: resolveImages,
    extractHeadings: extractHeadings,
    inlineImagesAsDataURL: inlineImagesAsDataURL,
    slugify: slugify,
    escapeHtml: escapeHtml,
    setNoteLookup: setNoteLookup,
    extractLinks: extractLinks,
    extractTags: extractTags,
    invalidateImage: invalidateImage,
    extractFindings: extractFindings,
    riskLevels: RISK_LEVELS
  };
})(window);
