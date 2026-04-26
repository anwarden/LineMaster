import * as THREE from 'three';

export type ColorKey = 'PINK' | 'CYAN' | 'LIME' | 'PURPLE' | 'ORANGE' | 'YELLOW';

export type Dimension = 'surface' | 'tunnel';

export type Phase = 'idle' | 'playing' | 'won' | 'lost';

/** Vivid, saturated LineMaster palette. */
export const COLORS: Record<ColorKey, string> = {
  PINK:   '#FF006E',
  CYAN:   '#00F5FF',
  LIME:   '#BFFF00',
  PURPLE: '#A855F7',
  ORANGE: '#FF6B00',
  YELLOW: '#FFE600',
};

/** World-space dimensions of the playfield. Stations placed within this. */
export const WORLD_HALF_X = 480;
export const WORLD_HALF_Z = 270;

/**
 * Layer altitudes. Both dimensions share the same orientation — the world
 * doesn't flip on switch — so we no longer associate a fixed Y with each
 * dimension. Instead we have:
 *
 *   - LAYER_Y_ACTIVE : world Y of whichever dimension is currently active
 *                      (the visible top floor, where the player draws).
 *   - LAYER_Y_INACTIVE : world Y of the inactive dimension's lines, ghosted
 *                        below the slab and visible through the translucent
 *                        top face.
 *
 * On a dimension switch, every committed line tweens between these two altitudes
 * based on whether its `dimension` tag matches the new active dim.
 */
export const LAYER_Y_ACTIVE = 80;
export const LAYER_Y_INACTIVE = -80;

/** Legacy mapping retained for reference. Surface lines initially live at
 *  LAYER_Y_ACTIVE, tunnel lines at LAYER_Y_INACTIVE — same shape as before
 *  the refactor, but the values are no longer hard-bound to a dimension. */
export const DIMENSION_LINE_Y: Record<Dimension, number> = {
  surface: LAYER_Y_ACTIVE,
  tunnel: LAYER_Y_INACTIVE,
};

export type StationDef = {
  id: string;
  x: number;          // world X
  z: number;          // world Z (depth on the floor)
  colorKey: ColorKey;
};

export type Station = StationDef & {
  group: THREE.Group;
  pulse: number;      // mutable, for hover/target glow
  spawnTime: number;  // for pop-in animation
  hoverPulse: number; // for hover wobble
};

export type Connection = {
  pathPoints: THREE.Vector3[];
  colorKey: ColorKey;
  dimension: Dimension;
  mesh: THREE.Object3D;
  born: number;       // elapsed time when committed (for spawn animation)
};

export type LevelConfig = {
  index: number;                 // 1, 2, 3
  name: string;
  instruction: string;
  durationSeconds: number;
  collisionEnabled: boolean;     // L1 disabled, L2+L3 enabled
  dimensionsEnabled: boolean;    // L3 only
  paletteSize: 3 | 5;
  buildStations: () => StationDef[];
  /** Tutorial: when set, the player must connect colours in this exact order.
   *  Only the current colour pulses; all others stay neutral until their turn. */
  tutorialOrder?: ColorKey[];
  /** Tutorial: when true, show a small floating "two crossing dashed lines"
   *  demo with a red prohibition tint — teaches the no-cross rule visually. */
  tutorialNoCrossDemo?: boolean;
  /** Tutorial: when true, briefly flip dimensions (surface→tunnel→surface) on
   *  level start to show the player there are two layers. Input is gated
   *  during the cinematic (~1.5 s). */
  introDimensionFlip?: boolean;
  /** Hard play boundary — when set, every recorded path point is clamped to
   *  this XZ rectangle so the player can't route around stations placed at
   *  the edge of the playfield. A glowing rectangle outline visualises it. */
  playBounds?: { halfX: number; halfZ: number };
};

/** Convert a hex string '#RRGGBB' to a number for Three.js. */
export function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}
