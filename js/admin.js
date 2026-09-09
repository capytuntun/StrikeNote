/* admin.js — account administration (admins only) and the change-password screen.
 *
 * The panel shows accounts and permissions, never note contents: reading a
 * colleague's report still requires them to share it. The server enforces that
 * by simply not having an endpoint that returns anyone else's text.
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------------- change password ----------------
  // `forced` is used for the first login of a generated admin password: the app
  // stays hidden until it is replaced.
  function showChangePassword(opts) {
    const o = opts || {};
    const overlay = el('div', 'modal-overlay pw-overlay');
    const modal = el('div', 'modal pw-modal');
    modal.innerHTML =
      '<div class="modal-title">' + (o.forced ? '請先更改密碼' : '更改密碼') + '</div>' +
      (o.forced
        ? '<div class="pw-warn">這個帳號目前使用系統產生的預設密碼，而它已經被印在伺服器的終端機上。請立刻改成只有你知道的密碼。</div>'
        : '') +
      '<label class="auth-field"><span>目前的密碼</span>' +
      '<input class="pw-current" type="password" autocomplete="current-password"></label>' +
      '<label class="auth-field"><span>新密碼</span>' +
      '<input class="pw-next" type="password" autocomplete="new-password"></label>' +
      '<label class="auth-field"><span>再次輸入新密碼</span>' +
      '<input class="pw-again" type="password" autocomplete="new-password"></label>' +
      '<div class="auth-hint">至少 12 個字元。</div>' +
      '<div class="pw-error" hidden></div>' +
      '<div class="modal-actions">' +
      (o.forced ? '' : '<button class="btn pw-cancel" type="button">取消</button>') +
      '<button class="btn btn-primary pw-save" type="button">更改密碼</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const errEl = modal.querySelector('.pw-error');
    const err = m => { errEl.textContent = m || ''; errEl.hidden = !m; };
    const save = modal.querySelector('.pw-save');

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape' && !o.forced) { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    if (!o.forced) {
      modal.querySelector('.pw-cancel').addEventListener('click', close);
      overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    }

    save.addEventListener('click', function () {
      const cur = modal.querySelector('.pw-current').value;
      const next = modal.querySelector('.pw-next').value;
      const again = modal.querySelector('.pw-again').value;
      if (next !== again) return err('兩次輸入的新密碼不一致');
      if (next.length < 12) return err('新密碼至少需 12 個字元');
      save.disabled = true;
      Store.changePassword(cur, next).then(function () {
        close();
        if (o.onDone) o.onDone();
      }).catch(function (e) {
        save.disabled = false;
        err(e.message);
      });
    });
    setTimeout(() => modal.querySelector('.pw-current').focus(), 30);
  }

  // ---------------- admin panel ----------------
  function showPanel() {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal admin-modal');
    modal.innerHTML =
      '<div class="modal-title">' + (global.Icons ? Icons.svg('users') : '') + ' 帳號管理</div>' +
      '<div class="admin-hint">管理員只看得到帳號與權限，<b>看不到任何人的筆記內容</b>——要讀同事的報告，仍然得請對方分享。</div>' +
      '<div class="admin-error" hidden></div>' +
      '<div class="admin-wrap"><table class="admin-table">' +
      '<thead><tr><th>帳號</th><th>權限</th><th>狀態</th><th class="num">筆記</th>' +
      '<th class="num">分享出</th><th class="num">收到</th><th>最後登入</th><th>動作</th></tr></thead>' +
      '<tbody></tbody></table></div>' +
      '<div class="modal-actions"><span class="admin-count"></span>' +
      '<button class="btn modal-cancel" type="button">關閉</button></div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const tbody = modal.querySelector('tbody');
    const errEl = modal.querySelector('.admin-error');
    const err = m => { errEl.textContent = m || ''; errEl.hidden = !m; };

    function act(label, cls, fn) {
      const b = el('button', 'admin-act ' + (cls || ''), label);
      b.type = 'button';
      b.addEventListener('click', function () {
        b.disabled = true;
        err('');
        fn().then(refresh).catch(function (e) { b.disabled = false; err(e.message); });
      });
      return b;
    }

    function refresh() {
      return Store.adminListUsers().then(function (users) {
        tbody.innerHTML = '';
        users.forEach(function (u) {
          const tr = el('tr', u.disabled ? 'is-disabled' : '');
          const name = el('td');
          name.appendChild(el('span', 'admin-name', u.username));
          if (u.self) name.appendChild(el('span', 'admin-self', '（你）'));
          tr.appendChild(name);

          const role = el('td');
          role.appendChild(el('span', 'role-tag role-' + u.role, u.role === 'admin' ? '管理員' : '一般'));
          tr.appendChild(role);

          const st = el('td');
          st.appendChild(el('span', 'st-tag ' + (u.disabled ? 'st-off' : 'st-on'), u.disabled ? '已停用' : '啟用中'));
          tr.appendChild(st);

          tr.appendChild(el('td', 'num', String(u.notes)));
          tr.appendChild(el('td', 'num', String(u.sharedOut)));
          tr.appendChild(el('td', 'num', String(u.sharedIn)));
          tr.appendChild(el('td', 'admin-date', fmtDate(u.lastLogin)));

          const actions = el('td', 'admin-actions');
          if (!u.self) {
            actions.appendChild(act(u.disabled ? '啟用' : '停用', u.disabled ? '' : 'danger',
              () => Store.adminSetDisabled(u.id, !u.disabled)));
            actions.appendChild(act(u.role === 'admin' ? '取消管理員' : '設為管理員', '',
              () => Store.adminSetRole(u.id, u.role === 'admin' ? 'user' : 'admin')));
            actions.appendChild(act('刪除', 'danger', function () {
              return App.confirm({
                title: '刪除帳號',
                message: '確定刪除「' + u.username + '」？\n他的 ' + u.notes + ' 篇筆記、' +
                  u.folders + ' 個資料夾與 ' + u.images + ' 張圖片都會一併永久刪除。\n此動作無法復原。',
                ok: '刪除', danger: true
              }).then(function (yes) {
                if (!yes) return Promise.reject(new Error(''));
                return Store.adminDeleteUser(u.id);
              });
            }));
          } else {
            actions.appendChild(el('span', 'admin-nil', '—'));
          }
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
        modal.querySelector('.admin-count').textContent =
          '共 ' + users.length + ' 個帳號 · ' +
          users.filter(u => u.role === 'admin').length + ' 位管理員 · ' +
          users.filter(u => u.disabled).length + ' 個已停用';
      }).catch(function (e) {
        if (e.message) err(e.message);
      });
    }

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    refresh();
  }

  // ---------------- storage (admin only) ----------------
  // How much room the data directory has left, what the database is made of,
  // and who is using it — sizes and counts, never content.
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  // el() above sets textContent (safe default for user-supplied strings); this
  // one is for markup we build ourselves.
  function elh(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  let storageTimer = null;
  let storageWarned = false;   // 這次登入只主動跳一次；之後從選單看
  function checkStorage() {
    if (!global.Store || !Store.adminStorage) return;
    Store.adminStorage().then(function (s) {
      if (s && s.low && !storageWarned) { storageWarned = true; showStorageWarning(s); }
      if (s && !s.low) storageWarned = false;
    }).catch(function () { /* not an admin any more, or offline */ });
    if (!storageTimer) storageTimer = setInterval(checkStorage, 30 * 60 * 1000);
  }

  function showStorageWarning(s) {
    let bar = document.getElementById('storage-banner');
    if (bar) bar.remove();
    bar = el('div', 'storage-banner');
    bar.id = 'storage-banner';
    const free = s.disk ? fmtBytes(s.disk.free) : '未知';
    bar.innerHTML = ic('alert-triangle') +
      '<span>磁碟剩餘空間不足：只剩 ' + free +
      '（門檻 ' + fmtBytes(s.thresholds.bytes) + ' 或 ' + s.thresholds.pct + '%）。請清理空間或擴充磁碟。</span>';
    const view = el('button', 'btn', '查看');
    view.type = 'button';
    view.addEventListener('click', function () { bar.remove(); showStorage(); });
    const x = el('button', 'storage-banner-x');
    x.type = 'button'; x.title = '關閉'; x.innerHTML = ic('x');
    x.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(view);
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  function showStorage() {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal storage-modal');
    modal.innerHTML =
      '<div class="modal-title">' + ic('hard-drive') + ' 儲存空間</div>' +
      '<div class="admin-hint">資料庫所在磁碟的剩餘空間，以及每個帳號用掉多少。只有大小與數量，看不到內容。</div>' +
      '<div class="admin-error" hidden></div>' +
      '<div class="storage-body"><div class="dash-empty">讀取中…</div></div>' +
      '<div class="modal-actions"><span class="admin-count"></span>' +
      '<button class="btn modal-cancel" type="button">關閉</button></div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const body = modal.querySelector('.storage-body');
    const errEl = modal.querySelector('.admin-error');
    const countEl = modal.querySelector('.admin-count');

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);

    Store.adminStorage().then(function (s) {
      body.innerHTML = '';
      if (s.disk) {
        const used = Math.max(0, s.disk.total - s.disk.free);
        const pct = s.disk.total ? Math.min(100, used / s.disk.total * 100) : 0;
        const status = el('div', s.low ? 'storage-warn' : 'storage-ok');
        status.innerHTML = ic(s.low ? 'alert-triangle' : 'check') +
          '<span>' + (s.low
            ? '剩餘空間低於門檻（' + fmtBytes(s.thresholds.bytes) + ' 或 ' + s.thresholds.pct + '%），請儘快處理。'
            : '空間充足。門檻：剩餘低於 ' + fmtBytes(s.thresholds.bytes) + ' 或 ' + s.thresholds.pct + '% 時警告。') + '</span>';
        body.appendChild(status);
        const bar = el('div', 'storage-bar');
        bar.appendChild(el('div', 'storage-bar-fill' + (s.low ? ' low' : '')));
        bar.firstChild.style.width = pct.toFixed(1) + '%';
        body.appendChild(bar);
        body.appendChild(elh('div', 'storage-bar-label',
          '<span>已用 ' + fmtBytes(used) + '（' + pct.toFixed(0) + '%）</span>' +
          '<span>剩餘 ' + fmtBytes(s.disk.free) + ' / 共 ' + fmtBytes(s.disk.total) + '</span>'));
      } else {
        body.appendChild(elh('div', 'storage-warn', ic('info') + '<span>這個平台無法讀取磁碟容量，只能顯示資料庫本身的大小。</span>'));
      }
      const grid = el('div', 'storage-grid');
      [
        [fmtBytes(s.dbBytes), '資料庫（InnoDB 資料＋索引）'],
        [fmtBytes(s.images.bytes), s.images.count + ' 張圖片 / 附件'],
        [fmtBytes(s.notes.bytes), s.notes.count + ' 篇筆記內文'],
        [fmtBytes(s.versions.bytes), (s.versions.count || 0) + ' 個歷史版本'],
        [fmtBytes((s.links || {}).bytes || 0), ((s.links || {}).count || 0) + ' 個電子書分享連結']
      ].forEach(function (x) {
        grid.appendChild(elh('div', 'storage-stat', '<div class="storage-stat-n">' + x[0] + '</div><div class="storage-stat-l">' + x[1] + '</div>'));
      });
      body.appendChild(grid);

      const wrap = el('div', 'admin-wrap');
      const table = el('table', 'admin-table');
      table.innerHTML = '<thead><tr><th>帳號</th><th class="num">筆記</th><th class="num">內文</th>' +
        '<th class="num">版本</th><th class="num">版本大小</th>' +
        '<th class="num">圖片</th><th class="num">圖片大小</th><th class="num">合計</th></tr></thead>';
      const tb = document.createElement('tbody');
      (s.perUser || []).forEach(function (u) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="admin-name"></td><td class="num">' + u.notes + '</td><td class="num">' + fmtBytes(u.noteBytes) + '</td>' +
          '<td class="num">' + (u.versions || 0) + '</td><td class="num">' + fmtBytes(u.versionBytes || 0) + '</td>' +
          '<td class="num">' + u.images + '</td><td class="num">' + fmtBytes(u.imageBytes) + '</td>' +
          '<td class="num"><b>' + fmtBytes(u.noteBytes + (u.versionBytes || 0) + u.imageBytes) + '</b></td>';
        tr.querySelector('.admin-name').textContent = u.username;
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      wrap.appendChild(table);
      body.appendChild(wrap);
      body.appendChild(el('div', 'storage-path', 'MariaDB 資料目錄：' + (s.dataDir || '（未知）')));
      countEl.textContent = '門檻可用環境變數 STORAGE_WARN_MB / STORAGE_WARN_PCT 調整';
    }).catch(function (e) {
      body.innerHTML = '';
      // 這個端點是後來加的：伺服器還沒重啟就會回 404，講清楚比顯示 not found 有用
      const msg = String(e && e.message || e);
      errEl.textContent = /not found|404/i.test(msg)
        ? '伺服器沒有這個端點——它是新加的，請重新啟動伺服器（node server/server.js）後再試。'
        : msg;
      errEl.hidden = false;
    });
  }

  global.Admin = {
    showPanel: showPanel, showChangePassword: showChangePassword,
    showStorage: showStorage, showStorageWarning: showStorageWarning, checkStorage: checkStorage
  };
})(window);
