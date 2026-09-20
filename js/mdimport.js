/* mdimport.js — 把外面來的 Markdown 整理成 StrikeNote 吃得下的樣子，瀏覽器與命令列共用。
 *
 * 外面的 .md（網頁轉出來的、別的筆記軟體匯出的）裡面的圖片有三種寫法，站上都不能直接用：
 *   ![](images/x.png)                相對路徑 → 站上沒有這個檔案，404
 *   ![](https://站外/x.png)           外部網址 → 站台的 CSP 只允許同源圖片，不會顯示
 *   <img src="...">                  HTML 寫法 → 不會經過 Markdown 的圖片渲染
 * 站上的寫法是 ![名稱](img:<id>)（PDF 是 pdf:、其他附件是 file:），檔案本身上傳到 /api/images。
 * 這個檔只負責「掃出引用」跟「換成站上的寫法」，實際上傳誰做由呼叫端決定：瀏覽器用
 * Store.uploadFile，命令列用 HTTP API（還會先把外部網址的圖抓下來——那是在使用者自己的
 * 電腦上抓，跟伺服器去抓使用者給的網址是兩回事，後者才有 SSRF 的問題）。
 *
 *   scan(text)                → 這份 Markdown 引用到的東西
 *   rewrite(text, resolve)    → 依 resolve() 給的結果換寫連結
 *   frontMatter(text)         → { title, body }：抽掉 YAML 開頭並取出標題
 *   schemeFor(mime, name)     → 'img' | 'pdf' | 'file'
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MdImport = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ![alt](目標 "標題")／[文字](目標)；目標用 <> 包起來的也吃
  const LINK = /(!?)\[([^\]]*)\]\(\s*<([^>]*)>|(!?)\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")|(?:\s+'[^']*'))?\s*\)/g;
  // 目標裡夾著空白的寫法（![圖](my file.png)）嚴格說不是合法的 Markdown，站上的 marked 也
  // 不會把它當圖片——但網站轉出來的檔案很常這樣寫。只有在資料夾裡真的找得到那個檔案時才會
  // 被換掉（resolve() 回 null 就原樣保留），所以換完是把本來就壞掉的圖修好，不會誤傷別的字。
  const LOOSE = /(!?)\[([^\]]*)\]\([ \t]*([^()<>\n]*?)((?:[ \t]+"[^"]*")|(?:[ \t]+'[^']*'))?[ \t]*\)/g;
  // [id]: 目標 "標題"。網址照規矩不該有空白，但外面轉出來的檔案很常見（中文檔名），
  // 所以取「這一行剩下的」再把結尾的標題拿掉，而不是一遇到空白就截斷。
  const REF_DEF = /^([ \t]{0,3}\[[^\]]+\]:[ \t]*)(?:<([^>]*)>|(\S[^\n]*?))([ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
  // <img src="..."> / <img src='...'>
  const HTML_IMG = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
  const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)(;[^,]*)?,/i;
  const FENCE = /^([ \t]*)(```+|~~~+)/;

  function isRemote(u) { return /^https?:\/\//i.test(u); }
  function isData(u) { return DATA_URI.test(u); }
  function isSiteRef(u) { return /^(img|pdf|file):/i.test(u); }
  function isAnchor(u) { return !u || u.charAt(0) === '#'; }
  function isOtherScheme(u) { return /^[a-z][a-z0-9+.-]*:/i.test(u) && !isData(u) && !isSiteRef(u); }
  // 本機相對路徑：不是網址、不是 data:、不是站上的 img:/pdf:/file:、不是錨點
  function isLocal(u) {
    if (isAnchor(u) || isData(u) || isSiteRef(u) || isRemote(u) || isOtherScheme(u)) return false;
    return u.indexOf('//') !== 0;
  }
  function kindOf(u) {
    if (isData(u)) return 'data';
    if (isRemote(u)) return 'remote';
    if (isLocal(u)) return 'local';
    return 'other';
  }

  // 程式碼區塊（``` 或 ~~~ 圍起來、以及縮排四格）裡的東西是內容，不是連結，不能動。
  // 回傳每一行是不是在程式碼裡。
  function codeLines(text) {
    const lines = text.split('\n');
    const out = new Array(lines.length);
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const m = FENCE.exec(lines[i]);
      if (fence) {
        out[i] = true;
        if (m && lines[i].trim().indexOf(fence) === 0) fence = null;
        continue;
      }
      if (m) { fence = m[2].charAt(0).repeat(3); out[i] = true; continue; }
      out[i] = /^(\t| {4})/.test(lines[i]) && (i === 0 || !lines[i - 1].trim() || out[i - 1]);
    }
    return out;
  }
  function offsetsOfLines(text) {
    const at = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) at.push(i + 1);
    return at;
  }
  function lineOfOffset(starts, off) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // 掃出這份 Markdown 引用到的東西。回傳 [{ target, kind, alt, embed, start, end, syntax }]
  //   kind: 'local'（相對路徑）｜'remote'（http/https）｜'data'（內嵌 base64）｜'other'
  //   embed: true 表示原本就是 ![...]（圖片），false 是一般連結
  function scan(text) {
    text = String(text || '');
    const code = codeLines(text), starts = offsetsOfLines(text);
    const inCode = function (off) { return code[lineOfOffset(starts, off)]; };
    const out = [], seen = [];
    let m;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) {
      const bang = m[1] !== undefined ? m[1] : m[4];
      const alt = m[2] !== undefined ? m[2] : m[5];
      const target = m[3] !== undefined ? m[3] : m[6];
      if (target == null || inCode(m.index)) continue;
      seen.push([m.index, m.index + m[0].length]);
      out.push({ target: target, kind: kindOf(target), alt: alt || '', embed: bang === '!', start: m.index, end: m.index + m[0].length, syntax: 'link' });
    }
    LOOSE.lastIndex = 0;
    while ((m = LOOSE.exec(text))) {
      const target = String(m[3] || '').trim();
      const start = m.index, end = m.index + m[0].length;
      // 只補「目標裡有空白、而且看起來是本機路徑」的那一種；其餘上面那條已經抓過了
      if (!target || !/\s/.test(target) || kindOf(target) !== 'local' || inCode(start)) continue;
      if (seen.some(function (r) { return start < r[1] && end > r[0]; })) continue;
      out.push({ target: target, kind: 'local', alt: m[2] || '', embed: m[1] === '!', start: start, end: end, syntax: 'link' });
    }
    REF_DEF.lastIndex = 0;
    while ((m = REF_DEF.exec(text))) {
      if (inCode(m.index)) continue;
      const target = m[2] !== undefined ? m[2] : m[3];
      if (!target) continue;
      // 結尾的 "標題" 留著不動，只換掉網址本身
      const end = m.index + m[1].length + (m[2] !== undefined ? m[2].length + 2 : m[3].length);
      out.push({ target: target, kind: kindOf(target), alt: '', embed: true, start: m.index, end: end, syntax: 'refdef', prefix: m[1] });
    }
    HTML_IMG.lastIndex = 0;
    while ((m = HTML_IMG.exec(text))) {
      if (inCode(m.index)) continue;
      const src = m[2] !== undefined ? m[2] : m[3];
      const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[0]);
      out.push({ target: src, kind: kindOf(src), alt: (alt && (alt[2] !== undefined ? alt[2] : alt[3])) || '', embed: true, start: m.index, end: m.index + m[0].length, syntax: 'html' });
    }
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  function schemeFor(mime, name) {
    mime = String(mime || '').toLowerCase();
    if (mime.indexOf('image/') === 0) return 'img';
    if (mime === 'application/pdf' || /\.pdf$/i.test(name || '')) return 'pdf';
    return 'file';
  }
  // 連結文字裡的 [ ] 跟換行會把語法弄壞
  function cleanLabel(s, fallback) {
    return String(s || '').replace(/[\[\]\r\n]/g, '').trim() || fallback || '檔案';
  }
  // 站上的寫法：圖片用 ![名稱](img:id)；PDF 用 ![名稱](pdf:id) 會變成站內檢視器，
  // 一般連結則是 [名稱](pdf:id)；其他附件一律 [名稱](file:id)（沒有「內嵌」的概念）。
  function siteRef(ref, res) {
    const label = cleanLabel(ref.alt || res.name, res.scheme === 'pdf' ? 'PDF' : '檔案');
    if (res.scheme === 'img') return '![' + label + '](img:' + res.id + ')';
    if (res.scheme === 'pdf') return (ref.embed ? '!' : '') + '[' + label.replace(/\.pdf$/i, '') + '](pdf:' + res.id + ')';
    return '[' + label + '](file:' + res.id + ')';
  }

  // 依 resolve(ref) 的結果換寫。resolve 回 { id, scheme, name } 就換掉，回 null 就原樣保留。
  function rewrite(text, resolve) {
    const refs = scan(text);
    if (!refs.length) return String(text || '');
    let out = '', at = 0;
    refs.forEach(function (ref) {
      if (ref.start < at) return;                 // 重疊（例如 HTML 裡又有 Markdown）就跳過
      const res = resolve(ref);
      if (!res || !res.id) return;
      out += text.slice(at, ref.start);
      out += ref.syntax === 'refdef' ? ref.prefix + res.scheme + ':' + res.id : siteRef(ref, res);
      at = ref.end;
    });
    return out + text.slice(at);
  }

  // YAML front matter：站上不解析它，但標題很有用——抽出來當筆記標題，其餘的原樣留在內文
  // 開頭（丟掉反而可能少了資訊）。回傳 { title, body }。
  function frontMatter(text) {
    text = String(text || '');
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    let title = '', body = text;
    if (m) {
      const t = /^[ \t]*title[ \t]*:[ \t]*(.+)$/im.exec(m[1]);
      if (t) title = t[1].trim().replace(/^["']|["']$/g, '');
      body = text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');   // 開頭的空行不留
    }
    if (!title) {
      const h = /^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
      if (h) title = h[1].trim();
    }
    return { title: title, body: body };
  }

  // data:image/png;base64,xxxx → { mime, bytes(Uint8Array), name }
  function decodeDataUri(uri, index) {
    const m = DATA_URI.exec(uri);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const payload = uri.slice(m[0].length);
    let bytes;
    try {
      if ((m[2] || '').indexOf('base64') >= 0) {
        const bin = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('binary');
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        const s = decodeURIComponent(payload);
        bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 255;
      }
    } catch (e) { return null; }
    const ext = (mime.split('/')[1] || 'bin').replace(/[^\w]+.*$/, '');
    return { mime: mime, bytes: bytes, name: '內嵌圖片-' + (index + 1) + '.' + ext };
  }

  // 相對路徑 → 選取範圍裡的路徑（處理 ./、../、%20 這種編碼，以及 ?query#hash）
  function resolvePath(dirs, target) {
    let t = String(target).split('#')[0].split('?')[0];
    try { t = decodeURIComponent(t); } catch (e) { /* 壞掉的編碼就照原樣 */ }
    const parts = t.charAt(0) === '/' ? [] : dirs.slice();
    t.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    });
    return parts.join('/');
  }

  const EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    zip: 'application/zip', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  function mimeOf(name, fallback) {
    const ext = (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1];
    return (ext && EXT_MIME[ext.toLowerCase()]) || fallback || 'application/octet-stream';
  }

  return {
    scan: scan,
    rewrite: rewrite,
    siteRef: siteRef,
    schemeFor: schemeFor,
    cleanLabel: cleanLabel,
    frontMatter: frontMatter,
    decodeDataUri: decodeDataUri,
    resolvePath: resolvePath,
    mimeOf: mimeOf,
    isLocal: isLocal,
    isRemote: isRemote
  };
});
