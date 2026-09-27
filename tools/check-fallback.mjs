// Verify the pointer-lock fallback: simulate a browser that denies pointer
// lock and confirm the overlay still clears and the game becomes playable.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Headless GPU stacks log driver chatter, and tearing the context down at the
// end of the run prints a CONTEXT_LOST warning. Neither says anything about the
// app, so only real errors are collected.
const BENIGN_CONSOLE = [
  /GL Driver Message/i,
  /GPU stall due to ReadPixels/i,
  /CONTEXT_LOST_WEBGL/i,
  /SwiftShader/i,
  /software WebGL/i,
  /GroupMarkerNotSet/i,
];
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (BENIGN_CONSOLE.some((re) => re.test(m.text()))) return;
  errors.push(`[${m.type()}] ${m.text()}`);
});

// Deny pointer lock the way an embedded webview does: throw WrongDocumentError.
await page.addInitScript(() => {
  const proto = HTMLCanvasElement.prototype;
  Object.defineProperty(proto, 'requestPointerLock', {
    configurable: true,
    value() { return Promise.reject(new DOMException('denied', 'WrongDocumentError')); },
  });
});

await page.goto('http://127.0.0.1:8137/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.ready(), null, { timeout: 60000 });
await page.waitForTimeout(600);

console.log('overlay visible before click :', await page.evaluate(() =>
  !document.getElementById('overlay').classList.contains('hidden')));

await page.click('#start');
await page.waitForTimeout(900);

const after = await page.evaluate(() => ({
  overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
  locked: document.pointerLockElement !== null,
}));
console.log('overlay hidden after click   :', after.overlayHidden, '(pointer lock granted:', after.locked + ')');

// Now prove the fallback controls actually work: move with W, then look by dragging.
const p0 = await page.evaluate(() => window.__game.player.pos.toArray());
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const p1 = await page.evaluate(() => window.__game.player.pos.toArray());
const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
console.log('walked with W                :', moved.toFixed(2), 'blocks');

const y0 = await page.evaluate(() => window.__game.player.yaw);
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(880, 400, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const y1 = await page.evaluate(() => window.__game.player.yaw);
console.log('drag-to-look changed yaw     :', (y1 - y0).toFixed(4));

// place + mine a block to prove the build path is reachable without pointer lock
const edited = await page.evaluate(() => {
  const g = window.__game;
  // look down at the ground so the raycast definitely hits terrain
  g.look(g.player.yaw, -1.1);
  const hit = g.player.raycast();
  if (!hit) return 'no target';
  const p = hit.place;                             // [x,y,z] adjacent cell
  const before = g.world.getBlock(hit.x, hit.y, hit.z);
  g.world.setBlock(p[0], p[1], p[2], 8);          // place brick
  const placedOk = g.world.getBlock(p[0], p[1], p[2]) === 8;
  g.world.setBlock(hit.x, hit.y, hit.z, 0);       // mine it back out
  const minedOk = g.world.getBlock(hit.x, hit.y, hit.z) === 0;
  return { target: [hit.x, hit.y, hit.z], was: before, placedAt: p, placedOk, minedOk };
});
console.log('block place + mine          :', JSON.stringify(edited));

await page.screenshot({ path: 'docs/screenshots/17-fallback-nopointerlock.png' });
console.log('page/console errors          :', errors.length, errors.slice(0, 3).join(' | '));
await browser.close();
process.exit(errors.length ? 1 : 0);
