/* trash.js — 垃圾桶：刪除的筆記先放這裡，保留期（伺服器 TRASH_KEEP_DAYS，預設 30 天）
 * 過後才真的刪掉；期間可以復原，也可以自己進來永久刪除或清空。
 *
 *   Trash.open({ folders, onChanged })
 *     folders    app.js 的資料夾清單，用來顯示筆記原本在哪個資料夾
 *     onChanged  關閉對話框時，如果有復原或永久刪除過任何一篇就呼叫，讓 app.js 重抓筆記
 *
 * 只透過 Store 跟伺服器講話；跟 versions.js 一樣，不管筆記怎麼載入或畫出來。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) { return global.Icons ? Icons.svg(name) : ''; }
  function toast(msg) { if (global.App && App.toast) App.toast(msg); }
  function confirm(opts) {
    if (global.App && App.confirm) return App.confirm(opts);
    return Promise.resolve(window.confirm(opts.message));
  }

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/') +
      (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function chars(n) {
    if (n == null) return '';
    return n >= 10000 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字';
  }
  // Whole days left, rounded up: a note deleted 29.5 days ago still has "1 天".
  function daysLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));
  }

  function open(opts) {
    const o = opts || {};
    const folders = o.folders || [];
    let changed = false;

    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal trash-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const head = el('div', 'modal-title');
    head.innerHTML = icon('trash');
    head.appendChild(el('span', null, '垃圾桶'));
    head.appendChild(el('span', 'ver-sp'));
    const close = el('button', 'icon-btn ver-close');
    close.type = 'button';
    close.title = '關閉';
    close.innerHTML = icon('x');
    head.appendChild(close);
    modal.appendChild(head);

    const hint = el('div', 'trash-hint', '載入中…');
    const list = el('div', 'trash-list');
    const foot = el('div', 'trash-foot');
    const count = el('span', 'trash-meta');
    const emptyBtn = el('button', 'btn btn-danger');
    emptyBtn.type = 'button';
    emptyBtn.innerHTML = icon('trash') + ' 清空垃圾桶';
    foot.appendChild(count);
    foot.appendChild(emptyBtn);
    modal.appendChild(hint);
    modal.appendChild(list);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function dismiss() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (changed && o.onChanged) o.onChanged();
    }
    function onKey(e) { if (e.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKey);

    function folderLabel(id) {
      if (!id) return '最上層';
      const f = folders.find(function (x) { return x.id === id; });
      return f ? '資料夾「' + f.name + '」' : '原資料夾已刪除，復原後會放在最上層';
    }

    function render() {
      list.textContent = '';
      Store.getTrash().then(function (data) {
        const notes = data.notes || [];
        hint.textContent = '刪除的筆記會在這裡保留 ' + data.keepDays + ' 天，之後自動永久刪除。復原會放回原本的資料夾。';
        count.textContent = notes.length ? notes.length + ' 篇' : '';
        emptyBtn.disabled = !notes.length;
        if (!notes.length) {
          list.appendChild(el('div', 'trash-empty', '垃圾桶是空的。'));
          return;
        }
        notes.forEach(function (n) {
          const row = el('div', 'trash-item');
          row.innerHTML = icon('file-text');
          const main = el('div', 'trash-main');
          main.appendChild(el('div', 'trash-title', n.title || '未命名筆記'));
          const meta = el('div', 'trash-meta');
          const left = daysLeft(n.expiresAt);
          const soon = el('span', left <= 3 ? 'soon' : '', left ? left + ' 天後永久刪除' : '即將永久刪除');
          meta.appendChild(document.createTextNode('刪除於 ' + when(n.deletedAt) + ' · '));
          meta.appendChild(soon);
          meta.appendChild(document.createTextNode(' · ' + chars(n.chars) + ' · ' + folderLabel(n.folderId)));
          main.appendChild(meta);
          row.appendChild(main);

          const acts = el('div', 'trash-acts');
          const restore = el('button', 'btn btn-primary');
          restore.type = 'button';
          restore.innerHTML = icon('rotate-ccw') + ' 復原';
          restore.addEventListener('click', function () {
            restore.disabled = true;
            Store.restoreNote(n.id).then(function () {
              changed = true;
              toast('已復原「' + (n.title || '未命名筆記') + '」');
              render();
            }).catch(function (e) { restore.disabled = false; toast('復原失敗：' + (e && e.message || e)); });
          });
          const purge = el('button', 'btn ver-delbtn');
          purge.type = 'button';
          purge.innerHTML = icon('trash') + ' 永久刪除';
          purge.addEventListener('click', function () {
            confirm({
              title: '永久刪除',
              message: '確定永久刪除「' + (n.title || '未命名筆記') + '」？\n這次真的無法復原，版本紀錄會一起刪除。',
              ok: '永久刪除', danger: true
            }).then(function (ok) {
              if (!ok) return;
              Store.purgeNote(n.id).then(function () {
                changed = true;
                toast('已永久刪除');
                render();
              }).catch(function (e) { toast('刪除失敗：' + (e && e.message || e)); });
            });
          });
          acts.appendChild(restore);
          acts.appendChild(purge);
          row.appendChild(acts);
          list.appendChild(row);
        });
      }).catch(function (e) {
        hint.textContent = '讀取垃圾桶失敗：' + (e && e.message || e);
      });
    }

    emptyBtn.addEventListener('click', function () {
      confirm({
        title: '清空垃圾桶',
        message: '確定永久刪除垃圾桶裡的所有筆記？\n這次真的無法復原。',
        ok: '全部永久刪除', danger: true
      }).then(function (ok) {
        if (!ok) return;
        Store.emptyTrash().then(function (r) {
          changed = true;
          toast('已清空垃圾桶（' + (r && r.purged || 0) + ' 篇）');
          render();
        }).catch(function (e) { toast('清空失敗：' + (e && e.message || e)); });
      });
    });

    render();
    setTimeout(function () { close.focus(); }, 30);
  }

  global.Trash = { open: open };
})(window);
