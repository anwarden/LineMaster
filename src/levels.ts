import {
  ColorKey,
  LevelConfig,
  StationDef,
  WORLD_HALF_X,
  WORLD_HALF_Z,
} from './types';

const ALL_COLORS: ColorKey[] = ['PINK', 'CYAN', 'LIME', 'PURPLE', 'ORANGE'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L1 — Warmup: 3 colors aligned in two rows. Pure matching, no crossing rule. */
function buildLevel1(): StationDef[] {
  const colors: ColorKey[] = ['PINK', 'CYAN', 'LIME'];
  const stations: StationDef[] = [];
  const xSpacing = (WORLD_HALF_X * 1.5) / (colors.length - 1);
  colors.forEach((c, i) => {
    const x = -WORLD_HALF_X * 0.75 + i * xSpacing;
    stations.push({ id: `${c}_top`, x, z: -WORLD_HALF_Z * 0.55, colorKey: c });
    stations.push({ id: `${c}_bot`, x, z:  WORLD_HALF_Z * 0.55, colorKey: c });
  });
  return stations;
}

/** L2 — Alert: 5 colors scattered randomly in two bands. Crossing penalised. */
function buildLevel2(): StationDef[] {
  const r = rng(0xa1b2c3d4);
  const stations: StationDef[] = [];
  ALL_COLORS.forEach((c) => {
    stations.push({
      id: `${c}_top`,
      x: -WORLD_HALF_X * 0.85 + r() * WORLD_HALF_X * 1.7,
      z: -WORLD_HALF_Z * 0.7 + r() * WORLD_HALF_Z * 0.4,
      colorKey: c,
    });
    stations.push({
      id: `${c}_bot`,
      x: -WORLD_HALF_X * 0.85 + r() * WORLD_HALF_X * 1.7,
      z:  WORLD_HALF_Z * 0.3 + r() * WORLD_HALF_Z * 0.4,
      colorKey: c,
    });
  });
  return stations;
}

/** L3 — Dimensions: every station sits ON the play boundary, with the colour
 *  pairs interleaved so their endpoints alternate around the perimeter. By
 *  the Jordan-curve / two-arc argument, two pairs whose endpoints alternate
 *  around the boundary of a simply-connected region MUST cross inside it —
 *  no clever routing escapes that. Combined with the hard bound clamp, this
 *  topologically forces the player to put one set of pairs on each layer.
 *
 *  Boundary order (clockwise from top edge):
 *    PINK_top → ORANGE_top  (top edge)
 *    CYAN_r → PURPLE_r → LIME_r  (right edge)
 *    ORANGE_bot → PINK_bot  (bot edge)
 *    LIME_l → PURPLE_l → CYAN_l  (left edge)
 *
 *  Crossing graph (after working out the alternation for each pair-pair):
 *    {PINK, ORANGE} × {CYAN, PURPLE, LIME}  — i.e. K_{2,3}.
 *  Bipartite ⇒ exactly 2-colourable ⇒ exactly 2 layers ⇒ flip required. */
function buildLevel3(): StationDef[] {
  // Stations sit on the bound (matches game.ts playBounds). Pulled 1 unit
  // inward so they remain pickable even with rounding drift from the clamp.
  const bx = WORLD_HALF_X * 0.95;
  const bz = WORLD_HALF_Z * 0.95;
  return [
    // Verticals — top + bot edges at x = ±0.4·bx
    { id: 'PINK_top',   x: -bx * 0.4, z: -bz, colorKey: 'PINK' },
    { id: 'PINK_bot',   x: -bx * 0.4, z:  bz, colorKey: 'PINK' },
    { id: 'ORANGE_top', x:  bx * 0.4, z: -bz, colorKey: 'ORANGE' },
    { id: 'ORANGE_bot', x:  bx * 0.4, z:  bz, colorKey: 'ORANGE' },
    // Horizontals — left + right edges at z = -0.66·bz, 0, +0.66·bz
    { id: 'CYAN_l',     x: -bx, z: -bz * 0.66, colorKey: 'CYAN' },
    { id: 'CYAN_r',     x:  bx, z: -bz * 0.66, colorKey: 'CYAN' },
    { id: 'PURPLE_l',   x: -bx, z:  0,         colorKey: 'PURPLE' },
    { id: 'PURPLE_r',   x:  bx, z:  0,         colorKey: 'PURPLE' },
    { id: 'LIME_l',     x: -bx, z:  bz * 0.66, colorKey: 'LIME' },
    { id: 'LIME_r',     x:  bx, z:  bz * 0.66, colorKey: 'LIME' },
  ];
}

export const LEVELS: LevelConfig[] = [
  {
    index: 1,
    name: 'LEVEL 01',
    instruction: 'Tutorial 1/3 — Drag from one glowing dot to its twin',
    durationSeconds: 12,
    collisionEnabled: false,
    dimensionsEnabled: false,
    paletteSize: 3,
    buildStations: buildLevel1,
    tutorialOrder: ['PINK', 'CYAN', 'LIME'],
  },
  {
    index: 2,
    name: 'LEVEL 02',
    instruction: 'Tutorial 2/3 — Do not cross your lines',
    durationSeconds: 9,
    collisionEnabled: true,
    dimensionsEnabled: false,
    paletteSize: 5,
    buildStations: buildLevel2,
    tutorialNoCrossDemo: true,
  },
  {
    index: 3,
    name: 'LEVEL 03 — DIMENSIONS',
    instruction: 'Tutorial 3/3 — Flip dimension to dodge crossings',
    durationSeconds: 16,
    collisionEnabled: true,
    dimensionsEnabled: true,
    paletteSize: 5,
    buildStations: buildLevel3,
    introDimensionFlip: true,
    // Bound matches the horizontals' x extent — the player can touch the
    // station endpoints but cannot detour past them, forcing the flip.
    playBounds: { halfX: WORLD_HALF_X * 0.95, halfZ: WORLD_HALF_Z * 0.95 },
  },
];
