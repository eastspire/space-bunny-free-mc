import { World } from '../src/world.js';
import { noise2, fbm2 } from '../src/noise.js';

console.log('--- noise2 range over a 64x64 grid (expect roughly -1..1) ---');
let mn = 9, mx = -9, sum = 0, n = 0;
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const v = noise2(x * 0.37, y * 0.37);
  mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; n++;
}
console.log(`min ${mn.toFixed(3)} max ${mx.toFixed(3)} mean ${(sum / n).toFixed(3)}`);

console.log('--- fbm2 range ---');
mn = 9; mx = -9;
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const v = fbm2(x * 0.008, y * 0.008, 4);
  mn = Math.min(mn, v); mx = Math.max(mx, v);
}
console.log(`min ${mn.toFixed(3)} max ${mx.toFixed(3)}`);

const w = new World(20260927);
console.log('--- heightAt 32x32 (x: 0..31, z: 0..31) ---');
for (let z = 0; z < 32; z += 2) {
  let row = '';
  for (let x = 0; x < 32; x++) row += String(Math.round(w.heightAt(x, z))).padStart(4);
  console.log(row);
}
console.log('--- cave hit ratio per y (32x32 columns) ---');
for (let y = 2; y < 34; y += 2) {
  let hits = 0, tot = 0;
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { tot++; if (w.caveAt(x, y, z)) hits++; }
  console.log(`y=${y} ${((hits / tot) * 100).toFixed(1)}%`);
}
console.log('--- biome counts 32x32 ---');
const b = {};
for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
  const n2 = w.biomeNameAt(x, z);
  b[n2] = (b[n2] || 0) + 1;
}
console.log(b);
console.log('--- tree count 64x64 ---');
let trees = 0;
for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) if (w.treeAt(x, z)) trees++;
console.log(trees);
