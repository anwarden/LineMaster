#!/usr/bin/env node
/**
 * Memory + frame-rate benchmark.
 *
 * Loads the game in headless Chrome, picks an actual matching station pair from
 * the live `window.__game` state, simulates a 1-second curved drag between them,
 * and reports JS heap & RAF cadence at idle / peak / settle.
 *
 * Run: node scripts/bench.mjs [--url=http://localhost:5174]
 */
import puppeteer from 'puppeteer-core';

const URL = (process.argv.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:5174').split('=')[1];
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const fmtKB = (b) => `${(b / 1024).toFixed(1)} KB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(t) { console.log('\n' + '─'.repeat(64)); console.log('  ' + t); console.log('─'.repeat(64)); }

async function captureHeap(page, label) {
  await page.evaluate(() => { if (window.gc) { window.gc(); window.gc(); } });
  const m = await page.evaluate(() => ({
    used: performance.memory.usedJSHeapSize,
    total: performance.memory.totalJSHeapSize,
  }));
  console.log(`  ${label.padEnd(28)} used=${fmtMB(m.used).padStart(10)}   total=${fmtMB(m.total).padStart(10)}`);
  return m;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[browser]', err.message));

  console.log(`\nBenchmarking ${URL} …`);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

  header('1 — page loaded (start screen)');
  const m_load = await captureHeap(page, 'load');

  // Title → level select → start L1 directly via the public Game API.
  await page.evaluate(() => window.__game.startSpecificLevel(0));
  await page.waitForFunction('window.__game && window.__game.stations && window.__game.stations.length > 0', { timeout: 5000 });
  await sleep(1500);

  header('2 — level 1 idle');
  const m_idle = await captureHeap(page, 'idle');

  // Pick any colour pair (puzzle mode: no enforced target) — first colour in the
  // first station works.
  const drag = await page.evaluate(() => {
    const g = window.__game;
    if (g.stations.length < 2) return null;
    const target = g.stations[0].colorKey;
    const same = g.stations.filter((s) => s.colorKey === target);
    if (same.length < 2) return null;
    const cam = g.rig.camera;
    const project = (v3) => {
      // Need THREE on window — easier: do the math by hand.
      // We replicate v.project(cam) using Vector3.project from three:
      // create a copy and use the camera's projectionMatrix/matrixWorldInverse
      const x = v3.x, y = v3.y, z = v3.z;
      // toWorld -> view: inverse of camera world matrix
      const e = cam.matrixWorldInverse.elements;
      const wx = e[0]*x + e[4]*y + e[8]*z + e[12];
      const wy = e[1]*x + e[5]*y + e[9]*z + e[13];
      const wz = e[2]*x + e[6]*y + e[10]*z + e[14];
      const ww = e[3]*x + e[7]*y + e[11]*z + e[15];
      const p = cam.projectionMatrix.elements;
      const px = p[0]*wx + p[4]*wy + p[8]*wz + p[12]*ww;
      const py = p[1]*wx + p[5]*wy + p[9]*wz + p[13]*ww;
      const pw = p[3]*wx + p[7]*wy + p[11]*wz + p[15]*ww;
      const ndcX = px / pw;
      const ndcY = py / pw;
      return {
        sx: (ndcX * 0.5 + 0.5) * window.innerWidth,
        sy: (-ndcY * 0.5 + 0.5) * window.innerHeight,
      };
    };
    const a = same[0].group.position, b = same[1].group.position;
    return {
      target,
      from: project(a),
      to: project(b),
    };
  });

  if (!drag) { console.error('No matching station pair found. Aborting.'); await browser.close(); process.exit(1); }
  console.log(`  drag target color: ${drag.target}`);
  console.log(`  from station: (${drag.from.sx.toFixed(0)}, ${drag.from.sy.toFixed(0)})`);
  console.log(`  to   station: (${drag.to.sx.toFixed(0)}, ${drag.to.sy.toFixed(0)})`);

  header('3 — drag simulation (in-page dispatch — no CDP overhead)');
  // Run the entire drag inside the page so wall time = real game time.
  const result = await page.evaluate(async (drag) => {
    const STEPS = 90;
    const DURATION_MS = 900;

    let rafCount = 0;
    let running = true;
    const rafLoop = () => { rafCount++; if (running) requestAnimationFrame(rafLoop); };
    requestAnimationFrame(rafLoop);

    const canvas = window.__game.rig.renderer.domElement;
    const fire = (type, x, y) => {
      const init = { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, pointerType: 'mouse' };
      const target = type === 'pointerdown' ? canvas : window;
      target.dispatchEvent(new PointerEvent(type, init));
    };

    fire('pointerdown', drag.from.sx, drag.from.sy);
    await new Promise((r) => setTimeout(r, 40));

    const t0 = performance.now();
    let peakUsed = 0;
    let peakTotal = 0;
    const heapSamples = [];

    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const dx = drag.to.sx - drag.from.sx;
      const dy = drag.to.sy - drag.from.sy;
      const px = drag.from.sx + dx * t + Math.sin(t * Math.PI * 5) * 80;
      const py = drag.from.sy + dy * t + Math.cos(t * Math.PI * 5) * 60;
      fire('pointermove', px, py);
      if (i % 6 === 0) {
        const u = performance.memory.usedJSHeapSize;
        const tt = performance.memory.totalJSHeapSize;
        heapSamples.push(u);
        if (u > peakUsed) peakUsed = u;
        if (tt > peakTotal) peakTotal = tt;
      }
      await new Promise((r) => setTimeout(r, DURATION_MS / STEPS));
    }

    const wallMs = performance.now() - t0;
    fire('pointerup', drag.to.sx + 200, drag.to.sy);   // release away from station so no commit
    running = false;

    const isDrawing = window.__game.isDrawing;

    return {
      wallMs,
      frames: rafCount,
      fps: (rafCount * 1000) / wallMs,
      peakUsed,
      peakTotal,
      heapSamples,
      isDrawing,
    };
  }, drag);

  console.log(`  drag wall time  : ${result.wallMs.toFixed(0)} ms`);
  console.log(`  frames during   : ${result.frames}  →  ${result.fps.toFixed(1)} fps`);
  console.log(`  used PEAK       : ${fmtMB(result.peakUsed)}    (delta vs idle: +${fmtMB(result.peakUsed - m_idle.used)})`);
  console.log(`  total PEAK      : ${fmtMB(result.peakTotal)}`);
  const peakUsed = result.peakUsed;
  const fps = result.fps;
  await sleep(500);

  header('4 — after release');
  const m_after = await captureHeap(page, 'after release');

  await sleep(1500);
  header('5 — post-GC settle');
  const m_settle = await captureHeap(page, 'settle');

  header('SUMMARY');
  console.log(`  loaded                : ${fmtMB(m_load.used)}`);
  console.log(`  idle on L1            : ${fmtMB(m_idle.used)}     (level setup: +${fmtMB(m_idle.used - m_load.used)})`);
  console.log(`  drag PEAK used        : ${fmtMB(peakUsed)}     (delta: +${fmtMB(peakUsed - m_idle.used)})`);
  console.log(`  drag fps              : ${fps.toFixed(1)} fps`);
  console.log(`  retained after settle : ${fmtKB(m_settle.used - m_idle.used)}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
