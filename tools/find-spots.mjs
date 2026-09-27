// Scans the seed for photogenic spots (one per biome) and prints coordinates.
import { World, BIOME_NAMES, SEA_LEVEL, CHUNK_Y } from '../src/world.js';

const seed = Number(process.argv[2] ?? 20260927);
const w = new World(seed);
const STEP = 48;
const RANGE = 4200;
const found = new Map();

for (let z = -RANGE; z <= RANGE; z += STEP) {
  for (let x = -RANGE; x <= RANGE; x += STEP) {
    const h = w.heightAt(x, z);
    const b = w.biomeAt(x, z, h);
    const key = BIOME_NAMES[b];
    // want the most interesting spot: relief around the point
    let relief = 0;
    for (const [dx, dz] of [[24, 0], [-24, 0], [0, 24], [0, -24], [40, 40], [-40, -40]]) {
      relief += Math.abs(w.heightAt(x + dx, z + dz) - h);
    }
    const cur = found.get(key);
    const score = relief + (b === 2 || b === 3 ? 30 : 0);
    if (!cur || score > cur.score) found.set(key, { x, z, h: Math.round(h), biome: b, relief: Math.round(relief), score: Math.round(score) });
  }
}

for (const [name, v] of found) {
  const trees = (() => { let t = 0; for (let dz = -24; dz <= 24; dz += 8) for (let dx = -24; dx <= 24; dx += 8) if (w.treeAt(v.x + dx, v.z + dz)) t++; return t; })();
  console.log(`${name.padEnd(10)} x=${v.x} z=${v.z} h=${v.h} relief=${v.relief} trees(49x49)=${trees}`);
}

// densest woodland
let best = null;
for (let z = -RANGE; z <= RANGE; z += 96) {
  for (let x = -RANGE; x <= RANGE; x += 96) {
    const h = w.heightAt(x, z);
    if (w.biomeAt(x, z, h) !== 3) continue;
    let t = 0;
    for (let dz = -32; dz <= 32; dz += 8) for (let dx = -32; dx <= 32; dx += 8) if (w.treeAt(x + dx, z + dz)) t++;
    if (!best || t > best.t) best = { x, z, t };
  }
}
console.log('woodland  ', JSON.stringify(best));

// a lake/sea spot to stand in water
let deep = null;
for (let z = -RANGE; z <= RANGE && !deep; z += STEP) {
  for (let x = -RANGE; x <= RANGE; x += STEP) {
    const h = w.heightAt(x, z);
    if (w.biomeAt(x, z, h) === 0 && h < SEA_LEVEL - 5) { deep = { x, z, h: Math.round(h) }; break; }
  }
}
console.log('deep water ', JSON.stringify(deep));
void CHUNK_Y;
