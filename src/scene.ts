import * as THREE from 'three';
import { Dimension, LAYER_Y_ACTIVE, WORLD_HALF_X, WORLD_HALF_Z } from './types';

/** Surface / tunnel slab face colours. The slab's *top* face material colour
 *  tweens between these on every dimension switch, so the player sees the
 *  active layer's hue painted on the ground. */
const FLOOR_SURFACE = new THREE.Color('#3a1e5c');
const FLOOR_TUNNEL  = new THREE.Color('#0a3a4a');

/** Decorative grid colour per dimension. */
const GRID_COLOR_SURFACE = new THREE.Color('#ff006e');
const GRID_COLOR_TUNNEL  = new THREE.Color('#00f5ff');

const SLAB_THICKNESS = 4;

/** Camera framing. Same tilt for both dimensions — orientations look identical
 *  between switches; the cinematic only happens during the transition. */
const CAM_FOV = 50;
const TILT_DEG = 20;
const FRAME_MARGIN = 1.18;

/** Total transition duration (dezoom-out → flip → rezoom-in). Snappy on purpose
 *  — the user expects the dimension change to feel punchy, not contemplative. */
const TRANSITION_DURATION = 0.5;
const TRANSITION_DEZOOM_AMOUNT = 0.42;     // peak dezoom multiplier mid-transition

/** Ambient light pulse during transition for the "wash of light" feel. */
const AMBIENT_BASE = 0.55;
const AMBIENT_BOOST = 0.65;

export class SceneRig {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly raycaster = new THREE.Raycaster();
  readonly stationsLayer = new THREE.Group();
  readonly linesLayer = new THREE.Group();
  readonly fxLayer = new THREE.Group();
  /** Group rotated 180° around X on each dimension switch — the actual world
   *  flip. It contains the slab + stations + lines so they all rotate together. */
  readonly worldFlip = new THREE.Group();

  readonly slab: THREE.Mesh;
  private grid: THREE.Mesh;
  private gridMat: THREE.MeshBasicMaterial;
  private ambientLight: THREE.AmbientLight;

  /** Transition progress 0..1. 1 means the scene is at rest. Drives dezoom +
   *  worldFlip rotation + rezoom in lock-step so the rotation only happens
   *  while the camera is pulled back. */
  private transitionT = 1;
  private flipFrom = 0;
  private flipTo = 0;
  private gridColorFrom = GRID_COLOR_SURFACE.clone();
  private gridColorTo = GRID_COLOR_SURFACE.clone();
  private flipFlash = 0;

  private updaters: Array<(dt: number) => void> = [];
  private elapsed = 0;
  private activeDim: Dimension = 'surface';

  // Hot-path raycasting scratch
  private ndcScratch = new THREE.Vector2();
  private hitScratch = new THREE.Vector3();
  private cachedRect: { left: number; top: number; width: number; height: number } | null = null;

  /** Plane at world Y = LAYER_Y_ACTIVE (= +80) — the visible active layer altitude. */
  private worldDrawPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LAYER_Y_ACTIVE);

  constructor(parent: HTMLElement) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, w / h, 1, 4000);
    this.applyCamPose();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    parent.appendChild(this.renderer.domElement);
    this.scene.background = null;

    this.ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_BASE);
    this.scene.add(this.ambientLight);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(160, 280, 80);
    this.scene.add(dir);
    const rimPink = new THREE.PointLight(0xff006e, 1.2, 1200);
    rimPink.position.set(-300, 200, 200);
    this.scene.add(rimPink);
    const rimCyan = new THREE.PointLight(0x00f5ff, 1.2, 1200);
    rimCyan.position.set(300, 200, -200);
    this.scene.add(rimCyan);

    // Flip group: slab + grid + stations + lines all rotate together on switch.
    // The grid is glued to the slab's top face so it flips with the world —
    // visually the cadriage stays "stuck" to the plane that turns.
    this.scene.add(this.worldFlip);
    this.slab = makeSlab();
    this.worldFlip.add(this.slab);

    [this.grid, this.gridMat] = makeGrid();
    this.grid.position.y = SLAB_THICKNESS / 2 + 0.5;
    this.worldFlip.add(this.grid);

    this.worldFlip.add(this.stationsLayer);
    this.worldFlip.add(this.linesLayer);

    this.scene.add(this.fxLayer);

    window.addEventListener('resize', () => this.onResize());
  }

  /** Returns the slab — kept for API compat. */
  floorFor(_dim: Dimension): THREE.Mesh {
    return this.slab;
  }

  /** Return the active dimension — used by the lines tweener to know where to
   *  animate each committed line's mesh.position.y. */
  getActiveDimension(): Dimension {
    return this.activeDim;
  }

  /** Trigger the cinematic dimension switch — dezoom out, flip the world 180°
   *  around X, rezoom back in. All synchronised on a single `transitionT`. */
  setActiveDimension(dim: Dimension) {
    if (this.activeDim === dim) return;
    this.activeDim = dim;
    this.transitionT = 0;
    this.flipFlash = 1;

    // World flip rotation snapshot
    this.flipFrom = this.worldFlip.rotation.x;
    this.flipTo = dim === 'tunnel' ? Math.PI : 0;

    // Grid colour tween (grid stays in world frame, not flipped)
    this.gridColorFrom = this.gridMat.color.clone();
    this.gridColorTo = (dim === 'surface' ? GRID_COLOR_SURFACE : GRID_COLOR_TUNNEL).clone();
  }

  onTick(fn: (dt: number) => void) {
    this.updaters.push(fn);
  }

  /** Cast a ray from the pointer through the camera onto the active drawing
   *  plane (world Y = LAYER_Y_ACTIVE = top of the visible world, regardless of
   *  flip state). Returns coords in worldFlip's local frame so XZ matches
   *  stations + committed lines (which all live inside worldFlip). */
  pickFloor(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.cachedRect) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.cachedRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    const rect = this.cachedRect;
    this.ndcScratch.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1)
    );
    this.raycaster.setFromCamera(this.ndcScratch, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.worldDrawPlane, this.hitScratch);
    if (!hit) return null;
    return this.worldFlip.worldToLocal(hit.clone());
  }

  start() {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.tick(dt);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private tick(dt: number) {
    this.elapsed += dt;

    // Idle grid drift + breathing opacity
    this.grid.rotation.y = Math.sin(this.elapsed * 0.15) * 0.05;
    this.gridMat.opacity = 0.30 + Math.sin(this.elapsed * 1.5) * 0.06;

    // Transition progression — drives dezoom curve, world flip, and grid colour
    // all synchronised on the same timeline.
    if (this.transitionT < 1) {
      this.transitionT = Math.min(1, this.transitionT + dt / TRANSITION_DURATION);
      const eased = easeInOut(this.transitionT);

      // World flip rotation. Eased so it accelerates into the rotation while
      // the camera is at peak dezoom (mid-transition), then settles at the new
      // orientation as the camera rezooms in.
      this.worldFlip.rotation.x = this.flipFrom + (this.flipTo - this.flipFrom) * eased;

      // Grid colour
      this.gridMat.color.copy(this.gridColorFrom).lerp(this.gridColorTo, eased);

      // Camera framing rebuild (dezoom multiplier computed inside applyCamPose)
      this.applyCamPose();
    } else if (this.worldFlip.rotation.x !== this.flipTo) {
      this.worldFlip.rotation.x = this.flipTo;
    }

    // Ambient brighten pulse
    if (this.flipFlash > 0) {
      this.flipFlash = Math.max(0, this.flipFlash - dt * 1.4);
      this.ambientLight.intensity = AMBIENT_BASE + this.flipFlash * AMBIENT_BOOST;
    }

    for (const fn of this.updaters) fn(dt);
  }

  private applyCamPose() {
    const baseDistance = this.computeFitDistance();
    // Parabolic dezoom: 0 at t=0 and t=1, peak (×TRANSITION_DEZOOM_AMOUNT) at t=0.5.
    // sin(πt) gives exactly that shape.
    const dezoom = 1 + Math.sin(Math.PI * Math.min(1, this.transitionT)) * TRANSITION_DEZOOM_AMOUNT;
    const distance = baseDistance * dezoom;

    const tilt = (TILT_DEG * Math.PI) / 180;
    const camY = distance * Math.cos(tilt);
    const camZ = distance * Math.sin(tilt);
    this.camera.position.set(0, camY, camZ);
    this.camera.lookAt(0, 0, 0);
  }

  private computeFitDistance(): number {
    const aspect = this.camera.aspect;
    const fovV = (this.camera.fov * Math.PI) / 180;
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);

    const halfX = WORLD_HALF_X * FRAME_MARGIN;
    const halfZ = WORLD_HALF_Z * FRAME_MARGIN;

    const tilt = (TILT_DEG * Math.PI) / 180;
    const tiltFactor = 1 / Math.max(0.5, Math.cos(tilt));
    const halfZTilted = halfZ * tiltFactor;

    const distForWidth = halfX / Math.tan(fovH / 2);
    const distForDepth = halfZTilted / Math.tan(fovV / 2);

    return Math.max(distForWidth, distForDepth);
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.applyCamPose();
    this.cachedRect = null;
  }
}

/** Smoothstep ease-in-out — driving the transition timeline. */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A 3D slab with translucent top + bottom faces. The face colours are static
 *  per side — we don't tween them, the worldFlip rotation handles which face
 *  ends up on top after a dimension switch. */
function makeSlab(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(WORLD_HALF_X * 3.4, SLAB_THICKNESS, WORLD_HALF_Z * 3.4);
  const sideMat = new THREE.MeshLambertMaterial({
    color: 0x0e0a1a,
    transparent: true,
    opacity: 0.55,
  });
  const topMat = new THREE.MeshLambertMaterial({
    color: FLOOR_SURFACE.getHex(),
    emissive: FLOOR_SURFACE.getHex(),
    emissiveIntensity: 0.20,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const botMat = new THREE.MeshLambertMaterial({
    color: FLOOR_TUNNEL.getHex(),
    emissive: FLOOR_TUNNEL.getHex(),
    emissiveIntensity: 0.24,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const mats: THREE.Material[] = [sideMat, sideMat, topMat, botMat, sideMat, sideMat];
  const mesh = new THREE.Mesh(geo, mats);
  mesh.position.y = 0;
  mesh.renderOrder = 5;
  return mesh;
}

function makeGrid(): [THREE.Mesh, THREE.MeshBasicMaterial] {
  const cells = 14;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cells * size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    const p = i * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(canvas.width, p); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);

  const geo = new THREE.PlaneGeometry(WORLD_HALF_X * 3, WORLD_HALF_Z * 3);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.30,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: GRID_COLOR_SURFACE.getHex(),
    side: THREE.DoubleSide,        // remains visible after the worldFlip 180°
  });
  const mesh = new THREE.Mesh(geo, mat);
  return [mesh, mat];
}
