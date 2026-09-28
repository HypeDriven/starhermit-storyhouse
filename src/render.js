// render.js — Three.js scene graph, semantic entity views, camera, lighting,
// VFX, quality tiers. Rendering consumes immutable snapshots + events; it
// never mutates rules state. No-post baseline: hierarchy, depth, selection,
// and state read clearly without any post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CameraRig, FRAMING } from './render/camera.js';
import { buildHouse, ROOM_D } from './render/house.js';
import { makePiece, makeGhost, makeOutline } from './render/pieces.js';
import { VfxPool } from './render/vfx.js';
import { RngStream, deriveSeed } from './rng.js';
import { detectPreset, describe, resolve, SHADOW_MAP, PARTICLE_CAP } from './gfx.js';

export const LAYERS = { ENV: 0, GAME: 1, GHOST: 2, VFX: 3 };

// Colour grade + vignette, applied in display space after tone mapping:
// a gentle S-curve, a touch more saturation, warm highlights / cool shadows.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.035, 1.0, 0.965), smoothstep(0.2, 0.8, l));
      c = mix(c, clamp(s * 0.95, 0.0, 1.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Bloom works on HDR scene colour before tone mapping: lit walls peak near
// 1.2, so only emissive accents (lamp shades, window glow, sparks) pass.
const BLOOM = { strength: 0.5, radius: 0.5, threshold: 1.5 };
const MOTE_COUNT = 140;

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
    this.gfxSaved = {};
    this.q = resolve({}, 'balanced');
    this.gpu = '';
    this.detected = 'balanced';
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.size = [0, 0];
    this._backdrop = null;   // null | 'static' | 'animated'
    this._envTex = null;
    this.reducedMotion = false;
    this.running = false;
    this._raf = 0;
    this._last = 0;

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
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gpu = Stage._gpuName(this.renderer);
    const mobile = !!(window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches);
    this.detected = detectPreset(this.gpu, { mobile });
    this.composer = null; this.postKey = null; this._envTex = null;

    this.scene = new THREE.Scene();
    this.scene.add(this.rig.camera);
    this.rig.camera.layers.enable(LAYERS.GAME);
    this.rig.camera.layers.enable(LAYERS.GHOST);
    this.rig.camera.layers.enable(LAYERS.VFX);

    this.vfx = new VfxPool(this.scene, PARTICLE_CAP.high);
    this._buildMarkers();
    this._buildMotes();
    // init() runs again after a context restore: the canvas keeps its listeners
    // and observer from the first pass, so neither may be registered twice.
    if (!this._contextLossBound) { this._bindContextLoss(); this._contextLossBound = true; }
    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
    this.setGraphics(this.gfxSaved);
    this._resize();
    return true;
  }

  static _gpuName(r) {
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch { return ''; }
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
      this.composer?.dispose();
      this.composer = null;
      this.renderer.dispose();
      const state = this._lastState, content = this.content, theme = this.theme;
      const backdrop = this._backdrop;
      this.init();
      if (content) this.startSession({ content, theme, state });
      this._backdrop = backdrop;
      this.hooks.onContextRestored?.();
    });
  }

  // ------------------------------------------------------------------ setup
  /** Apply saved graphics settings (see gfx.js) live — no reload. */
  setGraphics(saved = {}) {
    this.gfxSaved = saved || {};
    if (!this.renderer) return;
    const prev = this.q;
    const g = resolve(this.gfxSaved, this.detected);
    this.q = g;
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    if (this.keyLight) {
      this.keyLight.castShadow = size > 0;
      if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
        this.keyLight.shadow.mapSize.set(size, size);
        this.keyLight.shadow.map?.dispose();
        this.keyLight.shadow.map = null;
      }
    }
    this.vfx?.setCap(PARTICLE_CAP[g.particles]);
    // With bloom on, sparks are pushed into HDR so they glow.
    if (this.vfx) this.vfx.points.material.color.setScalar(g.bloom === 'on' ? 1.9 : 1);
    this._applyReflections();
    this._applyDetail(prev);
    this._applyMotion();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    document.body.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxAuto = g.auto ? '1' : '0';
    this.canvas.dataset.gfxPreset = g.preset;
    // Materials pick up shadow-map / environment changes on recompile.
    this.scene?.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.needsUpdate = true;
    });
    this._resize();
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost. */
  graphicsInfo(words) {
    const ratio = this._targetRatio();
    const px = [Math.round(this.size[0] * ratio), Math.round(this.size[1] * ratio)];
    return {
      gpu: this.gpu,
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, words),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _targetRatio() {
    return Math.min(window.devicePixelRatio || 1, this.q.cap) * this.q.scale * this.adaptiveScale;
  }

  _applyReflections() {
    if (!this.scene) return;
    const on = this.q.reflections === 'on';
    if (on && !this._envTex) {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment(this.renderer);
        this._envTex = pmrem.fromScene(room, 0.04).texture;
        room.dispose?.();
        pmrem.dispose();
      } catch { this._envTex = null; }
    }
    // Reflections light the pieces only (glazed, lacquered and metal parts);
    // the house keeps its hemisphere-lit palette so play colours stay put.
    const env = on ? this._envTex : null;
    for (const rec of this.pieces.values()) {
      rec.group.traverse(o => {
        if (o.isMesh && o.material?.isMeshStandardMaterial && o.material.envMap !== env) {
          o.material.envMap = env;
          o.material.needsUpdate = true;
        }
      });
    }
  }

  _applyDetail(prev) {
    const detailed = this.q.detail === 'detailed';
    if (this.house?.detailUniform) this.house.detailUniform.value = detailed ? 1 : 0;
    // Room dressing geometry depends on detail: rebuild the house shell in place.
    if (this.house && prev && prev.detail !== this.q.detail && this.content) {
      this.scene.remove(this.house.group);
      this.house.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      this.house.envMat.dispose();
      this.house.groundMat?.dispose();
      this.house = buildHouse(this.content.layout, this.theme, detailed ? 1 : 0);
      this.house.detailUniform.value = detailed ? 1 : 0;
      this.scene.add(this.house.group);
    }
  }

  _applyMotion() {
    if (this._motes) this._motes.visible = this.q.particles === 'high' && !this.reducedMotion && !!this.house;
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.rig.camera));
      if (g.ao !== 'off') {
        const hi = g.ao === 'high';
        const ao = new GTAOPass(this.scene, this.rig.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM.strength, BLOOM.radius, BLOOM.threshold));
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
      this.hooks.onGraphicsInfo?.();
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _render(dtSec) {
    const rescale = this._adapt(dtSec * 1000);
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || window.innerWidth, h = el.clientHeight || window.innerHeight;
    const ratio = this._targetRatio();
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.rig.resize(w / h);
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(dtSec); return; } catch {
        this.postFailed = true;
        this.composer = null;
        this.hooks.onGraphicsInfo?.();
      }
    }
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Title-screen backdrop: a furnished house with a slow, gentle camera sway. */
  setBackdrop(mode) {
    this._backdrop = mode || null;
    this._applyMotion();
  }
  get backdrop() { return this._backdrop; }

  _buildMotes() {
    // Dust motes drifting through the rooms' light: ambient motion only.
    const geo = new THREE.BufferGeometry();
    this._motePos = new Float32Array(MOTE_COUNT * 3);
    this._moteSeed = new Float32Array(MOTE_COUNT * 4);
    const rng = new RngStream(0x5d0f);
    for (let i = 0; i < MOTE_COUNT * 4; i++) this._moteSeed[i] = rng.next();
    geo.setAttribute('position', new THREE.BufferAttribute(this._motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this._motes = new THREE.Points(geo, new THREE.PointsMaterial({
      color: new THREE.Color(1.25, 1.1, 0.85), size: 0.035, sizeAttenuation: true,
      transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this._motes.frustumCulled = false;
    this._motes.layers.set(LAYERS.VFX);
    this._motes.raycast = () => {};
    this._motes.visible = false;
    this.scene.add(this._motes);
  }

  _updateMotes() {
    if (!this._motes?.visible || !this.house) return;
    const hw = this.house.houseW / 2, hh = this.house.houseH, t = this.time;
    const p = this._motePos, sd = this._moteSeed;
    const span = Math.max(0.5, hh - 0.4);
    for (let i = 0; i < MOTE_COUNT; i++) {
      const a = sd[i * 4], b = sd[i * 4 + 1], c = sd[i * 4 + 2], d = sd[i * 4 + 3];
      p[i * 3] = (a * 2 - 1) * hw * 0.92 + Math.sin(t * (0.13 + c * 0.1) + d * 6.28) * 0.35;
      p[i * 3 + 1] = 0.25 + ((b * span + t * (0.04 + c * 0.05)) % span);
      p[i * 3 + 2] = (d * 2 - 1) * ROOM_D * 0.4 + Math.cos(t * (0.11 + a * 0.1) + c * 6.28) * 0.25;
    }
    this._motes.geometry.attributes.position.needsUpdate = true;
  }

  setReducedMotion(on) {
    this.reducedMotion = on;
    this.rig.reducedMotion = on;
    if (this.vfx) this.vfx.enabled = !on; // reduced motion: no particles/rings, timing preserved
    this._applyMotion();
  }

  startSession({ content, theme, state }) {
    this._clearSession();
    this.content = content;
    this.theme = theme;
    this._lastState = state;
    this._backdrop = null;
    const q = this.q;
    const shadowSize = SHADOW_MAP[q.shadows];

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
    this.keyLight.castShadow = shadowSize > 0;
    this.keyLight.shadow.mapSize.set(shadowSize || 1024, shadowSize || 1024);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.025;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.fill = new THREE.DirectionalLight(theme.hemiSky, 0.35);
    this.fill.layers.enableAll();
    this.fill.position.set(-8, 6, -6);
    this.scene.add(this.fill);

    // House ----------------------------------------------------------------
    this.house = buildHouse(content.layout, theme, q.detail === 'detailed' ? 1 : 0);
    this.house.detailUniform.value = q.detail === 'detailed' ? 1 : 0;
    this.scene.add(this.house.group);
    const ext = this.house.houseExtent;
    this.keyLight.position.set(ext * 0.9, ext * 1.5, ext * 1.1);
    this.keyLight.target.position.copy(this.house.houseCenter);
    this._fitShadow();
    this._applyMotion();
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
    this._applyReflections();
    this.syncState(state);
    this._resize();
  }

  /** Fit the key light's shadow frustum tightly around the house and tray. */
  _fitShadow() {
    const h = this.house, sc = this.keyLight.shadow.camera;
    const hw = h.houseW / 2 + 0.7;
    const zMin = -ROOM_D / 2 - 0.5, zMax = ROOM_D / 2 + 3.0;
    const yMin = -0.3, yMax = h.houseH + 1.3;
    const view = new THREE.OrthographicCamera();
    view.position.copy(this.keyLight.position);
    view.lookAt(this.keyLight.target.position);
    view.updateMatrixWorld();
    const inv = view.matrixWorldInverse;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
    const v = new THREE.Vector3();
    for (const x of [-hw, hw]) for (const y of [yMin, yMax]) for (const z of [zMin, zMax]) {
      v.set(x, y, z).applyMatrix4(inv);
      min.min(v); max.max(v);
    }
    const pad = 0.3;
    sc.left = min.x - pad; sc.right = max.x + pad; sc.bottom = min.y - pad; sc.top = max.y + pad;
    sc.near = Math.max(0.1, -max.z - 1); sc.far = -min.z + 1;
    sc.updateProjectionMatrix();
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
      if (child === this.rig.camera || child === this.vfx?.points || child === this._motes) continue;
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
    // The ring lies flat via the geometry itself: rotating the instanced
    // parent would also rotate every instance translation, putting the glowing
    // markers somewhere other than the pick discs they advertise.
    const flatRingGeo = ringGeo.clone().rotateX(-Math.PI / 2);
    this._slotMarkers = new THREE.InstancedMesh(flatRingGeo, new THREE.MeshBasicMaterial({ color: LEGAL_COLOR, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }), 48);
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
    if (this._backdrop === 'animated' && !this.reducedMotion) {
      this.rig.yaw = Math.sin(this.time * 0.11) * 0.42;
      this.rig.pitch = FRAMING.pitch + Math.sin(this.time * 0.07) * 0.06;
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
    this._updateMotes();

    this._render(dt);
  }

  _resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.size = [w, h];
    this.pixelRatio = this._targetRatio();
    this.renderer.setPixelRatio(this.pixelRatio);
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
    this.composer?.dispose();
    this._envTex?.dispose();
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
