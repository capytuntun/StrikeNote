/* annotate.js — screenshot annotation: arrows, boxes, text, mosaic, blackout.
 *
 * Annotations are stored as vector shapes next to the untouched original, so
 * they stay editable: reopening the editor re-draws the shapes rather than
 * painting over baked pixels. What the note (and the PDF) shows is the flattened
 * `blob` re-rendered on every save.
 */
(function (global) {
  'use strict';

  const COLORS = ['#e5202e', '#ff8a00', '#f5c400', '#12a150', '#0068d6', '#8b3ff0', '#0f1b28', '#ffffff'];
  const WIDTHS = [2, 4, 7];
  const MOSAIC_BLOCK = 9;      // pixelation cell size, in natural px at scale 1
  const HANDLE = 8;            // px hit radius for "did I click this shape"
  const MIN_DRAG = 4;          // ignore sub-pixel jitter as a drag

  const TOOLS = [
    { id: 'arrow',    label: '箭頭',   icon: 'arrow-up-right' },
    { id: 'rect',     label: '方框',   icon: 'square' },
    { id: 'text',     label: '文字',   icon: 'T' },
    { id: 'mosaic',   label: '馬賽克', icon: 'grid' },
    { id: 'blackout', label: '塗黑',   icon: 'square-fill' }
  ];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function norm(s) {
    // Shapes are drawn in whatever direction the user dragged; normalise so
    // width/height are never negative.
    return {
      x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
      w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1)
    };
  }

  // ---------------- drawing ----------------
  function drawArrow(ctx, s) {
    const head = Math.max(9, s.width * 3.2);
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const a = Math.atan2(dy, dx);
    // Stop the shaft short so it doesn't poke through the head.
    const ex = s.x2 - Math.cos(a) * head * 0.85;
    const ey = s.y2 - Math.sin(a) * head * 0.85;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(a - Math.PI / 7), s.y2 - head * Math.sin(a - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(a + Math.PI / 7), s.y2 - head * Math.sin(a + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawRect(ctx, s) {
    const r = norm(s);
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineJoin = 'miter';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  function drawText(ctx, s) {
    ctx.save();
    ctx.font = '700 ' + s.size + 'px -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif';
    ctx.textBaseline = 'top';
    // Halo so the label stays readable over any screenshot.
    ctx.lineWidth = Math.max(3, s.size / 7);
    ctx.strokeStyle = (s.color === '#ffffff') ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.9)';
    ctx.lineJoin = 'round';
    String(s.text || '').split('\n').forEach(function (line, i) {
      const y = s.y1 + i * s.size * 1.25;
      ctx.strokeText(line, s.x1, y);
      ctx.fillStyle = s.color;
      ctx.fillText(line, s.x1, y);
    });
    ctx.restore();
  }

  function drawBlackout(ctx, s) {
    const r = norm(s);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // Pixelate by sampling the region from `src` at low resolution and blowing it
  // back up with smoothing off.
  function drawMosaic(ctx, s, src) {
    const r = norm(s);
    if (r.w < 2 || r.h < 2) return;
    const cols = Math.max(1, Math.round(r.w / MOSAIC_BLOCK));
    const rows = Math.max(1, Math.round(r.h / MOSAIC_BLOCK));
    const tmp = document.createElement('canvas');
    tmp.width = cols; tmp.height = rows;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, cols, rows);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, cols, rows, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  function drawShape(ctx, s, src) {
    if (s.type === 'arrow') return drawArrow(ctx, s);
    if (s.type === 'rect') return drawRect(ctx, s);
    if (s.type === 'text') return drawText(ctx, s);
    if (s.type === 'blackout') return drawBlackout(ctx, s);
    if (s.type === 'mosaic') return drawMosaic(ctx, s, src);
  }

  // Flatten original + shapes onto a canvas. Mosaic samples the canvas as it
  // stands, so stacking a mosaic over a box pixelates the box too.
  function composite(imgSource, shapes, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(imgSource, 0, 0, w, h);
    (shapes || []).forEach(function (s) { drawShape(ctx, s, c); });
    return c;
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')); };
      img.src = url;
    });
  }
  function canvasToBlob(canvas, type) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, type || 'image/png');
    });
  }

  // ---------------- editor ----------------
  function open(imageId, opts) {
    const o = opts || {};
    return Store.getImage(imageId).then(function (rec) {
      if (!rec || !rec.blob) throw new Error('找不到這張圖片');
      if (rec.canAnnotate === false) throw new Error('這張圖片屬於其他使用者，無法標註');
      // Only fetch the pre-annotation copy when there is one — an image with no
      // shapes yet is already its own original.
      const needOriginal = rec.shapes && rec.shapes.length;
      const p = needOriginal ? Store.getImageOriginal(imageId) : Promise.resolve(rec.blob);
      return p.then(function (originalBlob) {
        return loadImage(originalBlob).then(function (img) {
          buildUI(rec, img, originalBlob, o);
        });
      });
    }).catch(function (e) {
      alert('無法開啟標註工具：' + (e && e.message || e));
    });
  }

  function buildUI(rec, img, originalBlob, o) {
    const W = img.naturalWidth, H = img.naturalHeight;
    let shapes = (rec.shapes || []).map(function (s) { return Object.assign({}, s); });
    const redo = [];
    let tool = 'arrow';
    let color = COLORS[0];
    let width = WIDTHS[1];
    let draft = null;      // shape being dragged right now
    let textInput = null;  // floating input while typing a text label

    const overlay = el('div', 'modal-overlay anno-overlay');
    const modal = el('div', 'modal anno-modal');

    // ---- header ----
    const head = el('div', 'anno-head');
    const ttl = el('div', 'modal-title');
    ttl.innerHTML = (global.Icons ? Icons.svg('pencil') : '') + ' 圖片標註';
    head.appendChild(ttl);
    const dims = el('div', 'anno-dims', W + ' × ' + H);
    head.appendChild(dims);
    modal.appendChild(head);

    // ---- toolbar ----
    const bar = el('div', 'anno-bar');
    const toolWrap = el('div', 'anno-group');
    const toolBtns = {};
    TOOLS.forEach(function (t) {
      const b = el('button', 'anno-tool');
      b.innerHTML = (global.Icons ? Icons.svg(t.icon) : '') + '<span>' + t.label + '</span>';
      b.type = 'button';
      b.title = t.label;
      b.addEventListener('click', function () { setTool(t.id); });
      toolBtns[t.id] = b;
      toolWrap.appendChild(b);
    });
    bar.appendChild(toolWrap);

    const colorWrap = el('div', 'anno-group anno-colors');
    const colorBtns = [];
    COLORS.forEach(function (c) {
      const b = el('button', 'anno-color');
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', function () {
        color = c;
        colorBtns.forEach(function (x) { x.classList.toggle('on', x === b); });
      });
      colorBtns.push(b);
      colorWrap.appendChild(b);
    });
    colorBtns[0].classList.add('on');
    bar.appendChild(colorWrap);

    const widthWrap = el('div', 'anno-group');
    const widthBtns = [];
    WIDTHS.forEach(function (w, i) {
      const b = el('button', 'anno-width');
      b.type = 'button';
      b.title = '線寬 ' + w;
      b.appendChild(el('span', 'anno-width-dot'));
      b.querySelector('.anno-width-dot').style.height = w + 'px';
      b.addEventListener('click', function () {
        width = w;
        widthBtns.forEach(function (x) { x.classList.toggle('on', x === b); });
      });
      widthBtns.push(b);
      widthWrap.appendChild(b);
      if (i === 1) b.classList.add('on');
    });
    bar.appendChild(widthWrap);

    const histWrap = el('div', 'anno-group');
    const undoBtn = el('button', 'anno-tool');
    const redoBtn = el('button', 'anno-tool');
    const clearBtn = el('button', 'anno-tool');
    undoBtn.innerHTML = (global.Icons ? Icons.svg('undo') : '') + '<span>復原</span>';
    redoBtn.innerHTML = (global.Icons ? Icons.svg('redo') : '') + '<span>重做</span>';
    clearBtn.innerHTML = (global.Icons ? Icons.svg('x') : '') + '<span>全部清除</span>';
    [undoBtn, redoBtn, clearBtn].forEach(function (b) { b.type = 'button'; histWrap.appendChild(b); });
    bar.appendChild(histWrap);
    modal.appendChild(bar);

    // ---- canvas ----
    const stage = el('div', 'anno-stage');
    const canvas = el('canvas', 'anno-canvas');
    canvas.width = W; canvas.height = H;
    stage.appendChild(canvas);
    modal.appendChild(stage);
    const ctx = canvas.getContext('2d');

    const hint = el('div', 'anno-hint', '拖曳即可畫出圖形 · 文字工具點一下輸入 · Ctrl+Z 復原 · Esc 取消');
    modal.appendChild(hint);

    // ---- actions ----
    const actions = el('div', 'modal-actions');
    const count = el('span', 'anno-count');
    actions.appendChild(count);
    const revert = el('button', 'btn', '還原成原圖');
    const cancel = el('button', 'btn modal-cancel', '取消');
    const save = el('button', 'btn btn-primary', '儲存');
    [revert, cancel, save].forEach(function (b) { b.type = 'button'; actions.appendChild(b); });
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ---- rendering ----
    function render() {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      const all = draft ? shapes.concat([draft]) : shapes;
      all.forEach(function (s) { drawShape(ctx, s, canvas); });
      count.textContent = shapes.length ? shapes.length + ' 個標註' : '尚無標註';
      undoBtn.disabled = !shapes.length;
      redoBtn.disabled = !redo.length;
      clearBtn.disabled = !shapes.length;
      revert.disabled = !shapes.length;
    }
    function setTool(id) {
      tool = id;
      Object.keys(toolBtns).forEach(function (k) { toolBtns[k].classList.toggle('on', k === id); });
      canvas.style.cursor = (id === 'text') ? 'text' : 'crosshair';
    }
    function commit(s) {
      shapes.push(s);
      redo.length = 0;
      render();
    }

    // Map a pointer event onto natural image coordinates.
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (W / r.width),
        y: (e.clientY - r.top) * (H / r.height)
      };
    }

    // ---- pointer drawing ----
    canvas.addEventListener('pointerdown', function (e) {
      if (textInput) { closeTextInput(true); return; }
      if (e.button !== 0) return;
      const p = pos(e);
      if (tool === 'text') { openTextInput(p, e); return; }
      canvas.setPointerCapture(e.pointerId);
      draft = {
        type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y,
        color: color, width: width
      };
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!draft) return;
      const p = pos(e);
      draft.x2 = p.x; draft.y2 = p.y;
      render();
    });
    function endDraft(e) {
      if (!draft) return;
      const p = pos(e);
      draft.x2 = p.x; draft.y2 = p.y;
      const far = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) >= MIN_DRAG;
      const d = draft;
      draft = null;
      if (far) commit(d); else render();   // a click with no drag draws nothing
    }
    canvas.addEventListener('pointerup', endDraft);
    canvas.addEventListener('pointercancel', function () { draft = null; render(); });

    // ---- text tool ----
    function openTextInput(p, e) {
      closeTextInput(false);
      const size = Math.max(14, Math.round(width * 7));
      textInput = el('input', 'anno-text-input');
      textInput.type = 'text';
      textInput.placeholder = '輸入文字後按 Enter';
      textInput.style.left = e.clientX + 'px';
      textInput.style.top = e.clientY + 'px';
      textInput.style.color = color;
      textInput._at = p;
      textInput._size = size;
      document.body.appendChild(textInput);
      setTimeout(function () { textInput && textInput.focus(); }, 10);
      textInput.addEventListener('keydown', function (ev) {
        ev.stopPropagation(); // don't let Esc/Enter reach the modal handler
        if (ev.key === 'Enter') { ev.preventDefault(); closeTextInput(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeTextInput(false); }
      });
      textInput.addEventListener('blur', function () { closeTextInput(true); });
    }
    function closeTextInput(keep) {
      if (!textInput) return;
      const t = textInput;
      textInput = null;   // clear first so blur handler can't re-enter
      const val = t.value.trim();
      const at = t._at, size = t._size;
      t.remove();
      if (keep && val) {
        commit({
          type: 'text', x1: at.x, y1: at.y, x2: at.x, y2: at.y,
          color: color, width: width, size: size, text: val
        });
      }
    }

    // ---- history ----
    undoBtn.addEventListener('click', function () {
      if (!shapes.length) return;
      redo.push(shapes.pop());
      render();
    });
    redoBtn.addEventListener('click', function () {
      if (!redo.length) return;
      shapes.push(redo.pop());
      render();
    });
    clearBtn.addEventListener('click', function () {
      if (!shapes.length) return;
      redo.length = 0;
      shapes = [];
      render();
    });
    revert.addEventListener('click', function () {
      shapes = [];
      redo.length = 0;
      render();
      doSave();  // persist the original back as the visible image
    });

    // ---- close / keys ----
    function close() {
      closeTextInput(false);
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (textInput) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); undoBtn.click();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' ||
                 (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); redoBtn.click();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);

    // ---- save ----
    function doSave() {
      save.disabled = true;
      save.textContent = '儲存中…';
      const flat = composite(img, shapes, W, H);
      // PNG keeps text and boxes crisp; screenshots are the norm here.
      canvasToBlob(flat, 'image/png').then(function (blob) {
        rec.blob = blob;
        // Send the original only when it is not already stored server-side,
        // otherwise every save would re-upload an unchanged copy.
        rec.original = (rec.shapes && rec.shapes.length) ? null : originalBlob;
        rec.shapes = shapes;
        rec.type = 'image/png';
        return Store.saveImage(rec);
      }).then(function () {
        MD.invalidateImage(rec.id);
        close();
        if (o.onSaved) o.onSaved(rec.id);
      }).catch(function (e) {
        save.disabled = false;
        save.textContent = '儲存';
        alert('儲存失敗：' + (e && e.message || e));
      });
    }
    save.addEventListener('click', doSave);

    setTool('arrow');
    render();
  }

  global.Annotate = { open: open, composite: composite, drawShape: drawShape };
})(window);
