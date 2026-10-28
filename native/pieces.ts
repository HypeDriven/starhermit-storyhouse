// render/pieces.js on starhermit:scene: the procedural characters (Pip the
// clockwork tinker, Mabel in her sun hat, Otto the cook, Luna the stargazer,
// Biscuit the cat) and props (storybook, teapot, piano, fern, daybed,
// telescope, reading lamp, bread basket, old clock, ball of yarn) — lathe,
// tube and torus profiles and composed primitives — with contact shadows, the
// translucent ghost for target previews and the inverted-hull outline for the
// selection. Identity colours stay the same across themes. Shading and the
// curved-mesh segment count follow the preset's budget (Lambert on Low,
// Standard on Balanced, clear-coated Physical glazed and lacquered pieces on
// High and Ultra), as pieces.js rebuilt its geometry at the budget's
// multiplier (deliberately faceted shapes keep their few segments).
import {
  BackSide, BoxGeometry, CapsuleGeometry, CatmullRomCurve3, CircleGeometry, ConeGeometry, CylinderGeometry, Group, LatheGeometry,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, SphereGeometry, TorusGeometry, TubeGeometry,
  Vector2, Vector3, type BufferGeometry, type Material, type Object3D,
} from "starhermit:scene";

const BUDGET = { material: "physical" as "lambert" | "standard" | "physical", seg: 1 };
export function setPieceBudget(b: { material: "lambert" | "standard" | "physical"; seg: number }): void {
  BUDGET.material = b.material || "physical";
  BUDGET.seg = b.seg || 1;
}
const n = (v: number, min = 6): number => (v < 8 || BUDGET.seg === 1 ? v : Math.max(min, Math.round(v * BUDGET.seg)));
const Sph = (r: number, w: number, h: number): BufferGeometry => new SphereGeometry(r, n(w), n(h, 4));
const Cyl = (rt: number, rb: number, h: number, s: number): BufferGeometry => new CylinderGeometry(rt, rb, h, n(s));
const Cone = (r: number, h: number, s: number): BufferGeometry => new ConeGeometry(r, h, n(s));
const Tor = (r: number, t: number, rs: number, ts: number, arc?: number): BufferGeometry => new TorusGeometry(r, t, n(rs, 4), n(ts), arc);
const Box = (w: number, h: number, d: number): BufferGeometry => new BoxGeometry(w, h, d);

/** Envmapped materials (each piece's own reflections; render.ts sets envMap when Reflections are on). */
export const envMaterials = new Set<MeshStandardMaterial>();
interface MatOpts { emissive?: number; ei?: number; rough?: number; metal?: number; env?: number; coat?: number; coatRough?: number }
function mat(color: number, opts: MatOpts = {}): Material {
  const emissive = opts.emissive ?? 0x000000, emissiveIntensity = opts.ei ?? 1;
  if (BUDGET.material === "lambert") return new MeshLambertMaterial({ color, emissive, emissiveIntensity });
  const params = {
    color, roughness: opts.rough ?? 0.75, metalness: opts.metal ?? 0.05, emissive, emissiveIntensity,
    envMapIntensity: opts.env ?? ((opts.metal ?? 0) > 0.3 ? 0.9 : 0.45),
  };
  const m = opts.coat && BUDGET.material === "physical"
    ? new MeshPhysicalMaterial({ ...params, clearcoat: opts.coat, clearcoatRoughness: opts.coatRough ?? 0.18 })
    : new MeshStandardMaterial(params);
  envMaterials.add(m);
  return m;
}
interface V3 { x?: number; y?: number; z?: number }
function mesh(geo: BufferGeometry, material: Material, x = 0, y = 0, z = 0, rot: V3 | null = null, scale: V3 | null = null): Mesh {
  const m = new Mesh(geo, material);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
  if (scale) m.scale.set(scale.x ?? 1, scale.y ?? 1, scale.z ?? 1);
  m.castShadow = true;
  return m;
}
function lathe(profile: [number, number][], seg = 14): BufferGeometry {
  return new LatheGeometry(profile.map((p) => new Vector2(p[0], p[1])), n(seg));
}
function tube(points: [number, number, number][], radius: number, seg = 12): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(p[0], p[1], p[2])));
  return new TubeGeometry(curve, n(seg), radius, 6, false);
}
const DARK = 0x2a2226;
function addEyes(group: Group, y: number, spread: number, size = 0.045, z = 0.22): void {
  const g = Sph(size, 8, 6);
  const m = mat(DARK, { rough: 0.4 });
  group.add(mesh(g, m, -spread, y, z));
  group.add(mesh(g, m, spread, y, z));
}
function contactShadow(group: Group, r = 0.34): void {
  const s = new Mesh(new CircleGeometry(r, n(20, 8)), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false }));
  s.rotation.x = -Math.PI / 2;
  s.position.y = 0.012;
  s.userData.contact = true;
  group.add(s);
}

function makePip(): Group {
  const g = new Group();
  const copper = mat(0xc98850, { metal: 0.35, rough: 0.5 });
  const brass = mat(0xd9b06a, { metal: 0.55, rough: 0.35 });
  g.add(mesh(lathe([[0, 0], [0.26, 0.02], [0.3, 0.3], [0.2, 0.55], [0, 0.58]]), copper));
  g.add(mesh(Sph(0.22, 14, 12), copper, 0, 0.72, 0));
  g.add(mesh(Tor(0.07, 0.02, 6, 14), brass, -0.09, 0.75, 0.19));
  g.add(mesh(Tor(0.07, 0.02, 6, 14), brass, 0.09, 0.75, 0.19));
  g.add(mesh(Box(0.06, 0.02, 0.02), brass, 0, 0.75, 0.2));
  g.add(mesh(Cyl(0.025, 0.025, 0.1, 6), brass, 0, 0.4, -0.3, { x: Math.PI / 2 }));
  g.add(mesh(Tor(0.06, 0.018, 6, 12), brass, 0, 0.4, -0.36));
  g.add(mesh(Cyl(0.012, 0.012, 0.14, 5), brass, 0.05, 0.95, 0));
  g.add(mesh(Sph(0.03, 8, 6), mat(0xd95d4e, { emissive: 0xff6a50, ei: 3.0 }), 0.05, 1.03, 0));
  addEyes(g, 0.73, 0.085, 0.04);
  contactShadow(g);
  return g;
}
function makeMabel(): Group {
  const g = new Group();
  const dress = mat(0x7fb069), skin = mat(0xe8c4a0, { rough: 0.6 }), straw = mat(0xe8d48a);
  g.add(mesh(lathe([[0, 0], [0.32, 0.02], [0.26, 0.42], [0.14, 0.62], [0, 0.64]]), dress));
  g.add(mesh(Sph(0.2, 14, 12), skin, 0, 0.76, 0));
  g.add(mesh(Cyl(0.34, 0.36, 0.03, 16), straw, 0, 0.88, 0));
  g.add(mesh(Cone(0.2, 0.16, 14), straw, 0, 0.96, 0));
  g.add(mesh(Tor(0.21, 0.02, 6, 16), mat(0xc9563c), 0, 0.9, 0));
  addEyes(g, 0.77, 0.08, 0.04, 0.17);
  contactShadow(g);
  return g;
}
function makeOtto(): Group {
  const g = new Group();
  const apron = mat(0xf2ede4), scarf = mat(0xc9563c), skin = mat(0xd9a884, { rough: 0.6 });
  g.add(mesh(lathe([[0, 0], [0.3, 0.02], [0.32, 0.3], [0.24, 0.58], [0, 0.6]]), apron));
  g.add(mesh(Tor(0.2, 0.045, 8, 14), scarf, 0, 0.58, 0, { x: Math.PI / 2 }));
  g.add(mesh(Sph(0.21, 14, 12), skin, 0, 0.74, 0));
  g.add(mesh(Cyl(0.15, 0.16, 0.16, 14), apron, 0, 0.94, 0));
  g.add(mesh(Sph(0.16, 12, 10), apron, 0, 1.04, 0, null, { y: 0.7 }));
  g.add(mesh(Tor(0.06, 0.02, 6, 10, Math.PI), mat(0x6a4a34), 0, 0.68, 0.19, { z: Math.PI }));
  addEyes(g, 0.77, 0.085, 0.04, 0.18);
  contactShadow(g);
  return g;
}
function makeLuna(): Group {
  const g = new Group();
  const robe = mat(0x4a5a9a), skin = mat(0xd8c4e0, { rough: 0.6 }), silver = mat(0xd8dce8, { metal: 0.6, rough: 0.3 });
  g.add(mesh(lathe([[0, 0], [0.28, 0.02], [0.24, 0.45], [0.13, 0.62], [0, 0.64]]), robe));
  for (let i = 0; i < 4; i++) g.add(mesh(Sph(0.022, 6, 5), silver, Math.sin(i * 2.4) * 0.16, 0.14 + i * 0.12, 0.2 + Math.cos(i * 2.1) * 0.04));
  g.add(mesh(Sph(0.2, 14, 12), skin, 0, 0.76, 0));
  g.add(mesh(Sph(0.21, 14, 12), mat(0x3a3a5e), 0, 0.79, -0.03, null, { y: 0.85 }));
  g.add(mesh(Tor(0.07, 0.018, 6, 12, Math.PI * 1.3), silver, 0.14, 0.86, 0.12, { z: 2.2 }));
  addEyes(g, 0.77, 0.08, 0.04, 0.17);
  contactShadow(g);
  return g;
}
function makeBiscuit(): Group {
  const g = new Group();
  const fur = mat(0xd9955a), cream = mat(0xf2e2c8);
  g.add(mesh(Sph(0.26, 14, 12), fur, 0, 0.22, -0.05, null, { y: 0.9, z: 1.05 }));
  g.add(mesh(Sph(0.17, 12, 10), cream, 0, 0.14, 0.12, null, { y: 0.8 }));
  g.add(mesh(Sph(0.17, 14, 12), fur, 0, 0.42, 0.14));
  g.add(mesh(Cone(0.07, 0.12, 4), fur, -0.1, 0.56, 0.12));
  g.add(mesh(Cone(0.07, 0.12, 4), fur, 0.1, 0.56, 0.12));
  g.add(mesh(Cone(0.035, 0.07, 4), cream, -0.1, 0.55, 0.14));
  g.add(mesh(Cone(0.035, 0.07, 4), cream, 0.1, 0.55, 0.14));
  g.add(mesh(tube([[0.2, 0.1, -0.2], [0.34, 0.08, -0.05], [0.32, 0.2, 0.08]], 0.035), fur));
  g.add(mesh(Sph(0.02, 6, 5), mat(0xc9563c), 0, 0.4, 0.3));
  addEyes(g, 0.45, 0.07, 0.035, 0.27);
  contactShadow(g, 0.3);
  return g;
}
function makeBook(): Group {
  const g = new Group();
  g.add(mesh(Box(0.42, 0.1, 0.32), mat(0xb04a3a, { rough: 0.55, coat: 0.3, coatRough: 0.4 }), 0, 0.06, 0));
  g.add(mesh(Box(0.38, 0.06, 0.28), mat(0xf2e8d0), 0.01, 0.075, 0));
  g.add(mesh(Box(0.05, 0.11, 0.33), mat(0x8a352a), -0.2, 0.06, 0));
  g.add(mesh(Tor(0.05, 0.012, 5, 10), mat(0xd9b06a, { metal: 0.4 }), 0, 0.12, 0, { x: Math.PI / 2 }));
  contactShadow(g, 0.28);
  return g;
}
function makeTeapot(): Group {
  const g = new Group();
  const cel = mat(0x8fb8a8, { rough: 0.3, coat: 1 });
  g.add(mesh(lathe([[0, 0], [0.2, 0.02], [0.26, 0.18], [0.18, 0.34], [0.08, 0.38]]), cel, 0, 0, 0));
  g.add(mesh(Sph(0.06, 8, 6), cel, 0, 0.4, 0));
  g.add(mesh(tube([[0.2, 0.2, 0], [0.32, 0.28, 0], [0.34, 0.36, 0]], 0.04), cel));
  g.add(mesh(Tor(0.11, 0.03, 6, 12, Math.PI * 1.2), cel, -0.22, 0.2, 0, { z: 0.9 }));
  contactShadow(g, 0.26);
  return g;
}
function makePiano(): Group {
  const g = new Group();
  const wood = mat(0x4a3226, { rough: 0.45, coat: 0.8 });
  g.add(mesh(Box(0.9, 0.75, 0.3), wood, 0, 0.45, -0.12));
  g.add(mesh(Box(0.9, 0.06, 0.36), wood, 0, 0.42, 0.02));
  g.add(mesh(Box(0.8, 0.03, 0.14), mat(0xf2ede0, { rough: 0.4 }), 0, 0.45, 0.06));
  for (let i = 0; i < 6; i++) g.add(mesh(Box(0.05, 0.035, 0.07), mat(DARK), -0.3 + i * 0.12, 0.465, 0.03));
  g.add(mesh(Box(0.08, 0.35, 0.08), wood, -0.38, 0.17, 0.05));
  g.add(mesh(Box(0.08, 0.35, 0.08), wood, 0.38, 0.17, 0.05));
  contactShadow(g, 0.5);
  return g;
}
function makeFern(): Group {
  const g = new Group();
  g.add(mesh(lathe([[0, 0], [0.16, 0.02], [0.2, 0.2], [0.16, 0.26]]), mat(0xb5654a), 0, 0, 0));
  const leaf = mat(0x5a9a4a);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(mesh(Cone(0.06, 0.4, 5), leaf, Math.cos(a) * 0.1, 0.42, Math.sin(a) * 0.1, { x: Math.sin(a) * 0.6, z: -Math.cos(a) * 0.6 }));
  }
  g.add(mesh(Cone(0.05, 0.45, 5), leaf, 0, 0.48, 0));
  contactShadow(g, 0.24);
  return g;
}
function makeBed(): Group {
  const g = new Group();
  const wood = mat(0x6a4a34);
  g.add(mesh(Box(1.0, 0.16, 0.7), wood, 0, 0.12, 0));
  g.add(mesh(Box(0.94, 0.12, 0.64), mat(0xf2ede0), 0, 0.24, 0));
  g.add(mesh(Box(0.94, 0.07, 0.4), mat(0x7a9ac9), 0, 0.3, 0.1));
  g.add(mesh(Box(0.3, 0.08, 0.2), mat(0xffffff), -0.28, 0.3, -0.18));
  g.add(mesh(Box(1.0, 0.4, 0.08), wood, 0, 0.3, -0.36));
  contactShadow(g, 0.55);
  return g;
}
function makeTelescope(): Group {
  const g = new Group();
  const brass = mat(0xc9a24a, { metal: 0.5, rough: 0.4 });
  const rot = { x: 0, z: -0.5 };
  g.add(mesh(Cyl(0.07, 0.09, 0.6, 10), brass, 0.05, 0.52, 0, rot));
  g.add(mesh(Cyl(0.05, 0.05, 0.16, 8), mat(0x4a3226), -0.22, 0.42, 0, rot));
  g.add(mesh(Cyl(0.1, 0.1, 0.05, 10), brass, 0.3, 0.62, 0, rot));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    g.add(mesh(Cyl(0.02, 0.02, 0.5, 6), mat(0x4a3226), Math.cos(a) * 0.12, 0.22, Math.sin(a) * 0.12, { x: Math.sin(a) * 0.4, z: Math.cos(a) * 0.4 }));
  }
  contactShadow(g, 0.3);
  return g;
}
function makeLamp(): Group {
  const g = new Group();
  const brass = mat(0xc9a24a, { metal: 0.4, rough: 0.4 });
  g.add(mesh(Cyl(0.14, 0.18, 0.05, 12), brass, 0, 0.03, 0));
  g.add(mesh(Cyl(0.025, 0.025, 0.4, 8), brass, 0, 0.24, 0));
  g.add(mesh(lathe([[0.06, 0], [0.22, 0.14], [0.2, 0.22], [0.08, 0.26]]), mat(0xe8d48a, { emissive: 0xffd98a, ei: 1.6 }), 0, 0.42, 0));
  contactShadow(g, 0.22);
  return g;
}
function makeBasket(): Group {
  const g = new Group();
  const wick = mat(0xb58a5a);
  g.add(mesh(lathe([[0, 0], [0.2, 0.02], [0.26, 0.16], [0.24, 0.24]]), wick, 0, 0, 0));
  g.add(mesh(Tor(0.2, 0.025, 6, 12, Math.PI), wick, 0, 0.24, 0));
  const loaf = mat(0xd9b06a);
  g.add(mesh(new CapsuleGeometry(0.07, 0.14, 4, 8), loaf, -0.08, 0.28, 0, { z: 1.2 }));
  g.add(mesh(new CapsuleGeometry(0.07, 0.14, 4, 8), loaf, 0.08, 0.28, 0.02, { z: 1.9 }));
  g.add(mesh(new CapsuleGeometry(0.06, 0.12, 4, 8), loaf, 0, 0.3, -0.08, { x: 0.4, z: 1.4 }));
  contactShadow(g, 0.26);
  return g;
}
function makeClock(): Group {
  const g = new Group();
  const wood = mat(0x5a3a2a, { rough: 0.5, coat: 0.6 });
  g.add(mesh(Box(0.4, 0.72, 0.2), wood, 0, 0.38, 0));
  g.add(mesh(Box(0.44, 0.1, 0.24), wood, 0, 0.78, 0));
  g.add(mesh(Cyl(0.14, 0.14, 0.03, 16), mat(0xf2e8d0), 0, 0.6, 0.1, { x: Math.PI / 2 }));
  g.add(mesh(Tor(0.14, 0.015, 6, 16), mat(0xc9a24a, { metal: 0.5 }), 0, 0.6, 0.11));
  g.add(mesh(Box(0.015, 0.09, 0.01), mat(DARK), 0, 0.63, 0.12, { z: -0.5 }));
  g.add(mesh(Box(0.015, 0.06, 0.01), mat(DARK), 0, 0.62, 0.12, { z: 1.8 }));
  g.add(mesh(Cyl(0.05, 0.05, 0.02, 10), mat(0xc9a24a, { metal: 0.5 }), 0, 0.25, 0.08, { x: Math.PI / 2 }));
  contactShadow(g, 0.26);
  return g;
}
function makeYarn(): Group {
  const g = new Group();
  const pink = mat(0xc95a8a), dark = mat(0xa84a78);
  g.add(mesh(Sph(0.18, 14, 12), pink, 0, 0.18, 0));
  g.add(mesh(Tor(0.16, 0.02, 6, 16), dark, 0, 0.18, 0, { x: Math.PI / 2 }));
  g.add(mesh(Tor(0.16, 0.02, 6, 16), dark, 0, 0.18, 0, { y: Math.PI / 3 }));
  g.add(mesh(Tor(0.16, 0.02, 6, 16), dark, 0, 0.18, 0, { y: -Math.PI / 3, x: Math.PI / 2 }));
  g.add(mesh(tube([[0.14, 0.1, 0.1], [0.3, 0.03, 0.2], [0.42, 0.02, 0.1]], 0.015), pink));
  contactShadow(g, 0.24);
  return g;
}

const FACTORIES: Record<string, () => Group> = {
  pip: makePip, mabel: makeMabel, otto: makeOtto, luna: makeLuna, biscuit: makeBiscuit,
  book: makeBook, teapot: makeTeapot, piano: makePiano, fern: makeFern, bed: makeBed,
  telescope: makeTelescope, lamp: makeLamp, basket: makeBasket, clock: makeClock, yarn: makeYarn,
};
/** The tray's and the text mirror's icons (pieces.js PIECE_ICONS). */
export const PIECE_ICONS: Record<string, string> = {
  pip: "⚙", mabel: "❀", otto: "♨", luna: "☾", biscuit: "🐈",
  book: "📖", teapot: "🫖", piano: "🎹", fern: "🌿", bed: "🛏",
  telescope: "🔭", lamp: "💡", basket: "🥖", clock: "🕰", yarn: "🧶",
};
export function makePiece(key: string): Group {
  const factory = FACTORIES[key];
  if (!factory) throw new Error("unknown piece " + key);
  const group = factory();
  group.userData.pieceKey = key;
  group.traverse((o: Object3D) => { o.userData.pieceKey = key; });
  return group;
}
/** Translucent ghost clone for the target preview. */
export function makeGhost(source: Group): Group {
  const ghost = source.clone(true);
  ghost.traverse((o: Object3D) => {
    if (o instanceof Mesh) {
      const m = o;
      const mm = (m.material as Material).clone();
      mm.transparent = true;
      mm.opacity = 0.42;
      mm.depthWrite = false;
      m.material = mm;
      m.castShadow = false;
    }
  });
  return ghost;
}
/** Inverted-hull outline clone for the selection (works without post-processing). */
export function makeOutline(source: Group, color: number): Group {
  const outline = source.clone(true);
  const mat = new MeshBasicMaterial({ color, side: BackSide });
  outline.traverse((o: Object3D) => {
    if (o instanceof Mesh) {
      const m = o;
      if (o.userData.contact) { o.visible = false; return; }
      m.material = mat;
      m.castShadow = false;
    }
  });
  outline.scale.setScalar(1.07);
  return outline;
}
