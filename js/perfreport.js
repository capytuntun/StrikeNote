/* perfreport.js — 成效報告模式
 *
 * 與前兩種模式的編輯方式刻意不同：這是一個「表格式」編輯器。
 * 你逐列輸入弱點（名稱 / 風險等級 / 修復狀態），上方會 **即時** 統計
 * 各風險等級的數量與整體「修復率」，右側整面取代 md 編輯器。
 *
 * 儲存：結構化資料存 note.meta.perfReport，同時轉成 markdown 存 note.content
 *（含成效統計表、弱點清單表、總結），讓搜尋 / 預覽 / PDF 都可用。
 */
(function (global) {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };

  const SEVERITY = ['嚴重', '高', '中', '低', '資訊'];
  const STATUS = ['已修復', '處理中', '未修復', '風險接受'];
  // 風險等級對應的樣式 class（顏色）
  const SEV_CLASS = { '嚴重': 'crit', '高': 'high', '中': 'med', '低': 'low', '資訊': 'info' };
  // 修復狀態對應的樣式 class（顏色）—— 獨立於風險等級，不能共用同一組 class
  const STATUS_CLASS = { '已修復': 'fixed', '處理中': 'progress', '未修復': 'open', '風險接受': 'accepted' };

  // 模組狀態
  let cur = null, onSavedCb = null, saveTimer = null, inited = false;
  let wrap, titleEl, dateEl, infoEl, statsEl, tableWrapEl, summaryWrapEl, statusSave;
  let infoInputs = {};
  let summaryEl = null;

  function grab() {
    wrap = $('#perf-wrap');
    titleEl = $('#perf-title');
    dateEl = $('#perf-date');
    infoEl = $('#perf-info');
    statsEl = $('#perf-stats');
    tableWrapEl = $('#perf-table-wrap');
    summaryWrapEl = $('#perf-summary-wrap');
    statusSave = $('#perf-status-save');
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

  function blankReport() {
    return {
      version: 1, title: '成效報告', date: today(),
      unit: '', periodStart: '', periodEnd: '', scope: '', summary: '',
      findings: [{ name: '', severity: '', status: '' }]
    };
  }
  function titleFrom(info) {
    return (info.unit && info.unit.trim()) ? (info.unit.trim() + ' 成效報告') : '成效報告';
  }

  // ---------------- 統計 ----------------
  function computeStats(findings) {
    const counts = {};
    SEVERITY.forEach(function (s) { counts[s] = 0; });
    let total = 0, fixed = 0;
    findings.forEach(function (f) {
      if (!(f.name && f.name.trim()) && !f.severity) return; // 空列不計
      total += 1;
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
      if (f.status === '已修復') fixed += 1;
    });
    return { counts: counts, total: total, fixed: fixed, fixRate: total ? Math.round(fixed / total * 100) : 0 };
  }

  // ---------------- 報告產生（markdown）----------------
  function generate(meta) {
    const findings = meta.findings || [];
    const st = computeStats(findings);
    const L = [];
    L.push('# ' + (meta.title || '成效報告'));
    L.push('');
    if (meta.unit) L.push('**受測單位：** ' + meta.unit + '  ');
    if (meta.periodStart || meta.periodEnd) {
      L.push('**測試期間：** ' + (meta.periodStart || '?') + ' ～ ' + (meta.periodEnd || '?') + '  ');
    }
    if (meta.scope) L.push('**測試範圍：** ' + meta.scope + '  ');
    L.push('**日期：** ' + (meta.date || today()) + '  ');
    L.push('');
    L.push('---');
    L.push('');

    // 成效統計
    L.push('## 成效統計');
    L.push('');
    L.push('| 風險等級 | ' + SEVERITY.join(' | ') + ' | 合計 |');
    L.push('| --- |' + SEVERITY.map(function () { return ' :---: |'; }).join('') + ' :---: |');
    L.push('| 弱點數量 | ' + SEVERITY.map(function (s) { return st.counts[s]; }).join(' | ') + ' | ' + st.total + ' |');
    L.push('');
    L.push('**弱點總數：** ' + st.total + '  ');
    L.push('**已修復：** ' + st.fixed + ' / ' + st.total + '（修復率 ' + st.fixRate + '%）  ');
    L.push('');

    // 弱點清單
    L.push('## 弱點清單');
    L.push('');
    L.push('| # | 弱點名稱 | 風險等級 | 修復狀態 |');
    L.push('| :---: | --- | :---: | :---: |');
    let n = 0;
    findings.forEach(function (f) {
      if (!(f.name && f.name.trim()) && !f.severity && !f.status) return;
      n += 1;
      // 風險等級／修復狀態在編輯畫面靠顏色分辨；純文字的匯出（PDF／電子書）沒有顏色，
      // 用粗體至少保留視覺上的重量差異，而不是讓它們跟弱點名稱一樣輕
      L.push('| ' + n + ' | ' + (f.name || '') + ' | **' + (f.severity || '') + '** | **' + (f.status || '') + '** |');
    });
    if (n === 0) L.push('| — | *(尚未新增弱點)* |  |  |');
    L.push('');

    // 總結
    if (meta.summary && meta.summary.trim()) {
      L.push('## 總結');
      L.push('');
      L.push(meta.summary.replace(/([^\n])\n(?!\n)/g, '$1  \n'));
      L.push('');
    }

    return { title: meta.title || '成效報告', content: L.join('\n') };
  }

  // ---------------- 報告資訊卡片 ----------------
  function buildInfoCard(rep) {
    infoEl.innerHTML = '';
    infoInputs = {};
    const ro = cur && cur.perm === 'read';
    const card = el('div', 'sec-info-card');
    card.appendChild(el('div', 'sec-info-head', (global.Icons ? Icons.svg('chart') : '') + ' 報告資訊'));
    const grid = el('div', 'sec-info-grid');

    const fields = [
      { key: 'unit',        label: '受測單位', type: 'text', ph: '例如：某某股份有限公司' },
      { key: 'scope',       label: '測試範圍', type: 'text', ph: '例如：對外網站 / 內部系統' },
      { key: 'periodStart', label: '測試期間（起）', type: 'date' },
      { key: 'periodEnd',   label: '測試期間（迄）', type: 'date' }
    ];
    fields.forEach(function (f) {
      const cell = el('div', 'sec-info-cell');
      cell.appendChild(el('label', 'sec-mini-label', f.label));
      const inp = el('input', 'sec-info-input');
      inp.type = f.type;
      if (f.ph) inp.placeholder = f.ph;
      inp.value = rep[f.key] || '';
      if (ro) { inp.readOnly = true; inp.disabled = f.type === 'date'; }
      inp.addEventListener('input', scheduleSave);
      inp.addEventListener('change', scheduleSave);
      infoInputs[f.key] = inp;
      cell.appendChild(inp);
      grid.appendChild(cell);
    });
    card.appendChild(grid);
    infoEl.appendChild(card);
  }
  function collectInfo() {
    const g = function (k) { return infoInputs[k] ? infoInputs[k].value.trim() : ''; };
    return { unit: g('unit'), scope: g('scope'), periodStart: g('periodStart'), periodEnd: g('periodEnd') };
  }

  // ---------------- 即時統計面板 ----------------
  function renderStats() {
    const st = computeStats(collectFindings());
    statsEl.innerHTML = '';
    const head = el('div', 'perf-stats-head', (global.Icons ? Icons.svg('trending-up') : '') + ' 即時成效統計');
    statsEl.appendChild(head);

    const chips = el('div', 'perf-chips');
    SEVERITY.forEach(function (s) {
      const chip = el('div', 'perf-chip perf-sev-' + SEV_CLASS[s]);
      chip.appendChild(el('span', 'perf-chip-n', String(st.counts[s])));
      chip.appendChild(el('span', 'perf-chip-l', s));
      chips.appendChild(chip);
    });
    const totalChip = el('div', 'perf-chip perf-chip-total');
    totalChip.appendChild(el('span', 'perf-chip-n', String(st.total)));
    totalChip.appendChild(el('span', 'perf-chip-l', '弱點總數'));
    chips.appendChild(totalChip);
    statsEl.appendChild(chips);

    // 修復率進度條
    const fixWrap = el('div', 'perf-fix');
    fixWrap.appendChild(el('div', 'perf-fix-label',
      '修復率　' + st.fixed + ' / ' + st.total + '　<strong>' + st.fixRate + '%</strong>'));
    const bar = el('div', 'perf-fix-bar');
    const fill = el('div', 'perf-fix-fill');
    fill.style.width = st.fixRate + '%';
    bar.appendChild(fill);
    fixWrap.appendChild(bar);
    statsEl.appendChild(fixWrap);
  }

  // ---------------- 弱點列表（表格）----------------
  function buildSelect(value, options, placeholder, ro, extraCls) {
    const sel = el('select', extraCls ? 'perf-cell-select ' + extraCls : 'perf-cell-select');
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = placeholder;
    sel.appendChild(ph);
    let found = false;
    options.forEach(function (v) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === value) { o.selected = true; found = true; }
      sel.appendChild(o);
    });
    if (value && !found) {
      const o = document.createElement('option'); o.value = value; o.textContent = value; o.selected = true;
      sel.appendChild(o);
    }
    sel.disabled = ro;
    return sel;
  }

  let tbody = null;
  function renumberRows() {
    const cells = tbody.querySelectorAll('.perf-row-no');
    Array.prototype.forEach.call(cells, function (c, i) { c.textContent = (i + 1); });
  }

  function buildRow(f) {
    const ro = cur && cur.perm === 'read';
    const tr = el('tr', 'perf-row');

    const tdNo = el('td', 'perf-row-no', '1');
    tr.appendChild(tdNo);

    const tdName = document.createElement('td');
    const name = el('input', 'perf-cell-input');
    name.type = 'text'; name.placeholder = '弱點名稱'; name.value = f.name || ''; name.readOnly = ro;
    name.addEventListener('input', function () { renderStats(); scheduleSave(); });
    tdName.appendChild(name);
    tr.appendChild(tdName);

    const tdSev = document.createElement('td');
    const sev = buildSelect(f.severity || '', SEVERITY, '風險等級', ro, 'perf-sev-select');
    sev.addEventListener('change', function () {
      tr.dataset.sev = SEV_CLASS[sev.value] || '';
      renderStats(); scheduleSave();
    });
    tr.dataset.sev = SEV_CLASS[f.severity || ''] || '';
    tdSev.appendChild(sev);
    tr.appendChild(tdSev);

    const tdStatus = document.createElement('td');
    const status = buildSelect(f.status || '', STATUS, '修復狀態', ro, 'perf-status-select');
    status.addEventListener('change', function () {
      tr.dataset.status = STATUS_CLASS[status.value] || '';
      renderStats(); scheduleSave();
    });
    tr.dataset.status = STATUS_CLASS[f.status || ''] || '';
    tdStatus.appendChild(status);
    tr.appendChild(tdStatus);

    const tdDel = document.createElement('td');
    if (!ro) {
      const del = el('button', 'sec-card-del', global.Icons ? Icons.svg('x') : '✕');
      del.type = 'button'; del.title = '刪除這列';
      del.addEventListener('click', function () { tr.remove(); renumberRows(); renderStats(); scheduleSave(); });
      tdDel.appendChild(del);
    }
    tr.appendChild(tdDel);

    return tr;
  }

  function buildTable(findings) {
    tableWrapEl.innerHTML = '';
    const table = el('table', 'perf-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>#</th><th>弱點名稱</th><th>風險等級</th><th>修復狀態</th><th></th></tr>';
    table.appendChild(thead);
    tbody = el('tbody');
    table.appendChild(tbody);
    tableWrapEl.appendChild(table);
    (findings.length ? findings : [{ name: '', severity: '', status: '' }]).forEach(function (f) {
      tbody.appendChild(buildRow(f));
    });
    renumberRows();
  }
  function addRow(f) {
    const tr = buildRow(f || { name: '', severity: '', status: '' });
    tbody.appendChild(tr);
    renumberRows();
    return tr;
  }
  function collectFindings() {
    if (!tbody) return [];
    return Array.prototype.map.call(tbody.querySelectorAll('.perf-row'), function (tr) {
      const name = tr.querySelector('.perf-cell-input');
      const sels = tr.querySelectorAll('.perf-cell-select');
      return { name: name ? name.value : '', severity: sels[0] ? sels[0].value : '', status: sels[1] ? sels[1].value : '' };
    });
  }

  // ---------------- 總結 ----------------
  function buildSummary(rep) {
    summaryWrapEl.innerHTML = '';
    const ro = cur && cur.perm === 'read';
    summaryWrapEl.appendChild(el('div', 'sec-mini-label perf-summary-label', '總結說明'));
    summaryEl = el('textarea', 'sec-card-text perf-summary');
    summaryEl.placeholder = '整體成效總結、後續建議…';
    summaryEl.rows = 4;
    summaryEl.value = rep.summary || '';
    summaryEl.readOnly = ro;
    summaryEl.addEventListener('input', scheduleSave);
    summaryWrapEl.appendChild(summaryEl);
  }

  // ---------------- 儲存 ----------------
  function scheduleSave() {
    if (!cur || cur.perm === 'read') return;
    statusSave.textContent = '編輯中…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }
  function saveNow() {
    if (!cur || cur.perm === 'read') return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const info = collectInfo();
    const findings = collectFindings();
    const meta = {
      title: (titleEl.value || '').trim() || '成效報告',
      date: dateEl.value || today(),
      unit: info.unit, scope: info.scope, periodStart: info.periodStart, periodEnd: info.periodEnd,
      summary: summaryEl ? summaryEl.value : '',
      findings: findings
    };
    cur.title = meta.title;
    cur.meta = Object.assign({}, cur.meta, { perfReport: Object.assign({ version: 1 }, meta) });
    cur.content = generate(meta).content;
    global.Store.updateNote(cur).then(function () {
      statusSave.textContent = '已儲存 ✓';
      if (onSavedCb) onSavedCb(cur);
    }).catch(function (e) { statusSave.textContent = '⚠ 未儲存：' + (e && e.message || e); });
  }

  // ---------------- PDF ----------------
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
        onMeta: function (m) { cur.meta = Object.assign({}, cur.meta, m); global.Store.updateNote(cur); }
      }).then(function () { statusSave.textContent = ''; })
        .catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); statusSave.textContent = ''; });
    }, 250);
  }

  // ---------------- 綁定 / 開啟 ----------------
  function init() {
    if (inited) return;
    grab();
    inited = true;
    $('#perf-add-row').addEventListener('click', function () {
      const tr = addRow();
      const inp = tr.querySelector('.perf-cell-input');
      if (inp) inp.focus();
      renderStats(); scheduleSave();
    });
    titleEl.addEventListener('input', scheduleSave);
    dateEl.addEventListener('change', scheduleSave);
    $('#perf-export-pdf').addEventListener('click', exportPDF);
  }

  function open(note, opts) {
    init();
    cur = note;
    onSavedCb = (opts && opts.onSaved) || null;
    const rep = (note.meta && note.meta.perfReport) || blankReport();
    const ro = note.perm === 'read';

    titleEl.value = rep.title || '成效報告';
    titleEl.readOnly = ro;
    dateEl.value = rep.date || today();
    dateEl.disabled = ro;
    $('#perf-add-row').hidden = ro;
    wrap.classList.toggle('read-only', ro);

    buildInfoCard(rep);
    buildTable(rep.findings || []);
    renderStats();
    buildSummary(rep);
    statusSave.textContent = ro ? '🔒 唯讀' : '';
  }

  function show() { if (wrap) wrap.hidden = false; }
  function hide() { if (wrap) wrap.hidden = true; }

  // ---------------- 建立新報告的 modal ----------------
  function showNewDialog(onConfirm) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal sec-new-modal');
    modal.appendChild(el('div', 'modal-title', (global.Icons ? Icons.svg('chart') : '') + ' 建立成效報告'));
    modal.appendChild(el('div', 'sec-new-hint', '先填基本資訊，弱點清單與統計在編輯畫面逐列輸入。'));

    const spec = [
      { key: 'unit',        label: '受測單位', type: 'text', ph: '例如：某某股份有限公司' },
      { key: 'scope',       label: '測試範圍', type: 'text', ph: '例如：對外網站' },
      { key: 'periodStart', label: '測試期間（起）', type: 'date' },
      { key: 'periodEnd',   label: '測試期間（迄）', type: 'date' }
    ];
    const inputs = {};
    spec.forEach(function (f) {
      const fw = el('div', 'oscp-field');
      fw.appendChild(el('label', null, f.label));
      const inp = el('input'); inp.type = f.type; if (f.ph) inp.placeholder = f.ph;
      if (f.type === 'text') inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      inputs[f.key] = inp;
      fw.appendChild(inp);
      modal.appendChild(fw);
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
        unit: inputs.unit.value.trim(), scope: inputs.scope.value.trim(),
        periodStart: inputs.periodStart.value, periodEnd: inputs.periodEnd.value
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

  global.PerfReport = {
    open: open, show: show, hide: hide, blankReport: blankReport,
    generate: generate, showNewDialog: showNewDialog, titleFrom: titleFrom,
    isPerfNote: function (note) { return !!(note && note.meta && note.meta.perfReport); }
  };
})(window);
