// render.js — Three.js scene graph, semantic entity views, camera, lighting,
// VFX, quality tiers. Rendering consumes immutable snapshots + events; it
// never mutates rules state. No-post baseline: hierarchy, depth, selection,
// and state read clearly without any post-processing.
import * as THREE from 'three';
import { CameraRig } from './render/camera.js';
import { buildHouse, ROOM_D } from './render/house.js';
import { makePiece, makeGhost, makeOutline } from './render/pieces.js';
import { VfxPool } from './render/vfx.js';
import { RngStream, deriveSeed } from './rng.js';

export const LAYERS = { ENV: 0, GAME: 1, GHOST: 2, VFX: 3 };

const QUALITY_TIERS = {
  low:    { dpr: 1,   shadow: 0,    particles: 800,  detail: 0, shadowMap: 0 },
  medium: { dpr: 1.5, shadow: 1024, particles: 2000, detail: 1, shadowMap: 1024 },
  high:   { dpr: 2,   shadow: 2048, particles: 4000, detail: 1, shadowMap: 2048 },
};

const SELECT_COLOR = 0xffd166;
const LEGAL_COLOR = 0xf2e8d0;
const INVALID_COLOR = 0xd95d4e;

export class Stage {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.renderer = null;
    this.scene = null;
    this.rig = new CameraRig();
    this.qualityTier = 'high';
    this.autoQuality = true;
    this.reducedMotion = false;
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._fpsAcc = 0; this._fpsN = 0; this._fpsWindow = 0;

    this.house = null;        // buildHouse result
    this.content = null;
    this.theme = null;
    this.pieces = new Map();  // key -> runtime record
    this.trayAnchors = [];
    this.pickMeshes = [];
    this.av = new RngStream(1);
    this.time = 0;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._selected = null;
    this._ghost = null;
    this._outline = null;
    this._selRing = null;
    this._hoverRing = null;
    this._invalidRing = null;
    this._cursorMark = null;
    this._slotMarkers = null;
    this._contextLost = false;
    this._lastState = null;
  }

  static webglAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  init() {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    } catch { return false; }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.add(this.rig.camera);
    this.rig.camera.layers.enable(LAYERS.GAME);
    this.rig.camera.layers.enable(LAYERS.GHOST);
    this.rig.camera.layers.enable(LAYERS.VFX);

    this.vfx = new VfxPool(this.scene, 3000);
    this._buildMarkers();
    this._bindContextLoss();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
    this._resize();
    return true;
  }

  _bindContextLoss() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      this.setRunning(false);
      this.hooks.onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      // Rebuild GPU resources from retained CPU descriptors.
      this.renderer.dispose();
      const state = this._lastState, content = this.content, theme = this.theme;
      const tier = this.qualityTier;
      this.init();
      this.setQualityTier(tier);
      if (content) this.startSession({ content, theme, state });
      this.hooks.onContextRestored?.();
    });
  }

  // ------------------------------------------------------------------ setup
  setQualityTier(tier) {
    if (!QUALITY_TIERS[tier]) tier = 'high';
    this.qualityTier = tier;
    const q = QUALITY_TIERS[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    if (this.keyLight) {
      this.keyLight.castShadow = q.shadow > 0;
      if (q.shadow > 0) {
        this.keyLight.shadow.mapSize.set(q.shadowMap, q.shadowMap);
        if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
      }
    }
    this.vfx?.setCap(q.particles);
    this._resize();
  }

  setAutoQuality(on) { this.autoQuality = on; }
  setReducedMotion(on) {
    this.reducedMotion = on;
    this.rig.reducedMotion = on;
    if (this.vfx) this.vfx.enabled = !on; // reduced motion: no particles/rings, timing preserved
  }

  startSession({ content, theme, state }) {
    this._clearSession();
    this.content = content;
    this.theme = theme;
    this._lastState = state;
    const q = QUALITY_TIERS[this.qualityTier];

    // Sky, fog, lights -----------------------------------------------------
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, 30, 90);
    this.renderer.toneMappingExposure = theme.exposure ?? 1;

    this.hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 1.35);
    this.hemi.layers.enableAll();
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(theme.key, theme.keyIntensity);
    this.keyLight.position.set(9, 14, 10);
    this.keyLight.layers.enableAll();
    this.keyLight.castShadow = q.shadow > 0;
    this.keyLight.shadow.mapSize.set(q.shadowMap || 1024, q.shadowMap || 1024);
    this.keyLight.shadow.bias = -0.002;
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 50;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.fill = new THREE.DirectionalLight(theme.hemiSky, 0.35);
    this.fill.layers.enableAll();
    this.fill.position.set(-8, 6, -6);
    this.scene.add(this.fill);

    // House ----------------------------------------------------------------
    this.house = buildHouse(content.layout, theme, q.detail);
    this.scene.add(this.house.group);
    const ext = this.house.houseExtent;
    const sc = this.keyLight.shadow.camera;
    sc.left = -ext * 1.6; sc.right = ext * 1.6; sc.top = ext * 1.6; sc.bottom = -ext * 1.6;
    sc.updateProjectionMatrix();
    this.keyLight.position.set(ext * 0.9, ext * 1.5, ext * 1.1);
    this.keyLight.target.position.copy(this.house.houseCenter);
    this.rig.frameHouse(this.house.houseCenter, { w: this.house.houseW, h: this.house.houseH + 0.6 }, true);

    // Tray plank -----------------------------------------------------------
    const n = content.tray.length;
    const trayW = Math.max(this.house.houseW * 0.7, n * 1.15 + 1);
    const trayZ = ROOM_D / 2 + 2.1;
    const plankParts = new THREE.Mesh(
      new THREE.BoxGeometry(trayW, 0.16, 1.3),
      new THREE.MeshStandardMaterial({ color: theme.trim, roughness: 0.9 }),
    );
    plankParts.position.set(0, -0.08, trayZ);
    plankParts.receiveShadow = true;
    plankParts.layers.set(LAYERS.ENV);
    this.trayPlank = plankParts;
    this.scene.add(plankParts);
    this.trayAnchors = [];
    for (let i = 0; i < Math.max(n, 8); i++) {
      const t = (i + 0.5) / Math.max(n, 1);
      this.trayAnchors.push(new THREE.Vector3(THREE.MathUtils.lerp(-trayW / 2 + 0.7, trayW / 2 - 0.7, Math.min(t, 0.98)), 0, trayZ));
    }

    // Pieces ---------------------------------------------------------------
    this.av = new RngStream(deriveSeed('av', content.seed));
    for (const key of Object.keys(content.items)) {
      const group = makePiece(key);
      this.scene.add(group);
      const rec = {
        key, group,
        pos: new THREE.Vector3(0, -3, 0), target: new THREE.Vector3(0, -3, 0),
        vel: { x: { out: 0 }, y: { out: 0 }, z: { out: 0 } },
        lift: 0, targetLift: 0, liftVel: { out: 0 },
        phase: this.av.next() * Math.PI * 2,
        spin: 0, faceYaw: 0,
        slotRef: null, trayIndex: -1,
      };
      this.pieces.set(key, rec);
      group.position.copy(rec.pos);
    }

    // Slot pick discs ------------------------------------------------------
    this.pickMeshes = [];
    const pickGeo = new THREE.CircleGeometry(0.55, 10);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.slotPick = [];
    for (const [roomId, anchor] of this.house.roomAnchors) {
      anchor.slots.forEach((pos, slot) => {
        const m = new THREE.Mesh(pickGeo, pickMat);
        m.rotation.x = -Math.PI / 2;
        m.position.copy(pos).y += 0.02;
        m.userData.slotRef = { room: roomId, slot };
        m.layers.set(LAYERS.GAME);
        this.scene.add(m);
        this.slotPick.push(m);
        this.pickMeshes.push(m);
      });
    }
    for (const rec of this.pieces.values()) {
      rec.group.traverse(o => { if (o.isMesh) this.pickMeshes.push(o); });
    }

    this.vfx.clear();
    this.syncState(state);
    this._resize();
  }

  _clearSession() {
    if (!this.scene) return;
    const dispose = (obj) => {
      obj.traverse(o => {
        if (o.isMesh || o.isPoints) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => { if (m && !m.userData?.shared) m.dispose?.(); });
        }
      });
    };
    for (const child of [...this.scene.children]) {
      if (child === this.rig.camera || child === this.vfx?.points) continue;
      if (this.vfx && this.vfx.rings.some(r => r.mesh === child)) continue;
      dispose(child);
      this.scene.remove(child);
    }
    // Keep marker meshes; rebuild them.
    this._buildMarkers();
    this.pieces.clear();
    this.pickMeshes = [];
    this._ghost = null; this._outline = null; this._selected = null;
  }

  _buildMarkers() {
    const ringGeo = new THREE.RingGeometry(0.3, 0.4, 24);
    const mk = (color, opacity = 0.9) => {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.layers.set(LAYERS.GHOST);
      m.raycast = () => {};
      this.scene?.add(m);
      return m;
    };
    if (this._selRing) { this.scene.remove(this._selRing); this.scene.remove(this._hoverRing); this.scene.remove(this._invalidRing); this.scene.remove(this._cursorMark); this.scene.remove(this._slotMarkers); }
    this._selRing = mk(SELECT_COLOR);
    this._hoverRing = mk(0xffffff);
    this._invalidRing = mk(INVALID_COLOR);
    // Slot markers: instanced rings for legal targets.
    this._slotMarkers = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: LEGAL_COLOR, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }), 48);
    this._slotMarkers.rotation.x = -Math.PI / 2;
    this._slotMarkers.count = 0;
    this._slotMarkers.visible = false;
    this._slotMarkers.layers.set(LAYERS.GHOST);
    this._slotMarkers.raycast = () => {};
    this.scene?.add(this._slotMarkers);
    // Keyboard/gamepad cursor diamond.
    this._cursorMark = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.14),
      new THREE.MeshBasicMaterial({ color: SELECT_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this._cursorMark.visible = false;
    this._cursorMark.layers.set(LAYERS.GHOST);
    this._cursorMark.raycast = () => {};
    this.scene?.add(this._cursorMark);
  }

  // -------------------------------------------------------------- snapshots
  /** Full deterministic sync from an immutable snapshot. */
  syncState(state) {
    this._lastState = state;
    if (!this.house) return;
    const trayList = state.tray.slice();
    for (const rec of this.pieces.values()) {
      const placed = this._findItem(state, rec.key);
      if (placed) {
        const anchor = this.house.roomAnchors.get(placed.roomId);
        rec.target.copy(anchor.slots[placed.slot]);
        rec.slotRef = placed;
        rec.trayIndex = -1;
      } else {
        const ti = trayList.indexOf(rec.key);
        rec.trayIndex = ti;
        rec.slotRef = null;
        rec.target.copy(this.trayAnchors[ti] ?? this.trayAnchors[0]);
      }
    }
  }

  _findItem(state, key) {
    for (const room of state.rooms) {
      const i = room.slots.indexOf(key);
      if (i >= 0) return { roomId: room.id, slot: i };
    }
    return null;
  }

  /** Skip/fast-forward: every object settles into the exact end state. */
  settleAll(state) {
    this.syncState(state);
    for (const rec of this.pieces.values()) {
      rec.pos.copy(rec.target);
      rec.group.position.copy(rec.pos);
      rec.lift = 0; rec.targetLift = 0; rec.spin = 0;
      rec.group.rotation.set(0, 0, 0);
    }
    this.vfx.clear();
  }

  /** Cosmetic playback of rule events (state already updated by rules). */
  playEvents(events, state) {
    this.syncState(state);
    for (const e of events) {
      if (e.type === 'placed' || e.type === 'moved') {
        const rec = this.pieces.get(e.item);
        if (rec) { rec.liftVel.out = 2.2; rec.targetLift = 0; }
        const pos = this._slotPos(e.room, e.slot);
        if (pos) this.vfx.placed(pos, this.av);
      } else if (e.type === 'removed') {
        const rec = this.pieces.get(e.item);
        if (rec) rec.liftVel.out = 1.6;
      } else if (e.type === 'beat') {
        const a = this.pieces.get(e.beat.a), b = this.pieces.get(e.beat.b);
        if (a && b) {
          a.spin = 0.9; b.spin = 0.9;
          const mid = a.target.clone().add(b.target).multiplyScalar(0.5).setY(a.target.y + 0.7);
          this.vfx.beat(mid, e.beat.sig === 1, e.beat.hab === 1, this.av);
          if (e.beat.sig) this.rig.shake(0.035);
        }
      } else if (e.type === 'card') {
        const c = this.house?.houseCenter.clone().setY(this.house.houseH * 0.7) ?? new THREE.Vector3();
        this.vfx.card(c, this.av);
      } else if (e.type === 'invalid') {
        // surfaced by UI at the attempted target; small nudge here
        this.rig.shake(0.012);
      } else if (e.type === 'gameover') {
        const c = this.house?.houseCenter.clone() ?? new THREE.Vector3();
        this.vfx.fanfare(c, this.av);
        this.vfx.fanfare(c.clone().add(new THREE.Vector3(1.5, 0.5, 0)), this.av);
        this.vfx.fanfare(c.clone().add(new THREE.Vector3(-1.5, 0.5, 0)), this.av);
      }
    }
  }

  _slotPos(roomId, slot) {
    return this.house?.roomAnchors.get(roomId)?.slots[slot] ?? null;
  }
  piecePos(key) { return this.pieces.get(key)?.target ?? null; }
  roomIds() { return this.house ? [...this.house.roomAnchors.keys()] : []; }

  // ------------------------------------------------------------- selection
  setSelection(itemKey, legalSlots = []) {
    this._selected = itemKey;
    // Clean previous ghost/outline.
    if (this._ghost) { this.scene.remove(this._ghost); this._ghost = null; }
    if (this._outline) { this.scene.remove(this._outline); this._outline = null; }
    this._selRing.visible = false;
    for (const rec of this.pieces.values()) rec.targetLift = 0;

    if (itemKey) {
      const rec = this.pieces.get(itemKey);
      if (rec) {
        rec.targetLift = 0.34;
        this._outline = makeOutline(rec.group, SELECT_COLOR);
        this._outline.position.copy(rec.group.position);
        this.scene.add(this._outline);
        this._selRing.visible = true;
        this._selRing.position.copy(rec.target).y += 0.02;
      }
    }
    // Legal target markers.
    const m = new THREE.Matrix4();
    let count = 0;
    for (const ls of legalSlots) {
      const pos = this._slotPos(ls.room, ls.slot);
      if (!pos || count >= 48) continue;
      m.makeTranslation(pos.x, pos.y + 0.02, pos.z);
      this._slotMarkers.setMatrixAt(count++, m);
    }
    this._slotMarkers.count = count;
    this._slotMarkers.visible = count > 0;
    this._slotMarkers.instanceMatrix.needsUpdate = true;
  }

  /** Hover feedback + ghost preview at a legal slot; invalid feedback otherwise. */
  setHoverTarget(slotRef, itemKey, valid) {
    this._hoverRing.visible = false;
    this._invalidRing.visible = false;
    if (this._ghost) { this.scene.remove(this._ghost); this._ghost = null; }
    if (!slotRef) return;
    const pos = this._slotPos(slotRef.room, slotRef.slot);
    if (!pos) return;
    if (valid && itemKey) {
      const rec = this.pieces.get(itemKey);
      if (rec) {
        this._ghost = makeGhost(rec.group);
        this._ghost.position.copy(pos);
        this.scene.add(this._ghost);
      }
      this._hoverRing.visible = true;
      this._hoverRing.position.copy(pos).y += 0.025;
    } else if (!valid) {
      this._invalidRing.visible = true;
      this._invalidRing.position.copy(pos).y += 0.025;
    }
  }

  setCursor(pos) {
    if (!pos) { this._cursorMark.visible = false; return; }
    this._cursorMark.visible = true;
    this._cursorMark.position.copy(pos);
  }

  focusRoom(roomId) {
    const anchor = this.house?.roomAnchors.get(roomId);
    if (anchor) this.rig.focusRoom(anchor.center);
  }
  resetCamera() { this.rig.reset(); }
  orbit(dx, dy) { this.rig.orbit(dx, dy); }
  zoom(d) { this.rig.zoom(d); }

  // ---------------------------------------------------------------- picking
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.rig.camera);
    this._raycaster.layers.set(LAYERS.GAME);
    const hits = this._raycaster.intersectObjects(this.pickMeshes, false);
    for (const h of hits) {
      if (h.object.userData.slotRef) return { kind: 'slot', ...h.object.userData.slotRef, point: h.point };
      if (h.object.userData.pieceKey) return { kind: 'piece', key: h.object.userData.pieceKey, point: h.point };
    }
    return null;
  }

  worldOnGround(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.rig.camera);
    const out = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(this._groundPlane, out) ? out : null;
  }

  // ------------------------------------------------------------------ loop
  setRunning(on) {
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this._last = performance.now();
      const tick = (t) => {
        if (!this.running) return;
        this._raf = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (t - this._last) / 1000);
        this._last = t;
        this._frame(dt);
      };
      this._raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(this._raf);
    }
  }

  _frame(dt) {
    this.time += dt;
    // FPS monitor: auto quality steps down before touching simulation.
    if (this.autoQuality) {
      this._fpsAcc += dt; this._fpsN++;
      this._fpsWindow += dt;
      if (this._fpsWindow > 3) {
        const avg = this._fpsAcc / this._fpsN;
        this._fpsAcc = 0; this._fpsN = 0; this._fpsWindow = 0;
        if (avg > 0.024) {
          const order = ['high', 'medium', 'low'];
          const i = order.indexOf(this.qualityTier);
          if (i < order.length - 1) {
            this.setQualityTier(order[i + 1]);
            this.hooks.onTierChange?.(order[i + 1]);
          }
        }
      }
    }

    this.rig.update(dt);

    // Piece springs, fixed 120 Hz substeps.
    let remaining = dt;
    const step = 1 / 120;
    while (remaining > 1e-6) {
      const h = Math.min(step, remaining);
      remaining -= h;
      for (const rec of this.pieces.values()) {
        rec.pos.x = spring(rec.pos.x, rec.target.x, rec.vel.x, h);
        rec.pos.y = spring(rec.pos.y, rec.target.y, rec.vel.y, h);
        rec.pos.z = spring(rec.pos.z, rec.target.z, rec.vel.z, h);
        rec.lift = spring(rec.lift, rec.targetLift, rec.liftVel, h);
      }
    }
    for (const rec of this.pieces.values()) {
      let bob = 0;
      if (!this.reducedMotion) bob = Math.sin(this.time * 1.6 + rec.phase) * 0.018;
      rec.group.position.set(rec.pos.x, rec.pos.y + rec.lift + bob, rec.pos.z);
      if (rec.spin > 0) {
        rec.spin = Math.max(0, rec.spin - dt);
        const k = rec.spin / 0.9;
        rec.group.rotation.y = (1 - k) * Math.PI * 2 * (this.reducedMotion ? 0 : 1);
        rec.group.position.y += Math.sin((1 - k) * Math.PI) * 0.3;
      } else {
        rec.group.rotation.y *= 0.9;
      }
      const selScale = rec.key === this._selected ? 1.07 : 1;
      rec.group.scale.setScalar(selScale);
    }
    if (this._outline && this._selected) {
      const rec = this.pieces.get(this._selected);
      if (rec) {
        this._outline.position.copy(rec.group.position);
        this._outline.rotation.copy(rec.group.rotation);
      }
    }
    if (this._selRing?.visible && !this.reducedMotion) {
      const s = 1 + Math.sin(this.time * 4) * 0.08;
      this._selRing.scale.setScalar(s);
    }
    if (this._cursorMark?.visible && !this.reducedMotion) {
      this._cursorMark.rotation.y = this.time * 2.2;
      this._cursorMark.position.y += Math.sin(this.time * 3) * 0.002;
    }

    // VFX fixed 60 Hz.
    this._vfxAcc = (this._vfxAcc || 0) + dt;
    const vstep = 1 / 60;
    while (this._vfxAcc >= vstep) { this._vfxAcc -= vstep; this.vfx.update(vstep); }

    this.renderer.render(this.scene, this.rig.camera);
  }

  _resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
  }

  captureThumbnail() {
    this.renderer.render(this.scene, this.rig.camera);
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = 168; c.height = 112;
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    try { return c.toDataURL('image/png'); } catch { return null; }
  }

  dispose() {
    this.setRunning(false);
    this._resizeObserver?.disconnect();
    this._clearSession();
    this.renderer?.dispose();
  }
}

function spring(current, target, velocity, dt) {
  const omega = 14;
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * current + dt * velocity.out + hhoo * target;
  const detV = velocity.out + hoo * (target - current);
  velocity.out = detV * detInv;
  return detX * detInv;
}
