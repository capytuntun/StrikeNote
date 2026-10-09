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
      '<section class="admin-reg" aria-label="註冊設定">' +
        '<div class="admin-reg-row">' +
          '<span class="admin-reg-label">註冊方式</span>' +
          '<div class="imglib-seg admin-seg" role="radiogroup" aria-label="註冊方式">' +
            '<button type="button" role="radio" data-mode="invite">邀請制</button>' +
            '<button type="button" role="radio" data-mode="open">開放註冊</button>' +
            '<button type="button" role="radio" data-mode="closed">關閉註冊</button>' +
          '</div>' +
          '<span class="admin-reg-desc">讀取中…</span>' +
        '</div>' +
        '<div class="admin-reg-row admin-invite-row" hidden>' +
          '<span class="admin-reg-label">邀請碼</span>' +
          '<input class="admin-invite" type="text" spellcheck="false" autocomplete="off" maxlength="64" aria-label="邀請碼">' +
          '<button type="button" class="btn admin-invite-copy">複製</button>' +
          '<button type="button" class="btn admin-invite-save" disabled>儲存</button>' +
          '<button type="button" class="btn admin-invite-new">產生新的</button>' +
        '</div>' +
      '</section>' +
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

    // ---- 註冊方式與邀請碼（server/settings.js）----
    const seg = modal.querySelector('.admin-seg');
    const regDesc = modal.querySelector('.admin-reg-desc');
    const inviteRow = modal.querySelector('.admin-invite-row');
    const inviteInput = modal.querySelector('.admin-invite');
    const inviteSave = modal.querySelector('.admin-invite-save');
    const REG_DESC = {
      invite: '要輸入邀請碼才能註冊，把下面的邀請碼給要加入的人。',
      open: '任何連得到這個網站的人都能自己建立帳號，不需要邀請碼。',
      closed: '不開放註冊，登入頁不顯示「建立帳號」。'
    };
    let reg = null;
    function paintReg(s) {
      reg = s;
      seg.querySelectorAll('button[data-mode]').forEach(function (b) {
        const on = b.getAttribute('data-mode') === s.registerMode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      regDesc.textContent = REG_DESC[s.registerMode] || '';
      inviteRow.hidden = s.registerMode !== 'invite';
      inviteInput.value = s.inviteCode || '';
      inviteSave.disabled = true;
    }
    // 成功 resolve true；失敗顯示錯誤、畫面退回伺服器上的值，resolve false
    function saveReg(patch) {
      err('');
      return Store.adminSaveSettings(patch).then(function (s) { paintReg(s); return true; }, function (e) {
        err(e.message);
        if (reg) paintReg(reg);
        return false;
      });
    }
    Store.adminGetSettings().then(paintReg).catch(function (e) {
      regDesc.textContent = '';
      err(/not found|404/i.test(String(e && e.message))
        ? '伺服器沒有註冊設定的端點——它是新加的，請重新啟動伺服器後再試。'
        : e.message);
    });
    seg.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-mode]');
      if (!b || !reg) return;
      const m = b.getAttribute('data-mode');
      if (m === reg.registerMode) return;
      const ask = m === 'open'
        ? App.confirm({
          title: '開放註冊',
          message: '開放之後，任何連得到這個網站的人都能自己建立帳號，不需要邀請碼。\n確定要開放嗎？',
          ok: '開放註冊', danger: true
        })
        : Promise.resolve(true);
      ask.then(function (yes) { if (yes) saveReg({ registerMode: m }); });
    });
    inviteInput.addEventListener('input', function () {
      inviteSave.disabled = !reg || !inviteInput.value.trim() || inviteInput.value.trim() === reg.inviteCode;
    });
    inviteInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !inviteSave.disabled) { e.preventDefault(); inviteSave.click(); }
    });
    inviteSave.addEventListener('click', function () {
      saveReg({ inviteCode: inviteInput.value.trim() }).then(function (ok) {
        if (ok) App.toast('邀請碼已更新，舊的邀請碼不能再用');
      });
    });
    modal.querySelector('.admin-invite-new').addEventListener('click', function () {
      App.confirm({
        title: '產生新的邀請碼',
        message: '舊的邀請碼會立刻失效，還沒註冊的人要用新的邀請碼才能加入。',
        ok: '產生新的'
      }).then(function (yes) {
        if (!yes) return;
        saveReg({ regenerateInvite: true }).then(function (ok) { if (ok) App.toast('已產生新的邀請碼'); });
      });
    });
    modal.querySelector('.admin-invite-copy').addEventListener('click', function () {
      const text = inviteInput.value;
      function fallback() {
        inviteInput.focus();
        inviteInput.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (x) { copied = false; }
        App.toast(copied ? '已複製邀請碼' : '複製失敗，請手動選取');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { App.toast('已複製邀請碼'); }, fallback);
      } else {
        fallback();
      }
    });

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
    function onKey(e) {
      if (e.key !== 'Escape') return;
      // 確認框（開放註冊、換邀請碼、刪帳號）疊在上面時，Esc 是它的，不要連帳號管理一起關掉
      const layers = document.querySelectorAll('.modal-overlay');
      if (layers[layers.length - 1] !== overlay) return;
      e.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    refresh();
  }

  // ---------------- storage (admin only) ----------------
  // How much room the data directory has left, what the database is made of,
  // and who is using it — sizes and counts, never content.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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

  // ---- 系統監控 ----
  // 上半是機器：CPU、記憶體、負載、溫度、磁碟、這個 Node 程序、現在有幾個人連著；
  // 下半是原本「儲存空間」那些：資料庫、圖片、筆記、版本、連結、每個帳號用多少。
  // 面板開著的時候每 5 秒跟伺服器要一次（伺服器自己每 5 秒量一次 CPU，見 server/sysmon.js）。
  function fmtDur(sec) {
    sec = Math.floor(Number(sec) || 0);
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return d + ' 天 ' + h + ' 小時';
    if (h) return h + ' 小時 ' + m + ' 分';
    return m + ' 分 ' + (sec % 60) + ' 秒';
  }
  function pctClass(p) { return p >= 90 ? ' is-hot' : p >= 70 ? ' is-warm' : ''; }
  // 一條走勢線（最近 10 分鐘），純 SVG，沒有函式庫
  function sparkline(points, key, cls) {
    const W = 220, H = 36;
    if (!points || points.length < 2) return '<svg class="sys-spark ' + cls + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '"></svg>';
    const n = points.length;
    const d = points.map(function (q, i) {
      const x = (i / (n - 1)) * W, y = H - 1 - (Math.max(0, Math.min(100, q[key])) / 100) * (H - 2);
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const last = points[n - 1];
    const lx = W, ly = H - 1 - (Math.max(0, Math.min(100, last[key])) / 100) * (H - 2);
    return '<svg class="sys-spark ' + cls + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="none">' +
      '<path class="sys-spark-fill" d="' + d + ' L' + W + ',' + H + ' L0,' + H + ' Z"/>' +
      '<path class="sys-spark-line" d="' + d + '"/>' +
      '<circle class="sys-spark-dot" cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="2.5"/></svg>';
  }
  function gauge(label, pct, text, sub, cls, extraHTML) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<div class="sys-card' + pctClass(p) + (cls ? ' ' + cls : '') + '">' +
      '<div class="sys-card-head"><span class="sys-card-l">' + label + '</span><span class="sys-card-n">' + text + '</span></div>' +
      '<div class="storage-bar"><div class="storage-bar-fill" style="width:' + p.toFixed(1) + '%"></div></div>' +
      (sub ? '<div class="sys-card-sub">' + sub + '</div>' : '') + (extraHTML || '') + '</div>';
  }
  function kv(pairs) {
    return '<dl class="sys-kv">' + pairs.filter(function (x) { return x[1] != null && x[1] !== ''; })
      .map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
  }
  function renderSystem(body, s) {
    const st = s.storage || {};
    const host = s.host || {}, mem = s.mem || {}, proc = s.proc || {};
    const parts = [];
    // 磁碟門檻的警告照舊放最上面
    if (st.disk && st.low) {
      parts.push('<div class="storage-warn">' + ic('alert-triangle') + '<span>磁碟剩餘空間低於門檻（' + fmtBytes(st.thresholds.bytes) + ' 或 ' + st.thresholds.pct + '%），請儘快處理。</span></div>');
    }
    // ---- 機器 ----
    parts.push('<div class="sys-sec-t">' + ic('cpu') + '<span>機器</span>' +
      '<span class="sys-sec-m">' + esc(host.hostname || '') + ' · ' + esc(host.platform || '') + ' ' + esc(host.release || '') + ' · ' + esc(host.arch || '') +
      ' · 開機 ' + fmtDur(host.uptime) + '</span></div>');
    const memPct = mem.total ? (mem.used / mem.total * 100) : 0;
    const diskUsed = st.disk ? Math.max(0, st.disk.total - st.disk.free) : 0;
    const diskPct = st.disk && st.disk.total ? diskUsed / st.disk.total * 100 : 0;
    const load = (host.load || []).map(function (x) { return x.toFixed(2); }).join(' / ');
    parts.push('<div class="sys-grid">' +
      gauge('CPU', s.cpu, s.cpu == null ? '量測中…' : s.cpu.toFixed(0) + '%',
        (host.cores || 0) + ' 核心' + (host.model ? ' · ' + esc(host.model.replace(/\s+/g, ' ').slice(0, 40)) : '') + (load ? '<br>負載 ' + load + '（1／5／15 分鐘）' : ''),
        'sys-cpu', sparkline(s.history, 'cpu', 'sys-spark-cpu')) +
      gauge('記憶體', memPct, memPct.toFixed(0) + '%',
        '已用 ' + fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total) +
        (mem.swapTotal ? '<br>Swap ' + fmtBytes(mem.swapUsed || 0) + ' / ' + fmtBytes(mem.swapTotal) : ''),
        'sys-mem', sparkline(s.history, 'mem', 'sys-spark-mem')) +
      (st.disk
        ? gauge('磁碟', diskPct, diskPct.toFixed(0) + '%', '已用 ' + fmtBytes(diskUsed) + ' / ' + fmtBytes(st.disk.total) + '<br>剩餘 ' + fmtBytes(st.disk.free) +
            (st.low ? '' : ' · 門檻 ' + fmtBytes(st.thresholds.bytes) + ' 或 ' + st.thresholds.pct + '%'), st.low ? 'sys-disk is-hot' : 'sys-disk')
        : '<div class="sys-card"><div class="sys-card-head"><span class="sys-card-l">磁碟</span><span class="sys-card-n">—</span></div><div class="sys-card-sub">這個平台讀不到磁碟容量</div></div>') +
      // 磁碟讀寫速度：走勢線的高度照這十分鐘裡最快的那一刻算（沒有固定的 100%）
      (s.io
        ? (function () {
            const pts = (s.history || []).filter(function (q) { return q.rd != null; });
            const peak = Math.max(1, pts.reduce(function (m, q) { return Math.max(m, q.rd + q.wr); }, 0));
            const series = pts.map(function (q) { return { io: (q.rd + q.wr) / peak * 100 }; });
            const now = s.io.read + s.io.write;
            return gauge('磁碟讀寫', now / peak * 100, fmtBytes(now) + '/s',
              '讀 ' + fmtBytes(s.io.read) + '/s · 寫 ' + fmtBytes(s.io.write) + '/s<br>最近十分鐘最快 ' + fmtBytes(peak) + '/s',
              'sys-io', sparkline(series, 'io', 'sys-spark-io'));
          })()
        : '<div class="sys-card"><div class="sys-card-head"><span class="sys-card-l">磁碟讀寫</span><span class="sys-card-n">—</span></div><div class="sys-card-sub">這個平台讀不到磁碟讀寫速度（只有 Linux 的 /proc/diskstats 有）</div></div>') +
      (host.temp != null
        ? gauge('溫度', host.temp / 85 * 100, host.temp.toFixed(1) + ' °C', host.temp >= 80 ? '太熱了，檢查散熱' : host.temp >= 65 ? '偏熱' : '正常', 'sys-temp' + (host.temp >= 80 ? ' is-hot' : host.temp >= 65 ? ' is-warm' : ''))
        : '') +
      '</div>');
    // ---- 伺服器 ----
    const hub = s.hub || {}, sess = s.sessions || {};
    parts.push('<div class="sys-sec-t">' + ic('server') + '<span>capynote 伺服器</span></div>');
    parts.push('<div class="sys-two">' +
      kv([['程序', 'PID ' + proc.pid + ' · Node ' + esc(proc.node || '')], ['執行', fmtDur(proc.uptime)],
        ['程序 CPU', (proc.cpu != null ? proc.cpu.toFixed(1) : '—') + '%'],
        ['程序記憶體', fmtBytes(proc.rss) + '（heap ' + fmtBytes(proc.heapUsed) + ' / ' + fmtBytes(proc.heapTotal) + '）']]) +
      kv([['帳號', s.users + ' 個'], ['登入中', (sess.n || 0) + ' 個 session · ' + (sess.users || 0) + ' 個帳號'],
        ['正在編輯', (hub.users || 0) + ' 人 · ' + (hub.notesOpen || 0) + ' 篇筆記 · ' + (hub.connections || 0) + ' 條連線'],
        ['資料庫', fmtBytes(st.dbBytes) + '（InnoDB 資料＋索引）']]) +
      '</div>');
    // ---- 儲存 ----
    parts.push('<div class="sys-sec-t">' + ic('hard-drive') + '<span>儲存</span></div>');
    const grid = el('div', 'storage-grid');
    [
      [fmtBytes(st.dbBytes), '資料庫（InnoDB 資料＋索引）'],
      [fmtBytes((st.images || {}).bytes), ((st.images || {}).count || 0) + ' 張圖片 / 附件'],
      [fmtBytes((st.notes || {}).bytes), ((st.notes || {}).count || 0) + ' 篇筆記內文'],
      [fmtBytes((st.versions || {}).bytes), ((st.versions || {}).count || 0) + ' 個歷史版本'],
      [fmtBytes((st.links || {}).bytes || 0), ((st.links || {}).count || 0) + ' 個公開連結']
    ].forEach(function (x) {
      grid.appendChild(elh('div', 'storage-stat', '<div class="storage-stat-n">' + x[0] + '</div><div class="storage-stat-l">' + x[1] + '</div>'));
    });
    const wrap = el('div', 'admin-wrap');
    const table = el('table', 'admin-table');
    table.innerHTML = '<thead><tr><th>帳號</th><th class="num">筆記</th><th class="num">內文</th>' +
      '<th class="num">版本</th><th class="num">版本大小</th>' +
      '<th class="num">圖片</th><th class="num">圖片大小</th><th class="num">合計</th></tr></thead>';
    const tb = document.createElement('tbody');
    (st.perUser || []).forEach(function (u) {
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

    body.innerHTML = parts.join('');
    body.appendChild(grid);
    body.appendChild(wrap);
    body.appendChild(el('div', 'storage-path', 'MariaDB 資料目錄：' + (st.dataDir || '（未知）')));
  }

  function showStorage() {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal storage-modal sys-modal');
    modal.innerHTML =
      '<div class="modal-title">' + ic('activity') + ' 系統監控<span class="sys-live" title="每 5 秒更新">' + ic('refresh-cw') + '<span>即時</span></span></div>' +
      '<div class="admin-hint">這台機器與這個站台現在的狀態。只有數字與大小，看不到任何筆記內容。</div>' +
      '<div class="admin-error" hidden></div>' +
      '<div class="storage-body"><div class="dash-empty">讀取中…</div></div>' +
      '<div class="modal-actions"><span class="admin-count"></span>' +
      '<button class="btn modal-cancel" type="button">關閉</button></div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const body = modal.querySelector('.storage-body');
    const errEl = modal.querySelector('.admin-error');
    const countEl = modal.querySelector('.admin-count');
    let timer = null, closed = false;

    function close() { closed = true; clearTimeout(timer); overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);

    function tick() {
      if (closed) return;
      const call = (global.Store && Store.adminSystem) ? Store.adminSystem() : Promise.reject(new Error('not found'));
      call.then(function (s) {
        if (closed) return;
        errEl.hidden = true;
        renderSystem(body, s);
        countEl.textContent = '更新於 ' + new Date(s.at || Date.now()).toLocaleTimeString('zh-TW', { hour12: false }) + ' · 門檻可用 STORAGE_WARN_MB / STORAGE_WARN_PCT 調整';
      }).catch(function (e) {
        if (closed) return;
        // 這個端點是後來加的：伺服器還沒重啟就會回 404，講清楚比顯示 not found 有用
        const msg = String(e && e.message || e);
        errEl.textContent = /not found|404/i.test(msg)
          ? '伺服器沒有這個端點——它是新加的，請重新啟動伺服器（node server/server.js）後再試。'
          : msg;
        errEl.hidden = false;
        if (body.querySelector('.dash-empty')) body.innerHTML = '';
      }).then(function () { if (!closed) timer = setTimeout(tick, 5000); });
    }
    tick();
  }

  global.Admin = {
    showPanel: showPanel, showChangePassword: showChangePassword,
    showStorage: showStorage, showStorageWarning: showStorageWarning, checkStorage: checkStorage
  };
})(window);
