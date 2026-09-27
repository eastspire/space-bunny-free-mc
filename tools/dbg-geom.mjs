import { chromium } from 'playwright-core';

const url = process.argv[2];
const mode = process.argv[3] || 'wire';
const yaw = Number(process.argv[4] ?? 0.7);
const pitch = Number(process.argv[5] ?? -0.35);
const y = Number(process.argv[6] ?? 45);

const b = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 600 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.stack || e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text()); });
await p.goto(`${url}${url.includes('?') ? '&' : '?'}overlay=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__game && window.__game.ready(), null, { timeout: 60000 });
await p.evaluate((mode) => {
  const g = window.__game;
  g.player.flying = true;
  g.teleport(0, 45, 0);
  g.player.pos.y = 45;
  g.look(0.7, -0.35);
  g.setDebugMaterials(mode);
  if (mode !== 'off') g.scene.fog = null;
}, mode);
await p.waitForTimeout(600);
await p.evaluate(({ yaw, pitch, y }) => {
  const g = window.__game;
  g.player.pos.y = y;
  g.look(yaw, pitch);
}, { yaw, pitch, y });
await p.waitForTimeout(900);
await p.screenshot({ path: `shots/dbg-${mode}.png` });
console.log('stats', JSON.stringify(await p.evaluate(() => window.__game.stats())));
await b.close();
