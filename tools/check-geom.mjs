// Geometry sanity check: build chunk (0,0) headlessly and validate every
// triangle is a flat axis-aligned unit-cube face.

import { World, CHUNK_X, CHUNK_Y, CHUNK_Z, chunkKey } from '../src/world.js';
import { buildChunkGeometries } from '../src/mesher.js';
import { buildBlockAtlas } from '../src/blocks.js';

buildBlockAtlas();   // populates the layer lookup table

const world = new World(20260927);
for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) world.ensureChunk(cx, cz);
const c = world.chunks.get(chunkKey(0, 0));
console.log('chunk blocks generated:', c.blocks.length);

for (const [name, buf] of Object.entries(buildChunkGeometries(world, c))) {
  const P = buf.pos, I = buf.idx, N = buf.nor, L = buf.lay, C = buf.col;
  const badAttrs = [...L, ...N, ...C].filter((v) => !Number.isFinite(v)).length;
  console.log(`  non-finite attribute values: ${badAttrs}`);
  if (badAttrs) process.exitCode = 1;
  const vcount = P.length / 3;
  console.log(`\n--- ${name}: ${vcount} verts, ${I.length / 3} tris`);
  let bad = 0, badWinding = 0, nonFinite = 0;
  const samples = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
    const v = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[d], P[d + 1], P[d + 2]];
    if (v.some((n) => !Number.isFinite(n))) { nonFinite++; continue; }
    const e1 = [v[3] - v[0], v[4] - v[1], v[5] - v[2]];
    const e2 = [v[6] - v[0], v[7] - v[1], v[8] - v[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    if (len < 0.5) { bad++; if (samples.length < 3) samples.push({ t: t / 3, v }); continue; }
    const u = n.map((x) => x / len);
    const nn = c.blocks && null;
    // expected normal must be one of the 6 axis directions
    const axis = u.filter((x) => Math.abs(x) > 0.9).length;
    if (axis !== 1) { bad++; if (samples.length < 6) samples.push({ t: t / 3, v, u }); }
    // outward-facing: compare against the face normal stored in the attribute
    const gn = [I[t] * 3 + 0, I[t] * 3 + 1, I[t] * 3 + 2];
    const stored = N.slice(gn[0] - 0, gn[0] + 3);
    if (u[0] * stored[0] + u[1] * stored[1] + u[2] * stored[2] < 0.9) {
      badWinding++;
      if (samples.length < 12) samples.push({ t: t / 3, v, u, stored });
    }
    // vertex spread must fit inside one block
    const mn = [0, 1, 2].map((k) => Math.min(v[k], v[3 + k], v[6 + k]));
    const mx = [0, 1, 2].map((k) => Math.max(v[k], v[3 + k], v[6 + k]));
    const spread = [0, 1, 2].map((k) => mx[k] - mn[k]);
    if (spread.some((s) => s > 1.001)) { bad++; if (samples.length < 9) samples.push({ t: t / 3, v, spread }); }
    void nn;
  }
  console.log(`  bad=${bad} nonFinite=${nonFinite} badWinding=${badWinding}`);
  if (samples.length) console.log('  samples', JSON.stringify(samples).slice(0, 1200));
}

// cross-chunk consistency: no block face may be emitted twice
console.log('\n=== duplicate face check across 3x3 chunks ===');
const faces = new Set();
let dupCount = 0;
const dupSamples = [];
for (const c2 of [...world.chunks.values()]) {
  for (const buf of Object.values(buildChunkGeometries(world, c2))) {
    const P = buf.pos, I = buf.idx, N = buf.nor, L = buf.lay, C = buf.col;
  const badAttrs = [...L, ...N, ...C].filter((v) => !Number.isFinite(v)).length;
  console.log(`  non-finite attribute values: ${badAttrs}`);
  if (badAttrs) process.exitCode = 1;
    for (let t = 0; t < I.length; t += 6) {
      const corners = [0, 1, 2, 3, 4, 5].map((d) => I[t + d] * 3);
      const b = corners[0];
      const n = [N[b], N[b + 1], N[b + 2]];
      const k = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
      const o1 = (k + 1) % 3, o2 = (k + 2) % 3;
      const mn = (axis) => Math.min(...corners.map((o) => P[o + axis]));
      const real = `${k}${Math.sign(n[k]) > 0 ? '+' : '-'}:${P[b + k]}|${mn(o1)},${mn(o2)}`;
      if (faces.has(real)) { dupCount++; if (dupSamples.length < 5) dupSamples.push(real); }
      faces.add(real);
    }
  }
}
console.log(`  duplicate faces: ${dupCount}`, JSON.stringify(dupSamples));
console.log(`  total quads: ${faces.size}`);
