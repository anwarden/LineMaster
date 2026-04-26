import * as THREE from 'three';
import { COLORS, ColorKey, Connection, Dimension, DIMENSION_LINE_Y, hexToNum } from './types';

const TUBE_RADIUS = 6;
const RADIAL_SEGMENTS = 12;
const PREVIEW_RADIAL_SEGMENTS = 8;     // cheaper for the live rebuild path
const COLLISION_DISTANCE = 16;
const MIN_POINTS_FOR_CURVE = 2;
const GLOW_SCALE = 1.7;

/**
 * Build a glowing tube mesh — a solid inner core wrapped in an additive outer
 * shell so the line reads bright and saturated against the dark background.
 *
 * Geometry is baked at the dimension's altitude (surface or tunnel). The
 * worldFlip group rotates 180° around X on dimension switch, so a tunnel-baked
 * line at local Y=−80 will physically swing up to the visible top after the
 * flip — and vice versa.
 */
function buildTubeMesh(
  pathPoints: THREE.Vector3[],
  colorKey: ColorKey,
  dimension: Dimension
): THREE.Group {
  const y = DIMENSION_LINE_Y[dimension];
  const lifted = pathPoints.map((p) => new THREE.Vector3(p.x, y, p.z));
  const safe = lifted.length >= MIN_POINTS_FOR_CURVE
    ? lifted
    : [lifted[0], lifted[0].clone()];

  const curve = new THREE.CatmullRomCurve3(safe, false, 'centripetal', 0.4);
  const tubularSegments = Math.max(12, safe.length * 4);
  const colorHex = hexToNum(COLORS[colorKey]);
  const colorObj = new THREE.Color(colorHex);

  const group = new THREE.Group();
  group.userData = { kind: 'flow-tube', colorKey, dimension };

  // Inner core — vivid + emissive
  const coreGeo = new THREE.TubeGeometry(curve, tubularSegments, TUBE_RADIUS, RADIAL_SEGMENTS, false);
  const coreMat = new THREE.MeshLambertMaterial({
    color: colorHex,
    emissive: colorObj,
    emissiveIntensity: 0.85,
    transparent: true,
    opacity: 1,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.userData = { role: 'core' };
  group.add(core);

  // Outer additive glow tube
  const glowGeo = new THREE.TubeGeometry(curve, tubularSegments, TUBE_RADIUS * GLOW_SCALE, RADIAL_SEGMENTS, false);
  const glowMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.userData = { role: 'glow' };
  group.add(glow);

  // White hot inner stripe (very thin) for the juicy "neon center"
  const stripeGeo = new THREE.TubeGeometry(curve, tubularSegments, TUBE_RADIUS * 0.35, RADIAL_SEGMENTS, false);
  const stripeMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
  });
  const stripe = new THREE.Mesh(stripeGeo, stripeMat);
  stripe.userData = { role: 'stripe' };
  group.add(stripe);

  return group;
}

/**
 * Build a *cheap* single-tube mesh for the live preview during a drag.
 * The full 3-tube glow stack is reserved for committed connections — at drag time
 * the rebuild would happen at every pointermove, so we minimise vertex count.
 */
function buildPreviewMesh(
  pathPoints: THREE.Vector3[],
  colorKey: ColorKey,
  dimension: Dimension
): THREE.Mesh {
  const y = DIMENSION_LINE_Y[dimension];
  const lifted = pathPoints.map((p) => new THREE.Vector3(p.x, y, p.z));
  const safe = lifted.length >= MIN_POINTS_FOR_CURVE
    ? lifted
    : [lifted[0], lifted[0].clone()];

  const curve = new THREE.CatmullRomCurve3(safe, false, 'centripetal', 0.4);
  const tubularSegments = Math.max(8, safe.length * 2);    // half the segment density of committed
  const colorHex = hexToNum(COLORS[colorKey]);
  const colorObj = new THREE.Color(colorHex);

  const geo = new THREE.TubeGeometry(curve, tubularSegments, TUBE_RADIUS, PREVIEW_RADIAL_SEGMENTS, false);
  const mat = new THREE.MeshLambertMaterial({
    color: colorHex,
    emissive: colorObj,
    emissiveIntensity: 1.0,
    transparent: true,
    opacity: 0.92,
  });
  return new THREE.Mesh(geo, mat);
}

/** Live preview: rebuilds a single cheap tube when the path changes. */
export class LinePreview {
  private mesh: THREE.Mesh | null = null;
  private colorKey: ColorKey | null = null;

  constructor(private layer: THREE.Group) {}

  start(colorKey: ColorKey, dimension: Dimension, startPoint: THREE.Vector3) {
    this.dispose();
    this.colorKey = colorKey;
    this.setPath([startPoint, startPoint.clone()], dimension);
  }

  setPath(points: THREE.Vector3[], dimension: Dimension) {
    if (!this.colorKey) return;
    this.dispose();
    if (points.length < 2) return;
    this.mesh = buildPreviewMesh(points, this.colorKey, dimension);
    this.layer.add(this.mesh);
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.layer.remove(this.mesh);
      this.mesh = null;
    }
  }
}

export function commitConnection(
  layer: THREE.Group,
  pathPoints: THREE.Vector3[],
  colorKey: ColorKey,
  dimension: Dimension,
  born: number
): Connection {
  const group = buildTubeMesh(pathPoints, colorKey, dimension);
  layer.add(group);
  return {
    pathPoints: pathPoints.map((p) => p.clone()),
    colorKey,
    dimension,
    mesh: group,
    born,
  };
}

/** Spawn-swell + idle pulse for committed lines. Geometry is baked per-dim;
 *  the worldFlip group physically rotates 180° on a switch so the line swings
 *  to the right side of the slab. We just dim the inactive layer's lines so
 *  the player can still tell which side is up. */
export function updateConnectionVisibility(
  connections: Connection[],
  activeDimension: Dimension,
  elapsed: number
) {
  for (const c of connections) {
    if (!(c.mesh instanceof THREE.Group)) continue;
    const age = elapsed - c.born;
    const swell = age < 0.5 ? Math.min(1, age / 0.5) : 1;
    c.mesh.scale.setScalar(0.9 + swell * 0.1);
    const sameLayer = c.dimension === activeDimension;

    if (sameLayer) {
      const pulse = 0.32 + Math.sin(elapsed * 3 + c.born * 7) * 0.08;
      setMeshOpacityRole(c.mesh, 'glow',   pulse);
      setMeshOpacityRole(c.mesh, 'core',   1);
      setMeshOpacityRole(c.mesh, 'stripe', 0.85);
    } else {
      // Ghost — barely visible through the translucent slab.
      setMeshOpacityRole(c.mesh, 'glow',   0);
      setMeshOpacityRole(c.mesh, 'core',   0.32);
      setMeshOpacityRole(c.mesh, 'stripe', 0);
    }
  }
}

/** True if `point` is within collision radius of any same-dimension committed tube path. */
export function hasCrash(
  point: THREE.Vector3,
  connections: Connection[],
  dimension: Dimension
): boolean {
  for (const c of connections) {
    if (c.dimension !== dimension) continue;
    for (const p of c.pathPoints) {
      const dx = point.x - p.x;
      const dz = point.z - p.z;
      if (Math.hypot(dx, dz) < COLLISION_DISTANCE) return true;
    }
  }
  return false;
}

/** Bookkeeping helpers. */
function setMeshOpacityRole(group: THREE.Group, role: string, opacity: number) {
  for (const child of group.children) {
    const ud = (child.userData ?? {}) as { role?: string };
    if (ud.role === role && child instanceof THREE.Mesh) {
      const mat = child.material as THREE.Material & { opacity?: number };
      if (mat.opacity !== undefined) mat.opacity = opacity;
    }
  }
}

export function disposeTubeGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else (m as THREE.Material).dispose();
    }
  });
}
