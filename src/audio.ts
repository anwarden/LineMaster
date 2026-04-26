import { ColorKey, Dimension } from './types';

/**
 * Soft & playful sound layer — pure Web Audio synthesis, zero asset payload.
 * Aesthetic = pastel: round sines / triangles, slow attacks, gentle decays,
 * mild reverb tails. A master compressor + lowpass cap at 9 kHz globally
 * enforces "never harsh".
 *
 * Browsers start AudioContext suspended; call `unlock()` from any user
 * gesture (the Game wires this to the first PLAY click and the first
 * canvas pointerdown). Audio calls before unlock no-op silently.
 */

/** Pitch palette per station colour. Two chord-tones each so repeats read as
 *  a colour-chord rather than a single robotic pitch. All within C major-ish
 *  to keep different colours sounding related. */
const COLOR_FREQS: Record<ColorKey, [number, number]> = {
  PINK:   [523.25, 659.25],   // C5, E5
  CYAN:   [392.00, 493.88],   // G4, B4
  LIME:   [440.00, 523.25],   // A4, C5
  PURPLE: [587.33, 739.99],   // D5, F#5
  ORANGE: [349.23, 440.00],   // F4, A4
  YELLOW: [659.25, 783.99],   // E5, G5
};

/** Random pitch jitter ±15 cents — enough to make repeats feel alive,
 *  small enough to stay in tune. */
function jitter(freq: number): number {
  return freq * (1 + (Math.random() - 0.5) * 0.0173);
}

function pickFreq(key: ColorKey): number {
  const pair = COLOR_FREQS[key];
  return jitter(pair[Math.floor(Math.random() * 2)]);
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private fxBus!: GainNode;
  private musicBus!: GainNode;
  private reverbSend!: GainNode;
  private reverb!: ConvolverNode;

  /** The current "drawing" hum voice — one shared, not per-tick. */
  private humOscA: OscillatorNode | null = null;
  private humOscB: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  private humFilter: BiquadFilterNode | null = null;
  private humTickCount = 0;

  /** Background music nodes (so we can stop them later). */
  private musicNodes: AudioNode[] = [];
  private musicTimer: number | null = null;
  private musicStarted = false;
  private duckTimer: number | null = null;

  unlock(): void {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  // ============================================================
  // Master graph
  // ============================================================

  private buildGraph() {
    const ctx = this.ctx!;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.03;
    compressor.release.value = 0.25;

    const warmth = ctx.createBiquadFilter();
    warmth.type = 'lowshelf';
    warmth.frequency.value = 200;
    warmth.gain.value = 2;

    const tame = ctx.createBiquadFilter();
    tame.type = 'lowpass';
    tame.frequency.value = 9000;
    tame.Q.value = 0.7;

    this.master.connect(compressor);
    compressor.connect(warmth);
    warmth.connect(tame);
    tame.connect(ctx.destination);

    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 0.6;
    this.fxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(this.master);

    // Procedural reverb impulse — short, lush.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(0.85, 2.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);
  }

  private makeImpulse(durationSec: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * durationSec);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // ============================================================
  // Voice helpers
  // ============================================================

  /** Bubbly "bloop" — used for dot placement, melody notes, fail notes. */
  private bloop(freq: number, gain = 0.18, dur = 0.25): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // pitch dip: 1.4× → 1× over 70 ms = the "bubble pop" character
    osc.frequency.setValueAtTime(freq * 1.4, t0);
    osc.frequency.exponentialRampToValueAtTime(freq, t0 + 0.07);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    lp.Q.value = 0.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.fxBus);

    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => {
      osc.disconnect();
      lp.disconnect();
      g.disconnect();
    };
  }

  /** Fairy-dust shimmer — three sine bells, reverb-soaked. */
  private shimmer(freq: number, sendAmount = 0.5, spread = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const ratios = [1, 1.5, 2.005];
    for (const r of ratios) {
      const onset = Math.random() * 0.08;
      const t0 = ctx.currentTime + onset;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = jitter(freq * r) * spread;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);

      const send = ctx.createGain();
      send.gain.value = sendAmount;

      osc.connect(g);
      g.connect(this.fxBus);
      g.connect(send);
      send.connect(this.reverbSend);

      osc.start(t0);
      osc.stop(t0 + 0.7);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
        send.disconnect();
      };
    }
  }

  /** Dreamy whoomp — sine sweep landing on `freq`. Scheduled with a delay so
   *  it lands at the visual flip midpoint, not on click. */
  private whoomp(freq: number, delay: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 0.5, t0);
    osc.frequency.exponentialRampToValueAtTime(freq, t0 + 0.18);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.32, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);

    const send = ctx.createGain();
    send.gain.value = 0.4;

    osc.connect(g);
    g.connect(this.fxBus);
    g.connect(send);
    send.connect(this.reverbSend);

    osc.start(t0);
    osc.stop(t0 + 0.55);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
      send.disconnect();
    };
  }

  /** Whisper-soft hover chime. */
  private chime(freq: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    osc.connect(g);
    g.connect(this.fxBus);

    osc.start(t0);
    osc.stop(t0 + 0.22);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  // ============================================================
  // Public SFX
  // ============================================================

  dotPlace(colorKey: ColorKey): void {
    this.bloop(pickFreq(colorKey), 0.16, 0.28);
  }

  drawStart(colorKey: ColorKey): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.releaseHum();        // safety: kill any orphaned hum
    const baseFreq = pickFreq(colorKey) * 0.5;  // an octave lower so it sits under everything

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = 'triangle';
    oscB.type = 'triangle';
    oscA.frequency.value = baseFreq * (1 - 0.0029);   // -5 cents
    oscB.frequency.value = baseFreq * (1 + 0.0029);   // +5 cents

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 0.8;

    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.10, t0 + 0.06);

    oscA.connect(lp);
    oscB.connect(lp);
    lp.connect(g);
    g.connect(this.fxBus);

    oscA.start(t0);
    oscB.start(t0);

    this.humOscA = oscA;
    this.humOscB = oscB;
    this.humFilter = lp;
    this.humGain = g;
    this.humTickCount = 0;
  }

  drawTick(_colorKey: ColorKey): void {
    if (!this.ctx || !this.humFilter) return;
    this.humTickCount++;
    // Sweep the lowpass up as the line grows: 700 Hz → 2.4 kHz over ~30 ticks.
    const t = Math.min(1, this.humTickCount / 30);
    const target = 700 + t * 1700;
    const now = this.ctx.currentTime;
    this.humFilter.frequency.cancelScheduledValues(now);
    this.humFilter.frequency.linearRampToValueAtTime(target, now + 0.08);
  }

  drawEnd(): void {
    this.releaseHum();
  }

  private releaseHum(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (this.humGain) {
      const g = this.humGain;
      const a = this.humOscA;
      const b = this.humOscB;
      const lp = this.humFilter;
      const t0 = ctx.currentTime;
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      window.setTimeout(() => {
        a?.stop();
        b?.stop();
        a?.disconnect();
        b?.disconnect();
        lp?.disconnect();
        g.disconnect();
      }, 220);
    }
    this.humOscA = null;
    this.humOscB = null;
    this.humGain = null;
    this.humFilter = null;
    this.humTickCount = 0;
  }

  connect(colorKey: ColorKey, dimension: Dimension): void {
    if (!this.ctx) return;
    // A celebratory bloop + shimmer. Tunnel commits get a slightly wider chord
    // (cross-layer "magical" feel).
    this.bloop(pickFreq(colorKey), 0.22, 0.3);
    const wide = dimension === 'tunnel' ? 1.012 : 1.0;
    const send = dimension === 'tunnel' ? 0.7 : 0.45;
    this.shimmer(pickFreq(colorKey), send, wide);
  }

  flip(toDimension: Dimension): void {
    if (!this.ctx) return;
    // Flip animation is ~500 ms; we want the whoomp to land at midpoint.
    const baseFreq = toDimension === 'tunnel' ? 196 : 261.63;  // G3 (deeper) / C4
    this.whoomp(baseFreq, 0.25);
    // Trailing pillowy shimmer just past midpoint.
    window.setTimeout(() => {
      this.shimmer(baseFreq * 4, 0.7, 1);
    }, 400);

    // Briefly duck the music under the flip.
    this.setMusicDuck(0.6);
    window.setTimeout(() => this.setMusicDuck(0), 700);
  }

  hover(): void {
    // Random C-major chord-tone, very quiet.
    const tones = [523.25, 587.33, 659.25, 783.99, 880];
    this.chime(jitter(tones[Math.floor(Math.random() * tones.length)]));
  }

  levelComplete(): void {
    if (!this.ctx) return;
    // Bouncy 4-note pentatonic phrase.
    const notes = [523.25, 659.25, 783.99, 1046.5];   // C5 E5 G5 C6
    notes.forEach((f, i) => {
      window.setTimeout(() => this.bloop(jitter(f), 0.22, 0.32), i * 90);
    });
  }

  victory(): void {
    if (!this.ctx) return;
    // Happier, broader 8-note phrase — same pentatonic, two octaves.
    const notes = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1318.5, 1567.98];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.bloop(jitter(f), 0.22, 0.34), i * 95);
    });
    // A wash of shimmer underneath.
    window.setTimeout(() => this.shimmer(523.25, 0.8, 1), 200);
    window.setTimeout(() => this.shimmer(783.99, 0.8, 1.012), 600);
  }

  fail(): void {
    if (!this.ctx) return;
    // Soft descending two-note "aww" — major third E4 → C4. Sad-cute, never harsh.
    this.bloop(jitter(329.63), 0.16, 0.32);
    window.setTimeout(() => this.bloop(jitter(261.63), 0.16, 0.42), 140);
    this.setMusicDuck(0.7);
    window.setTimeout(() => this.setMusicDuck(0), 700);
  }

  // ============================================================
  // Background music — cosy pad + slow pentatonic arp
  // ============================================================

  startMusic(): void {
    if (!this.ctx || this.musicStarted) return;
    this.musicStarted = true;
    const ctx = this.ctx;

    // Pad: two detuned saws lowpassed heavily. Drone on C2.
    const padA = ctx.createOscillator();
    const padB = ctx.createOscillator();
    padA.type = 'sawtooth';
    padB.type = 'sawtooth';
    padA.frequency.value = 65.41 * (1 - 0.003);   // C2 -5 cents
    padB.frequency.value = 65.41 * (1 + 0.003);   // C2 +5 cents

    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 300;
    padFilter.Q.value = 0.5;

    // Slow LFO on the filter for movement.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.1;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain);
    lfoGain.connect(padFilter.frequency);

    const padGain = ctx.createGain();
    padGain.gain.value = 0.04;

    padA.connect(padFilter);
    padB.connect(padFilter);
    padFilter.connect(padGain);
    padGain.connect(this.musicBus);

    const t0 = ctx.currentTime + 0.05;
    padA.start(t0);
    padB.start(t0);
    lfo.start(t0);

    this.musicNodes.push(padA, padB, lfo, lfoGain, padFilter, padGain);

    // Arpeggio loop — C major pentatonic, gently bouncing.
    const notes = [261.63, 329.63, 392.00, 493.88, 392.00, 329.63];
    let idx = 0;
    const playNote = () => {
      if (!this.ctx) return;
      const f = notes[idx % notes.length];
      idx++;
      const tn = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = jitter(f);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.06, tn + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, tn + 0.9);

      osc.connect(g);
      g.connect(this.musicBus);
      osc.start(tn);
      osc.stop(tn + 1.0);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    };
    playNote();
    this.musicTimer = window.setInterval(playNote, 1067);   // 6.4 s loop ÷ 6 notes
  }

  stopMusic(): void {
    if (this.musicTimer != null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    for (const n of this.musicNodes) {
      try { (n as OscillatorNode).stop?.(); } catch { /* not all are oscillators */ }
      n.disconnect();
    }
    this.musicNodes = [];
    this.musicStarted = false;
  }

  /** 0 = full music volume, 1 = fully ducked. Smooths over 80 ms. */
  setMusicDuck(amount: number): void {
    if (!this.ctx) return;
    const target = 0.5 * (1 - Math.max(0, Math.min(1, amount)));
    const now = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.linearRampToValueAtTime(target, now + 0.08);
    if (this.duckTimer != null) {
      window.clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
  }
}
