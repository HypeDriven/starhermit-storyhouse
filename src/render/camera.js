// render/camera.js — authored camera: framing constants (no magic offsets),
// critically damped spring motion, interruptible transitions, orbit limits.
import * as THREE from 'three';

export const FRAMING = {
  fov: 32,               // low-distortion perspective
  pitch: 0.66,           // rad above horizon looking at house
  yaw: 0.0,              // front-on
  distPerUnit: 1.9,      // distance per world unit of house extent
  minDist: 7,
  maxDist: 34,
  lookLift: -0.5,        // aim below the roofline so the tray reads on screen
  orbitYawLimit: 0.85,   // rad
  orbitPitchMin: 0.28,
  orbitPitchMax: 1.15,
  omega: 5.5,            // spring natural frequency (critically damped)
};

function damp(current, target, velocity, omega, dt) {
  // Critically damped spring step (stable for any dt, interruptible).
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

export class CameraRig {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
    this.target = new THREE.Vector3();
    this.dist = 16;
    this.yaw = FRAMING.yaw;
    this.pitch = FRAMING.pitch;
    // Spring state
    this.sTarget = new THREE.Vector3();
    this.sDist = 16; this.sYaw = FRAMING.yaw; this.sPitch = FRAMING.pitch;
    this.vTarget = new THREE.Vector3();
    this.vDist = { out: 0 }; this.vYaw = { out: 0 }; this.vPitch = { out: 0 };
    this.vT = { x: { out: 0 }, y: { out: 0 }, z: { out: 0 } };
    this.reducedMotion = false;
    this.houseCenter = new THREE.Vector3();
    this.houseExtent = 8;
    this.aspect = 1;
    this._shake = 0;
  }

  /** Frame the whole house from its bounds. */
  frameHouse(center, size, snap = false) {
    // size: {w, h} world dimensions of the house (or a scalar extent).
    const s = typeof size === 'number' ? { w: size, h: size } : size;
    if (!s || !Number.isFinite(s.w) || !Number.isFinite(s.h) || s.w <= 0 || s.h <= 0) return;
    this.houseCenter.copy(center);
    this.houseSize = { ...s };
    this.houseExtent = Math.max(s.w, s.h) / 2;
    const halfFov = THREE.MathUtils.degToRad(FRAMING.fov / 2);
    const margin = 1.5;
    const distH = (s.h / 2 + margin) / Math.tan(halfFov);
    const distW = (s.w / 2 + margin) / (Math.tan(halfFov) * Math.max(0.4, this.aspect));
    const dist = THREE.MathUtils.clamp(Math.max(distH, distW), FRAMING.minDist, FRAMING.maxDist);
    this.setPose(center.x, center.y + FRAMING.lookLift, center.z, dist, FRAMING.yaw, FRAMING.pitch, snap);
  }

  setPose(tx, ty, tz, dist, yaw, pitch, snap = false) {
    this.target.set(tx, ty, tz);
    this.dist = dist; this.yaw = yaw; this.pitch = pitch;
    if (snap || this.reducedMotion) {
      this.sTarget.copy(this.target);
      this.sDist = dist; this.sYaw = yaw; this.sPitch = pitch;
    }
  }

  orbit(dYaw, dPitch) {
    this.yaw = THREE.MathUtils.clamp(this.yaw + dYaw, -FRAMING.orbitYawLimit, FRAMING.orbitYawLimit);
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, FRAMING.orbitPitchMin, FRAMING.orbitPitchMax);
  }
  zoom(delta) {
    this.dist = THREE.MathUtils.clamp(this.dist * (1 + delta), FRAMING.minDist, FRAMING.maxDist);
  }
  focusRoom(center) {
    this.setPose(center.x, center.y + FRAMING.lookLift, center.z,
      Math.max(FRAMING.minDist, this.houseExtent * 0.9), FRAMING.yaw * 0.4, FRAMING.pitch, false);
  }
  reset() {
    this.frameHouse(this.houseCenter, this.houseSize || this.houseExtent);
  }
  shake(amount) {
    if (this.reducedMotion) return;
    this._shake = Math.min(0.12, this._shake + amount);
  }

  resize(aspect) {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.houseSize || this.houseExtent) this.frameHouse(this.houseCenter, this.houseSize || this.houseExtent);
  }

  /** Advance springs with fixed 120 Hz substeps — never per-frame lerp. */
  update(dt) {
    let remaining = Math.min(dt, 0.1);
    const step = 1 / 120;
    while (remaining > 1e-6) {
      const h = Math.min(step, remaining);
      remaining -= h;
      this.sDist = damp(this.sDist, this.dist, this.vDist, FRAMING.omega, h);
      this.sYaw = damp(this.sYaw, this.yaw, this.vYaw, FRAMING.omega, h);
      this.sPitch = damp(this.sPitch, this.pitch, this.vPitch, FRAMING.omega, h);
      this.sTarget.x = damp(this.sTarget.x, this.target.x, this.vT.x, FRAMING.omega, h);
      this.sTarget.y = damp(this.sTarget.y, this.target.y, this.vT.y, FRAMING.omega, h);
      this.sTarget.z = damp(this.sTarget.z, this.target.z, this.vT.z, FRAMING.omega, h);
    }
    const cy = Math.cos(this.sPitch), sy = Math.sin(this.sPitch);
    const cx = Math.cos(this.sYaw), sx = Math.sin(this.sYaw);
    const pos = new THREE.Vector3(
      this.sTarget.x + this.sDist * cy * sx,
      this.sTarget.y + this.sDist * sy,
      this.sTarget.z + this.sDist * cy * cx,
    );
    if (this._shake > 0.0005) {
      const t = performance.now() * 0.03;
      pos.x += Math.sin(t * 1.3) * this._shake;
      pos.y += Math.cos(t * 1.7) * this._shake * 0.6;
      this._shake *= Math.exp(-dt * 7);
    } else {
      this._shake = 0;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this.sTarget);
  }
}
