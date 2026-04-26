import * as THREE from 'three';
import {
  COLORS,
  ColorKey,
  Connection,
  Dimension,
  DIMENSION_LINE_Y,
  LevelConfig,
  Phase,
  Station,
  hexToNum,
} from './types';
import { LEVELS } from './levels';
import { SceneRig } from './scene';
import {
  buildStation,
  distToNearestStation,
  findStationAt,
  updateStationGlow,
} from './stations';
import {
  commitConnection,
  disposeTubeGroup,
  hasCrash,
  LinePreview,
  updateConnectionVisibility,
} from './lines';
import { Hud } from './hud';
import { Fx } from './fx';
import { Audio } from './audio';

const COMBO_BANNERS = ['NICE!', 'GREAT!', 'COMBO x{n}!', 'SUPER!', 'INSANE!', 'POP!'];

/** Min squared XZ distance between two consecutive recorded path points.
 *  At ~8 world units, the visible curve is unchanged but the rebuild rate drops
 *  from "every pointermove" (~60 Hz) to "every meaningful displacement" (~10–20 Hz). */
const MIN_PATH_SPACING_SQ = 8 * 8;

export class Game {
  private rig: SceneRig;
  private hud: Hud;
  private fx: Fx;
  private audio: Audio;
  private linePreview: LinePreview;
  /** Tracks hover edges so we only fire `audio.hover()` on null→id transitions. */
  private prevHoveredStationId: string | null = null;

  private levelIdx = 0;
  private level: LevelConfig = LEVELS[0];
  private phase: Phase = 'idle';

  private stations: Station[] = [];
  private connections: Connection[] = [];

  private currentDimension: Dimension = 'surface';
  private score = 0;
  private streak = 0;
  private elapsed = 0;
  private hoveredStationId: string | null = null;
  private lastPopAt = 0;
  /** Cached set of colours not yet connected — rebuilt each tick, used by both
   *  the station glow pulse and the input handler to gate which stations can
   *  start a draft. */
  private unconnectedColors = new Set<ColorKey>();
  /** Tutorial cursor — index into level.tutorialOrder. Advances each commit. */
  private tutorialIdx = 0;
  /** Marching-dot hint shown between the current tutorial pair (L1 only).
   *  Animated each frame in tick() until the player makes the connection. */
  private tutorialHint: THREE.Points | null = null;
  private tutorialHintGeo: THREE.BufferGeometry | null = null;
  private tutorialHintMat: THREE.PointsMaterial | null = null;

  /** L2 "no-cross" demo: two short crossing dotted segments + a red ✕ overlay,
   *  floating above the playfield to teach the no-cross rule visually. */
  private noCrossDemo: THREE.Group | null = null;
  /** Disposables for the no-cross demo (geometries + materials) so we can free
   *  them all at once when leaving the level. */
  private noCrossDemoDisposables: Array<{ dispose: () => void }> = [];

  /** Locks pointer input + dimension toggle while a cinematic plays (e.g. the
   *  L3 intro flip). The runtime sets it true at level start and clears it via
   *  setTimeout once the cinematic settles. */
  private cinematicLock = false;

  /** Visual rectangle outline for the level's hard play bounds (L3 only). */
  private boundsFrame: THREE.Group | null = null;
  private boundsFrameDisposables: Array<{ dispose: () => void }> = [];

  private isDrawing = false;
  private currentPath: THREE.Vector3[] = [];
  private currentPathColor: ColorKey | null = null;
  private currentPathDimension: Dimension = 'surface';
  private previewDirty = false;

  // ── Level-editor mode ──────────────────────────────────────────
  /** When true, pointer input behaves as an editor: click empty ground = drop
   *  a station with `editorColor`, click+drag a station = move it, right-click
   *  a station = delete it. Drawing connections is suspended. */
  private editorMode = false;
  private editorColor: ColorKey = 'PINK';
  private draggingStationId: string | null = null;
  private nextEditorStationId = 0;
  /** Snapshot of the editor's stations taken right before "TEST LEVEL" — used
   *  to restore the editor exactly where the player left it after they win,
   *  fail, or hit "← Levels" on the test run. */
  private editorTestSnapshot: string | null = null;

  constructor(parent: HTMLElement) {
    this.rig = new SceneRig(parent);
    this.linePreview = new LinePreview(this.rig.linesLayer);
    this.fx = new Fx(document.getElementById('popup-layer')!);
    this.audio = new Audio();
    this.hud = new Hud({
      onPlay: () => { this.audio.unlock(); this.audio.startMusic(); this.goToLevelSelect(); },
      onLevelSelect: (idx) => { this.audio.unlock(); this.audio.startMusic(); this.startSpecificLevel(idx); },
      onBackToTitle: () => this.goToTitle(),
      onBackToLevels: () => this.exitGameplay(),
      onDimensionToggle: () => this.toggleDimension(),
      onOpenEditor: () => { this.audio.unlock(); this.audio.startMusic(); this.openEditor(); },
      onEditorExport: () => this.exportEditorClipboard(),
      onEditorTest: () => this.testEditorLevel(),
    });

    this.bindPointerInput();
    // Belt-and-braces unlock: any pointerdown on the canvas resumes the
    // AudioContext (covers the rare case where the player clicks past the
    // title screen without going through a HUD button).
    const unlock = () => {
      this.audio.unlock();
      this.audio.startMusic();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);

    this.rig.onTick((dt) => this.tick(dt));
    this.rig.start();

    // Bench/debug hook — only useful in dev for memory/perf instrumentation.
    (window as unknown as { __game?: Game }).__game = this;
  }

  // ============================================================
  // Lifecycle / Screen flow
  // ============================================================

  /** Show the title screen — called on init and after a final victory. */
  goToTitle() {
    this.phase = 'idle';
    this.cancelDraft();
    this.clearStations();
    this.clearConnections();
    this.disposeTutorialHint();
    this.disposeNoCrossDemo();
    this.disposeBoundsFrame();
    if (this.editorMode) { this.setEditorMode(false); document.body.classList.remove('editor-mode'); }
    this.editorTestSnapshot = null;
    this.unconnectedColors.clear();
    this.score = 0;
    this.streak = 0;
    this.hud.setScore(0);
    this.hud.showTitle();
    this.hud.hideLevelSelect();
    this.hud.hideWin();
  }

  /** Open the visual editor on a blank board, called from the "+" card on the
   *  level-select screen. Hides the overlays, switches the scene into editor
   *  mode, and shows the back button so the user can return to the menu. */
  openEditor() {
    this.phase = 'idle';
    this.cancelDraft();
    this.clearStations();
    this.clearConnections();
    this.unconnectedColors.clear();
    this.score = 0;
    this.streak = 0;
    this.hud.setScore(0);
    this.hud.hideTitle();
    this.hud.hideLevelSelect();
    this.hud.hideWin();
    this.hud.setLevel('EDITOR', 'Click empty area = place • Drag = move • Right-click = delete');
    this.hud.setDimensionToggleVisible(false);
    this.setEditorMode(true);
    document.body.classList.add('editor-mode');
  }

  /** Show the level-select screen — accessible from title and from the in-game
   *  back button. */
  goToLevelSelect() {
    this.phase = 'idle';
    this.cancelDraft();
    this.clearStations();
    this.clearConnections();
    this.disposeTutorialHint();
    this.disposeNoCrossDemo();
    this.disposeBoundsFrame();
    if (this.editorMode) { this.setEditorMode(false); document.body.classList.remove('editor-mode'); }
    this.editorTestSnapshot = null;
    this.unconnectedColors.clear();
    this.hud.hideTitle();
    this.hud.hideWin();
    this.hud.showLevelSelect();
  }

  /** Start a specific level (called by the level-select cards). */
  startSpecificLevel(idx: number) {
    if (idx < 0 || idx >= LEVELS.length) return;
    this.score = 0;
    this.streak = 0;
    this.hud.setScore(0);
    this.hud.hideTitle();
    this.hud.hideLevelSelect();
    this.hud.hideWin();
    this.startLevel(idx);
  }

  private startLevel(idx: number) {
    this.levelIdx = idx;
    this.level = LEVELS[idx];
    this.phase = 'playing';
    this.tutorialIdx = 0;
    this.cinematicLock = false;

    this.clearStations();
    this.clearConnections();
    this.disposeTutorialHint();
    this.disposeNoCrossDemo();
    this.disposeBoundsFrame();
    this.cancelDraft();

    this.setDimension('surface', { silent: true });
    this.hud.setDimensionToggleVisible(this.level.dimensionsEnabled);

    const defs = this.level.buildStations();
    defs.forEach((def, i) => {
      const station = buildStation(def, this.elapsed, this.level.dimensionsEnabled);
      this.stations.push(station);
      this.rig.stationsLayer.add(station.group);
      // small spawn pop-fx in screen space
      const screen = this.worldToScreen(new THREE.Vector3(def.x, 0, def.z));
      this.fx.pop(screen.x, screen.y, COLORS[def.colorKey]);
      // Stagger the audio bloops so they read as a chord arpeggio rather than
      // a single chord crash on level start.
      window.setTimeout(() => this.audio.dotPlace(def.colorKey), i * 55);
    });

    this.hud.setLevel(this.level.name, this.level.instruction);
    this.refreshUnconnected();
    this.rebuildTutorialHint();

    if (this.level.tutorialNoCrossDemo) this.buildNoCrossDemo();
    if (this.level.introDimensionFlip) this.playIntroDimensionFlip();
    if (this.level.playBounds) this.buildBoundsFrame(this.level.playBounds);
  }

  /** Build the glowing wall frame for the hard play bounds. Four solid red
   *  walls (BoxGeometry) sit just outside the bound rectangle plus an inner
   *  vivid line right ON the bound — together they read as a force-field cage
   *  even from the tilted top-down camera. Pulsing handled in tick(). */
  private buildBoundsFrame(b: { halfX: number; halfZ: number }) {
    this.disposeBoundsFrame();
    const group = new THREE.Group();
    group.position.y = DIMENSION_LINE_Y[this.currentDimension];
    group.userData = { kind: 'bounds-frame' };

    const RED = 0xff2244;
    const W = 6;     // wall thickness (XZ)
    const H = 22;    // wall height (Y)

    const wallMat = new THREE.MeshBasicMaterial({
      color: RED,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.boundsFrameDisposables.push(wallMat);

    const fullX = b.halfX * 2 + W * 2;
    const fullZ = b.halfZ * 2 + W * 2;

    const buildWall = (sx: number, sz: number, x: number, z: number) => {
      const geo = new THREE.BoxGeometry(sx, H, sz);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(x, H / 2, z);
      group.add(mesh);
      this.boundsFrameDisposables.push(geo);
    };
    buildWall(fullX, W, 0, -b.halfZ - W / 2);   // top
    buildWall(fullX, W, 0,  b.halfZ + W / 2);   // bot
    buildWall(W, fullZ, -b.halfX - W / 2, 0);   // left
    buildWall(W, fullZ,  b.halfX + W / 2, 0);   // right

    // Vivid core line ON the bound — gives a sharp "this is where the wall
    // starts" edge so the player immediately reads where the path will stop.
    const corners = [
      new THREE.Vector3(-b.halfX, 0.5, -b.halfZ),
      new THREE.Vector3( b.halfX, 0.5, -b.halfZ),
      new THREE.Vector3( b.halfX, 0.5,  b.halfZ),
      new THREE.Vector3(-b.halfX, 0.5,  b.halfZ),
      new THREE.Vector3(-b.halfX, 0.5, -b.halfZ),
    ];
    const coreGeo = new THREE.BufferGeometry().setFromPoints(corners);
    const coreMat = new THREE.LineBasicMaterial({
      color: RED,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });
    group.add(new THREE.Line(coreGeo, coreMat));
    this.boundsFrameDisposables.push(coreGeo, coreMat);

    this.rig.linesLayer.add(group);
    this.boundsFrame = group;
  }

  /** Slow danger-stripe pulse on the bounds wall — keeps the eye aware of the
   *  cage without becoming a strobe. */
  private updateBoundsFrame() {
    if (!this.boundsFrame) return;
    // Pulse the wall material's opacity (it's shared across all 4 walls).
    const mat = this.boundsFrameDisposables.find(
      (d) => d instanceof THREE.MeshBasicMaterial
    ) as THREE.MeshBasicMaterial | undefined;
    if (mat) {
      const t = 0.42 + Math.sin(this.elapsed * 2.4) * 0.18;
      mat.opacity += (t - mat.opacity) * 0.2;
    }
  }

  private disposeBoundsFrame() {
    if (this.boundsFrame) this.rig.linesLayer.remove(this.boundsFrame);
    for (const d of this.boundsFrameDisposables) d.dispose();
    this.boundsFrameDisposables = [];
    this.boundsFrame = null;
  }

  /** True when the cursor is within touch radius of a station whose colour
   *  differs from the active draft — used to invalidate paths that graze
   *  foreign nodes (the boundary stations on L3 are colour-coded gates and
   *  must not be touched by another colour's rope). */
  private touchesForeignStation(point: THREE.Vector3): boolean {
    if (!this.currentPathColor) return false;
    const TOUCH_R = 28;
    const TOUCH_R_SQ = TOUCH_R * TOUCH_R;
    for (const s of this.stations) {
      if (s.colorKey === this.currentPathColor) continue;
      const dx = point.x - s.group.position.x;
      const dz = point.z - s.group.position.z;
      if (dx * dx + dz * dz < TOUCH_R_SQ) return true;
    }
    return false;
  }

  /** Clamp a world-space XZ point to the level's play bounds (if any). */
  private clampToBounds(p: THREE.Vector3): THREE.Vector3 {
    const b = this.level.playBounds;
    if (!b) return p;
    if (p.x < -b.halfX) p.x = -b.halfX;
    else if (p.x > b.halfX) p.x = b.halfX;
    if (p.z < -b.halfZ) p.z = -b.halfZ;
    else if (p.z > b.halfZ) p.z = b.halfZ;
    return p;
  }

  // ============================================================
  // Tutorial cinematics & demos
  // ============================================================

  /** L3 intro cinematic — surface → tunnel → surface, driven by setDimension().
   *  Input is gated for ~1.6 s so the player just *watches* the flip, registers
   *  "there are two layers", and then can play. */
  private playIntroDimensionFlip() {
    this.cinematicLock = true;
    this.fx.banner('TWO DIMENSIONS');
    window.setTimeout(() => this.setDimension('tunnel'), 350);
    window.setTimeout(() => this.setDimension('surface'), 1100);
    window.setTimeout(() => { this.cinematicLock = false; }, 1700);
  }

  /** L2 no-cross demo — two short crossing dashed segments and a red ✕ glyph,
   *  floating above the centre of the playfield. Built once on level start,
   *  pulses gently in tick(), wiped on level transition. */
  private buildNoCrossDemo() {
    this.disposeNoCrossDemo();
    const group = new THREE.Group();
    group.position.set(0, DIMENSION_LINE_Y[this.currentDimension] + 6, -160);
    group.userData = { kind: 'no-cross-demo' };

    // Two crossing dashed segments (white-ish so the red ✕ pops against them).
    const SEG_LEN = 70;
    const a = makeDashedSegment(-SEG_LEN, -SEG_LEN, SEG_LEN, SEG_LEN, 0xffffff);
    const b = makeDashedSegment(-SEG_LEN, SEG_LEN, SEG_LEN, -SEG_LEN, 0xffffff);
    group.add(a.line, b.line);
    this.noCrossDemoDisposables.push(a.geo, a.mat, b.geo, b.mat);

    // Red prohibition ✕ centred on the crossing point.
    const x1 = makeDashedSegment(-22, -22, 22, 22, 0xff2244, 1.0);
    const x2 = makeDashedSegment(-22, 22, 22, -22, 0xff2244, 1.0);
    x1.line.position.y = 1;
    x2.line.position.y = 1;
    group.add(x1.line, x2.line);
    this.noCrossDemoDisposables.push(x1.geo, x1.mat, x2.geo, x2.mat);

    // Red ring around the ✕ to read instantly as "forbidden".
    const ringGeo = new THREE.RingGeometry(34, 40, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff2244,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.5;
    group.add(ring);
    this.noCrossDemoDisposables.push(ringGeo, ringMat);

    this.rig.linesLayer.add(group);
    this.noCrossDemo = group;
  }

  private disposeNoCrossDemo() {
    if (this.noCrossDemo) this.rig.linesLayer.remove(this.noCrossDemo);
    for (const d of this.noCrossDemoDisposables) d.dispose();
    this.noCrossDemoDisposables = [];
    this.noCrossDemo = null;
  }

  /** Pulse the no-cross demo so it reads as a "warning" sign rather than a
   *  static decal. Cheap (one sin call). */
  private updateNoCrossDemo() {
    if (!this.noCrossDemo) return;
    const breathe = 0.85 + Math.sin(this.elapsed * 3.2) * 0.15;
    this.noCrossDemo.scale.setScalar(breathe);
    // Hide while drawing — the player has the rope, demo would compete.
    this.noCrossDemo.visible = !this.isDrawing;
  }

  /** Refresh the cached set of colours that still need a connection. Called on
   *  level start, on commit, and on clear. In tutorial mode, only the
   *  *current* tutorial colour is exposed as connectable — keeps the player on
   *  rails while we teach them the verb. */
  private refreshUnconnected() {
    const order = this.level.tutorialOrder;
    if (order) {
      // Only the current step's colour is "live" — until it's connected, all
      // other still-unconnected colours stay quiet.
      this.unconnectedColors = new Set();
      const cur = order[this.tutorialIdx];
      if (cur && !this.connections.some((c) => c.colorKey === cur)) {
        this.unconnectedColors.add(cur);
      }
      return;
    }
    this.unconnectedColors = new Set(uniqueColors(this.stations));
    for (const c of this.connections) this.unconnectedColors.delete(c.colorKey);
  }

  /** Advance the tutorial cursor when its current colour has just been
   *  connected, and flash a guiding burst on the next pair so the eye is
   *  pulled there immediately. No-op outside tutorial levels. */
  private advanceTutorialIfNeeded() {
    const order = this.level.tutorialOrder;
    if (!order) return;
    const cur = order[this.tutorialIdx];
    if (cur && this.connections.some((c) => c.colorKey === cur)) {
      this.tutorialIdx++;
      const next = order[this.tutorialIdx];
      if (next) {
        for (const s of this.stations) {
          if (s.colorKey !== next) continue;
          const screen = this.worldToScreen(s.group.position);
          this.fx.pop(screen.x, screen.y, COLORS[next]);
        }
      }
      this.rebuildTutorialHint();
    }
  }

  /** Build (or rebuild) the marching-dot hint between the current tutorial
   *  pair. Visualises "drag from this dot to that dot" without drawing the
   *  whole line — the dots animate (phase shift) so the eye follows them and
   *  reads the verb "trace from A to B". */
  private rebuildTutorialHint() {
    this.disposeTutorialHint();
    this.disposeNoCrossDemo();
    this.disposeBoundsFrame();
    const order = this.level.tutorialOrder;
    if (!order) return;
    const cur = order[this.tutorialIdx];
    if (!cur) return;
    const pair = this.stations.filter((s) => s.colorKey === cur);
    if (pair.length < 2) return;

    const a = this.liftToLayer(pair[0].group.position, this.currentDimension);
    const b = this.liftToLayer(pair[1].group.position, this.currentDimension);
    const COUNT = 22;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const t = i / (COUNT - 1);
      positions[i * 3 + 0] = a.x + (b.x - a.x) * t;
      positions[i * 3 + 1] = a.y + 1.5;
      positions[i * 3 + 2] = a.z + (b.z - a.z) * t;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: hexToNum(COLORS[cur]),
      size: 9,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.userData = { kind: 'tutorial-hint', a, b, count: COUNT };
    this.rig.linesLayer.add(pts);
    this.tutorialHint = pts;
    this.tutorialHintGeo = geo;
    this.tutorialHintMat = mat;
  }

  private disposeTutorialHint() {
    if (this.tutorialHint) this.rig.linesLayer.remove(this.tutorialHint);
    this.tutorialHintGeo?.dispose();
    this.tutorialHintMat?.dispose();
    this.tutorialHint = null;
    this.tutorialHintGeo = null;
    this.tutorialHintMat = null;
  }

  /** Animate marching dots: shift the parametric position by elapsed time so
   *  the eye reads movement A→B. Also fade out while the player is drawing
   *  so the hint doesn't fight with the live preview line. */
  private updateTutorialHint() {
    if (!this.tutorialHint || !this.tutorialHintGeo || !this.tutorialHintMat) return;
    const ud = this.tutorialHint.userData as { a: THREE.Vector3; b: THREE.Vector3; count: number };
    const positions = this.tutorialHintGeo.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;
    const phase = (this.elapsed * 0.45) % 1;
    for (let i = 0; i < ud.count; i++) {
      const t = ((i / ud.count) + phase) % 1;
      arr[i * 3 + 0] = ud.a.x + (ud.b.x - ud.a.x) * t;
      arr[i * 3 + 2] = ud.a.z + (ud.b.z - ud.a.z) * t;
    }
    positions.needsUpdate = true;

    // Fade with breathing pulse; dim while drawing so the live rope wins focus.
    const breathe = 0.55 + Math.sin(this.elapsed * 4) * 0.25;
    const target = this.isDrawing ? 0.18 : breathe;
    this.tutorialHintMat.opacity += (target - this.tutorialHintMat.opacity) * 0.15;
  }

  /** After every successful commit (and on level start) check whether the level
   *  is complete; if it is, advance or trigger victory. No timer or target colour
   *  is set — the player picks the next colour freely. */
  private checkLevelComplete() {
    if (this.unconnectedColors.size > 0) return;

    // Editor test run — celebrate, then bounce back to the editor with the
    // saved layout. We never advance to "level 100" or pop the win modal.
    if (this.editorTestSnapshot != null) {
      this.fx.banner('LEVEL CLEARED!');
      this.audio.levelComplete();
      this.phase = 'idle';
      window.setTimeout(() => this.exitGameplay(), 1200);
      return;
    }

    if (this.levelIdx < LEVELS.length - 1) {
      this.fx.banner('LEVEL UP!');
      this.audio.levelComplete();
      this.phase = 'idle';
      window.setTimeout(() => this.startLevel(this.levelIdx + 1), 800);
      return;
    }
    this.phase = 'won';
    this.fx.banner('VICTORY!');
    this.audio.victory();
    this.hud.showWin();
  }

  private clearStations() {
    for (const s of this.stations) {
      this.rig.stationsLayer.remove(s.group);
      s.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }
    this.stations = [];
  }

  private clearConnections() {
    for (const c of this.connections) {
      this.rig.linesLayer.remove(c.mesh);
      if (c.mesh instanceof THREE.Group) disposeTubeGroup(c.mesh);
    }
    this.connections = [];
  }

  // ============================================================
  // Frame tick
  // ============================================================

  private tick(dt: number) {
    this.elapsed += dt;

    updateStationGlow(this.stations, this.unconnectedColors, this.hoveredStationId, this.elapsed, !!this.level.tutorialOrder);
    updateConnectionVisibility(this.connections, this.currentDimension, this.elapsed);
    this.updateTutorialHint();
    this.updateNoCrossDemo();
    this.updateBoundsFrame();

    // Apply any deferred preview rebuild — at most one per frame, regardless of how
    // many pointermove events came in since the last tick.
    if (this.previewDirty && this.isDrawing && this.currentPathColor) {
      this.linePreview.setPath(this.currentPath, this.currentPathDimension);
      this.previewDirty = false;
    }

    if (this.phase === 'playing') {
      // No timer — puzzle mode lets the player think.
      // Drip sparkles along the in-progress line — kept low-rate to avoid hammering
      // the FX canvas (shadowBlur 18px is the main cost there). 5 Hz is enough to
      // read as "juicy" without choking the rAF budget.
      if (this.isDrawing && this.elapsed - this.lastPopAt > 0.2 && this.currentPathColor) {
        const last = this.currentPath[this.currentPath.length - 1];
        if (last) {
          const screen = this.worldToScreen(last);
          this.fx.pop(screen.x, screen.y, COLORS[this.currentPathColor]);
          this.lastPopAt = this.elapsed;
        }
      }
    }
  }

  // ============================================================
  // Input
  // ============================================================

  private bindPointerInput() {
    const canvas = this.rig.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', () => this.cancelDraft());
    // Suppress the native context menu so right-click can be used as
    // "delete station" in editor mode without the browser eating the gesture.
    canvas.addEventListener('contextmenu', (e) => {
      if (this.editorMode) e.preventDefault();
    });
  }

  /** Raycast the cursor onto the active drawing plane (world Y = LAYER_Y_ACTIVE).
   *  The hit point's Y is already at the active layer altitude. */
  private pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
    return this.rig.pickFloor(clientX, clientY);
  }

  /** Snap an arbitrary point to its dimension's altitude. Used at line endpoints
   *  to pin them precisely on the station axis. Surface lines are baked at +Y,
   *  tunnel lines at −Y; the worldFlip group rotates 180° on switch so the
   *  active layer is always the visible top. */
  private liftToLayer(point: THREE.Vector3, dim: Dimension): THREE.Vector3 {
    return new THREE.Vector3(point.x, DIMENSION_LINE_Y[dim], point.z);
  }

  private onPointerDown(e: PointerEvent) {
    if (this.editorMode) { this.editorPointerDown(e); return; }
    if (this.phase !== 'playing') return;
    if (this.cinematicLock) return;
    const point = this.pickGround(e.clientX, e.clientY);
    if (!point) return;
    const station = findStationAt(point, this.stations);
    if (!station) return;

    // The player picks any colour they like — but a colour already connected
    // is just acknowledged ("DONE") rather than starting a new draft.
    if (!this.unconnectedColors.has(station.colorKey)) {
      this.fx.popup(e.clientX, e.clientY, 'DONE', COLORS[station.colorKey]);
      return;
    }

    this.isDrawing = true;
    this.currentPathColor = station.colorKey;
    this.currentPathDimension = this.currentDimension;
    const start = this.liftToLayer(station.group.position, this.currentPathDimension);
    this.currentPath = [start];
    this.linePreview.start(this.currentPathColor, this.currentPathDimension, start);

    this.fx.burst(e.clientX, e.clientY, COLORS[this.currentPathColor], 18, 0.85);
    this.audio.drawStart(this.currentPathColor);
  }

  private onPointerMove(e: PointerEvent) {
    if (this.editorMode) { this.editorPointerMove(e); return; }
    // Hover detection (when not drawing) — drives the wobble/ripple FX
    if (!this.isDrawing) {
      const point = this.pickGround(e.clientX, e.clientY);
      if (point) {
        const { station, dist } = distToNearestStation(point, this.stations);
        this.hoveredStationId = station && dist < 60 ? station.id : null;
      } else {
        this.hoveredStationId = null;
      }
      // Edge-trigger the hover chime: only fire when we transition from "no
      // station hovered" to "this station hovered" (or between two stations).
      if (this.hoveredStationId && this.hoveredStationId !== this.prevHoveredStationId) {
        this.audio.hover();
      }
      this.prevHoveredStationId = this.hoveredStationId;
      return;
    }

    const point = this.pickGround(e.clientX, e.clientY);
    if (!point) return;
    this.clampToBounds(point);

    if (this.level.collisionEnabled && hasCrash(point, this.connections, this.currentPathDimension)) {
      this.fail('Lines crossed!');
      return;
    }

    // Foreign-node touch — the rope cannot graze another colour's station.
    // We allow the start-station to be within range while the line is short
    // (player just leaving the dot) by skipping the test against same-colour
    // stations.
    if (this.touchesForeignStation(point)) {
      this.fail('Touched another colour');
      return;
    }

    // Decimate: drop pointermove samples that haven't moved far enough from the
    // last recorded vertex. Cheap rebuilds = fluid drag + bounded heap pressure.
    const last = this.currentPath[this.currentPath.length - 1];
    const dx = point.x - last.x;
    const dz = point.z - last.z;
    if (dx * dx + dz * dz < MIN_PATH_SPACING_SQ) return;

    // The picked point's Y is already at the active layer altitude (set by
    // pickFloor → world plane Y=+80 → worldToLocal). The rope visibly follows
    // the cursor without the slab-projection offset.
    this.currentPath.push(point);
    this.previewDirty = true;
    if (this.currentPathColor) this.audio.drawTick(this.currentPathColor);
  }

  private onPointerUp(e: PointerEvent) {
    if (this.editorMode) { this.editorPointerUp(); return; }
    if (!this.isDrawing) return;
    const point = this.pickGround(e.clientX, e.clientY);
    const endStation = point ? findStationAt(point, this.stations) : null;

    const startStation = this.stations.find((s) => {
      const start = this.currentPath[0];
      return Math.hypot(s.group.position.x - start.x, s.group.position.z - start.z) < 1;
    });

    const valid =
      !!endStation &&
      endStation !== startStation &&
      endStation.colorKey === this.currentPathColor &&
      this.currentPath.length > 5;

    if (valid && this.currentPathColor && endStation) {
      this.currentPath.push(this.liftToLayer(endStation.group.position, this.currentPathDimension));
      const conn = commitConnection(
        this.rig.linesLayer,
        this.currentPath,
        this.currentPathColor,
        this.currentPathDimension,
        this.elapsed
      );
      this.connections.push(conn);

      // === JUICY PAYOFF ===
      this.score++;
      this.streak++;
      this.hud.setScore(this.score);

      // Celebration burst at landing station
      const landing = this.worldToScreen(endStation.group.position);
      this.fx.celebrate(landing.x, landing.y, COLORS[this.currentPathColor]);
      this.audio.connect(this.currentPathColor, this.currentPathDimension);

      // Floating "+1" / streak text
      const streakText = this.streak > 1 ? `+${this.streak} STREAK!` : '+1';
      this.fx.popup(landing.x, landing.y - 30, streakText, COLORS[this.currentPathColor]);

      // Banner for streaks
      if (this.streak >= 2) {
        const banner = COMBO_BANNERS[Math.min(this.streak - 2, COMBO_BANNERS.length - 1)]
          .replace('{n}', String(this.streak));
        this.fx.banner(banner);
      }

      this.cancelDraft();
      this.advanceTutorialIfNeeded();
      this.refreshUnconnected();
      this.checkLevelComplete();
    } else {
      // gentle miss feedback (no fail) when releasing on empty space
      const c = this.currentPathColor ? COLORS[this.currentPathColor] : '#FF006E';
      this.fx.popup(e.clientX, e.clientY, 'MISS', c);
      this.streak = 0;
      this.cancelDraft();
    }
  }

  private cancelDraft() {
    this.isDrawing = false;
    this.currentPath = [];
    this.currentPathColor = null;
    this.previewDirty = false;
    this.linePreview.dispose();
    this.audio.drawEnd();
  }

  // ============================================================
  // Level Editor — visual click-to-place / drag / right-click delete
  // ============================================================

  /** Toggle the visual level editor. When entering, we suspend the gameplay
   *  loop (phase becomes 'idle'), wipe any committed connections, and show
   *  the bounds frame so the user can compose against the playable area. */
  setEditorMode(on: boolean): void {
    this.editorMode = on;
    if (on) {
      this.phase = 'idle';
      this.cancelDraft();
      this.clearConnections();
      this.unconnectedColors.clear();
      this.disposeTutorialHint();
      this.disposeNoCrossDemo();
      // Show a generous bound so the editor can place anywhere on screen.
      this.disposeBoundsFrame();
      this.buildBoundsFrame({ halfX: 460, halfZ: 250 });
    } else {
      this.draggingStationId = null;
      this.disposeBoundsFrame();
    }
  }

  setEditorColor(color: ColorKey): void {
    this.editorColor = color;
  }

  /** Replace the current scene with an empty board — the editor's blank
   *  canvas. Stations remain editable; phase stays 'idle'. */
  clearStationsForEditor(): void {
    this.cancelDraft();
    this.clearConnections();
    this.clearStations();
    this.unconnectedColors.clear();
  }

  /** Serialize the current station layout to JSON the user can paste into
   *  src/levels.ts. */
  exportEditorJSON(): string {
    const defs = this.stations.map((s) => ({
      id: s.id,
      x: Math.round(s.group.position.x),
      z: Math.round(s.group.position.z),
      colorKey: s.colorKey,
    }));
    return JSON.stringify(defs, null, 2);
  }

  /** Import a JSON station list (same shape as `exportEditorJSON()` produces)
   *  and replace the current scene with those stations. Robust to malformed
   *  input — throws a readable error so the editor panel can surface it. */
  importEditorJSON(json: string): void {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch (err) {
      throw new Error('Invalid JSON: ' + (err as Error).message);
    }
    if (!Array.isArray(raw)) throw new Error('Expected an array of station defs');
    const defs: Array<{ id: string; x: number; z: number; colorKey: ColorKey }> = [];
    for (const item of raw) {
      const o = item as Record<string, unknown>;
      if (typeof o.x !== 'number' || typeof o.z !== 'number' || typeof o.colorKey !== 'string') {
        throw new Error('Station def missing x/z/colorKey');
      }
      if (!(o.colorKey in COLORS)) throw new Error(`Unknown colorKey: ${o.colorKey}`);
      defs.push({
        id: typeof o.id === 'string' ? o.id : `imp_${this.nextEditorStationId++}`,
        x: o.x,
        z: o.z,
        colorKey: o.colorKey as ColorKey,
      });
    }
    this.clearStationsForEditor();
    for (const d of defs) {
      const station = buildStation(d, this.elapsed, true);
      this.stations.push(station);
      this.rig.stationsLayer.add(station.group);
    }
  }

  private editorPointerDown(e: PointerEvent) {
    const point = this.pickGround(e.clientX, e.clientY);
    if (!point) return;
    const hit = findStationAt(point, this.stations);
    // Right-click on a station → delete it.
    if (e.button === 2) {
      if (hit) this.removeStationLive(hit.id);
      return;
    }
    // Left-click on a station → start dragging it.
    if (hit) {
      this.draggingStationId = hit.id;
      return;
    }
    // Left-click on empty ground → place a new station with the current colour.
    const id = `ed_${this.nextEditorStationId++}`;
    const station = buildStation(
      { id, x: point.x, z: point.z, colorKey: this.editorColor },
      this.elapsed,
      true
    );
    this.stations.push(station);
    this.rig.stationsLayer.add(station.group);
    this.draggingStationId = id;
    this.audio.dotPlace(this.editorColor);
  }

  private editorPointerMove(e: PointerEvent) {
    if (this.draggingStationId == null) return;
    const point = this.pickGround(e.clientX, e.clientY);
    if (!point) return;
    this.updateStationLive(this.draggingStationId, { x: point.x, z: point.z });
  }

  private editorPointerUp() {
    this.draggingStationId = null;
  }

  /** Copy the current layout JSON to clipboard, with a textarea fallback for
   *  browsers that haven't granted clipboard permission. Surfaces a quick
   *  in-game banner so the user knows the action took. */
  exportEditorClipboard() {
    const json = this.exportEditorJSON();
    const announce = (msg: string) => this.fx.banner(msg);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json)
        .then(() => announce('COPIED!'))
        .catch(() => {
          this.exportEditorFallback(json);
          announce('JSON READY');
        });
    } else {
      this.exportEditorFallback(json);
      announce('JSON READY');
    }
  }

  /** Drop the JSON into a temporary textarea + select-all so the user can
   *  hit Ctrl/Cmd+C if the clipboard API isn't available. Element auto-removes
   *  after a few seconds or on next click. */
  private exportEditorFallback(json: string) {
    const existing = document.getElementById('editor-export-fallback');
    if (existing) existing.remove();
    const ta = document.createElement('textarea');
    ta.id = 'editor-export-fallback';
    ta.value = json;
    ta.readOnly = true;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    setTimeout(() => ta.remove(), 8000);
  }

  /** Play-test the current editor layout. Snapshots the stations as JSON,
   *  builds a synthetic LevelConfig from them, then jumps into the gameplay
   *  loop. The next call to `exitGameplay()` (Back button, win, fail) will
   *  detect `editorTestSnapshot` and route the user back into editor mode. */
  testEditorLevel() {
    if (this.stations.length < 2) {
      this.fx.banner('NEED 2+ NODES');
      return;
    }
    // Need at least one matching pair to play.
    const counts = new Map<ColorKey, number>();
    for (const s of this.stations) counts.set(s.colorKey, (counts.get(s.colorKey) ?? 0) + 1);
    const hasPair = [...counts.values()].some((n) => n >= 2);
    if (!hasPair) {
      this.fx.banner('NEED A PAIR');
      return;
    }

    this.editorTestSnapshot = this.exportEditorJSON();
    const defs = this.stations.map((s) => ({
      id: s.id,
      x: s.group.position.x,
      z: s.group.position.z,
      colorKey: s.colorKey,
    }));

    // Leave editor mode but keep the snapshot so the user can return.
    this.editorMode = false;
    this.draggingStationId = null;
    document.body.classList.remove('editor-mode');
    this.disposeBoundsFrame();

    // Build a synthetic level on the fly. No tutorial guidance, crossings
    // enabled, dimensions enabled (so the flip button is available — useful
    // when testing complex layouts), no playBounds (the editor lets users
    // place anywhere on screen).
    const customLevel: LevelConfig = {
      index: 99,
      name: 'EDITOR TEST',
      instruction: 'Test your level — Back to return to editing',
      durationSeconds: 0,
      collisionEnabled: true,
      dimensionsEnabled: true,
      paletteSize: 5,
      buildStations: () => defs,
    };

    // Splice the synthetic level into the current run. We don't push to LEVELS
    // permanently — startLevelDirect handles a "level passed in" path.
    this.startLevelDirect(customLevel);
  }

  /** Start a level from a passed-in config rather than an index in LEVELS.
   *  Mirrors `startLevel(idx)` minus the index lookup so editor-test runs
   *  don't pollute the LEVELS array. */
  private startLevelDirect(cfg: LevelConfig) {
    this.level = cfg;
    this.levelIdx = -1;            // -1 sentinel = "not in the LEVELS array"
    this.phase = 'playing';
    this.tutorialIdx = 0;
    this.cinematicLock = false;

    this.clearStations();
    this.clearConnections();
    this.disposeTutorialHint();
    this.disposeNoCrossDemo();
    this.disposeBoundsFrame();
    this.cancelDraft();

    this.setDimension('surface', { silent: true });
    this.hud.setDimensionToggleVisible(cfg.dimensionsEnabled);

    const defs = cfg.buildStations();
    defs.forEach((def, i) => {
      const station = buildStation(def, this.elapsed, cfg.dimensionsEnabled);
      this.stations.push(station);
      this.rig.stationsLayer.add(station.group);
      const screen = this.worldToScreen(new THREE.Vector3(def.x, 0, def.z));
      this.fx.pop(screen.x, screen.y, COLORS[def.colorKey]);
      window.setTimeout(() => this.audio.dotPlace(def.colorKey), i * 55);
    });

    this.hud.setLevel(cfg.name, cfg.instruction);
    this.refreshUnconnected();
  }

  /** Called when the player hits "← Levels" from in-game. Routes back into the
   *  editor if a test was in progress, otherwise to the level select. */
  exitGameplay() {
    if (this.editorTestSnapshot != null) {
      const snap = this.editorTestSnapshot;
      this.editorTestSnapshot = null;
      // Re-enter the editor and rehydrate the layout.
      this.openEditor();
      try { this.importEditorJSON(snap); } catch { /* fall back to empty */ }
      return;
    }
    this.goToLevelSelect();
  }

  // ============================================================
  // Dimension switching (L3) — peel transition
  // ============================================================

  private toggleDimension() {
    if (this.phase !== 'playing') return;
    if (!this.level.dimensionsEnabled) return;
    if (this.isDrawing) return;
    if (this.cinematicLock) return;
    this.setDimension(this.currentDimension === 'surface' ? 'tunnel' : 'surface');
  }

  private setDimension(dim: Dimension, opts: { silent?: boolean } = {}) {
    this.currentDimension = dim;
    this.rig.setActiveDimension(dim);
    this.hud.setDimensionState(dim);
    if (this.boundsFrame) this.boundsFrame.position.y = DIMENSION_LINE_Y[dim] - 4;

    if (opts.silent) return;

    // ── BEEFED FLIP FX CASCADE ─────────────────────────────────
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const primary = dim === 'tunnel' ? COLORS.CYAN   : COLORS.PINK;
    const accent  = dim === 'tunnel' ? COLORS.PURPLE : COLORS.YELLOW;
    const secondary = dim === 'tunnel' ? COLORS.LIME : COLORS.ORANGE;

    // Big initial blast at the dezoom peak
    this.fx.burst(cx, cy, primary, 56, 1.6);
    this.fx.flipBanner(primary);
    this.hud.shake();
    // Audio: whoomp scheduled at +250 ms (≈ midpoint of the 500 ms flip).
    this.audio.flip(dim);

    // Off-axis sparkles (depth)
    window.setTimeout(() => {
      this.fx.burst(cx - 220, cy - 60, accent, 18, 0.85);
      this.fx.burst(cx + 220, cy + 60, accent, 18, 0.85);
    }, 70);

    // Cascading shockwave rings (each fx.burst adds one ripple ring)
    window.setTimeout(() => this.fx.burst(cx, cy, secondary, 28, 1.05), 160);
    window.setTimeout(() => this.fx.burst(cx, cy, primary,   18, 0.75), 280);
    window.setTimeout(() => this.fx.burst(cx, cy, accent,    12, 0.55), 400);

    // Final celebrate-style sparkle as the rezoom settles
    window.setTimeout(() => {
      this.fx.celebrate(cx, cy, primary);
    }, 460);
  }

  // ============================================================
  // Win / fail
  // ============================================================

  private fail(reason: string) {
    if (this.phase !== 'playing') return;
    // Puzzle-mode fail: brief crash feedback then restart the same level.
    this.phase = 'idle';
    this.streak = 0;
    this.cancelDraft();
    this.hud.shake();
    this.hud.errorFlash();
    this.fx.burst(window.innerWidth / 2, window.innerHeight / 2, '#FF006E', 28, 1.1);
    this.fx.banner(`CRASHED — ${reason}`);
    this.audio.fail();
    if (this.editorTestSnapshot != null) {
      // During an editor-test run a crash means "your layout has issues" —
      // bounce back to the editor instead of looping the test forever.
      window.setTimeout(() => this.exitGameplay(), 900);
      return;
    }
    window.setTimeout(() => this.startLevel(this.levelIdx), 700);
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Project a point given in worldFlip *local* coords (what stations and
   *  currentPath use) to a 2D screen pixel for the FX overlay. We must convert
   *  through worldFlip's matrix so FX in tunnel mode (flip=π) land at the right
   *  on-screen pixel — without this they'd appear at the surface side because
   *  the local coords reverse Y/Z after rotation. */
  private worldToScreen(local: THREE.Vector3): { x: number; y: number } {
    const world = this.rig.worldFlip.localToWorld(local.clone());
    world.project(this.rig.camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: (world.x * 0.5 + 0.5) * w,
      y: (-world.y * 0.5 + 0.5) * h,
    };
  }

  // ============================================================
  // DEBUG / live-edit API (consumed by src/editor.ts)
  // ============================================================

  getDebugSnapshot() {
    return {
      levelIdx: this.levelIdx,
      levelName: this.level.name,
      duration: this.level.durationSeconds,
      collision: this.level.collisionEnabled,
      dimensions: this.level.dimensionsEnabled,
      dimension: this.currentDimension,
      targetColor: null,
      score: this.score,
      streak: this.streak,
      stations: this.stations.map((s) => ({ id: s.id, x: s.x, z: s.z, colorKey: s.colorKey })),
    };
  }

  applyDebugLevelParams(p: { duration?: number; collision?: boolean; dimensions?: boolean }) {
    // duration is preserved on the type for backward compatibility but is no
    // longer used at runtime — the timer was removed for puzzle mode.
    if (p.duration !== undefined) this.level.durationSeconds = p.duration;
    if (p.collision !== undefined) this.level.collisionEnabled = p.collision;
    if (p.dimensions !== undefined) {
      this.level.dimensionsEnabled = p.dimensions;
      this.hud.setDimensionToggleVisible(p.dimensions);
    }
  }

  updateStationLive(id: string, partial: Partial<{ x: number; z: number; colorKey: ColorKey }>) {
    const idx = this.stations.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = this.stations[idx];
    if (partial.x !== undefined) { s.x = partial.x; s.group.position.x = partial.x; }
    if (partial.z !== undefined) { s.z = partial.z; s.group.position.z = partial.z; }
    if (partial.colorKey !== undefined && partial.colorKey !== s.colorKey) {
      // Rebuild this station with the new colour. Cheap (~1ms).
      this.rig.stationsLayer.remove(s.group);
      s.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      const fresh = buildStation({ id: s.id, x: s.x, z: s.z, colorKey: partial.colorKey }, this.elapsed - 0.6, this.level.dimensionsEnabled);
      this.stations[idx] = fresh;
      this.rig.stationsLayer.add(fresh.group);
    }
  }

  addStationLive(def: { id?: string; x: number; z: number; colorKey: ColorKey }) {
    const id = def.id ?? `dbg_${Math.random().toString(36).slice(2, 7)}`;
    const station = buildStation({ id, x: def.x, z: def.z, colorKey: def.colorKey }, this.elapsed, this.level.dimensionsEnabled);
    this.stations.push(station);
    this.rig.stationsLayer.add(station.group);
  }

  removeStationLive(id: string) {
    const idx = this.stations.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = this.stations[idx];
    this.rig.stationsLayer.remove(s.group);
    s.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.stations.splice(idx, 1);
    this.refreshUnconnected();
  }

  resetLevelDebug() {
    this.startLevel(this.levelIdx);
  }

  skipLevelDebug() {
    this.startLevel((this.levelIdx + 1) % LEVELS.length);
  }

  forceWinDebug() {
    this.phase = 'won';
    this.cancelDraft();
    this.fx.banner('VICTORY!');
    this.hud.showWin();
  }

  forceFailDebug() {
    this.fail('Debug — forced fail');
  }
}

function uniqueColors(stations: Station[]): ColorKey[] {
  const set = new Set<ColorKey>();
  for (const s of stations) set.add(s.colorKey);
  return [...set];
}

/** Build a single dashed line segment between two XZ points (Y is taken from
 *  the parent group's transform). Returns the line + its disposables so the
 *  caller can free GPU memory at level reset. */
function makeDashedSegment(
  x1: number, z1: number,
  x2: number, z2: number,
  color: number,
  opacity: number = 0.85
): { line: THREE.Line; geo: THREE.BufferGeometry; mat: THREE.LineDashedMaterial } {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x1, 0, z1),
    new THREE.Vector3(x2, 0, z2),
  ]);
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize: 8,
    gapSize: 6,
    transparent: true,
    opacity,
    depthWrite: false,
    linewidth: 2,
  });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  return { line, geo, mat };
}
