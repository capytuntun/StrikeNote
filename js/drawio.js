/* draw.io（js/drawio.js）
 *
 * 編輯器是 draw.io 本尊——vendor/drawio/ 是它的釋出版（server/tools/vendor-drawio.js 從
 * draw.war 精簡來的），用它自己的 embed 模式放進一個 iframe，兩邊只靠 postMessage 講話
 * （https://www.drawio.com/doc/faq/embed-mode）。這個檔案只做外面那一圈：頁面的殼、
 * 訊息協定、以及「圖要怎麼存進筆記」。
 *
 * iframe 是沙箱（不給 allow-same-origin）：筆記可以分享，別人做的圖會在我的瀏覽器裡被
 * draw.io 解析；放在沙箱裡，它就算被一張惡意圖檔打穿，也是不透明來源，拿不到這個站的
 * cookie、讀不到父頁面。伺服器那邊為此替 vendor/drawio/ 準備了專用的標頭，見 server.js
 * 的 drawioHeaders。
 *
 * 存檔格式：一張圖＝一篇筆記（meta.drawio），內容是一個 ```drawio 圍欄，裡面**只有一行**：
 *
 *   ```drawio
 *   <svg … content="&lt;mxfile …&gt;">…</svg>
 *   ```
 *
 * 那一行是 draw.io 的 xmlsvg——一張可以直接顯示的 SVG，根節點的 content 屬性裡帶著可以
 * 再編輯的原始圖檔（存成 .drawio.svg 就能用桌面版 draw.io 打開）。所以一份資料同時是
 * 「畫面」與「原始檔」，而且住在筆記內容裡：版本紀錄、備份還原、垃圾桶、分享都不用
 * 另外處理。三種形式（decode 都認得）：
 *   - <svg …>      一般情況
 *   - base64:…     SVG 裡有換行、而且換成字元參照之後對不回來時的後備（極少見）
 *   - <mxfile …>   只有原始檔、還沒有畫面（來不及匯出就被切走；下次打開會補畫）
 *
 * 圍欄裡不能有換行（不然某一行剛好以 ``` 開頭就會把圍欄截斷），所以換行一律寫成 &#10;。
 */
(function (global) {
  'use strict';

  const EDITOR = 'vendor/drawio/index.html';
  const B64 = 'base64:';
  const EXPORT_DELAY = 800;      // 停手多久才向 draw.io 要一份新的 SVG
  const CLOSE_WAIT = 4000;       // 返回時最多等匯出多久

  function ic(name) { return global.Icons ? Icons.svg(name) : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- UTF-8 <-> base64（btoa/atob 只吃 Latin-1）----
  function b64encode(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function dataUrl(svg) { return 'data:image/svg+xml;base64,' + b64encode(svg); }
  // draw.io 匯出回來的是 data URI；base64 或 utf8 兩種寫法都可能
  function textOfDataUri(uri) {
    const s = String(uri || '');
    const i = s.indexOf(',');
    if (s.slice(0, 5) !== 'data:' || i < 0) return '';
    const head = s.slice(0, i), body = s.slice(i + 1);
    try { return /;base64/i.test(head) ? b64decode(body) : decodeURIComponent(body); }
    catch (e) { return ''; }
  }

  // ---- SVG 裡的原始圖檔 ----
  function parseSvg(svg) {
    try {
      const doc = new DOMParser().parseFromString(String(svg), 'image/svg+xml');
      if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return null;
      if (doc.documentElement.nodeName.toLowerCase() !== 'svg') return null;
      return doc;
    } catch (e) { return null; }
  }
  function xmlInSvg(svg) {
    const doc = parseSvg(svg);
    return doc ? (doc.documentElement.getAttribute('content') || '') : '';
  }
  function isStale(svg) {
    const doc = parseSvg(svg);
    return !!doc && doc.documentElement.getAttribute('data-stale') === '1';
  }

  // ---- 筆記內容 <-> payload ----
  function payloadOf(content) {
    const m = /^```drawio[ \t]*\r?\n([^\n]*?)\r?\n```/m.exec(String(content || ''));
    return m ? m[1].trim() : null;
  }
  function wrap(payload) { return '```drawio\n' + (payload || '') + '\n```\n'; }
  function generate() { return wrap(''); }
  function isNote(note) { return !!(note && note.meta && note.meta.drawio); }

  function decode(payload) {
    let p = String(payload || '').trim();
    if (!p) return { svg: '', xml: '' };
    if (p.slice(0, B64.length) === B64) {
      try { p = b64decode(p.slice(B64.length)).trim(); } catch (e) { return { svg: '', xml: '' }; }
    }
    if (/^<(?:mxfile|mxGraphModel)[\s>]/.test(p)) return { svg: '', xml: p };
    if (/^<(?:\?xml|!DOCTYPE|svg[\s>])/.test(p)) return { svg: p, xml: xmlInSvg(p) };
    return { svg: '', xml: '' };
  }
  // 一行裝得下就直接放，裝不下（或換行換掉之後對不回來）才退到 base64
  function oneLine(text, check) {
    const s = String(text || '');
    if (!/[\r\n]/.test(s)) return s;
    const flat = s.replace(/\r\n?|\n/g, '&#10;');
    return check(flat) ? flat : B64 + b64encode(s);
  }
  function encode(svg) {
    const want = xmlInSvg(svg);
    return oneLine(svg, function (flat) {
      const doc = parseSvg(flat);
      return !!doc && (doc.documentElement.getAttribute('content') || '') === want;
    });
  }
  function encodeXml(xml) {
    // 原始圖檔沒有畫面可以對照，有換行就直接 base64，不去猜換行在哪一種節點裡
    return oneLine(xml, function () { return false; });
  }
  // 把原始圖檔放進 SVG 的 content 屬性。draw.io 匯出的 xmlsvg 本來就帶著一份，但那一份
  // 一律是壓縮過的（deflate＋base64，不管 compressXml 怎麼設），存進筆記就是一串亂碼；
  // autosave 事件給的則是沒壓縮的 XML，所以存檔時一律換成那一份——圖裡的文字搜尋得到、
  // 版本紀錄的差異看得懂，而且 draw.io 兩種都讀得回去。
  // stale＝畫面比原始檔舊（來不及重新匯出）：標上 data-stale，下次打開會補畫。
  function payloadFor(svg, xml, stale) {
    const doc = svg ? parseSvg(svg) : null;
    if (!doc) return xml ? encodeXml(xml) : '';
    if (xml) doc.documentElement.setAttribute('content', xml);
    if (stale) doc.documentElement.setAttribute('data-stale', '1');
    else doc.documentElement.removeAttribute('data-stale');
    return encode(new XMLSerializer().serializeToString(doc));
  }

  // ---- 唯讀渲染（預覽／PDF／電子書）----
  // 圖是 <img src="data:image/svg+xml…">：在 <img> 裡的 SVG 不會跑 script、也載不了外部
  // 資源，所以就算圖檔是別人精心做過的，這裡也只是一張圖。
  function imgHTML(payload, alt) {
    const d = decode(payload);
    if (!d.svg) return '';
    return '<img class="drawio-img" alt="' + esc(alt || 'draw.io 圖表') + '" src="' + dataUrl(d.svg) + '">';
  }
  function blockHTML(payload, alt) {
    const img = imgHTML(payload, alt);
    if (img) return '<div class="drawio-block">' + img + '</div>';
    const d = decode(payload);
    return '<div class="drawio-block is-empty">' + ic('shapes') + '<span>' +
      (d.xml ? '這張圖還沒有產生預覽，打開編輯一次就會有' : '空白的 draw.io 圖表') + '</span></div>';
  }
  function imgOf(content, alt) { return imgHTML(payloadOf(content) || '', alt); }

  // ---- 頁面的殼 ----
  function shell(host, opts, readOnly) {
    host.classList.add('dio-page');
    host.innerHTML =
      '<header class="dio-bar">' +
      '<span class="dio-bar-t">' + ic('shapes') + '<span>draw.io</span></span>' +
      (opts.title !== undefined
        ? '<input class="dio-title" type="text" placeholder="未命名圖表"' + (readOnly ? ' readonly' : '') + '>'
        : '') +
      '<span class="dio-status" aria-live="polite"></span>' +
      '<span class="dio-bar-sp"></span>' +
      (readOnly ? '<span class="dio-readonly">' + ic('lock') + ' 唯讀</span>' : '') +
      (!readOnly && opts.onHistory
        ? '<button class="btn btn-ghost dio-history" type="button" title="這張圖的版本紀錄（可以還原）">' + ic('history') + ' 版本</button>'
        : '') +
      '<button class="btn dio-back" type="button">' + ic('arrow-left') + ' 返回</button>' +
      '</header>' +
      '<div class="dio-body"></div>';
    const titleEl = host.querySelector('.dio-title');
    if (titleEl) {
      titleEl.value = opts.title || '';
      if (!readOnly) {
        titleEl.addEventListener('change', function () { if (opts.onTitle) opts.onTitle(titleEl.value.trim()); });
        titleEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
          e.stopPropagation();
        });
      }
    }
    return {
      body: host.querySelector('.dio-body'), status: host.querySelector('.dio-status'),
      back: host.querySelector('.dio-back'), history: host.querySelector('.dio-history')
    };
  }
  function unshell(host) { host.innerHTML = ''; host.classList.remove('dio-page'); }

  // ---- 唯讀檢視（只有讀取權限的分享筆記）----
  function view(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {} };
    const ui = shell(host, opts, true);
    ui.body.classList.add('dio-view');
    ui.body.innerHTML = blockHTML(payloadOf(content) || '', opts.title);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      unshell(host);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ui.back.addEventListener('click', close);
    return { close: close };
  }

  // ---- 編輯器 ----
  function open(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {} };

    const first = decode(payloadOf(content) || '');
    let lastSvg = first.svg, lastXml = first.xml;
    // 畫面是舊的（上次來不及匯出）或根本沒有畫面：載入之後主動補畫一次
    const needRedraw = !!first.xml && (!first.svg || isStale(first.svg));
    let ready = false, closed = false;
    let changeSeq = 0, exportedSeq = 0, askedSeq = -1;
    let exportTimer = null, closeTimer = null, afterExport = null;

    const ui = shell(host, opts, false);
    ui.body.innerHTML = '<div class="dio-loading">載入 draw.io…</div>';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const frame = document.createElement('iframe');
    frame.className = 'dio-frame';
    frame.title = 'draw.io';
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals allow-downloads');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.src = EDITOR + '?' + [
      'embed=1', 'proto=json', 'spin=1',
      'configure=1',          // 起來之前先問我們要設定（見 onMessage 的 configure）
      'lang=zh-tw',
      'libraries=1',          // 圖庫（更多圖形…）在 embed 模式預設是關的
      'noSaveBtn=1', 'noExitBtn=1', 'saveAndExit=0',   // 存檔是自動的、離開用上面那顆返回
      'stealth=1',            // 不碰任何外部服務；本站的 CSP 本來也不准
      'dark=' + (dark ? '1' : '0')
    ].join('&');
    ui.body.appendChild(frame);

    function setStatus(text, cls) {
      if (!ui.status) return;
      ui.status.textContent = text || '';
      ui.status.className = 'dio-status' + (cls ? ' ' + cls : '');
    }
    function post(msg) {
      // 沙箱裡的文件是不透明來源，targetOrigin 指名不了，只能寫 '*'；收件端靠 e.source 認人
      if (frame.contentWindow) frame.contentWindow.postMessage(JSON.stringify(msg), '*');
    }
    // 回傳的 promise 在這一份真的存進伺服器之後才解開（失敗也解開——等它的人要的是「存檔
    // 這件事結束了」，不是成功與否；失敗會顯示在狀態上）
    function emit(payload) {
      if (!opts.onChange) return Promise.resolve();
      setStatus('儲存中…');
      return Promise.resolve(opts.onChange(wrap(payload))).then(function () {
        if (!closed && exportedSeq === changeSeq) setStatus('已儲存', 'is-ok');
      }, function () {
        if (!closed) setStatus('儲存失敗', 'is-err');
      });
    }
    function askExport() {
      clearTimeout(exportTimer);
      if (!ready || closed) return;
      askedSeq = changeSeq;
      // theme: 'light'——編輯器開深色模式時 draw.io 預設匯出「會跟著環境變色」的 SVG
      // （light-dark()），那張圖放到白底上線條會變成白的、整張看不見；報告印出來也是白紙，
      // 所以存下來的畫面一律是淺色版，跟編輯器當下的主題無關。
      post({ action: 'export', format: 'xmlsvg', theme: 'light', spinKey: 'saving' });
    }
    function scheduleExport() {
      clearTimeout(exportTimer);
      exportTimer = setTimeout(askExport, EXPORT_DELAY);
    }
    function dirty() { return changeSeq !== exportedSeq; }

    function onMessage(e) {
      if (closed || e.source !== frame.contentWindow) return;
      let msg = null;
      try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return; }
      if (!msg || !msg.event) return;
      if (msg.event === 'configure') {
        // 原始圖檔不要壓縮：draw.io 預設把 <diagram> 的內容 deflate＋base64，存進筆記就是一串
        // 亂碼；不壓縮的話圖裡的文字搜尋得到、版本紀錄的差異也看得懂，多出來的幾 KB 不算什麼。
        post({ action: 'configure', config: { compressXml: false } });
      } else if (msg.event === 'init') {
        ready = true;
        const l = ui.body.querySelector('.dio-loading');
        if (l) l.remove();
        // title 不傳：draw.io 會把它印在選單列右邊，而且之後在上面那條列改名它不會跟著變，
        // 畫面上就會有兩個對不起來的標題。
        post({ action: 'load', xml: lastXml || '', autosave: 1, noSaveBtn: '1', noExitBtn: '1', saveAndExit: '0' });
      } else if (msg.event === 'load') {
        if (needRedraw) { changeSeq++; askExport(); }
        else setStatus(lastXml ? '已儲存' : '', 'is-ok');
      } else if (msg.event === 'autosave' || msg.event === 'save') {
        if (typeof msg.xml === 'string') lastXml = msg.xml;
        changeSeq++;
        setStatus('尚未儲存');
        if (msg.event === 'save') askExport(); else scheduleExport();
        if (msg.exit) requestClose();
      } else if (msg.event === 'export') {
        const svg = textOfDataUri(msg.data);
        if (svg && parseSvg(svg)) {
          lastSvg = svg;
          // 匯出的這一份對應的是「發出要求那一刻」的圖；之後又改過的話還是髒的
          if (askedSeq >= 0) exportedSeq = askedSeq;
          // 還沒收過 autosave（例如一打開就補畫）時手上沒有未壓縮的原始檔，就用匯出帶的那份
          if (!lastXml) lastXml = (typeof msg.xml === 'string' && msg.xml) || xmlInSvg(svg);
          const saved = emit(payloadFor(svg, lastXml, dirty()));
          if (dirty()) scheduleExport();
          if (afterExport) { const f = afterExport; afterExport = null; saved.then(f); }
          return;
        }
        if (afterExport) { const f = afterExport; afterExport = null; f(); }
      } else if (msg.event === 'exit') {
        requestClose();
      }
    }
    window.addEventListener('message', onMessage);

    // 同步收掉：切到別的檢視時 app.js 叫的就是這個，不能等 draw.io 回覆。還沒匯出的
    // 改動不會丟——原始檔（autosave 事件每改一下就送來）是最新的，只有畫面慢一拍。
    function close() {
      if (closed) return;
      const pending = dirty() && !!lastXml;
      closed = true;
      clearTimeout(exportTimer); clearTimeout(closeTimer);
      window.removeEventListener('message', onMessage);
      if (pending && opts.onChange) opts.onChange(wrap(payloadFor(lastSvg, lastXml, true)));
      unshell(host);
      if (opts.onClose) opts.onClose();
    }
    // 使用者自己按返回：等 draw.io 把最新的畫面匯出來再走，等不到就照上面那條路收
    function requestClose() {
      if (closed) return;
      if (!ready || !dirty()) { close(); return; }
      setStatus('儲存中…');
      afterExport = close;
      closeTimer = setTimeout(close, CLOSE_WAIT);
      askExport();
    }
    ui.back.addEventListener('click', requestClose);

    // 版本紀錄要看到的是「現在畫面上這張」，所以先把還沒存的送出去再打開
    function whenSaved(cb) {
      if (closed) return;
      if (!ready || !dirty()) { cb(); return; }
      let done = false;
      const once = function () { if (done || closed) return; done = true; clearTimeout(t); cb(); };
      const t = setTimeout(once, CLOSE_WAIT);
      afterExport = once;
      askExport();
    }
    if (ui.history) ui.history.addEventListener('click', function () { whenSaved(function () { opts.onHistory(); }); });

    // 不存檔直接拆掉：還原到舊版本之後用的——這個編輯器裡還是還原前的圖，讓它照平常的
    // close() 走一遍，有機會把舊圖又存回去蓋掉剛還原的版本。
    function discard() {
      if (closed) return;
      closed = true;
      clearTimeout(exportTimer); clearTimeout(closeTimer);
      window.removeEventListener('message', onMessage);
      unshell(host);
    }

    return { close: close, requestClose: requestClose, discard: discard };
  }

  global.DrawIO = {
    open: open, view: view,
    isNote: isNote, generate: generate,
    payloadOf: payloadOf, wrap: wrap, decode: decode, encode: encode,
    imgOf: imgOf, blockHTML: blockHTML, dataUrl: dataUrl
  };
})(window);
