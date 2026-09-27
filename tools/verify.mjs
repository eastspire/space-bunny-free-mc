// Headless verification harness: boots the game, waits for the world to stream
// in, drives it through several scenarios and writes screenshots to shots/.
//
//   node tools/verify.mjs [--headful] [--url http://127.0.0.1:8137/]
//
// Screenshots land in docs/screenshots/ and are committed as-is.

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const headful = argv.includes('--headful');
const base = (() => {
  const i = argv.indexOf('--url');
  return i >= 0 ? argv[i + 1] : 'http://127.0.0.1:8137/';
})();

const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

const browser = await chromium.launch({
  headless: !headful,
  channel: 'chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') consoleErrors.push(`[${t}] ${m.text()}`);
  note(`  console.${t}: ${m.text()}`);
});
page.on('pageerror', (e) => { pageErrors.push(String(e)); note(`  PAGEERROR: ${e}`); });

const shot = async (name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  note(`  shot -> docs/screenshots/${name}.png`);
  return file;
};

const waitReady = async (timeout = 60000) => {
  await page.waitForFunction(() => window.__game && window.__game.ready(), null, { timeout });
  await page.waitForTimeout(700);
};

const stats = () => page.evaluate(() => window.__game.stats());

// ---------------------------------------------------------------- 1. boot
note('== scenario 1: cold boot / intro overlay ==');
const t0 = Date.now();
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await waitReady();
note(`  world streamed in ${Date.now() - t0}ms`);
note(`  stats ${JSON.stringify(await stats())}`);
await shot('01-intro-overlay');

// ------------------------------------------------- 2. spawn view (no lock)
note('== scenario 2: spawn panorama ==');
await page.evaluate(() => document.getElementById('overlay').classList.add('peek'));
await page.evaluate(() => {
  const g = window.__game;
  g.player.flying = true;
  g.player.pos.y += 16;
  g.look(0.9, -0.26);
});
await page.waitForTimeout(1200);
await shot('02-spawn-panorama');
await page.evaluate(() => document.getElementById('overlay').classList.remove('peek'));

// ------------------------------------------------------ 3. pointer lock
note('== scenario 3: pointer lock + first person ==');
await page.click('#start');
await page.waitForTimeout(500);
note(`  pointer locked: ${await page.evaluate(() => document.pointerLockElement !== null)}`);
await page.evaluate(() => {
  const g = window.__game;
  g.player.flying = false;
  g.player.vel.set(0, 0, 0);
  g.player.spawnAt(Math.floor(g.player.pos.x), Math.floor(g.player.pos.z));  // clear, dry ground
  g.look(0.9, -0.16);
});
await page.waitForTimeout(1400);
await shot('03-first-person');

// ------------------------------------------------------------ 4. walking
note('== scenario 4: walk forward 2.5s ==');
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
await page.evaluate(() => window.__game.look(window.__game.player.yaw, -0.08));
await page.waitForTimeout(500);
note(`  stats ${JSON.stringify(await stats())}`);
await shot('04-after-walk');

// ------------------------------------------------- 5. mine + place blocks
note('== scenario 5: build, then mine with a real mouse press ==');
const built = await page.evaluate(() => {
  const g = window.__game;
  const B = { PLANKS: 7, BRICK: 8, GLASS: 9, LOG: 5, LEAVES: 6, SNOW: 11, COBBLE: 12 };
  const spot = g.flatSpot(1128, 3672, 96, 8);
  const ox = spot.x + 2, oz = spot.z - 2;
  const oy = Math.floor(g.world.heightAt(ox, oz)) + 1;
  let n = 0;
  // 7x7 brick hut: plank roof, glass windows, log corner posts
  for (let x = 0; x < 7; x++) {
    for (let z = 0; z < 7; z++) {
      g.world.setBlock(ox + x, oy - 1, oz + z, B.BRICK); n++;
      for (let y = 0; y < 4; y++) {
        const edge = x === 0 || z === 0 || x === 6 || z === 6;
        if (!edge) continue;
        const corner = (x === 0 || x === 6) && (z === 0 || z === 6);
        const window_ = y === 1 && !corner && ((x + z) % 2 === 0);
        g.world.setBlock(ox + x, oy + y, oz + z,
          corner ? B.LOG : y === 3 ? B.PLANKS : window_ ? B.GLASS : B.BRICK);
        n++;
      }
    }
  }
  for (let x = -1; x <= 7; x++) {
    for (let z = -1; z <= 7; z++) {
      const inner = x >= 0 && x <= 6 && z >= 0 && z <= 6;
      g.world.setBlock(ox + x, oy + 4, oz + z, inner ? B.PLANKS : B.SNOW);
      n++;
    }
  }
  g.player.flying = true;
  const ex = ox - 7, ez = oz - 7;
  const eye = Math.max(Math.floor(g.world.heightAt(ex, ez)) + 3, oy + 4);
  g.teleport(ex, eye, ez);
  g.player.pos.y = eye;
  g.lookAt(ox + 3.5, oy + 1.5, oz + 3.5);
  return { placed: n, at: [ox, oy, oz], flat: spot.flat };
});
note(`  built ${JSON.stringify(built)}`);
await waitReady();
await page.waitForTimeout(1200);
await shot('05-blocks-placed');

// mine a block with the real mouse button
note('== scenario 5b: cobblestone wall + real mouse mining ==');
const wall = await page.evaluate(() => {
  const g = window.__game;
  g.player.flying = true;
  g.look(0.7, 0);
  const p = g.player.pos, d = g.player.lookDir();
  const bx = Math.floor(p.x + d.x * 7);
  const by = Math.floor(p.y + 1.62);
  const bz = Math.floor(p.z + d.z * 7);
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = 0; z < 2; z++) g.world.setBlock(bx + x, by + y, bz + z, 12);
    }
  }
  g.look(0.7, 0);
  const hit = g.player.raycast(6);
  return { wall: [bx, by, bz], hit: hit && { id: hit.id, at: [hit.x, hit.y, hit.z] } };
});
note(`  wall at ${JSON.stringify(wall.wall)} raycast ${JSON.stringify(wall.hit)}`);
await page.waitForTimeout(900);
await page.mouse.down();
await page.waitForTimeout(500);
await shot('06a-mining-progress');
await page.waitForTimeout(1200);
await page.mouse.up();
await page.waitForTimeout(500);
const mined = await page.evaluate((hit) => {
  const g = window.__game;
  return {
    target: g.world.getBlock(hit[0], hit[1], hit[2]),
    neighbour: g.world.getBlock(hit[0] - 2, hit[1], hit[2]),
  };
}, wall.hit.at);
note(`  after mining: target=${mined.target} (0=air) neighbour=${mined.neighbour} (12=cobble)`);
await shot('06-blocks-broken');

// ------------------------------------------------------------- 6. hotbar
note('== scenario 6: hotbar selection ==');
for (const k of ['Digit3', 'Digit6', 'Digit9']) {
  await page.keyboard.press(k);
  await page.waitForTimeout(200);
}
await shot('07-hotbar');

// ------------------------------------------------------------ 7. biomes
// coordinates come from tools/find-spots.mjs for this seed
// [name, x, z, yaw, pitch, y, aimPeak]
const biomeShots = [
  ['08-biome-mountains', 1704, 1752, 0.6, -0.12, 46, 96],
  ['09-biome-woodland', -552, -4008, 0.9, 0.04, 38, 0],
  ['10-biome-desert', 2760, 3384, 1.4, -0.08, 54, 0],
  ['11-biome-beach', -1512, 4056, 2.1, -0.05, 32, 0],
];
for (const [name, x, z, yaw, pitch, y, aimPeak] of biomeShots) {
  note(`== scenario 7: ${name} ==`);
  await page.evaluate(({ x, z, yaw, pitch, y, aimPeak }) => {
    const g = window.__game;
    g.player.flying = true;
    if (aimPeak) {
      // stand back from the peak so the camera is never buried in the rock
      const peak = g.highestWithin(x, z, aimPeak);
      const back = 62;
      const ang = 0.9;
      const cx = Math.round(peak.x - Math.cos(ang) * back);
      const cz = Math.round(peak.z + Math.sin(ang) * back);
      const ground = g.world.surfaceY(cx, cz);
      g.teleport(cx, Math.max(ground + 8, peak.h + 7), cz);
      g.player.pos.y = Math.max(ground + 8, peak.h + 7);
      g.lookAt(peak.x, peak.h - 6, peak.z);
    } else {
      g.teleport(x, y, z);
      g.player.pos.y = y;
      g.look(yaw, pitch);
    }
  }, { x, z, yaw, pitch, y, aimPeak });
  await waitReady();
  await page.waitForTimeout(1200);
  note(`  stats ${JSON.stringify(await stats())}`);
  await shot(name);
}

// --------------------------------------------------------- 8. day / night
note('== scenario 8: day / sunset / night ==');
for (const [name, frac, pitch] of [
  ['12-noon', 0.5, -0.13],
  ['13-sunset', 0.755, 0.02],
  ['14-night', 0.02, 0.06],
]) {
  await page.evaluate(({ frac, pitch }) => {
    const g = window.__game;
    g.player.flying = true;
    g.teleport(1128, 44, 3672);
    g.player.pos.y = 44;
    g.look(0.7, pitch);
    g.setTime(frac);
  }, { frac, pitch });
  await waitReady();
  await page.waitForTimeout(1100);
  await shot(name);
}

// ------------------------------------------------- 9. high / low overview
note('== scenario 9: aerial overview ==');
await page.evaluate(() => {
  const g = window.__game;
  g.setTime(0.36);
  g.teleport(1128, 74, 3672);
  g.player.pos.y = 74;
  g.player.flying = true;
  g.look(2.4, -0.36);
});
await waitReady();
await page.waitForTimeout(1200);
await shot('15-aerial');

// ---------------------------------------------------- 10. underwater view
note('== scenario 10: water ==');
const ocean = await page.evaluate(() => {
  const g = window.__game;
  for (const [x, z] of [[-3096, -4200], [-648, 4008]]) {
    const y = Math.floor(g.world.heightAt(x, z));
    if (y > 0 && y < 24) return { x, z, y };
  }
  return null;
});
note(`  ocean floor sample ${JSON.stringify(ocean)}`);
if (ocean) {
  await page.evaluate(({ x, y, z }) => {
    const g = window.__game;
    g.setTime(0.4);
    g.teleport(x + 0.5, y + 2.4, z + 0.5);
    g.player.pos.y = y + 2.4;
    g.player.flying = true;
    g.look(0.9, -0.1);
  }, ocean);
  await waitReady();
  await page.waitForTimeout(1200);
  await shot('16-water');
}

// ------------------------------------------------------------ perf probe
note('== perf: 90 frames ==');
await page.evaluate(() => {
  const g = window.__game;
  g.teleport(1128, 60, 3672);
  g.player.pos.y = 60;
  g.player.flying = true;
  g.look(0.6, -0.2);
});
await waitReady();
const perf = await page.evaluate(async () => {
  const g = window.__game;
  const t = performance.now();
  let frames = 0;
  await new Promise((res) => {
    const tick = () => { frames++; frames < 90 ? requestAnimationFrame(tick) : res(); };
    requestAnimationFrame(tick);
  });
  const dt = (performance.now() - t) / 1000;
  return { fps: +(frames / dt).toFixed(1), ...g.stats() };
});
note(`  ${JSON.stringify(perf)}`);

note('== writing report ==');
const report = {
  url: base,
  when: new Date().toISOString(),
  pageErrors,
  consoleErrors: [...new Set(consoleErrors)],
  perf,
  shots: readdirSync(SHOTS).filter((f) => f.endsWith('.png')),
};
writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));

note('== summary ==');
note(`  page errors: ${pageErrors.length}`);
note(`  console warn/err: ${report.consoleErrors.length}`);
if (pageErrors.length) note('  ' + pageErrors.join('\n  '));
if (report.consoleErrors.length) note('  ' + report.consoleErrors.slice(0, 20).join('\n  '));

// pointer lock can keep the browser process alive, so do not wait forever
await Promise.race([
  browser.close(),
  new Promise((r) => setTimeout(r, 4000)),
]);
process.exit(pageErrors.length || consoleErrors.length ? 1 : 0);
