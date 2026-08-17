// ui-input.js — pointer/touch/keyboard/gamepad input. Raycasts hit only the
// gameplay layer; drags use pointer capture and cancel safely on loss. Tap,
// drag, and camera gestures are separated by distance/time thresholds; core
// play never needs multi-touch. Double commits are prevented by the session's
// command ids, not by debounce timers.

const TAP_MAX_DIST = 12;      // px
const TAP_MAX_MS = 350;
const DRAG_MIN_DIST = 14;     // px before a piece drag begins

export class Input {
  constructor(canvas, stage, handlers) {
    this.canvas = canvas;
    this.stage = stage;
    this.h = handlers;      // intents into main.js
    this.enabled = false;
    this.locked = false;    // brief lock during non-interruptible resolution
    this.ctx = null;        // {state, selection, legalSlots, dragMode}
    this._pointer = null;   // active pointer record
    this._drag = null;      // dragging piece record
    this._trayDrag = null;  // drag started on a DOM tray item
    this._suppressTrayClick = false;
    this._cursorTargets = [];
    this._cursorIndex = -1;
    this._padPrev = [];
    this._padTimer = 0;
    this._captureRebind = null;
    this._bind();
  }

  _bind() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
    this.canvas.addEventListener('lostpointercapture', (e) => this._onLostCapture(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.enabled || this.locked) return;
      e.preventDefault();
      this.stage.zoom(Math.sign(e.deltaY) * 0.08);
    }, { passive: false });
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    this._padTimer = setInterval(() => this._pollGamepad(), 50);

    // The DOM tray sits on top of the 3D tray pieces, so tray drags start on
    // the tray buttons; they drive the same drag intents as canvas drags.
    this.tray = document.getElementById('tray');
    if (this.tray) {
      this.tray.addEventListener('pointerdown', (e) => this._onTrayPointerDown(e));
      // Move/up are tracked at document level: pointer capture is requested
      // once the drag starts, but browsers may drop or refuse it — the drag
      // must keep working regardless.
      document.addEventListener('pointermove', (e) => this._onTrayPointerMove(e));
      document.addEventListener('pointerup', (e) => this._onTrayPointerUp(e));
      document.addEventListener('pointercancel', () => this._cancelTrayDrag());
      // A finished drag must not also fire the button's click (select).
      this.tray.addEventListener('click', (e) => {
        if (!this._suppressTrayClick) return;
        this._suppressTrayClick = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }, true);
    }
  }

  setContext(ctx) {
    this.ctx = ctx;
    this._rebuildCursorTargets();
  }

  // ----------------------------------------------------------- pointer
  _onPointerDown(e) {
    if (!this.enabled || this.locked || !this.ctx) return;
    this.canvas.setPointerCapture(e.pointerId);
    const hit = this.stage.pick(e.clientX, e.clientY);
    this._pointer = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(),
      x: e.clientX, y: e.clientY, hit, orbiting: false,
    };
    this.h.onPress?.();
    if (hit?.kind === 'piece') {
      const key = hit.key;
      // Begin potential drag of this piece.
      this._drag = { key, started: false, fromSlot: this._pieceSlot(key) };
      this.h.onPieceTouch?.(key);
    } else if (!hit) {
      this._pointer.orbiting = true; // camera gesture on empty background
    }
  }

  _onPointerMove(e) {
    if (!this._pointer || e.pointerId !== this._pointer.id) return;
    const dx = e.clientX - this._pointer.x0;
    const dy = e.clientY - this._pointer.y0;
    const dist = Math.hypot(dx, dy);
    this._pointer.x = e.clientX; this._pointer.y = e.clientY;

    if (this._pointer.orbiting) {
      this.stage.orbit(-dx * 0.004, dy * 0.003);
      this._pointer.x0 = e.clientX; this._pointer.y0 = e.clientY;
      return;
    }
    if (this._drag && !this._drag.started && dist > DRAG_MIN_DIST && this._dragAllowed()) {
      this._drag.started = true;
      this.h.onDragStart?.(this._drag.key);
    }
    if (this._drag?.started) {
      const hit = this.stage.pick(e.clientX, e.clientY);
      let slot = null;
      if (hit?.kind === 'slot') slot = { room: hit.room, slot: hit.slot };
      else if (hit?.kind === 'piece') slot = this._pieceSlot(hit.key); // occupied slot → invalid preview
      this.h.onDragHover?.(this._drag.key, slot);
    } else if (!this._drag) {
      // Plain hover preview (never required).
      const hit = this.stage.pick(e.clientX, e.clientY);
      this.h.onHover?.(hit);
    }
  }

  _onPointerUp(e) {
    if (!this._pointer || e.pointerId !== this._pointer.id) return;
    const dist = Math.hypot(e.clientX - this._pointer.x0, e.clientY - this._pointer.y0);
    const held = performance.now() - this._pointer.t0;
    const hit = this.stage.pick(e.clientX, e.clientY);

    if (this._drag?.started) {
      let slot = null;
      if (hit?.kind === 'slot') slot = { room: hit.room, slot: hit.slot };
      else if (hit?.kind === 'piece') slot = this._pieceSlot(hit.key); // drop on occupied → engine explains
      this.h.onDragEnd?.(this._drag.key, slot);
    } else if (this._drag && dist <= TAP_MAX_DIST && held < TAP_MAX_MS * 2) {
      this.h.onTapPiece?.(this._drag.key);
    } else if (hit?.kind === 'slot' && dist <= TAP_MAX_DIST && held <= TAP_MAX_MS) {
      this.h.onTapSlot?.({ room: hit.room, slot: hit.slot });
    } else if (!hit && dist <= TAP_MAX_DIST && held <= TAP_MAX_MS) {
      this.h.onTapBackground?.();
    }
    this._pointer = null;
    this._drag = null;
  }

  _onPointerCancel() { this._cancelDrag(); }
  _onLostCapture() { this._cancelDrag(); }
  _cancelDrag() {
    if (this._drag?.started) this.h.onDragEnd?.(this._drag.key, null);
    this._pointer = null;
    this._drag = null;
  }

  // ----------------------------------------------------- tray (DOM) drags
  _onTrayPointerDown(e) {
    this._suppressTrayClick = false;
    if (!this.enabled || this.locked || !this.ctx || this._trayDrag) return;
    if (!this._dragAllowed()) return;
    const item = e.target.closest?.('.tray-item');
    const key = item?.dataset.key;
    if (!key || !this.ctx.state?.tray.includes(key)) return;
    this._trayDrag = { id: e.pointerId, key, x0: e.clientX, y0: e.clientY, started: false };
  }

  _onTrayPointerMove(e) {
    const d = this._trayDrag;
    if (!d || e.pointerId !== d.id) return;
    if (d.started && e.buttons === 0) { this._cancelTrayDrag(); return; } // missed pointerup
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= DRAG_MIN_DIST) return;
      d.started = true;
      this._suppressTrayClick = true; // a completed drag is not a click
      this.h.onDragStart?.(d.key);
      // Keeps events flowing if the pointer leaves the window; not every
      // browser honors capture mid-gesture and loss is harmless here, so
      // delivery never depends on it (moves/ups are tracked on document).
      try { this.tray.setPointerCapture(e.pointerId); } catch {}
    }
    this.h.onDragHover?.(d.key, this._slotAt(e.clientX, e.clientY));
  }

  _onTrayPointerUp(e) {
    const d = this._trayDrag;
    if (!d || e.pointerId !== d.id) return;
    this._trayDrag = null;
    if (!d.started) return; // plain tap — the button's click handler selects
    this.h.onDragEnd?.(d.key, this._slotAt(e.clientX, e.clientY));
  }

  _cancelTrayDrag() {
    if (this._trayDrag?.started) {
      this._suppressTrayClick = true;
      this.h.onDragEnd?.(this._trayDrag.key, null);
    }
    this._trayDrag = null;
  }

  _slotAt(clientX, clientY) {
    const hit = this.stage.pick(clientX, clientY);
    if (hit?.kind === 'slot') return { room: hit.room, slot: hit.slot };
    if (hit?.kind === 'piece') return this._pieceSlot(hit.key); // occupied → engine explains
    return null;
  }

  _pieceSlot(key) {
    const st = this.ctx?.state;
    if (!st) return null;
    for (const room of st.rooms) {
      const i = room.slots.indexOf(key);
      if (i >= 0) return { room: room.id, slot: i };
    }
    return null;
  }
  _dragAllowed() {
    const mode = this.ctx?.dragMode || 'both';
    return mode === 'both' || mode === 'drag';
  }

  // ----------------------------------------------------------- keyboard
  _onKeyDown(e) {
    // Rebinding capture has first claim.
    if (this._captureRebind) {
      e.preventDefault();
      const cap = this._captureRebind;
      this._captureRebind = null;
      cap(e.key === 'Escape' ? null : [e.key]);
      return;
    }
    if (!this.enabled || this.locked || !this.ctx) return;
    const b = this.ctx.bindings;
    const is = (action) => (b[action] || []).includes(e.key);
    const tag = document.activeElement?.tagName;
    const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (inField) return;

    if (is('left') || is('right') || is('up') || is('down')) {
      e.preventDefault();
      const dir = is('left') ? 'left' : is('right') ? 'right' : is('up') ? 'up' : 'down';
      this._moveCursor(dir);
      return;
    }
    if (is('confirm')) {
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== this.canvas) return; // let DOM buttons work
      e.preventDefault();
      this._confirmCursor();
      return;
    }
    if (is('undo')) { e.preventDefault(); this.h.onUndo?.(); return; }
    if (is('hint')) { e.preventDefault(); this.h.onHint?.(); return; }
    if (is('camera')) { e.preventDefault(); this.stage.resetCamera(); return; }
    if (is('mute')) { e.preventDefault(); this.h.onMuteToggle?.(); return; }
    if (e.key === 'Escape') {
      if (this.ctx.selection) {
        e.preventDefault();
        e.stopImmediatePropagation(); // cancel the selection, do not also pause
        this.h.onCancel?.();
      }
      return; // pause handled globally by main
    }
  }

  captureNextKey(fn) { this._captureRebind = fn; }

  // ----------------------------------------------------------- cursor
  _rebuildCursorTargets() {
    const st = this.ctx?.state;
    this._cursorTargets = [];
    this._cursorIndex = -1;
    if (!st || !this.stage.house) { this.stage.setCursor(null); return; }
    // Rows top→bottom: rooms by descending gy, tray last.
    const rooms = st.rooms.slice().sort((a, b) => b.gy - a.gy || a.gx - b.gx);
    for (const room of rooms) {
      const anchor = this.stage.house.roomAnchors.get(room.id);
      room.slots.forEach((item, slot) => {
        const pos = anchor.slots[slot];
        this._cursorTargets.push({
          type: 'slot', room: room.id, slot, item,
          x: pos.x, y: room.gy, z: pos.z, pos: pos.clone().setY(pos.y + 0.75),
        });
      });
    }
    st.tray.forEach((key, i) => {
      const pos = this.stage.trayAnchors[i];
      if (pos) this._cursorTargets.push({ type: 'tray', item: key, x: pos.x, y: -1, pos: pos.clone().setY(pos.y + 0.75) });
    });
  }

  _moveCursor(dir) {
    const T = this._cursorTargets;
    if (!T.length) return;
    if (this._cursorIndex < 0) {
      // Start on the first tray item — the most actionable target.
      const firstTray = T.findIndex(t => t.type === 'tray');
      this._cursorIndex = firstTray >= 0 ? firstTray : 0;
    } else {
      const cur = T[this._cursorIndex];
      if (dir === 'left' || dir === 'right') {
        const d = dir === 'left' ? -1 : 1;
        // Next target in the same row.
        let i = this._cursorIndex;
        for (let n = 0; n < T.length; n++) {
          i = (i + d + T.length) % T.length;
          if (T[i].y === cur.y) break;
        }
        this._cursorIndex = i;
      } else {
        const d = dir === 'up' ? 1 : -1; // screen up = higher gy row
        const rows = [...new Set(T.map(t => t.y))].sort((a, b) => a - b);
        const ri = rows.indexOf(cur.y);
        const nri = ri + d;
        if (nri >= 0 && nri < rows.length) {
          const rowTargets = T.map((t, i) => [t, i]).filter(([t]) => t.y === rows[nri]);
          // nearest x in the new row
          let best = rowTargets[0][1], bestDx = Infinity;
          for (const [t, i] of rowTargets) {
            const dx = Math.abs(t.x - cur.x);
            if (dx < bestDx) { bestDx = dx; best = i; }
          }
          this._cursorIndex = best;
        }
      }
    }
    const t = this._cursorTargets[this._cursorIndex];
    this.stage.setCursor(t.pos);
    this.h.onCursorMove?.(t);
  }

  _confirmCursor() {
    if (this._cursorIndex < 0) { this._moveCursor('right'); return; }
    const t = this._cursorTargets[this._cursorIndex];
    if (!t) return;
    if (t.type === 'tray') this.h.onTapPiece?.(t.item);
    else if (t.item) this.h.onTapPiece?.(t.item);
    else this.h.onTapSlot?.({ room: t.room, slot: t.slot });
  }

  cursorRoomCycle(dir) {
    const st = this.ctx?.state;
    if (!st) return;
    const rooms = st.rooms.slice().sort((a, b) => a.gx - b.gx || a.gy - b.gy);
    const cur = this._cursorTargets[this._cursorIndex];
    const curRoom = cur?.room ?? null;
    const ids = rooms.map(r => r.id);
    const i = curRoom ? ids.indexOf(curRoom) : -1;
    const next = rooms[(i + dir + rooms.length) % rooms.length];
    const idx = this._cursorTargets.findIndex(t => t.room === next.id);
    if (idx >= 0) {
      this._cursorIndex = idx;
      this.stage.setCursor(this._cursorTargets[idx].pos);
      this.stage.focusRoom(next.id);
      this.h.onCursorMove?.(this._cursorTargets[idx]);
    }
  }

  // ----------------------------------------------------------- gamepad
  _pollGamepad() {
    if (!this.enabled || this.locked || !this.ctx) return;
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    const pad = [...pads].find(p => p && p.connected);
    if (!pad) return;
    const map = this.ctx.gamepadMap;
    const pressed = (i) => i !== undefined && pad.buttons[i]?.pressed;
    const edge = (i) => {
      const was = this._padPrev[i];
      const now = !!pressed(i);
      this._padPrev[i] = now;
      return now && !was;
    };
    // Rebind capture mode.
    if (this._capturePad) {
      pad.buttons.forEach((btn, i) => {
        if (btn.pressed) {
          const cap = this._capturePad;
          this._capturePad = null;
          cap(i);
        }
      });
      return;
    }
    // Sticks → cursor with repeat.
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    const dpadL = pressed(14), dpadR = pressed(15), dpadU = pressed(12), dpadD = pressed(13);
    const now = performance.now();
    if (!this._stickAt) this._stickAt = 0;
    if (now - this._stickAt > 220) {
      if (ax < -0.5 || dpadL) { this._moveCursor('left'); this._stickAt = now; }
      else if (ax > 0.5 || dpadR) { this._moveCursor('right'); this._stickAt = now; }
      else if (ay < -0.5 || dpadU) { this._moveCursor('up'); this._stickAt = now; }
      else if (ay > 0.5 || dpadD) { this._moveCursor('down'); this._stickAt = now; }
    }
    if (edge(map.confirm)) this._confirmCursor();
    if (edge(map.cancel)) this.h.onCancel?.();
    if (edge(map.interact)) this.h.onInteractKey?.();
    if (edge(map.hint)) this.h.onHint?.();
    if (edge(map.undo)) this.h.onUndo?.();
    if (edge(map.pause)) this.h.onPauseKey?.();
    if (edge(map.cycleRoomL)) this.cursorRoomCycle(-1);
    if (edge(map.cycleRoomR)) this.cursorRoomCycle(1);
    // Right stick → camera orbit.
    const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
    if (Math.abs(rx) > 0.3 || Math.abs(ry) > 0.3) this.stage.orbit(-rx * 0.03, ry * 0.02);
  }

  captureNextPadButton(fn) { this._capturePad = fn; }
}
