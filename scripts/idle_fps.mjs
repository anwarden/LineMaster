import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--enable-precise-memory-info','--js-flags=--expose-gc','--no-sandbox','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.goto('http://localhost:5174', { waitUntil: 'networkidle0' });
await page.click('#btn-start');
await new Promise((r) => setTimeout(r, 1500));
const r = await page.evaluate(async () => {
  let n = 0;
  const tick = () => { n++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, 1000));
  return { frames: n };
});
console.log(`Idle fps over 1s: ${r.frames}`);
await browser.close();
