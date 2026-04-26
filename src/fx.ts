/**
 * FX overlay — runs on a fullscreen 2D canvas above the WebGL renderer
 * and an absolutely-positioned popup layer for floating text.
 *
 * Particles & screen-space effects (bursts, ripples, sparks) live here.
 * Anything 3D-spatial stays in three (handled in scene/lines/stations).
 */

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: 'spark' | 'shard' | 'star';
  rot: number;
  vr: number;
};

type Ripple = {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  life: number;
  color: string;
};

export class Fx {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private ripples: Ripple[] = [];
  private lastTime = performance.now();
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor(private popupLayer: HTMLElement) {
    this.canvas = document.getElementById('fx-layer') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame((t) => this.loop(t));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(this.dpr, this.dpr);
  }

  // ============================================================
  // Burst — used on station place/connect
  // ============================================================
  burst(x: number, y: number, color: string, count = 24, force = 1) {
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const speed = (180 + Math.random() * 280) * force;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        life: 0,
        maxLife: 0.55 + Math.random() * 0.45,
        size: 3 + Math.random() * 5,
        color,
        kind: Math.random() < 0.3 ? 'star' : (Math.random() < 0.5 ? 'spark' : 'shard'),
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 12,
      });
    }
    this.ripples.push({
      x, y, radius: 0, maxRadius: 90 * force, life: 0, color,
    });
  }

  /** Lighter burst suited to in-progress connection placement. */
  pop(x: number, y: number, color: string) {
    this.burst(x, y, color, 14, 0.7);
  }

  /** Big celebration burst for completed connection. */
  celebrate(x: number, y: number, color: string) {
    this.burst(x, y, color, 36, 1.4);
    // gold flecks
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2;
      const speed = 220 + Math.random() * 260;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 60,
        life: 0,
        maxLife: 0.8 + Math.random() * 0.5,
        size: 4 + Math.random() * 4,
        color: '#FFE600',
        kind: 'star',
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 14,
      });
    }
  }

  // ============================================================
  // Floating popup text
  // ============================================================
  popup(x: number, y: number, text: string, color: string) {
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = color;
    this.popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  /** Big center-screen banner (combo / nice / great). */
  banner(text: string) {
    const el = document.createElement('div');
    el.className = 'combo-banner';
    el.textContent = text;
    this.popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  /** Flip-specific banner: same iconography as the toggle button (round + diamond
   *  + curved arrows) plus a clear "FLIP" wordmark, tinted in the destination
   *  dimension's accent colour so the user reads at a glance "I just flipped to
   *  this colour's layer". */
  flipBanner(toDimensionColor: string) {
    const el = document.createElement('div');
    el.className = 'flip-banner';
    el.style.color = toDimensionColor;
    el.innerHTML = `
      <svg class="flip-banner-icon" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="9" r="6" fill="currentColor" />
        <path d="M14 11 Q3 13 3 24 Q3 35 14 37" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
        <polyline points="11 33 14 37 11 41" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M34 37 Q45 35 45 24 Q45 13 34 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
        <polyline points="37 15 34 11 37 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        <g transform="rotate(45 24 39)"><rect x="18" y="33" width="12" height="12" fill="currentColor" /></g>
      </svg>
      <span class="flip-banner-text">FLIP</span>
    `;
    this.popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  // ============================================================
  // Loop
  // ============================================================
  private loop(now: number) {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { this.particles.splice(i, 1); continue; }
      p.vx *= 0.94;
      p.vy = p.vy * 0.94 + 280 * dt;       // gravity-ish
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const lifeFrac = 1 - p.life / p.maxLife;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = lifeFrac;
      ctx.fillStyle = p.color;
      const s = p.size * lifeFrac;
      // Cheap two-layer "glow": a wider, low-alpha halo behind a vivid core.
      // No shadowBlur (single most expensive canvas2D op).
      if (p.kind === 'spark') {
        ctx.globalAlpha = lifeFrac * 0.35;
        ctx.fillRect(-s * 1.6, -s * 0.5, s * 3.2, s * 1);
        ctx.globalAlpha = lifeFrac;
        ctx.fillRect(-s, -s * 0.25, s * 2, s * 0.5);
      } else if (p.kind === 'shard') {
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.7, 0);
        ctx.lineTo(0, s);
        ctx.lineTo(-s * 0.7, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        drawStar(ctx, 0, 0, s * 1.3, s * 0.55, 5);
        ctx.fill();
      }
      ctx.restore();
    }

    // Ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.life += dt;
      const T = 0.55;
      if (r.life >= T) { this.ripples.splice(i, 1); continue; }
      const f = r.life / T;
      r.radius = r.maxRadius * f;
      ctx.save();
      ctx.strokeStyle = r.color;
      // Two-pass ring: thick faint halo + thin vivid core. No shadowBlur.
      ctx.globalAlpha = (1 - f) * 0.32;
      ctx.lineWidth = 14 * (1 - f) + 4;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = (1 - f) * 0.9;
      ctx.lineWidth = 4 * (1 - f) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame((t) => this.loop(t));
  }
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  outer: number, inner: number,
  spikes: number
) {
  let rot = -Math.PI / 2;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    rot += Math.PI / spikes;
    ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
    rot += Math.PI / spikes;
  }
  ctx.closePath();
}
