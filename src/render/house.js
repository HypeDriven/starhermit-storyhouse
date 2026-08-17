// render/house.js — the cutaway dollhouse: procedural rooms, authored set
// dressing per room type, merged static geometry (one draw call per room),
// vertex-colored, theme-driven. Front faces stay open toward the camera.
import * as THREE from 'three';

export const ROOM_W = 4.2;
export const ROOM_H = 3.1;
export const ROOM_D = 3.6;
export const ROOM_GAP = 0.28;
const WALL_T = 0.16;

// ---------------------------------------------------------------------------
// Merge helper: bake each part's transform + color into one vertex-colored
// non-indexed geometry. Static dressing draws as a single mesh per room.
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
function mergeParts(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (const part of parts) {
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    const p = geo.attributes.position, no = geo.attributes.normal;
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
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function box(w, h, d, x, y, z, color, rot = null) {
  const matrix = new THREE.Matrix4();
  if (rot) matrix.makeRotationFromEuler(new THREE.Euler(rot.x || 0, rot.y || 0, rot.z || 0));
  matrix.setPosition(x, y, z);
  return { geo: new THREE.BoxGeometry(w, h, d), color, matrix };
}
function cyl(rt, rb, h, seg, x, y, z, color, rot = null) {
  const matrix = new THREE.Matrix4();
  if (rot) matrix.makeRotationFromEuler(new THREE.Euler(rot.x || 0, rot.y || 0, rot.z || 0));
  matrix.setPosition(x, y, z);
  return { geo: new THREE.CylinderGeometry(rt, rb, h, seg), color, matrix };
}
function sph(r, x, y, z, color, scaleY = 1) {
  const matrix = new THREE.Matrix4().makeScale(1, scaleY, 1);
  matrix.setPosition(x, y, z);
  return { geo: new THREE.SphereGeometry(r, 10, 8), color, matrix };
}

// ---------------------------------------------------------------------------
// Room dressing — small authored vignettes that tell each room's story.
// ---------------------------------------------------------------------------
function dressing(type, P, detail) {
  const B = -ROOM_D / 2 + 0.35; // near back wall
  const parts = [];
  const add = (...ps) => parts.push(...ps);
  switch (type) {
    case 'kitchen': {
      add(box(1.7, 0.85, 0.55, -1.0, 0.425, B, P.trim));            // counter
      add(box(1.75, 0.06, 0.6, -1.0, 0.88, B, P.floor));            // counter top
      add(cyl(0.16, 0.2, 0.22, 10, -1.35, 1.0, B, P.accent));       // kettle
      add(box(1.2, 0.05, 0.05, 0.6, 2.0, B - 0.2, P.trim));         // hanging rail
      add(cyl(0.16, 0.16, 0.05, 10, 0.35, 1.8, B - 0.2, P.roof));   // pan 1
      add(cyl(0.13, 0.13, 0.05, 10, 0.85, 1.75, B - 0.2, P.roof));  // pan 2
      if (detail > 0) add(box(0.5, 0.7, 0.4, 1.3, 0.35, B, P.wallSide)); // cupboard
      break;
    }
    case 'library': {
      add(box(2.0, 2.3, 0.35, -0.9, 1.15, B, P.trim));              // shelf case
      for (let s = 0; s < 3; s++) add(box(1.8, 0.05, 0.3, -0.9, 0.55 + s * 0.62, B + 0.03, P.floor));
      if (detail > 0) {
        const cols = [P.accent, P.roof, P.wallSide, P.floor];
        for (let s = 0; s < 3; s++) {
          for (let i = 0; i < 7; i++) {
            const h = 0.34 + ((i * 7 + s * 3) % 4) * 0.05;
            add(box(0.16, h, 0.22, -1.68 + i * 0.26, 0.6 + s * 0.62 + h / 2 - 0.02, B + 0.06, cols[(i + s) % 4]));
          }
        }
      }
      add(box(0.35, 1.6, 0.12, 1.2, 0.8, B + 0.15, P.floor, { z: 0.18 })); // ladder
      break;
    }
    case 'garden': {
      add(box(1.9, 0.3, 0.8, -0.9, 0.15, B + 0.2, P.trim));         // soil bed
      if (detail > 0) {
        for (let i = 0; i < 5; i++) {
          const x = -1.6 + i * 0.38;
          add(cyl(0.02, 0.02, 0.3, 5, x, 0.45, B + 0.2, P.accent));
          add(sph(0.09, x, 0.64, B + 0.2, i % 2 ? P.roof : P.accent));
        }
      }
      for (let i = 0; i < 4; i++) add(box(0.07, 0.5, 0.07, 0.7 + i * 0.3, 0.25, 1.2, P.wallSide)); // fence
      add(box(1.0, 0.06, 0.06, 1.15, 0.42, 1.2, P.wallSide));
      add(cyl(0.12, 0.16, 0.25, 8, 1.2, 0.55, B, P.accent));        // watering can
      break;
    }
    case 'parlor': {
      add(cyl(0.9, 0.9, 0.03, 20, 0.2, 0.02, 0.4, P.accent));       // rug
      add(box(0.85, 0.4, 0.8, -1.2, 0.2, B + 0.5, P.roof));         // armchair seat
      add(box(0.85, 0.75, 0.2, -1.2, 0.55, B + 0.18, P.roof));      // armchair back
      add(box(0.18, 0.5, 0.8, -1.72, 0.35, B + 0.5, P.roof));       // arm
      add(box(0.18, 0.5, 0.8, -0.68, 0.35, B + 0.5, P.roof));       // arm
      add(cyl(0.3, 0.35, 0.5, 10, 1.2, 0.25, B + 0.3, P.trim));     // side table
      add(box(0.7, 0.55, 0.06, 0.3, 1.9, B - 0.15, P.floor));       // picture frame
      if (detail > 0) add(box(0.5, 0.35, 0.04, 0.3, 1.9, B - 0.12, P.wallSide)); // picture
      break;
    }
    case 'bedroom': {
      add(box(1.5, 0.3, 1.0, -0.9, 0.15, B + 0.3, P.trim));         // bed frame
      add(box(1.4, 0.18, 0.9, -0.9, 0.38, B + 0.3, P.wallSide));    // mattress
      add(box(1.4, 0.1, 0.55, -0.9, 0.5, B + 0.45, P.accent));      // blanket
      add(box(0.4, 0.12, 0.3, -1.35, 0.5, B - 0.05, P.hemiSky));    // pillow
      add(box(0.9, 1.9, 0.5, 1.2, 0.95, B, P.trim));                // wardrobe
      if (detail > 0) add(cyl(0.05, 0.05, 0.04, 8, 1.2, 1.0, B + 0.26, P.brand || P.accent)); // knob
      break;
    }
    case 'attic': {
      for (let i = 0; i < 3; i++) add(box(0.12, 0.12, ROOM_D - 0.4, -1.0 + i * 1.0, ROOM_H - 0.5, 0, P.trim, { z: 0.5 })); // rafters
      add(box(1.1, 0.55, 0.6, -1.1, 0.28, B + 0.3, P.roof));        // trunk
      add(box(1.15, 0.12, 0.65, -1.1, 0.6, B + 0.3, P.trim));       // trunk lid
      add(cyl(0.4, 0.4, 0.08, 16, 1.1, 1.9, B - 0.15, P.floor, { x: Math.PI / 2 })); // round window frame
      if (detail > 0) add(cyl(0.32, 0.32, 0.05, 16, 1.1, 1.9, B - 0.12, P.skyColor, { x: Math.PI / 2 }));
      break;
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// House assembly
// ---------------------------------------------------------------------------
export function buildHouse(layout, theme, detail = 1) {
  const P = {
    wall: theme.wall, wallSide: theme.wallSide, floor: theme.floor,
    trim: theme.trim, accent: theme.accent, roof: theme.roof,
    ground: theme.ground, hemiSky: theme.hemiSky, skyColor: theme.sky,
    brand: 0xe8b04a,
  };
  const group = new THREE.Group();
  group.name = 'house';
  const roomAnchors = new Map();

  const cols = Math.max(...layout.rooms.map(r => r.gx)) + 1;
  const rows = Math.max(...layout.rooms.map(r => r.gy)) + 1;
  const houseW = cols * (ROOM_W + ROOM_GAP) - ROOM_GAP;
  const houseH = rows * (ROOM_H + ROOM_GAP) - ROOM_GAP;
  const x0 = -houseW / 2 + ROOM_W / 2;

  const envMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 });

  for (const room of layout.rooms) {
    const cx = x0 + room.gx * (ROOM_W + ROOM_GAP);
    const cy = room.gy * (ROOM_H + ROOM_GAP);
    const parts = [];
    // Shell: floor slab, back wall, two side walls, trim strips.
    parts.push(box(ROOM_W, 0.2, ROOM_D, 0, -0.1, 0, P.floor));
    parts.push(box(ROOM_W, ROOM_H, WALL_T, 0, ROOM_H / 2, -ROOM_D / 2, P.wall));
    parts.push(box(WALL_T, ROOM_H, ROOM_D, -ROOM_W / 2 + WALL_T / 2, ROOM_H / 2, 0, P.wallSide));
    parts.push(box(WALL_T, ROOM_H, ROOM_D, ROOM_W / 2 - WALL_T / 2, ROOM_H / 2, 0, P.wallSide));
    parts.push(box(ROOM_W, 0.1, 0.1, 0, 0.05, ROOM_D / 2 - 0.05, P.trim));      // front threshold
    parts.push(box(ROOM_W, 0.12, 0.12, 0, ROOM_H - 0.06, -ROOM_D / 2 + 0.2, P.trim)); // crown
    // Window on back wall (authored per room, offset by index for variety).
    const wx = ((room.gx * 2 + room.gy) % 3 - 1) * 0.9;
    parts.push(box(0.9, 1.0, 0.06, wx, 1.9, -ROOM_D / 2 + 0.05, P.trim));
    parts.push(box(0.7, 0.8, 0.04, wx, 1.9, -ROOM_D / 2 + 0.08, P.skyColor));
    parts.push(...dressing(room.type, P, detail));

    const mesh = new THREE.Mesh(mergeParts(parts), envMat);
    mesh.position.set(cx, cy, 0);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.layers.set(0);
    group.add(mesh);

    // Slot anchors spread across the floor.
    const n = room.slots;
    const slots = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = cx + THREE.MathUtils.lerp(-ROOM_W / 2 + 0.85, ROOM_W / 2 - 0.85, t);
      const z = i % 2 === 0 ? 0.55 : -0.15; // gentle depth alternation
      slots.push(new THREE.Vector3(x, cy, z));
    }
    roomAnchors.set(room.id, {
      id: room.id, center: new THREE.Vector3(cx, cy + ROOM_H * 0.45, 0),
      floorCenter: new THREE.Vector3(cx, cy, 0.3), slots, bounds: { w: ROOM_W, h: ROOM_H, d: ROOM_D },
    });
  }

  // Roof slabs per column + a chimney.
  const roofParts = [];
  for (let gx = 0; gx < cols; gx++) {
    const cx = x0 + gx * (ROOM_W + ROOM_GAP);
    roofParts.push(box(ROOM_W + 0.4, 0.22, ROOM_D + 0.5, cx, houseH + 0.11, 0, P.roof));
    roofParts.push(box(ROOM_W + 0.44, 0.1, ROOM_D + 0.54, cx, houseH + 0.02, 0, P.trim));
  }
  roofParts.push(box(0.5, 0.9, 0.5, x0 + (cols - 1) * (ROOM_W + ROOM_GAP) + 1.1, houseH + 0.55, -0.8, P.trim));
  roofParts.push(box(0.6, 0.14, 0.6, x0 + (cols - 1) * (ROOM_W + ROOM_GAP) + 1.1, houseH + 1.0, -0.8, P.roof));
  // Stepping stones in front of ground-floor rooms.
  if (detail > 0) {
    for (const room of layout.rooms.filter(r => r.gy === 0)) {
      const cx = x0 + room.gx * (ROOM_W + ROOM_GAP);
      for (let i = 0; i < 3; i++) {
        roofParts.push(cyl(0.3 - i * 0.04, 0.3 - i * 0.04, 0.06, 8, cx + (i - 1) * 0.8, 0.03, ROOM_D / 2 + 0.9 + i * 0.55, P.wallSide));
      }
    }
  }
  const roofMesh = new THREE.Mesh(mergeParts(roofParts), envMat);
  roofMesh.castShadow = true;
  roofMesh.layers.set(0);
  group.add(roofMesh);

  // Ground.
  const extent = Math.max(houseW, houseH) * 0.5 + 4;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(extent * 1.6, 40),
    new THREE.MeshStandardMaterial({ color: P.ground, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.22;
  ground.receiveShadow = true;
  ground.layers.set(0);
  group.add(ground);

  const houseCenter = new THREE.Vector3(0, houseH / 2 - 0.4, 0);
  const houseExtent = Math.max(houseW, houseH * 1.15) / 2 + 1.2;
  return { group, roomAnchors, houseCenter, houseExtent, houseW, houseH, envMat };
}
