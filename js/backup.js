/* backup.js — 備份與還原：一個 zip 下載全部資料，上傳同一個 zip 還原。
 *
 *   Backup.open({ isAdmin })
 *
 * 備份是 GET /api/backup?scope=mine|site，用隱藏的 iframe 觸發下載：伺服器串流回傳，
 * 幾百 MB 的 zip 也不會先塞進瀏覽器記憶體；用 iframe 而不是換頁，是萬一伺服器回錯誤
 * 頁不會把整個 app 帶走。
 *
 * 還原分三段：把檔案切成小塊 PUT 上去（Cloudflare 單一請求的上限是 100 MB，而且斷線
 * 可以只重送那一塊）→ inspect 看清楚是哪一份備份、有幾篇筆記 → 使用者按下還原，
 * 伺服器在背景做、這裡輪詢進度，做完顯示報告並重新載入筆記清單。
 */
(function (global) {
  'use strict';

  const CHUNK = 4 * 1024 * 1024;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function elh(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 下載：隱藏 iframe。伺服器送 Content-Disposition: attachment，瀏覽器直接存檔。
  function download(scope) {
    const f = document.createElement('iframe');
    f.hidden = true;
    f.src = Store.backupUrl(scope);
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 120000);
  }

  function open(opts) {
    const o = opts || {};
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal backup-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML =
      '<div class="modal-title">' + ic('save') + ' 備份與還原</div>' +
      '<div class="admin-hint">備份是一個 zip：每篇筆記一個 .md 檔、照資料夾放好，加上上傳過的圖片與檔案、版本歷史、分享設定、電子書與垃圾桶裡的筆記。' +
      '要還原時上傳同一個 zip：缺的會補回來，已經有的預設不動。</div>' +
      '<div class="admin-error bk-error" hidden></div>' +
      '<section class="bk-sec">' +
        '<div class="bk-sec-head">' + ic('download') + '<span>備份</span></div>' +
        (o.isAdmin
          ? '<div class="bk-row"><div class="imglib-seg bk-scope" role="radiogroup" aria-label="備份範圍">' +
              '<button type="button" role="radio" data-scope="mine" class="active" aria-checked="true">我的資料</button>' +
              '<button type="button" role="radio" data-scope="site" aria-checked="false">整個站台</button></div>' +
              '<span class="bk-scope-desc">只有你自己的筆記、檔案與電子書。</span></div>'
          : '') +
        '<div class="bk-row"><button type="button" class="btn btn-primary bk-download">' + ic('download') + '下載備份 zip</button>' +
        '<span class="bk-note">下載會在背景進行，筆記很多時要等一下才會開始。</span></div>' +
      '</section>' +
      '<section class="bk-sec">' +
        '<div class="bk-sec-head">' + ic('upload') + '<span>還原</span></div>' +
        '<div class="bk-row bk-pick">' +
          '<input type="file" class="bk-file" accept=".zip,application/zip" hidden>' +
          '<button type="button" class="btn bk-choose">' + ic('upload') + '選擇備份 zip…</button>' +
          '<span class="bk-note">選好之後會先顯示這份備份的內容，再由你決定是否還原。</span>' +
        '</div>' +
        '<div class="bk-progress" hidden><div class="bk-progress-label"></div><div class="storage-bar"><div class="storage-bar-fill"></div></div></div>' +
        '<div class="bk-summary" hidden></div>' +
        '<div class="bk-report" hidden></div>' +
      '</section>' +
      '<div class="modal-actions"><span class="admin-count"></span><button class="btn modal-cancel" type="button">關閉</button></div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const errEl = modal.querySelector('.bk-error');
    const err = m => { errEl.textContent = m || ''; errEl.hidden = !m; };
    const progress = modal.querySelector('.bk-progress');
    const progressLabel = modal.querySelector('.bk-progress-label');
    const progressFill = modal.querySelector('.storage-bar-fill');
    const summary = modal.querySelector('.bk-summary');
    const reportEl = modal.querySelector('.bk-report');
    const fileInput = modal.querySelector('.bk-file');
    const chooseBtn = modal.querySelector('.bk-choose');
    let busy = false;      // 上傳或還原進行中：關不掉
    let uploadId = null;

    function setProgress(label, frac) {
      progress.hidden = false;
      progressLabel.textContent = label;
      progressFill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    }

    // ---- 備份 ----
    let scope = 'mine';
    const seg = modal.querySelector('.bk-scope');
    if (seg) {
      const desc = modal.querySelector('.bk-scope-desc');
      seg.addEventListener('click', function (e) {
        const b = e.target.closest('button[data-scope]');
        if (!b) return;
        scope = b.getAttribute('data-scope');
        seg.querySelectorAll('button').forEach(function (x) {
          const on = x === b;
          x.classList.toggle('active', on);
          x.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        desc.textContent = scope === 'site'
          ? '所有使用者的全部資料，含帳號與密碼雜湊、註冊設定。可以在一台全新的機器上把整個站台還原回來，請妥善保管這個檔案。'
          : '只有你自己的筆記、檔案與電子書。';
      });
    }
    modal.querySelector('.bk-download').addEventListener('click', function () {
      err('');
      download(scope);
      App.toast('開始下載備份…');
    });

    // ---- 還原 ----
    chooseBtn.addEventListener('click', function () { if (!busy) fileInput.click(); });
    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) uploadAndInspect(f);
    });

    async function putChunk(id, offset, blob) {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await Store.backupAppend(id, offset, blob); }
        catch (e) {
          lastErr = e;
          // 斷線後不知道那一塊有沒有送到：問伺服器收到多少，從那裡接著送
          const st = await Store.backupUploadStatus(id).catch(function () { return null; });
          if (st && st.size === offset + blob.size) return st;
          if (st && st.size !== offset) throw new Error('上傳中斷，請重新選擇檔案');
          await sleep(800 * (attempt + 1));
        }
      }
      throw lastErr || new Error('上傳失敗');
    }

    async function uploadAndInspect(file) {
      err('');
      summary.hidden = true;
      reportEl.hidden = true;
      busy = true;
      chooseBtn.disabled = true;
      try {
        if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') throw new Error('請選擇 .zip 備份檔');
        const created = await Store.backupCreateUpload();
        if (file.size > created.totalMax) throw new Error('備份檔超過上限 ' + fmtBytes(created.totalMax));
        uploadId = created.id;
        const chunk = Math.min(CHUNK, Math.max(256 * 1024, Math.floor(created.chunkMax * 0.8)));
        for (let offset = 0; offset < file.size; offset += chunk) {
          setProgress('上傳中 ' + fmtBytes(offset) + ' / ' + fmtBytes(file.size), offset / file.size);
          await putChunk(uploadId, offset, file.slice(offset, Math.min(file.size, offset + chunk)));
        }
        if (file.size === 0) throw new Error('這是一個空檔案');
        setProgress('檢查備份內容…', 1);
        const info = await Store.backupInspect(uploadId);
        progress.hidden = true;
        showSummary(info, file);
      } catch (e) {
        progress.hidden = true;
        err(e && e.message || String(e));
        if (uploadId) { Store.backupDrop(uploadId).catch(function () {}); uploadId = null; }
      } finally {
        busy = false;
        chooseBtn.disabled = false;
      }
    }

    function showSummary(info, file) {
      const c = info.counts || {};
      const site = info.scope === 'site';
      summary.innerHTML =
        '<div class="bk-summary-head">' + ic('info') + '<b>' + esc(file.name) + '</b><span>' + fmtBytes(info.bytes) + '</span></div>' +
        '<dl class="bk-props">' +
          '<dt>範圍</dt><dd>' + (site ? '整個站台（含使用者帳號）' : '單一帳號的資料') + '</dd>' +
          '<dt>建立時間</dt><dd>' + esc(fmtDate(info.exportedAt)) + '</dd>' +
          '<dt>建立者</dt><dd>' + esc(info.exportedBy || '—') + '</dd>' +
          '<dt>內容</dt><dd>' + esc([
            (c.notes != null ? c.notes + ' 篇筆記' : null), (c.folders != null ? c.folders + ' 個資料夾' : null),
            (c.files != null ? c.files + ' 個檔案' : null), (c.bookLinks ? c.bookLinks + ' 個分享連結' : null),
            (site && c.users != null ? c.users + ' 個使用者' : null)
          ].filter(Boolean).join('、')) + '</dd>' +
        '</dl>' +
        (info.canRestore
          ? '<label class="bk-opt"><input type="checkbox" class="bk-overwrite"> 已經存在的筆記、資料夾、檔案也用備份裡的內容覆蓋' +
            '<span class="bk-opt-sub">覆蓋前會先把目前的內容存成一個版本（還原備份前），可以從版本紀錄找回。不勾的話只補回缺少的東西。</span></label>' +
            (site ? '<div class="bk-warn">' + ic('alert-triangle') + '<span>站台備份會建立缺少的使用者帳號（用備份裡的密碼）；已經存在的帳號、包括你自己，密碼都不會變。</span></div>' : '') +
            '<div class="bk-row"><button type="button" class="btn btn-primary bk-restore">' + ic('rotate-ccw') + '開始還原</button>' +
            '<button type="button" class="btn bk-cancel-up">取消</button></div>'
          : '<div class="bk-warn">' + ic('alert-triangle') + '<span>' + esc(info.reason || '這份備份不能在這裡還原') + '</span></div>' +
            '<div class="bk-row"><button type="button" class="btn bk-cancel-up">取消</button></div>');
      summary.hidden = false;
      const cancel = summary.querySelector('.bk-cancel-up');
      if (cancel) cancel.addEventListener('click', function () {
        if (uploadId) Store.backupDrop(uploadId).catch(function () {});
        uploadId = null;
        summary.hidden = true;
      });
      const go = summary.querySelector('.bk-restore');
      if (go) go.addEventListener('click', function () {
        const overwrite = summary.querySelector('.bk-overwrite').checked;
        App.confirm({
          title: '還原備份',
          message: (overwrite
            ? '會把備份裡的資料補回來，而且已經存在的筆記會被備份裡的內容覆蓋（覆蓋前會先留一份版本）。'
            : '會把備份裡缺少的資料補回來，已經存在的不會動。') + '\n確定要開始還原嗎？',
          ok: '開始還原', danger: overwrite
        }).then(function (yes) { if (yes) runRestore({ overwrite: overwrite }); });
      });
    }

    async function runRestore(o) {
      err('');
      busy = true;
      chooseBtn.disabled = true;
      summary.hidden = true;
      try {
        const started = await Store.backupRestore(uploadId, o);
        uploadId = null;
        setProgress('還原中…', 0);
        let job;
        for (;;) {
          job = await Store.backupJob(started.job);
          if (job.finished) break;
          setProgress('還原中：' + job.phase + (job.total ? '（' + job.done + ' / ' + job.total + '）' : ''),
            job.total ? job.done / job.total : 0);
          await sleep(700);
        }
        progress.hidden = true;
        if (job.error) throw new Error(job.error);
        showReport(job.report);
        App.toast('還原完成');
        if (global.App && App.reload) App.reload();
      } catch (e) {
        progress.hidden = true;
        err('還原失敗：' + (e && e.message || String(e)));
      } finally {
        busy = false;
        chooseBtn.disabled = false;
      }
    }

    function showReport(r) {
      if (!r) return;
      const rows = [];
      const line = (label, parts) => {
        const bits = parts.filter(p => p[1]).map(p => p[1] + ' ' + p[0]);
        rows.push('<dt>' + esc(label) + '</dt><dd>' + (bits.length ? esc(bits.join('、')) : '—') + '</dd>');
      };
      if (r.scope === 'site') line('使用者', [['個新建', r.users.created], ['個原本就有', r.users.kept], ['個略過', r.users.skipped]]);
      line('資料夾', [['個新建', r.folders.created], ['個更新', r.folders.updated], ['個已存在', r.folders.skipped], ['個 id 衝突', r.folders.conflicts]]);
      line('筆記', [['篇新建', r.notes.created], ['篇覆蓋', r.notes.overwritten], ['篇已存在', r.notes.skipped], ['篇 id 衝突', r.notes.conflicts]]);
      if (r.notes.trashed) line('其中在垃圾桶', [['篇', r.notes.trashed]]);
      line('版本歷史', [['個', r.versions.created]]);
      line('檔案', [['個新建', r.files.created], ['個更新', r.files.updated], ['個已存在', r.files.skipped], ['個 id 衝突', r.files.conflicts]]);
      line('分享', [['筆', r.shares.created]]);
      line('電子書', [['個版本', r.books.versions], ['個分享連結', r.books.links], ['個略過', r.books.skipped]]);
      let html = '<div class="bk-report-head">' + ic('check') + '<span>還原完成</span></div><dl class="bk-props">' + rows.join('') + '</dl>';
      if (r.settings) html += '<div class="bk-note">註冊方式與邀請碼也已套用備份裡的設定。</div>';
      if (r.shares.missingUsers.length) {
        html += '<div class="bk-note">這些被分享的使用者不在這個站台，分享沒有還原：' + esc(r.shares.missingUsers.join('、')) + '</div>';
      }
      if (r.warnings.length) {
        html += '<details class="bk-warnings"><summary>' + r.warnings.length + ' 個提醒</summary><ul>' +
          r.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></details>';
      }
      reportEl.innerHTML = html;
      reportEl.hidden = false;
    }

    function close() {
      if (busy) { App.toast('上傳或還原還在進行中'); return; }
      if (uploadId) Store.backupDrop(uploadId).catch(function () {});
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      const layers = document.querySelectorAll('.modal-overlay');
      if (layers[layers.length - 1] !== overlay) return;   // 確認框疊在上面時，Esc 是它的
      e.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
  }

  global.Backup = { open: open };
})(window);
