// render/house.js on starhermit:scene: the cutaway dollhouse — procedural
// rooms (floor slab, back wall, side walls, trim, a window per room), the
// authored set dressing per room type (kitchen counter and pans, library
// shelves and books, garden bed and fence, parlor armchair and rug, bedroom
// bed and wardrobe, attic rafters and trunk), merged into one vertex-coloured
// mesh per room, the roof slabs and chimney, stepping stones and the round
// ground. The surface detail render.js injected with onBeforeCompile
// (floorboards on floor-coloured tops, striped wallpaper on wall-coloured
// faces, fine grain, a soft glow on window panes, ground mottling; off on the
// Plain tier) is the same pattern as a WGSL surface hook.
import {
  BoxGeometry, BufferGeometry, CircleGeometry, Color, CylinderGeometry, Euler, Float32BufferAttribute, Group, MathUtils,
  Matrix3, Matrix4, Mesh, MeshLambertMaterial, MeshStandardMaterial, SphereGeometry, Vector3, type MaterialHooks,
} from "starhermit:scene";
import type { Layout, Theme } from "./game.ts";
import type { Budget } from "./quality.ts";

export const ROOM_W = 4.2;
export const ROOM_H = 3.1;
export const ROOM_D = 3.6;
export const ROOM_GAP = 0.28;
const WALL_T = 0.16;

interface Part { geo: BufferGeometry; color: number; matrix: Matrix4 }
const _nm = new Matrix3();
function mergeParts(parts: Part[]): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new Color();
  const v = new Vector3(), n = new Vector3();
  for (const part of parts) {
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    const p = geo.attributes.position!, no = geo.attributes.normal!;
    c.set(part.color);
    _nm.getNormalMatrix(part.matrix);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(part.matrix);
      pos.push(v.x, v.y, v.z);
      n.fromBufferAttribute(no, i).applyMatrix3(_nm).normalize();
      nor.push(n.x, n.y, n.z);
      col.push(c.r, c.g, c.b);
    }
    if (geo !== part.geo) geo.dispose();
    part.geo.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new Float32BufferAttribute(col, 3));
  return out;
}
interface Rot { x?: number; y?: number; z?: number }
function placed(x: number, y: number, z: number, rot: Rot | null): Matrix4 {
  const m = new Matrix4();
  if (rot) m.makeRotationFromEuler(new Euler(rot.x || 0, rot.y || 0, rot.z || 0));
  m.setPosition(x, y, z);
  return m;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rot: Rot | null = null): Part {
  return { geo: new BoxGeometry(w, h, d), color, matrix: placed(x, y, z, rot) };
}
// Curved dressing at the preset budget's segment multiplier (set per buildHouse call).
let SEG = 1;
const sseg = (n: number, min = 6): number => Math.max(min, Math.round(n * SEG));
function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, color: number, rot: Rot | null = null): Part {
  return { geo: new CylinderGeometry(rt, rb, h, sseg(seg, Math.min(seg, 5))), color, matrix: placed(x, y, z, rot) };
}
function sph(r: number, x: number, y: number, z: number, color: number): Part {
  const m = new Matrix4().makeScale(1, 1, 1);
  m.setPosition(x, y, z);
  return { geo: new SphereGeometry(r, sseg(10), sseg(8, 4)), color, matrix: m };
}

interface Palette { wall: number; wallSide: number; floor: number; trim: number; accent: number; roof: number; ground: number; hemiSky: number; skyColor: number; brand: number }
function dressing(type: string, P: Palette, detail: number): Part[] {
  const B = -ROOM_D / 2 + 0.35;
  const parts: Part[] = [];
  const add = (...ps: Part[]): void => { parts.push(...ps); };
  switch (type) {
    case "kitchen":
      add(box(1.7, 0.85, 0.55, -1.0, 0.425, B, P.trim));
      add(box(1.75, 0.06, 0.6, -1.0, 0.88, B, P.floor));
      add(cyl(0.16, 0.2, 0.22, 10, -1.35, 1.0, B, P.accent));
      add(box(1.2, 0.05, 0.05, 0.6, 2.0, B - 0.2, P.trim));
      add(cyl(0.16, 0.16, 0.05, 10, 0.35, 1.8, B - 0.2, P.roof));
      add(cyl(0.13, 0.13, 0.05, 10, 0.85, 1.75, B - 0.2, P.roof));
      if (detail > 0) add(box(0.5, 0.7, 0.4, 1.3, 0.35, B, P.wallSide));
      break;
    case "library": {
      add(box(2.0, 2.3, 0.35, -0.9, 1.15, B, P.trim));
      for (let s = 0; s < 3; s++) add(box(1.8, 0.05, 0.3, -0.9, 0.55 + s * 0.62, B + 0.03, P.floor));
      if (detail > 0) {
        const cols = [P.accent, P.roof, P.wallSide, P.floor];
        for (let s = 0; s < 3; s++) {
          for (let i = 0; i < 7; i++) {
            const h = 0.34 + ((i * 7 + s * 3) % 4) * 0.05;
            add(box(0.16, h, 0.22, -1.68 + i * 0.26, 0.6 + s * 0.62 + h / 2 - 0.02, B + 0.06, cols[(i + s) % 4]!));
          }
        }
      }
      add(box(0.35, 1.6, 0.12, 1.2, 0.8, B + 0.15, P.floor, { z: 0.18 }));
      break;
    }
    case "garden":
      add(box(1.9, 0.3, 0.8, -0.9, 0.15, B + 0.2, P.trim));
      if (detail > 0) {
        for (let i = 0; i < 5; i++) {
          const x = -1.6 + i * 0.38;
          add(cyl(0.02, 0.02, 0.3, 5, x, 0.45, B + 0.2, P.accent));
          add(sph(0.09, x, 0.64, B + 0.2, i % 2 ? P.roof : P.accent));
        }
      }
      for (let i = 0; i < 4; i++) add(box(0.07, 0.5, 0.07, 0.7 + i * 0.3, 0.25, 1.2, P.wallSide));
      add(box(1.0, 0.06, 0.06, 1.15, 0.42, 1.2, P.wallSide));
      add(cyl(0.12, 0.16, 0.25, 8, 1.2, 0.55, B, P.accent));
      break;
    case "parlor":
      add(cyl(0.9, 0.9, 0.03, 20, 0.2, 0.02, 0.4, P.accent));
      add(box(0.85, 0.4, 0.8, -1.2, 0.2, B + 0.5, P.roof));
      add(box(0.85, 0.75, 0.2, -1.2, 0.55, B + 0.18, P.roof));
      add(box(0.18, 0.5, 0.8, -1.72, 0.35, B + 0.5, P.roof));
      add(box(0.18, 0.5, 0.8, -0.68, 0.35, B + 0.5, P.roof));
      add(cyl(0.3, 0.35, 0.5, 10, 1.2, 0.25, B + 0.3, P.trim));
      add(box(0.7, 0.55, 0.06, 0.3, 1.9, B - 0.15, P.floor));
      if (detail > 0) add(box(0.5, 0.35, 0.04, 0.3, 1.9, B - 0.12, P.wallSide));
      break;
    case "bedroom":
      add(box(1.5, 0.3, 1.0, -0.9, 0.15, B + 0.3, P.trim));
      add(box(1.4, 0.18, 0.9, -0.9, 0.38, B + 0.3, P.wallSide));
      add(box(1.4, 0.1, 0.55, -0.9, 0.5, B + 0.45, P.accent));
      add(box(0.4, 0.12, 0.3, -1.35, 0.5, B - 0.05, P.hemiSky));
      add(box(0.9, 1.9, 0.5, 1.2, 0.95, B, P.trim));
      if (detail > 0) add(cyl(0.05, 0.05, 0.04, 8, 1.2, 1.0, B + 0.26, P.brand || P.accent));
      break;
    case "attic":
      for (let i = 0; i < 3; i++) add(box(0.12, 0.12, ROOM_D - 0.4, -1.0 + i * 1.0, ROOM_H - 0.5, 0, P.trim, { z: 0.5 }));
      add(box(1.1, 0.55, 0.6, -1.1, 0.28, B + 0.3, P.roof));
      add(box(1.15, 0.12, 0.65, -1.1, 0.6, B + 0.3, P.trim));
      add(cyl(0.4, 0.4, 0.08, 16, 1.1, 1.9, B - 0.15, P.floor, { x: Math.PI / 2 }));
      if (detail > 0) add(cyl(0.32, 0.32, 0.05, 16, 1.1, 1.9, B - 0.12, P.skyColor, { x: Math.PI / 2 }));
      break;
  }
  return parts;
}

// house.js DETAIL_GLSL + addSurfaceDetail's colour_fragment / emissivemap_fragment patches in WGSL.
const DETAIL_WGSL = /* wgsl */ `
fn sh_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn sh_noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sh_hash(i), sh_hash(i + vec2f(1.0, 0.0)), f.x), mix(sh_hash(i + vec2f(0.0, 1.0)), sh_hash(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn surface(s: Surface) -> Surface {
  var o = s;
  if (uniforms.uDetail > 0.5) {
    let wp = s.world;
    let wn = normalize(s.normal);
    var k = 1.0;
    var glow = 0.0;
    if (uniforms.uGround > 0.5) {
      k = k * (0.9 + 0.2 * sh_noise(wp.xz * 0.45) + 0.06 * sh_noise(wp.xz * 3.1));
    } else {
      let base = s.color.rgb;
      let onFloor = step(distance(base, uniforms.uFloor), 0.02) * step(0.9, wn.y);
      let onWall = step(distance(base, uniforms.uWall), 0.02) * step(0.9, abs(wn.z));
      let onPane = step(distance(base, uniforms.uPane), 0.02) * step(0.9, abs(wn.z));
      let row = floor(wp.z / 0.3);
      let along = wp.x + sh_hash(vec2f(row, 3.0)) * 2.0;
      let board = floor(along / 1.4);
      let fz = fract(wp.z / 0.3);
      let fx = fract(along / 1.4);
      let seam = max(1.0 - smoothstep(0.0, 0.04, min(fz, 1.0 - fz)), 1.0 - smoothstep(0.0, 0.008, min(fx, 1.0 - fx)));
      let plank = 0.92 + 0.14 * sh_hash(vec2f(row, board)) + 0.05 * sh_noise(vec2f(along * 6.0, wp.z * 40.0));
      k = k * mix(1.0, plank * (1.0 - 0.28 * seam), onFloor);
      let stripe = smoothstep(0.35, 0.5, abs(fract(wp.x / 0.26) - 0.5));
      let dp = fract(vec2f(wp.x / 0.26, wp.y / 0.3)) - 0.5;
      let dotm = 1.0 - smoothstep(0.05, 0.08, length(dp));
      k = k * mix(1.0, 1.0 - 0.05 * stripe - 0.04 * dotm, onWall);
      glow = onPane;
      k = k * (0.97 + 0.06 * sh_noise(wp.xy * 9.0 + wp.zz * 7.0));
    }
    o.base_color = vec4f(s.base_color.rgb * k, s.base_color.a);
    o.emissive = s.emissive + o.base_color.rgb * glow * 0.9;
  }
  return o;
}`;
function detailHooks(detail: { value: number }, wall: Color, floor: Color, pane: Color, ground: number): MaterialHooks {
  return { uniforms: { uDetail: detail, uWall: { value: wall }, uFloor: { value: floor }, uPane: { value: pane }, uGround: { value: ground } }, surface: DETAIL_WGSL };
}

export interface RoomAnchor { id: string; center: Vector3; floorCenter: Vector3; slots: Vector3[] }
export interface House {
  group: Group; roomAnchors: Map<string, RoomAnchor>; houseCenter: Vector3; houseExtent: number; houseW: number; houseH: number;
  envMat: MeshStandardMaterial | MeshLambertMaterial; groundMat: MeshStandardMaterial | MeshLambertMaterial; detailUniform: { value: number };
}
type LitParams = { color?: number; vertexColors?: boolean; roughness?: number; metalness?: number };
export function buildHouse(layout: Layout, theme: Theme, detail: number, budget: Budget): House {
  SEG = budget.seg || 1;
  const lit = (p: LitParams): MeshStandardMaterial | MeshLambertMaterial => budget.material === "lambert"
    ? new MeshLambertMaterial({ color: p.color ?? 0xffffff, vertexColors: !!p.vertexColors })
    : new MeshStandardMaterial(p);
  const P: Palette = {
    wall: theme.wall, wallSide: theme.wallSide, floor: theme.floor, trim: theme.trim, accent: theme.accent, roof: theme.roof,
    ground: theme.ground, hemiSky: theme.hemiSky, skyColor: theme.sky, brand: 0xe8b04a,
  };
  const group = new Group();
  group.name = "house";
  const roomAnchors = new Map<string, RoomAnchor>();
  const cols = Math.max(...layout.rooms.map((r) => r.gx)) + 1;
  const rows = Math.max(...layout.rooms.map((r) => r.gy)) + 1;
  const houseW = cols * (ROOM_W + ROOM_GAP) - ROOM_GAP;
  const houseH = rows * (ROOM_H + ROOM_GAP) - ROOM_GAP;
  const x0 = -houseW / 2 + ROOM_W / 2;

  const envMat = lit({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
  const detailUniform = { value: detail > 0 ? 1 : 0 };
  envMat.hooks = detailHooks(detailUniform, new Color(P.wall), new Color(P.floor), new Color(P.skyColor), 0);

  for (const room of layout.rooms) {
    const cx = x0 + room.gx * (ROOM_W + ROOM_GAP);
    const cy = room.gy * (ROOM_H + ROOM_GAP);
    const parts: Part[] = [];
    parts.push(box(ROOM_W, 0.2, ROOM_D, 0, -0.1, 0, P.floor));
    parts.push(box(ROOM_W, ROOM_H, WALL_T, 0, ROOM_H / 2, -ROOM_D / 2, P.wall));
    parts.push(box(WALL_T, ROOM_H, ROOM_D, -ROOM_W / 2 + WALL_T / 2, ROOM_H / 2, 0, P.wallSide));
    parts.push(box(WALL_T, ROOM_H, ROOM_D, ROOM_W / 2 - WALL_T / 2, ROOM_H / 2, 0, P.wallSide));
    parts.push(box(ROOM_W, 0.1, 0.1, 0, 0.05, ROOM_D / 2 - 0.05, P.trim));
    parts.push(box(ROOM_W, 0.12, 0.12, 0, ROOM_H - 0.06, -ROOM_D / 2 + 0.2, P.trim));
    const wx = ((room.gx * 2 + room.gy) % 3 - 1) * 0.9;
    parts.push(box(0.9, 1.0, 0.06, wx, 1.9, -ROOM_D / 2 + 0.05, P.trim));
    parts.push(box(0.7, 0.8, 0.04, wx, 1.9, -ROOM_D / 2 + 0.08, P.skyColor));
    parts.push(...dressing(room.type, P, detail));
    const mesh = new Mesh(mergeParts(parts), envMat);
    mesh.position.set(cx, cy, 0);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    group.add(mesh);
    const n = room.slots;
    const slots: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = cx + MathUtils.lerp(-ROOM_W / 2 + 0.85, ROOM_W / 2 - 0.85, t);
      const z = i % 2 === 0 ? 0.55 : -0.15;
      slots.push(new Vector3(x, cy, z));
    }
    roomAnchors.set(room.id, { id: room.id, center: new Vector3(cx, cy + ROOM_H * 0.45, 0), floorCenter: new Vector3(cx, cy, 0.3), slots });
  }

  const roofParts: Part[] = [];
  for (let gx = 0; gx < cols; gx++) {
    const cx = x0 + gx * (ROOM_W + ROOM_GAP);
    roofParts.push(box(ROOM_W + 0.4, 0.22, ROOM_D + 0.5, cx, houseH + 0.11, 0, P.roof));
    roofParts.push(box(ROOM_W + 0.44, 0.1, ROOM_D + 0.54, cx, houseH + 0.02, 0, P.trim));
  }
  roofParts.push(box(0.5, 0.9, 0.5, x0 + (cols - 1) * (ROOM_W + ROOM_GAP) + 1.1, houseH + 0.55, -0.8, P.trim));
  roofParts.push(box(0.6, 0.14, 0.6, x0 + (cols - 1) * (ROOM_W + ROOM_GAP) + 1.1, houseH + 1.0, -0.8, P.roof));
  if (detail > 0) {
    for (const room of layout.rooms.filter((r) => r.gy === 0)) {
      const cx = x0 + room.gx * (ROOM_W + ROOM_GAP);
      for (let i = 0; i < 3; i++) {
        roofParts.push(cyl(0.3 - i * 0.04, 0.3 - i * 0.04, 0.06, 8, cx + (i - 1) * 0.8, 0.03, ROOM_D / 2 + 0.9 + i * 0.55, P.wallSide));
      }
    }
  }
  const roofMesh = new Mesh(mergeParts(roofParts), envMat);
  roofMesh.castShadow = true;
  group.add(roofMesh);

  const extent = Math.max(houseW, houseH) * 0.5 + 4;
  const groundMat = lit({ color: P.ground, roughness: 1 });
  groundMat.hooks = detailHooks(detailUniform, new Color(), new Color(), new Color(), 1);
  const ground = new Mesh(new CircleGeometry(extent * 1.6, sseg(40, 16)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.22;
  // render.js fitted the key light's shadow frustum to the house and tray, so the house never shadowed the
  // open ground beyond them; the engine fits shadows to the view, so the ground takes none.
  ground.receiveShadow = false;
  group.add(ground);

  const houseCenter = new Vector3(0, houseH / 2 - 0.4, 0);
  const houseExtent = Math.max(houseW, houseH * 1.15) / 2 + 1.2;
  return { group, roomAnchors, houseCenter, houseExtent, houseW, houseH, envMat, groundMat, detailUniform };
}
