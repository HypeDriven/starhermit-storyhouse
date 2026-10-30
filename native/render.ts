// The dollhouse on starhermit:scene, as the browser build's src/render.js drew
// it with three.js r160: the sky colour and fog, the hemisphere, key and fill
// lights, the cutaway house (house.ts), the tray plank in front with the
// pieces waiting on it (pieces.ts), the invisible pick discs on every slot,
// the selection (lift, inverted-hull outline, pulsing ring, glowing rings on
// every legal spot), the drag ghost and its hover / invalid rings, the
// keyboard cursor diamond, spring-animated pieces (bobbing, spinning on a
// story beat), the sparks and rings (vfx.ts), the dust motes, the authored
// orbit camera (camera.ts) and the title backdrop (a furnished demo house,
// still or with a slow sway). Rendering reads rules state and never writes it.
//
// From three.js r160 (physically based lights): colours, the hemisphere,
// key and fill light intensities, the shadow's bias / normalBias / radius and
// its fitted box as written (minor 29). render.js's `new RoomEnvironment(this.renderer)` (r160: the
// bright room) is kept as written, through PMREMGenerator.fromScene at sigma
// 0.04, and set as each piece material's own envMap at its old
// envMapIntensity (the house keeps its hemisphere-lit palette), as render.js
// did with Reflections on. The old composer (RenderPass in half floats →
// GTAO → UnrealBloom 0.5 / 0.5 / 1.5 (bloom.model "r160", the page's strength) → OutputPass with ACES at the theme's
// exposure → the colour grade + vignette in display space → SMAA / FXAA, or
// MSAA on the target) is the runtime's renderer.ao / bloom / grade /
// antialias. The canvas filled the window behind the HUD, as the camera does.
import {
  ACESFilmicToneMapping, AdditiveBlending, Box3, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, DirectionalLight, DoubleSide,
  DynamicDrawUsage, Fog, Group, HemisphereLight, InstancedMesh, MathUtils, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshStandardMaterial, OctahedronGeometry, OrthographicCamera, PMREMGenerator, Points, PointsMaterial, Raycaster, RingGeometry, RoomEnvironment, Vector2,
  Vector3, pointerToNdc, renderer, scene, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, createImageBitmap } from "starhermit:canvas";
import { compress } from "starhermit:engine";
import { CameraRig, FRAMING } from "./camera.ts";
import { buildHouse, ROOM_D, type House } from "./house.ts";
import { envMaterials, makeGhost, makeOutline, makePiece, setPieceBudget } from "./pieces.ts";
import { VfxPool } from "./vfx.ts";
import { MOTE_MAX, PARTICLE_MAX, particleCap, type Look } from "./quality.ts";
import { Rngs, type Content, type Event, type Rng, type State, type Theme } from "./game.ts";

export interface Rect { x: number; y: number; width: number; height: number }
export interface SlotRef { room: string; slot: number }
export type Hit = { kind: "slot"; room: string; slot: number } | { kind: "piece"; key: string } | null;

const SELECT_COLOR = 0xffd166, LEGAL_COLOR = 0xf2e8d0, INVALID_COLOR = 0xd95d4e;
const BLOOM = { strength: 0.5, radius: 0.5, threshold: 1.5 };

const rig = new CameraRig();
const hemi = new HemisphereLight(0xffffff, 0x888888, 1.35);
const keyLight = new DirectionalLight(0xffffff, 2.6);
const fill = new DirectionalLight(0xffffff, 0.35);
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.025;
keyLight.shadow.radius = 3;
fill.position.set(-8, 6, -6);
scene.add(hemi, keyLight, keyLight.target, fill);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const vfx = new VfxPool(scene, PARTICLE_MAX);
let look: Look | null = null;
let reducedMotion = false;
let envTex: Texture | null = null;
let backdrop: Look["backdrop"] | null = null;
let time = 0;
let active = false;

// ---------------------------------------------------------------- markers (render.js _buildMarkers)
const ringGeo = new RingGeometry(0.3, 0.4, 24);
function marker(color: number, opacity = 0.9): Mesh {
  const m = new Mesh(ringGeo, new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  scene.add(m);
  return m;
}
const selRing = marker(SELECT_COLOR), hoverRing = marker(0xffffff), invalidRing = marker(INVALID_COLOR);
// Legal-target rings, instanced; the ring lies flat in its geometry so each instance sits exactly on its pick disc.
const slotMarkers = new InstancedMesh(new RingGeometry(0.3, 0.4, 24).rotateX(-Math.PI / 2),
  new MeshBasicMaterial({ color: LEGAL_COLOR, transparent: true, opacity: 0.75, depthWrite: false, side: DoubleSide }), 48);
slotMarkers.count = 0;
slotMarkers.visible = false;
scene.add(slotMarkers);
const cursorMark = new Mesh(new OctahedronGeometry(0.14), new MeshBasicMaterial({ color: SELECT_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
cursorMark.visible = false;
cursorMark.renderOrder = 10;
scene.add(cursorMark);

// ---------------------------------------------------------------- dust motes
const motePos = new Float32Array(MOTE_MAX * 3), moteSeed = new Float32Array(MOTE_MAX * 4);
{
  const r = new Rngs.RngStream(0x5d0f);
  for (let i = 0; i < MOTE_MAX * 4; i++) moteSeed[i] = r.next();
}
const moteGeo = new BufferGeometry();
const moteAttr = new BufferAttribute(motePos, 3).setUsage(DynamicDrawUsage);
moteGeo.setAttribute("position", moteAttr);
const motes = new Points(moteGeo, new PointsMaterial({
  color: new Color(1.25, 1.1, 0.85), size: 0.035, sizeAttenuation: true, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending,
}));
motes.frustumCulled = false;
motes.visible = false;
scene.add(motes);
let moteCount = 0;

// ---------------------------------------------------------------- the session's objects
interface PieceRec {
  key: string; group: Group; pos: Vector3; target: Vector3; vel: { x: { out: number }; y: { out: number }; z: { out: number } };
  lift: number; targetLift: number; liftVel: { out: number }; phase: number; spin: number;
  /** Its size (for its named target on screen). */
  h: number; r: number;
}
let world: Group | null = null;
let house: House | null = null;
let content: Content | null = null;
let theme: Theme | null = null;
let lastState: State | null = null;
const pieces = new Map<string, PieceRec>();
export let trayAnchors: Vector3[] = [];
let pickMeshes: Object3D[] = [];
let av: Rng = new Rngs.RngStream(1);
let selected: string | null = null;
let legal: SlotRef[] = [];
let ghost: Group | null = null;
let outline: Group | null = null;
let builtKey = "";
const raycaster = new Raycaster();
const ndc = new Vector2();
let win = { w: 1, h: 1 };

function disposeTree(obj: Object3D): void {
  obj.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) (m as Material).dispose();
    }
  });
}
function clearSession(): void {
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (outline) { scene.remove(outline); outline = null; }
  if (world) { scene.remove(world); disposeTree(world); world = null; }
  envMaterials.clear();
  pieces.clear();
  pickMeshes = [];
  house = null;
  selected = null;
  legal = [];
  for (const m of [selRing, hoverRing, invalidRing, cursorMark]) m.visible = false;
  slotMarkers.count = 0;
  slotMarkers.visible = false;
  vfx.clear();
}

/** render.js startSession: the theme's sky and lights, the house, tray, pieces and pick discs. */
export function startSession(c: Content, th: Theme, state: State): void {
  clearSession();
  content = c; theme = th; lastState = state;
  backdrop = null;
  const q = look!;
  scene.background = new Color(th.sky);
  scene.fog = new Fog(th.fog, 30, 90);
  renderer.toneMappingExposure = th.exposure ?? 1;
  hemi.color.set(th.hemiSky); hemi.groundColor.set(th.hemiGround);
  keyLight.color.set(th.key); keyLight.intensity = th.keyIntensity;
  fill.color.set(th.hemiSky);
  world = new Group();
  scene.add(world);
  builtKey = `${q.budget.material}|${q.budget.seg}|${q.detailed}`;
  setPieceBudget(q.budget);
  house = buildHouse(c.layout, th, q.detailed ? 1 : 0, q.budget);
  world.add(house.group);
  const ext = house.houseExtent;
  keyLight.position.set(ext * 0.9, ext * 1.5, ext * 1.1);
  keyLight.target.position.copy(house.houseCenter);
  rig.frameHouse(house.houseCenter, { w: house.houseW, h: house.houseH + 0.6 }, true);
  applyShadows();

  // Tray plank
  const n = c.tray.length;
  const trayW = Math.max(house.houseW * 0.7, n * 1.15 + 1);
  const trayZ = ROOM_D / 2 + 2.1;
  const plankMat = q.budget.material === "lambert" ? new MeshLambertMaterial({ color: th.trim }) : new MeshStandardMaterial({ color: th.trim, roughness: 0.9 });
  const plank = new Mesh(new BoxGeometry(trayW, 0.16, 1.3), plankMat);
  plank.position.set(0, -0.08, trayZ);
  plank.receiveShadow = true;
  world.add(plank);
  trayAnchors = [];
  for (let i = 0; i < Math.max(n, 8); i++) {
    const t = (i + 0.5) / Math.max(n, 1);
    trayAnchors.push(new Vector3(MathUtils.lerp(-trayW / 2 + 0.7, trayW / 2 - 0.7, Math.min(t, 0.98)), 0, trayZ));
  }
  // Pieces
  av = new Rngs.RngStream(Rngs.deriveSeed("av", c.seed));
  for (const key of Object.keys(c.items)) {
    const group = makePiece(key);
    const box = new Box3().setFromObject(group);
    const size = box.getSize(new Vector3());
    world.add(group);
    const rec: PieceRec = {
      key, group, pos: new Vector3(0, -3, 0), target: new Vector3(0, -3, 0), vel: { x: { out: 0 }, y: { out: 0 }, z: { out: 0 } },
      lift: 0, targetLift: 0, liftVel: { out: 0 }, phase: av.next() * Math.PI * 2, spin: 0,
      h: Math.max(0.15, size.y), r: Math.max(0.15, Math.min(0.45, Math.max(size.x, size.z) * 0.35)),
    };
    pieces.set(key, rec);
    group.position.copy(rec.pos);
  }
  // Slot pick discs (invisible, hit by rays at minor 18+)
  const pickGeo = new CircleGeometry(0.55, 10);
  const pickMat = new MeshBasicMaterial({ color: 0xffffff });
  for (const [roomId, anchor] of house.roomAnchors) {
    anchor.slots.forEach((pos, slot) => {
      const m = new Mesh(pickGeo, pickMat);
      m.rotation.x = -Math.PI / 2;
      m.position.copy(pos);
      m.position.y += 0.02;
      m.visible = false;
      m.userData.slotRef = { room: roomId, slot };
      world!.add(m);
      pickMeshes.push(m);
    });
  }
  for (const rec of pieces.values()) rec.group.traverse((o) => { if (o instanceof Mesh && !o.userData.contact) pickMeshes.push(o); });
  vfx.clear();
  applyReflections();
  applyMotion();
  syncState(state);
  settleAll(state);
}

function environment(): Texture | null {
  if (!envTex) {
    try {
      const pmrem = new PMREMGenerator(renderer);
      envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}
/** Reflections light the pieces only (glazed, lacquered and metal parts). */
function applyReflections(): void {
  const env = look?.reflections ? environment() : null;
  for (const m of envMaterials) m.envMap = env;
}
function applyShadows(): void {
  const sm = look?.shadows ?? 0;
  renderer.shadowMap.enabled = sm > 0;
  keyLight.castShadow = sm > 0;
  if (sm > 0) keyLight.shadow.mapSize = sm;
  if (house) fitShadow(house);
}
/** render.js _fitShadow: the key light's shadow box fitted tightly around the house and tray. */
function fitShadow(h: House): void {
  const sc = keyLight.shadow.camera as OrthographicCamera;
  const hw = h.houseW / 2 + 0.7;
  const zMin = -ROOM_D / 2 - 0.5, zMax = ROOM_D / 2 + 3.0;
  const yMin = -0.3, yMax = h.houseH + 1.3;
  const view = new OrthographicCamera();
  view.position.copy(keyLight.position);
  view.lookAt(keyLight.target.position);
  view.updateMatrixWorld();
  const inv = view.matrixWorldInverse;
  const min = new Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
  const v = new Vector3();
  for (const x of [-hw, hw]) for (const y of [yMin, yMax]) for (const z of [zMin, zMax]) {
    v.set(x, y, z).applyMatrix4(inv);
    min.min(v); max.max(v);
  }
  const pad = 0.3;
  sc.left = min.x - pad; sc.right = max.x + pad; sc.bottom = min.y - pad; sc.top = max.y + pad;
  sc.near = Math.max(0.1, -max.z - 1); sc.far = -min.z + 1;
  sc.updateProjectionMatrix();
}
function applyMotion(): void {
  motes.visible = look?.particles === "high" && !reducedMotion && !!house;
}

/** The runtime's quality tier applied live (render.js setGraphics). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  renderer.bloom = next.bloom ? { model: "r160", strength: BLOOM.strength, radius: BLOOM.radius, threshold: BLOOM.threshold, resolution: next.budget.bloomRes } : null;
  // GTAOPass: radius 0.45, distance exponent 1.4, thickness 1, 16 / 8 samples, the denoise per tier, blend 0.75.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader after OutputPass (display space): an 0.18-weight smoothstep S-curve, saturation 1.1, cool
  // shadows / warm highlights split by a 0.2–0.8 smoothstep of luma, clamp(s × 0.95) (levels), the 0.2 vignette 0.4–0.9 (y × 0.85).
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.1, split: [0.2, 0.8],
    shadows: [0.97, 0.98, 1.04], highlights: [1.035, 1.0, 0.965], levels: [0.95, 0],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.9, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
  vfx.setCap(particleCap(next));
  moteCount = Math.min(MOTE_MAX, next.budget.motes);
  moteGeo.setDrawRange(0, moteCount);
  // With bloom on, sparks are pushed into HDR so they glow.
  vfx.material.color.setScalar(next.bloom ? 1.9 : 1);
  applyShadows();
  applyMotion();
  // Another shading model, mesh detail or room dressing rebuilds the session's house from the retained content.
  const key = `${next.budget.material}|${next.budget.seg}|${next.detailed}`;
  if (content && theme && lastState && key !== builtKey) {
    const sel = selected, lg = legal, bd = backdrop;
    startSession(content, theme, lastState);
    backdrop = bd;
    applyMotion();
    if (sel) setSelection(sel, lg);
  } else applyReflections();
}

export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  rig.reducedMotion = on;
  vfx.enabled = !on;
  applyMotion();
}
/** Whether the 3D view draws (off: the title without a backdrop shows the plain page). */
export function setActive(on: boolean): void { active = on; renderer.camera = on ? rig.camera : null; }
export function isActive(): boolean { return active; }
/** The title backdrop: null (a story is open), "static" or "animated" (render.js setBackdrop). */
export function setBackdrop(mode: Look["backdrop"] | null): void { backdrop = mode; applyMotion(); }
export function hasHouse(): boolean { return !!house; }

// ---------------------------------------------------------------- snapshots and events
function findItem(state: State, key: string): { roomId: string; slot: number } | null {
  for (const room of state.rooms) {
    const i = room.slots.indexOf(key);
    if (i >= 0) return { roomId: room.id, slot: i };
  }
  return null;
}
/** Full deterministic sync from a snapshot. */
export function syncState(state: State): void {
  lastState = state;
  if (!house) return;
  for (const rec of pieces.values()) {
    const placed = findItem(state, rec.key);
    if (placed) rec.target.copy(house.roomAnchors.get(placed.roomId)!.slots[placed.slot]!);
    else {
      const ti = state.tray.indexOf(rec.key);
      rec.target.copy(trayAnchors[ti] ?? trayAnchors[0]!);
    }
  }
}
/** Skip / fast-forward: every object settles into the exact end state. */
export function settleAll(state: State): void {
  syncState(state);
  for (const rec of pieces.values()) {
    rec.pos.copy(rec.target);
    rec.group.position.copy(rec.pos);
    rec.lift = 0; rec.targetLift = rec.key === selected ? 0.34 : 0; rec.spin = 0;
    rec.vel.x.out = rec.vel.y.out = rec.vel.z.out = rec.liftVel.out = 0;
    rec.group.rotation.set(0, 0, 0);
  }
  vfx.clear();
}
function slotPos(roomId: string, slot: number): Vector3 | null { return house?.roomAnchors.get(roomId)?.slots[slot] ?? null; }
/** Cosmetic playback of rule events (the state already updated by the rules). */
export function playEvents(events: Event[], state: State): void {
  syncState(state);
  for (const e of events) {
    if (e.type === "placed" || e.type === "moved") {
      const rec = pieces.get(e.item!);
      if (rec) { rec.liftVel.out = 2.2; rec.targetLift = 0; }
      const pos = slotPos(e.room!, e.slot!);
      if (pos) vfx.placed(pos, av);
    } else if (e.type === "removed") {
      const rec = pieces.get(e.item!);
      if (rec) rec.liftVel.out = 1.6;
    } else if (e.type === "beat" && e.beat) {
      const a = pieces.get(e.beat.a), b = pieces.get(e.beat.b);
      if (a && b) {
        a.spin = 0.9; b.spin = 0.9;
        const mid = a.target.clone().add(b.target).multiplyScalar(0.5);
        mid.y = a.target.y + 0.7;
        vfx.beat(mid, e.beat.sig === 1, e.beat.hab === 1, av);
        if (e.beat.sig) rig.shake(0.035);
      }
    } else if (e.type === "card") {
      const c = house ? house.houseCenter.clone() : new Vector3();
      if (house) c.y = house.houseH * 0.7;
      vfx.card(c, av);
    } else if (e.type === "invalid") rig.shake(0.012);
    else if (e.type === "gameover") {
      const c = house ? house.houseCenter.clone() : new Vector3();
      vfx.fanfare(c, av);
      vfx.fanfare(c.clone().add(new Vector3(1.5, 0.5, 0)), av);
      vfx.fanfare(c.clone().add(new Vector3(-1.5, 0.5, 0)), av);
    }
  }
}

// ---------------------------------------------------------------- selection, hover, cursor
export function setSelection(itemKey: string | null, legalSlots: SlotRef[] = []): void {
  selected = itemKey;
  legal = legalSlots;
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (outline) { scene.remove(outline); outline = null; }
  selRing.visible = false;
  for (const rec of pieces.values()) rec.targetLift = 0;
  if (itemKey) {
    const rec = pieces.get(itemKey);
    if (rec) {
      rec.targetLift = 0.34;
      outline = makeOutline(rec.group, SELECT_COLOR);
      outline.position.copy(rec.group.position);
      scene.add(outline);
      selRing.visible = true;
      selRing.position.copy(rec.target);
      selRing.position.y += 0.02;
    }
  }
  const m = new Matrix4();
  let count = 0;
  for (const ls of legalSlots) {
    const pos = slotPos(ls.room, ls.slot);
    if (!pos || count >= 48) continue;
    m.makeTranslation(pos.x, pos.y + 0.02, pos.z);
    slotMarkers.setMatrixAt(count++, m);
  }
  slotMarkers.count = count;
  slotMarkers.visible = count > 0;
  slotMarkers.instanceMatrix.needsUpdate = true;
}
/** Hover feedback + ghost preview at a legal slot; the red ring otherwise. */
export function setHoverTarget(slot: SlotRef | null, itemKey: string | null = null, valid = false): void {
  hoverRing.visible = false;
  invalidRing.visible = false;
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (!slot) return;
  const pos = slotPos(slot.room, slot.slot);
  if (!pos) return;
  if (valid && itemKey) {
    const rec = pieces.get(itemKey);
    if (rec) {
      ghost = makeGhost(rec.group);
      ghost.position.copy(pos);
      ghost.rotation.set(0, 0, 0);
      scene.add(ghost);
    }
    hoverRing.visible = true;
    hoverRing.position.copy(pos);
    hoverRing.position.y += 0.025;
  } else if (!valid) {
    invalidRing.visible = true;
    invalidRing.position.copy(pos);
    invalidRing.position.y += 0.025;
  }
}
export function setCursor(pos: Vector3 | null): void {
  if (!pos) { cursorMark.visible = false; return; }
  cursorMark.visible = true;
  cursorMark.position.copy(pos);
}
export function slotAnchor(room: string, slot: number): Vector3 | null { return slotPos(room, slot); }
export function focusRoom(roomId: string): void {
  const a = house?.roomAnchors.get(roomId);
  if (a) rig.focusRoom(a.center);
}
export function resetCamera(): void { rig.reset(); }
export function orbit(dYaw: number, dPitch: number): void { rig.orbit(dYaw, dPitch); }
export function zoom(d: number): void { rig.zoom(d); }

// ---------------------------------------------------------------- picking and projection
/** What is under a window point: a slot's pick disc or a piece (render.js pick). */
export function pick(x: number, y: number): Hit {
  if (!house) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, rig.camera);
  const hits = raycaster.intersectObjects(pickMeshes, false);
  for (const h of hits) {
    const ref = h.object.userData.slotRef as SlotRef | undefined;
    if (ref) return { kind: "slot", room: ref.room, slot: ref.slot };
    const key = h.object.userData.pieceKey as string | undefined;
    if (key) return { kind: "piece", key };
  }
  return null;
}
const _v = new Vector3();
function toWindow(p: Vector3): { x: number; y: number } | null {
  _v.copy(p).project(rig.camera);
  if (_v.z > 1 || _v.z < -1) return null;
  return { x: ((_v.x + 1) / 2) * win.w, y: ((1 - _v.y) / 2) * win.h };
}
/** A box around a world point (radius r, height h) on screen, window px. */
function screenBox(p: Vector3, r: number, h: number): Rect | null {
  const pts = [new Vector3(p.x - r, p.y, p.z + r), new Vector3(p.x + r, p.y, p.z - r), new Vector3(p.x - r, p.y + h, p.z), new Vector3(p.x + r, p.y + h, p.z)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) {
    const s = toWindow(q);
    if (!s) return null;
    x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
/** A slot's spot on screen (its pick disc). */
export function slotRect(room: string, slot: number): Rect | null {
  const p = slotPos(room, slot);
  return p ? screenBox(p, 0.45, 0.05) : null;
}
/** A piece on screen (where it stands now). */
export function pieceRect(key: string): Rect | null {
  const rec = pieces.get(key);
  return rec ? screenBox(rec.group.position, rec.r, rec.h) : null;
}
/** A world point on screen (window px). */
export function project(p: Vector3): { x: number; y: number } | null { return toWindow(p); }

// ---------------------------------------------------------------- each frame (render.js _frame)
function spring(current: number, target: number, velocity: { out: number }, dt: number): number {
  const omega = 14;
  const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * current + dt * velocity.out + hhoo * target;
  const detV = velocity.out + hoo * (target - current);
  velocity.out = detV * detInv;
  return detX * detInv;
}
function updateMotes(): void {
  if (!motes.visible || !house) return;
  const hw = house.houseW / 2, hh = house.houseH, t = time;
  const span = Math.max(0.5, hh - 0.4);
  for (let i = 0; i < moteCount; i++) {
    const a = moteSeed[i * 4]!, b = moteSeed[i * 4 + 1]!, c = moteSeed[i * 4 + 2]!, d = moteSeed[i * 4 + 3]!;
    motePos[i * 3] = (a * 2 - 1) * hw * 0.92 + Math.sin(t * (0.13 + c * 0.1) + d * 6.28) * 0.35;
    motePos[i * 3 + 1] = 0.25 + ((b * span + t * (0.04 + c * 0.05)) % span);
    motePos[i * 3 + 2] = (d * 2 - 1) * ROOM_D * 0.4 + Math.cos(t * (0.11 + a * 0.1) + c * 6.28) * 0.25;
  }
  moteAttr.needsUpdate = true;
}
let vfxAcc = 0;
let aspectKey = "";
export function update(dt: number, w: number, h: number): void {
  dt = Math.min(0.1, Math.max(0, dt));
  time += dt;
  if (w > 0 && h > 0) {
    win = { w, h };
    const k = `${w}x${h}`;
    if (k !== aspectKey) { aspectKey = k; rig.resize(w / h); }
  }
  if (backdrop === "animated" && !reducedMotion) {
    rig.yaw = Math.sin(time * 0.11) * 0.42;
    rig.pitch = FRAMING.pitch + Math.sin(time * 0.07) * 0.06;
  }
  rig.update(dt);
  let remaining = dt;
  const step = 1 / 120;
  while (remaining > 1e-6) {
    const s = Math.min(step, remaining);
    remaining -= s;
    for (const rec of pieces.values()) {
      rec.pos.x = spring(rec.pos.x, rec.target.x, rec.vel.x, s);
      rec.pos.y = spring(rec.pos.y, rec.target.y, rec.vel.y, s);
      rec.pos.z = spring(rec.pos.z, rec.target.z, rec.vel.z, s);
      rec.lift = spring(rec.lift, rec.targetLift, rec.liftVel, s);
    }
  }
  for (const rec of pieces.values()) {
    const bob = reducedMotion ? 0 : Math.sin(time * 1.6 + rec.phase) * 0.018;
    rec.group.position.set(rec.pos.x, rec.pos.y + rec.lift + bob, rec.pos.z);
    if (rec.spin > 0) {
      rec.spin = Math.max(0, rec.spin - dt);
      const k = rec.spin / 0.9;
      rec.group.rotation.y = (1 - k) * Math.PI * 2 * (reducedMotion ? 0 : 1);
      rec.group.position.y += Math.sin((1 - k) * Math.PI) * 0.3;
    } else rec.group.rotation.y *= 0.9;
    rec.group.scale.setScalar(rec.key === selected ? 1.07 : 1);
  }
  if (outline && selected) {
    const rec = pieces.get(selected);
    if (rec) {
      outline.position.copy(rec.group.position);
      outline.rotation.copy(rec.group.rotation);
    }
  }
  if (selRing.visible) {
    const rec = selected ? pieces.get(selected) : null;
    if (rec) { selRing.position.x = rec.target.x; selRing.position.z = rec.target.z; selRing.position.y = rec.target.y + 0.02; }
    selRing.scale.setScalar(reducedMotion ? 1 : 1 + Math.sin(time * 4) * 0.08);
  }
  if (cursorMark.visible && !reducedMotion) cursorMark.rotation.y = time * 2.2;
  vfxAcc += dt;
  const vstep = 1 / 60;
  while (vfxAcc >= vstep) { vfxAcc -= vstep; vfx.update(vstep); }
  updateMotes();
}

// ---------------------------------------------------------------- thumbnails (render.js captureThumbnail)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A PNG (RGB, 8-bit) of straight RGBA pixels, with the engine's deflate. */
export function encodePng(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = rgba[s]!; raw[d + 1] = rgba[s + 1]!; raw[d + 2] = rgba[s + 2]!;
    }
  }
  const idat = compress(raw, "deflate");
  const chunks: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const chunk = (type: string, data: Uint8Array): void => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    chunks.push(out);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", new Uint8Array(0));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { png.set(c, o); o += c.length; }
  return png;
}
export function toDataUrl(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x2000) s += String.fromCharCode(...png.subarray(i, i + 0x2000));
  return "data:image/png;base64," + btoa(s);
}
/** The scene as a 168×112 PNG data URL (cover-cropped from the frame), as the scrapbook keeps it; null when it fails. */
export async function captureThumbnail(): Promise<string | null> {
  try {
    const bytes = await renderer.capture({ ui: false });
    const bmp = await createImageBitmap(bytes);
    const W = 168, H = 112;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext("2d")!;
    const k = Math.max(W / bmp.width, H / bmp.height);
    const sw = W / k, sh = H / k;
    g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
    bmp.close();
    return toDataUrl(encodePng(g.getImageData(0, 0, W, H).data, W, H));
  } catch (e) { console.warn(`thumbnail: ${String(e)}`); return null; }
}
