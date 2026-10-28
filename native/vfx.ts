// render/vfx.js on starhermit:scene: the pooled sparks (one Points cloud,
// vertex-coloured, hard-capped per quality tier) and the eight impact rings,
// spawned from the seeded audiovisual stream by event tier — placement <
// story beat (gold for signatures, green at home) < discovery card < the
// saved-scene fanfare — and stepped at a fixed 60 Hz. Never pickable; reduced
// motion turns them off with the timing kept.
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Mesh, MeshBasicMaterial, Points, PointsMaterial, RingGeometry,
  type Scene, type Vector3,
} from "starhermit:scene";
import type { Rng } from "./game.ts";

interface SpawnOpts { colors: number[]; radius?: number; up?: number; out?: number; life?: number; gravity?: number }
interface RingRec { mesh: Mesh; mat: MeshBasicMaterial; t: number; dur: number }
export class VfxPool {
  cap: number;
  count = 0;
  readonly pos: Float32Array; readonly vel: Float32Array; readonly col: Float32Array;
  readonly life: Float32Array; readonly maxLife: Float32Array; readonly grav: Float32Array;
  readonly points: Points;
  readonly material: PointsMaterial;
  private posAttr: BufferAttribute; private colAttr: BufferAttribute;
  readonly rings: RingRec[] = [];
  enabled = true;
  private c = new Color();
  constructor(scene: Scene, max: number) {
    this.cap = max;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max); this.grav = new Float32Array(max);
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setDrawRange(0, 0);
    this.material = new PointsMaterial({ size: 0.09, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < 8; i++) {
      const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
      const ring = new Mesh(new RingGeometry(0.3, 0.38, 24), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(ring);
      this.rings.push({ mesh: ring, mat, t: 1, dur: 0.5 });
    }
  }
  setCap(cap: number): void {
    this.cap = Math.min(cap, this.pos.length / 3);
    if (this.count > this.cap) this.count = this.cap;
  }
  spawn(n: number, origin: Vector3, opts: SpawnOpts, rng: Rng): void {
    if (!this.enabled) return;
    for (let i = 0; i < n; i++) {
      if (this.count >= this.cap) return;
      const k = this.count++;
      const a = rng.next() * Math.PI * 2;
      const r = (opts.radius ?? 0.15) * (0.4 + rng.next() * 0.6);
      this.pos[k * 3] = origin.x + Math.cos(a) * r;
      this.pos[k * 3 + 1] = origin.y + (rng.next() - 0.2) * 0.1;
      this.pos[k * 3 + 2] = origin.z + Math.sin(a) * r;
      const up = opts.up ?? 1.6, out = opts.out ?? 0.9;
      this.vel[k * 3] = Math.cos(a) * out * (0.3 + rng.next() * 0.7);
      this.vel[k * 3 + 1] = up * (0.5 + rng.next() * 0.8);
      this.vel[k * 3 + 2] = Math.sin(a) * out * (0.3 + rng.next() * 0.7);
      this.c.set(opts.colors[(rng.next() * opts.colors.length) | 0]!);
      this.col[k * 3] = this.c.r; this.col[k * 3 + 1] = this.c.g; this.col[k * 3 + 2] = this.c.b;
      this.maxLife[k] = this.life[k] = (opts.life ?? 0.8) * (0.7 + rng.next() * 0.6);
      this.grav[k] = opts.gravity ?? 3.2;
    }
  }
  ring(origin: Vector3, color: number, scale = 1): void {
    if (!this.enabled) return;
    const r = this.rings.find((x) => x.t >= x.dur) || this.rings[0]!;
    r.t = 0; r.dur = 0.5;
    r.mesh.visible = true;
    r.mesh.position.copy(origin);
    r.mesh.position.y += 0.03;
    r.mat.color.set(color);
    r.mesh.scale.setScalar(scale);
  }
  /** Fixed-step update; deterministic motion independent of frame rate. */
  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i] = this.life[i]! - dt;
      if (this.life[i]! <= 0) {
        const last = --this.count;
        if (i !== last) {
          for (let c = 0; c < 3; c++) {
            this.pos[i * 3 + c] = this.pos[last * 3 + c]!;
            this.vel[i * 3 + c] = this.vel[last * 3 + c]!;
            this.col[i * 3 + c] = this.col[last * 3 + c]!;
          }
          this.life[i] = this.life[last]!; this.maxLife[i] = this.maxLife[last]!; this.grav[i] = this.grav[last]!;
        }
        continue;
      }
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! - this.grav[i]! * dt;
      this.pos[i * 3] = this.pos[i * 3]! + this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
      if (this.pos[i * 3 + 1]! < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * -0.35; }
      i++;
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    for (const r of this.rings) {
      if (r.t >= r.dur) { r.mesh.visible = false; continue; }
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      r.mesh.scale.setScalar(0.6 + k * 1.8);
      r.mat.opacity = 0.7 * (1 - k);
    }
  }
  clear(): void {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
    for (const r of this.rings) { r.t = r.dur; r.mesh.visible = false; }
  }
  placed(o: Vector3, rng: Rng): void { this.spawn(10, o, { colors: [0xf2e8d0, 0xd9b06a], up: 1.4, out: 0.7, life: 0.6 }, rng); this.ring(o, 0xf2e8d0, 0.7); }
  beat(o: Vector3, sig: boolean, hab: boolean, rng: Rng): void {
    const colors = sig ? [0xe8b04a, 0xffd166, 0xf2e8d0] : hab ? [0x7fb069, 0xa8d89a, 0xf2e8d0] : [0x9ac9e8, 0xf2e8d0];
    this.spawn(sig || hab ? 26 : 16, o, { colors, up: 2.2, out: 1.2, life: 0.9 }, rng);
    this.ring(o, sig ? 0xe8b04a : hab ? 0x7fb069 : 0x9ac9e8, 1.1);
  }
  card(o: Vector3, rng: Rng): void {
    this.spawn(34, o, { colors: [0x9a7fc9, 0xe8b04a, 0xf2e8d0], up: 2.6, out: 1.5, life: 1.1 }, rng);
    this.ring(o, 0x9a7fc9, 1.4);
  }
  fanfare(o: Vector3, rng: Rng): void {
    this.spawn(90, o, { colors: [0xe8b04a, 0x7fb069, 0x9ac9e8, 0xc95a8a, 0xf2e8d0], up: 3.4, out: 2.0, life: 1.5, gravity: 2.6 }, rng);
  }
}
