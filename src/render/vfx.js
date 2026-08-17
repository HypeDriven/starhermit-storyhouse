// render/vfx.js — pooled particles + impact rings on their own render layer.
// Event hierarchy: ack < legal move < goal < round completion. Particles
// never intercept raycasts. Motion is seeded (audiovisual stream) and the
// pool is hard-capped per quality tier.
import * as THREE from 'three';

const LAYER_VFX = 3;

export class VfxPool {
  constructor(scene, cap = 3000) {
    this.cap = cap;
    this.count = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_VFX);
    this.points.raycast = () => {}; // cosmetic: never pickable
    scene.add(this.points);

    // Impact rings (bounded accent pool).
    this.rings = [];
    for (let i = 0; i < 8; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.38, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.layers.set(LAYER_VFX);
      ring.raycast = () => {};
      scene.add(ring);
      this.rings.push({ mesh: ring, t: 1, dur: 0.5 });
    }
    this.enabled = true;
    this._c = new THREE.Color();
  }

  setCap(cap) {
    this.cap = Math.min(cap, this.pos.length / 3);
    if (this.count > this.cap) this.count = this.cap;
  }

  spawn(n, origin, opts, rng) {
    if (!this.enabled) return;
    for (let i = 0; i < n; i++) {
      if (this.count >= this.cap) return;
      const k = this.count++;
      const a = rng.next() * Math.PI * 2;
      const r = (opts.radius ?? 0.15) * (0.4 + rng.next() * 0.6);
      this.pos[k * 3] = origin.x + Math.cos(a) * r;
      this.pos[k * 3 + 1] = origin.y + (rng.next() - 0.2) * 0.1;
      this.pos[k * 3 + 2] = origin.z + Math.sin(a) * r;
      const up = opts.up ?? 1.6;
      const out = opts.out ?? 0.9;
      this.vel[k * 3] = Math.cos(a) * out * (0.3 + rng.next() * 0.7);
      this.vel[k * 3 + 1] = up * (0.5 + rng.next() * 0.8);
      this.vel[k * 3 + 2] = Math.sin(a) * out * (0.3 + rng.next() * 0.7);
      this._c.set(opts.colors[(rng.next() * opts.colors.length) | 0]);
      this.col[k * 3] = this._c.r; this.col[k * 3 + 1] = this._c.g; this.col[k * 3 + 2] = this._c.b;
      this.maxLife[k] = this.life[k] = (opts.life ?? 0.8) * (0.7 + rng.next() * 0.6);
      this.grav[k] = opts.gravity ?? 3.2;
    }
  }

  ring(origin, color, scale = 1) {
    if (!this.enabled) return;
    const r = this.rings.find(x => x.t >= x.dur) || this.rings[0];
    r.t = 0; r.dur = 0.5;
    r.mesh.visible = true;
    r.mesh.position.copy(origin).y += 0.03;
    r.mesh.material.color.set(color);
    r.mesh.scale.setScalar(scale);
  }

  /** Fixed-step update; deterministic motion independent of frame rate. */
  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        const last = --this.count;
        if (i !== last) {
          for (let c = 0; c < 3; c++) {
            this.pos[i * 3 + c] = this.pos[last * 3 + c];
            this.vel[i * 3 + c] = this.vel[last * 3 + c];
            this.col[i * 3 + c] = this.col[last * 3 + c];
          }
          this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last]; this.grav[i] = this.grav[last];
        }
        continue;
      }
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.35; }
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
      r.mesh.material.opacity = 0.7 * (1 - k);
    }
  }

  clear() {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
    for (const r of this.rings) { r.t = r.dur; r.mesh.visible = false; }
  }

  // Event tiers -----------------------------------------------------------
  ack(origin, rng)          { this.spawn(6, origin, { colors: [0xf2e8d0], up: 1.0, out: 0.5, life: 0.5 }, rng); }
  placed(origin, rng)       { this.spawn(10, origin, { colors: [0xf2e8d0, 0xd9b06a], up: 1.4, out: 0.7, life: 0.6 }, rng); this.ring(origin, 0xf2e8d0, 0.7); }
  invalid(origin, rng)      { this.spawn(5, origin, { colors: [0xd95d4e], up: 0.7, out: 0.4, life: 0.4 }, rng); }
  beat(origin, sig, hab, rng) {
    const colors = sig ? [0xe8b04a, 0xffd166, 0xf2e8d0] : hab ? [0x7fb069, 0xa8d89a, 0xf2e8d0] : [0x9ac9e8, 0xf2e8d0];
    this.spawn(sig || hab ? 26 : 16, origin, { colors, up: 2.2, out: 1.2, life: 0.9 }, rng);
    this.ring(origin, sig ? 0xe8b04a : hab ? 0x7fb069 : 0x9ac9e8, 1.1);
  }
  card(origin, rng) {
    this.spawn(34, origin, { colors: [0x9a7fc9, 0xe8b04a, 0xf2e8d0], up: 2.6, out: 1.5, life: 1.1 }, rng);
    this.ring(origin, 0x9a7fc9, 1.4);
  }
  fanfare(origin, rng) {
    this.spawn(90, origin, { colors: [0xe8b04a, 0x7fb069, 0x9ac9e8, 0xc95a8a, 0xf2e8d0], up: 3.4, out: 2.0, life: 1.5, gravity: 2.6 }, rng);
  }
}
