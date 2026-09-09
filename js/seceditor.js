/* seceditor.js — 資安院報告模式的「行內步驟編輯器」
 *
 * 與一般 md 編輯器不同：這個模式沒有 markdown 編輯區，右側整個是步驟式編輯器。
 * 一步 = 一個文字描述框 + 一張圖片上傳。可「＋ 新增文字描述框」，每步可刪除；
 * 描述框上方的「範本」（如「確認 IP」）會帶入樣板文字。
 *
 * 儲存策略：
 *   - 結構化資料存在 note.meta.secReport = { version, title, date, steps:[{text,imgId}] }
 *     （開啟時用它重建這個編輯器）
 *   - 同時把它轉成 markdown 存進 note.content（沿用 SecReport.generate），
 *     讓搜尋、預覽與 PDF 輸出都能照常運作。
 */
(function (global) {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };

  // 模組狀態
  let cur = null;          // 目前編輯的 note
  let onSavedCb = null;    // 儲存後回呼（app.js 用來更新樹狀標題等）
  let saveTimer = null;
  let inited = false;

  // DOM 參照（延遲取得）
  let wrap, titleEl, dateEl, stepsEl, statusSave, infoEl;
  // 報告資訊欄位（單位 / Domain / IP / 弱點類型）— 由 open() 建立
  let infoInputs = {};

  function grab() {
    wrap = $('#sec-wrap');
    titleEl = $('#sec-title');
    dateEl = $('#sec-date');
    stepsEl = $('#sec-steps');
    infoEl = $('#sec-info');
    statusSave = $('#sec-status-save');
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function today() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 建立一個空的報告資料結構（app.js 建新筆記時用）
  function blankReport() {
    return {
      version: 1, title: '報告', date: today(),
      unit: '', ip: '', domain: '', vulnType: '', impact: '',
      steps: [{ text: '', imgId: null, tpl: '' }]
    };
  }

  // 依報告資訊組出標題：「單位 — 弱點類型 報告」
  function titleFrom(info) {
    const parts = [info.unit, info.vulnType].filter(function (x) { return x && x.trim(); });
    return parts.length ? (parts.join(' — ') + ' 報告') : '報告';
  }

  // 常見弱點類型（給下拉選單用）
  const VULN_TYPES = [
    'SQL Injection', 'Cross-Site Scripting (XSS)', 'Command Injection',
    'Broken Access Control', '身分驗證繞過', '弱密碼 / 預設憑證',
    'Sensitive Data Exposure', 'SSRF', 'File Upload', 'CSRF',
    'Insecure Deserialization', '目錄遍歷', '設定不當', '軟體供應鏈失效'
  ];

  // 衝擊度等級（由高到低）
  const IMPACT_LEVELS = ['嚴重', '高', '中', '低', '資訊'];

  // ---------------- 步驟卡片 ----------------
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function renumber() {
    const nums = stepsEl.querySelectorAll('.sec-card-num');
    Array.prototype.forEach.call(nums, function (n, i) { n.textContent = pad2(i + 1); });
  }

  function buildCard(step) {
    const ro = cur && cur.perm === 'read';
    const card = el('div', 'sec-card');
    card.dataset.imgId = step.imgId || '';

    // 標頭：編號徽章 + 刪除
    const head = el('div', 'sec-card-head');
    const badge = el('span', 'sec-card-badge');
    badge.appendChild(el('span', 'sec-card-num', '01'));
    badge.appendChild(el('span', 'sec-card-badge-label', '文字描述框'));
    head.appendChild(badge);
    if (!ro) {
      const del = el('button', 'sec-card-del', global.Icons ? Icons.svg('x') : '✕');
      del.type = 'button';
      del.title = '刪除這個文字描述框';
      del.addEventListener('click', function () { card.remove(); renumber(); scheduleSave(); });
      head.appendChild(del);
    }
    card.appendChild(head);

    const body = el('div', 'sec-card-body');
    card.dataset.tpl = step.tpl || '';

    // 工具列：範本下拉＋帶入樣板（左）、插入程式碼區塊（右），合成一列——原本是
    // 兩排各自的高度／間距／按鈕樣式對不齊，現在共用同一套 .btn-ghost 系統。
    const snippets = (global.SecReport && global.SecReport.snippets) || [{ id: '', label: '（不使用範本）', text: '' }];
    const tplRow = el('div', 'sec-tools-row');
    tplRow.appendChild(el('span', 'sec-mini-label', '範本'));
    const tplSel = el('select', 'sec-tpl');
    snippets.forEach(function (s) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      tplSel.appendChild(o);
    });
    tplSel.value = step.tpl || '';
    tplSel.disabled = ro;
    tplRow.appendChild(tplSel);
    // 「帶入樣板」按鈕：把目前所選範本的樣板文字插入描述框（可重複套用；下拉選到
    // 同一個範本不會觸發 change，這顆鈕是手動再套用一次的唯一辦法，不是重複功能）
    const applyBtn = el('button', 'btn btn-ghost sec-tpl-apply', '帶入樣板');
    applyBtn.type = 'button';
    applyBtn.hidden = ro;
    tplRow.appendChild(applyBtn);
    tplRow.appendChild(el('span', 'sec-tools-sp'));
    const codeBtn = el('button', 'btn btn-ghost sec-tool-btn',
      (global.Icons ? Icons.svg('square-code') : '') + '<span>程式碼區塊</span>');
    codeBtn.type = 'button';
    codeBtn.title = '插入程式碼區塊（可貼上自己的腳本）';
    codeBtn.hidden = ro;
    tplRow.appendChild(codeBtn);
    body.appendChild(tplRow);

    // 文字描述框
    const ta = el('textarea', 'sec-card-text');
    ta.placeholder = '在此描述這個步驟…（可用 ``` 包住程式碼，或按上方「程式碼區塊」）';
    ta.rows = 4;
    ta.value = step.text || '';
    ta.readOnly = ro;
    ta.addEventListener('input', scheduleSave);
    body.appendChild(ta);

    function applyTemplate() {
      const snip = snippets.filter(function (s) { return s.id === tplSel.value; })[0];
      if (!snip || !snip.text) return;
      const c = ta.value.replace(/\s+$/, '');
      ta.value = c ? (c + '\n' + snip.text) : snip.text;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      scheduleSave();
    }
    // 記住所選範本（重整後不會跑掉），並自動帶入一次樣板文字
    tplSel.addEventListener('change', function () {
      card.dataset.tpl = tplSel.value;
      applyTemplate();
    });
    applyBtn.addEventListener('click', applyTemplate);

    // 在游標處插入程式碼區塊（有選取文字則包起來）
    codeBtn.addEventListener('click', function () {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const sel = v.slice(s, e);
      const lead = (s > 0 && v[s - 1] !== '\n') ? '\n' : '';
      const block = lead + '```\n' + sel + '\n```\n';
      ta.value = v.slice(0, s) + block + v.slice(e);
      const inside = s + lead.length + 4; // 落在 ```\n 之後
      ta.focus();
      if (sel) { ta.selectionStart = inside; ta.selectionEnd = inside + sel.length; }
      else { ta.selectionStart = ta.selectionEnd = inside; }
      scheduleSave();
    });

    // 圖片上傳區（可點擊 / 拖曳；有圖時顯示縮圖與操作）
    const zone = el('div', 'sec-imgzone');
    const fi = el('input');
    fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true;
    zone.appendChild(fi);
    const empty = el('div', 'sec-imgzone-empty',
      '<span class="sec-imgzone-ic">' + (global.Icons ? Icons.svg('image') : '') + '</span><span>點擊或拖曳圖片到此上傳</span>');
    const preview = el('div', 'sec-imgzone-preview');
    zone.appendChild(empty);
    zone.appendChild(preview);

    function showEmpty() {
      card.dataset.imgId = '';
      zone.classList.remove('has-img');
      preview.innerHTML = '';
    }
    function showImage(imgId) {
      if (!imgId || !(global.Store && global.Store.getImage)) { showEmpty(); return; }
      card.dataset.imgId = imgId;
      zone.classList.add('has-img');
      preview.innerHTML = '';
      global.Store.getImage(imgId).then(function (rec) {
        if (rec && rec.blob) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(rec.blob);
          preview.appendChild(img);
        }
      });
      if (!ro) {
        const bar = el('div', 'sec-imgzone-bar');
        const replace = el('button', 'sec-imgbtn', '更換');
        replace.type = 'button';
        replace.addEventListener('click', function (e) { e.stopPropagation(); fi.click(); });
        const remove = el('button', 'sec-imgbtn sec-imgbtn-danger', '移除');
        remove.type = 'button';
        remove.addEventListener('click', function (e) { e.stopPropagation(); showEmpty(); scheduleSave(); });
        bar.appendChild(replace); bar.appendChild(remove);
        preview.appendChild(bar);
      }
    }
    function upload(file) {
      if (!file || !(global.Store && global.Store.putImage)) return;
      statusSave.textContent = '上傳圖片…';
      global.Store.putImage(file).then(function (id) {
        showImage(id);
        scheduleSave();
      }).catch(function () { statusSave.textContent = '⚠ 圖片上傳失敗'; });
    }

    if (!ro) {
      empty.addEventListener('click', function () { fi.click(); });
      fi.addEventListener('change', function () {
        const f = fi.files && fi.files[0];
        fi.value = '';
        upload(f);
      });
      zone.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) {
          e.preventDefault(); zone.classList.add('drag-over');
        }
      });
      zone.addEventListener('dragleave', function () { zone.classList.remove('drag-over'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault(); zone.classList.remove('drag-over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && f.type && f.type.indexOf('image/') === 0) upload(f);
      });
    }

    if (step.imgId) showImage(step.imgId);
    body.appendChild(zone);

    card.appendChild(body);
    return card;
  }

  function addStep(step) {
    const card = buildCard(step || { text: '', imgId: null });
    stepsEl.appendChild(card);
    renumber();
    return card;
  }

  // ---------------- 報告資訊卡片 ----------------
  const INFO_FIELDS = [
    { key: 'unit',     label: '受測單位', ph: '例如：某某股份有限公司' },
    { key: 'domain',   label: '目標網域', ph: 'example.com' },
    { key: 'ip',       label: 'IP',      ph: '1.2.3.4' },
    { key: 'vulnType', label: '弱點類型', options: VULN_TYPES,   placeholder: '（請選擇弱點類型）' },
    { key: 'impact',   label: '衝擊度',   options: IMPACT_LEVELS, placeholder: '（請選擇衝擊度）' }
  ];

  // 下拉選單；若既有值不在清單內（舊資料 / 自訂），仍保留為一個選項不遺失。
  function buildSelect(value, options, placeholder, cls, ro) {
    const sel = el('select', cls);
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = placeholder || '（請選擇）';
    sel.appendChild(ph);
    let found = false;
    options.forEach(function (v) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === value) { o.selected = true; found = true; }
      sel.appendChild(o);
    });
    if (value && !found) {
      const o = document.createElement('option');
      o.value = value; o.textContent = value; o.selected = true;
      sel.appendChild(o);
    }
    if (ro) sel.disabled = true;
    return sel;
  }

  function buildInfoCard(sec) {
    infoEl.innerHTML = '';
    infoInputs = {};
    const ro = cur && cur.perm === 'read';
    const card = el('div', 'sec-info-card');
    card.appendChild(el('div', 'sec-info-head', (global.Icons ? Icons.svg('shield') : '') + ' 報告資訊'));
    const grid = el('div', 'sec-info-grid');
    INFO_FIELDS.forEach(function (f) {
      const cell = el('div', 'sec-info-cell');
      cell.appendChild(el('label', 'sec-mini-label', f.label));
      let inp;
      if (f.options) {
        inp = buildSelect(sec[f.key] || '', f.options, f.placeholder, 'sec-info-input', ro);
        inp.addEventListener('change', scheduleSave);
      } else {
        inp = el('input', 'sec-info-input');
        inp.type = 'text'; inp.placeholder = f.ph; inp.value = sec[f.key] || '';
        inp.readOnly = ro;
        inp.addEventListener('input', scheduleSave);
      }
      infoInputs[f.key] = inp;
      cell.appendChild(inp);
      grid.appendChild(cell);
    });
    card.appendChild(grid);
    infoEl.appendChild(card);
  }

  function collectInfo() {
    const g = function (k) { return infoInputs[k] ? infoInputs[k].value.trim() : ''; };
    return { unit: g('unit'), domain: g('domain'), ip: g('ip'), vulnType: g('vulnType'), impact: g('impact') };
  }

  // ---------------- 收集 / 儲存 ----------------
  function collectSteps() {
    return Array.prototype.map.call(stepsEl.querySelectorAll('.sec-card'), function (card) {
      const ta = card.querySelector('.sec-card-text');
      return { text: ta ? ta.value : '', imgId: card.dataset.imgId || null, tpl: card.dataset.tpl || '' };
    });
  }

  function scheduleSave() {
    if (!cur || cur.perm === 'read') return;
    statusSave.textContent = '編輯中…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }

  function saveNow() {
    if (!cur || cur.perm === 'read') return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const steps = collectSteps();
    const info = collectInfo();
    const meta = {
      title: (titleEl.value || '').trim() || '報告',
      date: dateEl.value || today(),
      unit: info.unit, domain: info.domain, ip: info.ip,
      vulnType: info.vulnType, impact: info.impact
    };
    cur.title = meta.title;
    cur.meta = Object.assign({}, cur.meta, {
      secReport: Object.assign({ version: 1 }, meta, { steps: steps })
    });
    // 產生對應 markdown，讓搜尋 / 預覽 / PDF 都可用
    const gen = (global.SecReport && global.SecReport.generate)
      ? global.SecReport.generate(meta, steps) : { content: '' };
    cur.content = gen.content;
    global.Store.updateNote(cur).then(function () {
      statusSave.textContent = '已儲存 ✓';
      if (onSavedCb) onSavedCb(cur);
    }).catch(function (e) {
      statusSave.textContent = '⚠ 未儲存：' + (e && e.message || e);
    });
  }

  // ---------------- PDF 輸出 ----------------
  function exportPDF() {
    if (!cur || !global.PDF || !global.MD) return;
    saveNow();
    const preview = $('#preview');
    preview.innerHTML = global.MD.render(cur.content || '');
    global.MD.resolveImages(preview);
    statusSave.textContent = '準備列印預覽…';
    setTimeout(function () {
      global.PDF.showPreview(cur, preview, {
        meta: cur.meta,
        onMeta: function (m) {
          cur.meta = Object.assign({}, cur.meta, m);
          global.Store.updateNote(cur);
        }
      }).then(function () { statusSave.textContent = ''; })
        .catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); statusSave.textContent = ''; });
    }, 250);
  }

  // ---------------- 一次性事件綁定 ----------------
  function init() {
    if (inited) return;
    grab();
    inited = true;
    $('#sec-add-step').addEventListener('click', function () {
      const card = addStep({ text: '', imgId: null });
      const ta = card.querySelector('.sec-card-text');
      if (ta) ta.focus();
      scheduleSave();
    });
    titleEl.addEventListener('input', scheduleSave);
    dateEl.addEventListener('change', scheduleSave);
    $('#sec-export-pdf').addEventListener('click', exportPDF);
  }

  // ---------------- 對外 API ----------------
  // 開啟某篇資安院筆記進行編輯
  function open(note, opts) {
    init();
    cur = note;
    onSavedCb = (opts && opts.onSaved) || null;
    const sec = (note.meta && note.meta.secReport) || blankReport();

    const ro = note.perm === 'read';
    titleEl.value = sec.title || '報告';
    titleEl.readOnly = ro;
    dateEl.value = sec.date || today();
    dateEl.disabled = ro;
    $('#sec-add-step').hidden = ro;
    wrap.classList.toggle('read-only', ro);

    buildInfoCard(sec);

    stepsEl.innerHTML = '';
    const steps = (sec.steps && sec.steps.length) ? sec.steps : [{ text: '', imgId: null }];
    steps.forEach(function (s) { addStep(s); });
    statusSave.textContent = ro ? '🔒 唯讀' : '';
  }

  function show() { if (wrap) wrap.hidden = false; }
  function hide() { if (wrap) { wrap.hidden = true; } }

  // ---------------- 建立新報告的 modal ----------------
  // 先詢問 單位 / Domain / IP / 弱點類型，確認後才建立報告。
  // onConfirm({ unit, domain, ip, vulnType })；取消則不呼叫。
  function showNewDialog(onConfirm) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal sec-new-modal');
    modal.appendChild(el('div', 'modal-title', (global.Icons ? Icons.svg('shield') : '') + ' 建立資安院報告'));
    modal.appendChild(el('div', 'sec-new-hint', '先填寫報告的基本資訊，之後仍可在編輯畫面修改。'));

    const inputs = {};
    INFO_FIELDS.forEach(function (f) {
      const fieldWrap = el('div', 'oscp-field');
      fieldWrap.appendChild(el('label', null, f.label));
      let inp;
      if (f.options) {
        inp = buildSelect('', f.options, f.placeholder, 'oscp-select', false);
      } else {
        inp = el('input');
        inp.type = 'text'; inp.placeholder = f.ph;
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
      inputs[f.key] = inp;
      fieldWrap.appendChild(inp);
      modal.appendChild(fieldWrap);
    });

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn modal-cancel', '取消'); cancel.type = 'button';
    const ok = el('button', 'btn btn-primary', '建立報告'); ok.type = 'button';
    actions.appendChild(cancel); actions.appendChild(ok);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function submit() {
      const info = {
        unit: inputs.unit.value.trim(),
        domain: inputs.domain.value.trim(),
        ip: inputs.ip.value.trim(),
        vulnType: inputs.vulnType.value.trim(),
        impact: inputs.impact.value.trim()
      };
      close();
      if (onConfirm) onConfirm(info);
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);
    ok.addEventListener('click', submit);
    setTimeout(function () { inputs.unit.focus(); }, 30);
  }

  global.SecEditor = {
    open: open, show: show, hide: hide, blankReport: blankReport,
    showNewDialog: showNewDialog, titleFrom: titleFrom,
    isSecNote: function (note) { return !!(note && note.meta && note.meta.secReport); }
  };
})(window);
