// render/camera.js on starhermit:scene, unchanged: the authored camera —
// framing constants (no magic offsets), critically damped spring motion on
// fixed 120 Hz substeps, interruptible transitions, bounded orbit (yaw ±0.6
// rad, pitch 0.5–1.15 rad) so the walls never hide the rooms, and a small
// event-tiered shake (none with reduced motion).
import { MathUtils, PerspectiveCamera, Vector3 } from "starhermit:scene";

export const FRAMING = {
  fov: 32, pitch: 0.66, yaw: 0.0, distPerUnit: 1.9, minDist: 7, maxDist: 34,
  lookLift: -0.5, orbitYawLimit: 0.6, orbitPitchMin: 0.5, orbitPitchMax: 1.15, omega: 5.5,
};
interface Vel { out: number }
function damp(current: number, target: number, velocity: Vel, omega: number, dt: number): number {
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
  camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
  target = new Vector3();
  dist = 16; yaw = FRAMING.yaw; pitch = FRAMING.pitch;
  sTarget = new Vector3();
  sDist = 16; sYaw = FRAMING.yaw; sPitch = FRAMING.pitch;
  vDist: Vel = { out: 0 }; vYaw: Vel = { out: 0 }; vPitch: Vel = { out: 0 };
  vT = { x: { out: 0 }, y: { out: 0 }, z: { out: 0 } };
  reducedMotion = false;
  houseCenter = new Vector3();
  houseSize: { w: number; h: number } | null = null;
  houseExtent = 8;
  aspect = 1;
  private shakeAmt = 0;
  private time = 0;

  /** Frame the whole house from its bounds. */
  frameHouse(center: Vector3, s: { w: number; h: number }, snap = false): void {
    if (!s || !Number.isFinite(s.w) || !Number.isFinite(s.h) || s.w <= 0 || s.h <= 0) return;
    this.houseCenter.copy(center);
    this.houseSize = { ...s };
    this.houseExtent = Math.max(s.w, s.h) / 2;
    const halfFov = MathUtils.degToRad(FRAMING.fov / 2);
    const margin = 1.5;
    const distH = (s.h / 2 + margin) / Math.tan(halfFov);
    const distW = (s.w / 2 + margin) / (Math.tan(halfFov) * Math.max(0.4, this.aspect));
    const dist = MathUtils.clamp(Math.max(distH, distW), FRAMING.minDist, FRAMING.maxDist);
    this.setPose(center.x, center.y + FRAMING.lookLift, center.z, dist, FRAMING.yaw, FRAMING.pitch, snap);
  }
  setPose(tx: number, ty: number, tz: number, dist: number, yaw: number, pitch: number, snap = false): void {
    this.target.set(tx, ty, tz);
    this.dist = dist; this.yaw = yaw; this.pitch = pitch;
    if (snap || this.reducedMotion) {
      this.sTarget.copy(this.target);
      this.sDist = dist; this.sYaw = yaw; this.sPitch = pitch;
    }
  }
  orbit(dYaw: number, dPitch: number): void {
    this.yaw = MathUtils.clamp(this.yaw + dYaw, -FRAMING.orbitYawLimit, FRAMING.orbitYawLimit);
    this.pitch = MathUtils.clamp(this.pitch + dPitch, FRAMING.orbitPitchMin, FRAMING.orbitPitchMax);
  }
  zoom(delta: number): void { this.dist = MathUtils.clamp(this.dist * (1 + delta), FRAMING.minDist, FRAMING.maxDist); }
  focusRoom(center: Vector3): void {
    this.setPose(center.x, center.y + FRAMING.lookLift, center.z, Math.max(FRAMING.minDist, this.houseExtent * 0.9), FRAMING.yaw * 0.4, FRAMING.pitch, false);
  }
  reset(): void { if (this.houseSize) this.frameHouse(this.houseCenter, this.houseSize); }
  shake(amount: number): void {
    if (this.reducedMotion) return;
    this.shakeAmt = Math.min(0.12, this.shakeAmt + amount);
  }
  resize(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.houseSize) this.frameHouse(this.houseCenter, this.houseSize);
  }
  /** Advance springs with fixed 120 Hz substeps — never per-frame lerp. */
  update(dt: number): void {
    this.time += dt;
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
    const pos = new Vector3(this.sTarget.x + this.sDist * cy * sx, this.sTarget.y + this.sDist * sy, this.sTarget.z + this.sDist * cy * cx);
    if (this.shakeAmt > 0.0005) {
      const t = this.time * 30;
      pos.x += Math.sin(t * 1.3) * this.shakeAmt;
      pos.y += Math.cos(t * 1.7) * this.shakeAmt * 0.6;
      this.shakeAmt *= Math.exp(-dt * 7);
    } else this.shakeAmt = 0;
    this.camera.position.copy(pos);
    this.camera.lookAt(this.sTarget);
  }
}
