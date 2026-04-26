import * as THREE from 'three';
import {
  COLORS,
  ColorKey,
  DIMENSION_LINE_Y,
  Station,
  StationDef,
  hexToNum,
} from './types';

/**
 * A station is a glossy gem-cap pierced by a slim white post that spans both layers.
 * - Coloured cap at the top  → reaches the surface line plane (Y > 0)
 * - Coloured cap at the bottom → reaches the tunnel line plane (Y < 0)
 * - Glow shell around each cap (additive sphere) for vivid bloom-like halo
 * - Halo ring at the ground for the active target colour
 */
const POST_RADIUS = 3;
const CAP_RADIUS = 16;
const CAP_HEIGHT = 8;
const STATION_HIT_RADIUS = 32;

const SURFACE_Y = DIMENSION_LINE_Y.surface;
const TUNNEL_Y = DIMENSION_LINE_Y.tunnel;

export function buildStation(
  def: StationDef,
  elapsed: number,
  /** When false (levels without the flip mechanic), only the surface side is
   *  rendered — no bottom cap, no tunnel-side glow, post stops at the slab. */
  dimensional: boolean = true
): Station {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.userData = { kind: 'station', id: def.id };

  const colorHex = hexToNum(COLORS[def.colorKey]);
  const colorObj = new THREE.Color(colorHex);

  // Vertical post — spans both layers in dimensional mode, otherwise stops at
  // the slab so non-dim levels don't show a stick poking into empty void.
  const postHeight = dimensional
    ? (SURFACE_Y - TUNNEL_Y) + 4                  // full span (~164 u)
    : SURFACE_Y + 4;                              // surface only (~84 u)
  const postCenterY = dimensional
    ? (SURFACE_Y + TUNNEL_Y) / 2                  // centred between layers (= 0)
    : SURFACE_Y / 2;                              // centred between slab and surface cap

  const postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, postHeight, 16);
  const postMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  const post = new THREE.Mesh(postGeo, postMat);
  post.position.y = postCenterY;
  group.add(post);

  // === TOP CAP (surface) ===
  const topCap = new THREE.Group();
  topCap.position.y = SURFACE_Y + CAP_HEIGHT / 2;
  topCap.userData = { kind: 'cap', layer: 'surface' };
  group.add(topCap);

  const topGeo = new THREE.CylinderGeometry(CAP_RADIUS, CAP_RADIUS, CAP_HEIGHT, 32);
  const topMat = new THREE.MeshLambertMaterial({
    color: colorHex,
    emissive: colorObj,
    emissiveIntensity: 0.6,
  });
  topCap.add(new THREE.Mesh(topGeo, topMat));

  // White inner core
  const topDotGeo = new THREE.CylinderGeometry(CAP_RADIUS * 0.32, CAP_RADIUS * 0.32, CAP_HEIGHT + 0.5, 24);
  const topDotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const topDot = new THREE.Mesh(topDotGeo, topDotMat);
  topDot.position.y = 0.4;
  topCap.add(topDot);

  // Additive glow shell
  const topGlowGeo = new THREE.SphereGeometry(CAP_RADIUS * 1.6, 24, 16);
  const topGlowMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const topGlow = new THREE.Mesh(topGlowGeo, topGlowMat);
  topGlow.userData = { kind: 'glow' };
  topCap.add(topGlow);

  // === BOTTOM CAP (tunnel) — DIAMANT (carré rotaté 45° vu de dessus) ===
  // Built only for dimensional levels — non-dimensional levels (L1/L2) hide
  // the entire tunnel side so nothing visually clutters the player.
  if (dimensional) {
    const botCap = new THREE.Group();
    botCap.position.y = TUNNEL_Y - CAP_HEIGHT / 2;
    botCap.rotation.y = Math.PI / 4;        // 45° → diamant vu d'au-dessus
    botCap.userData = { kind: 'cap', layer: 'tunnel' };
    group.add(botCap);

    const SQUARE_SIDE = CAP_RADIUS * Math.SQRT2;
    const botGeo = new THREE.BoxGeometry(SQUARE_SIDE, CAP_HEIGHT, SQUARE_SIDE);
    const botMat = new THREE.MeshLambertMaterial({
      color: colorHex,
      emissive: colorObj,
      emissiveIntensity: 0.6,
    });
    botCap.add(new THREE.Mesh(botGeo, botMat));

    const botDotSide = SQUARE_SIDE * 0.32;
    const botDotGeo = new THREE.BoxGeometry(botDotSide, CAP_HEIGHT + 0.5, botDotSide);
    const botDotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const botDot = new THREE.Mesh(botDotGeo, botDotMat);
    botDot.position.y = -0.4;
    botCap.add(botDot);

    const botGlowSide = SQUARE_SIDE * 1.85;
    const botGlowGeo = new THREE.BoxGeometry(botGlowSide, CAP_HEIGHT * 2.5, botGlowSide);
    const botGlowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const botGlow = new THREE.Mesh(botGlowGeo, botGlowMat);
    botGlow.userData = { kind: 'glow' };
    botCap.add(botGlow);
  }

  // === Halo ring on the ground plane ===
  const haloGeo = new THREE.RingGeometry(CAP_RADIUS * 1.4, CAP_RADIUS * 1.85, 48);
  haloGeo.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.y = 0.6;
  halo.userData = { kind: 'halo' };
  group.add(halo);

  // Outer expanding ripple ring (used on hover-near pulse)
  const rippleGeo = new THREE.RingGeometry(CAP_RADIUS * 1.0, CAP_RADIUS * 1.15, 48);
  rippleGeo.rotateX(-Math.PI / 2);
  const rippleMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ripple = new THREE.Mesh(rippleGeo, rippleMat);
  ripple.position.y = 0.4;
  ripple.userData = { kind: 'ripple' };
  group.add(ripple);

  // Start scaled to 0 for pop-in
  group.scale.setScalar(0);

  return { ...def, group, pulse: 0, hoverPulse: 0, spawnTime: elapsed };
}

/** Pick the closest station to a ground point within hit radius (XZ only). */
export function findStationAt(
  point: THREE.Vector3,
  stations: Station[]
): Station | null {
  let best: Station | null = null;
  let bestDist = STATION_HIT_RADIUS;
  for (const s of stations) {
    const d = Math.hypot(point.x - s.group.position.x, point.z - s.group.position.z);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

/** Distance to the closest station (no hit-radius filter). */
export function distToNearestStation(point: THREE.Vector3, stations: Station[]): { station: Station | null; dist: number } {
  let best: Station | null = null;
  let bestDist = Infinity;
  for (const s of stations) {
    const d = Math.hypot(point.x - s.group.position.x, point.z - s.group.position.z);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return { station: best, dist: bestDist };
}

/** Animate pop-in spawn, halo ring, hover ripple, and target wobble.
 *
 *  Puzzle mode: instead of one "current target colour", every colour that
 *  hasn't been connected yet pulses — the player picks freely which to start.
 */
export function updateStationGlow(
  stations: Station[],
  unconnectedColors: Set<ColorKey>,
  hoveredId: string | null,
  elapsed: number,
  /** When true, the (single) target colour blinks faster + harder so the
   *  tutorial player's eye is pulled to it. */
  tutorialBoost: boolean = false
) {
  // Sharper, faster sine for tutorial — same shape, double frequency, ~2× amplitude.
  const wobbleFreq = tutorialBoost ? 11 : 6;
  const wobbleAmp  = tutorialBoost ? 0.16 : 0.07;
  const haloFreq   = tutorialBoost ? 9 : 5;
  const haloAmp    = tutorialBoost ? 0.35 : 0.18;
  const haloBase   = tutorialBoost ? 0.65 : 0.45;
  const haloScaleAmp = tutorialBoost ? 0.14 : 0.06;
  const haloScaleFreq = tutorialBoost ? 7 : 4;

  for (const s of stations) {
    const t = Math.min(1, (elapsed - s.spawnTime) / 0.5);
    const eased = t < 1
      ? overshoot(t)
      : 1;
    const spawnScale = eased;

    const isTarget = unconnectedColors.has(s.colorKey);
    const isHovered = hoveredId === s.id;

    s.pulse = isTarget ? Math.min(1, s.pulse + 0.08) : Math.max(0, s.pulse - 0.05);
    s.hoverPulse = isHovered ? Math.min(1, s.hoverPulse + 0.18) : Math.max(0, s.hoverPulse - 0.12);

    // Wobble on target + hover bump
    const wobble = isTarget ? Math.sin(elapsed * wobbleFreq) * wobbleAmp : 0;
    const hoverBump = s.hoverPulse * 0.18;
    const baseScale = spawnScale * (1 + wobble + hoverBump);
    s.group.scale.setScalar(baseScale);

    // Slight rotation jitter for hovered target
    if (isHovered) {
      s.group.rotation.y = Math.sin(elapsed * 8) * 0.08 * s.hoverPulse;
    } else {
      s.group.rotation.y *= 0.85;
    }

    const halo = findChildByKind(s.group, 'halo') as THREE.Mesh | undefined;
    if (halo) {
      const haloMat = halo.material as THREE.MeshBasicMaterial;
      const target = isTarget ? haloBase + Math.sin(elapsed * haloFreq) * haloAmp : 0;
      haloMat.opacity += (target - haloMat.opacity) * 0.18;
      const haloScale = isTarget ? 1 + Math.sin(elapsed * haloScaleFreq) * haloScaleAmp : 1;
      halo.scale.setScalar(haloScale);
    }

    const ripple = findChildByKind(s.group, 'ripple') as THREE.Mesh | undefined;
    if (ripple) {
      const rippleMat = ripple.material as THREE.MeshBasicMaterial;
      // expand on hover
      if (s.hoverPulse > 0.01) {
        const phase = (elapsed * 1.4) % 1;
        ripple.scale.setScalar(1 + phase * 1.4);
        rippleMat.opacity = (1 - phase) * 0.7 * s.hoverPulse;
      } else {
        rippleMat.opacity *= 0.85;
      }
    }

    // Pulse glow shells with target pulse + hover
    s.group.traverse((child) => {
      const ud = (child.userData ?? {}) as { kind?: string };
      if (ud.kind === 'glow' && child instanceof THREE.Mesh) {
        const m = child.material as THREE.MeshBasicMaterial;
        const base = 0.22 + (isTarget ? 0.18 + Math.sin(elapsed * 5) * 0.1 : 0) + s.hoverPulse * 0.25;
        m.opacity = base;
      }
    });
  }
}

/** Linear ease overshoot — for the springy pop-in. */
function overshoot(t: number): number {
  // cubic-bezier(.34,1.56,.64,1)-ish via sigmoid-ish curve
  const c = 1.7;
  const x = t - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

function findChildByKind(group: THREE.Object3D, kind: string): THREE.Object3D | undefined {
  return group.children.find((c) => (c.userData as { kind?: string }).kind === kind);
}
