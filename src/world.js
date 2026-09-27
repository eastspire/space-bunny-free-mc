// Chunked voxel world: deterministic terrain, caves, ores, biomes, trees, water.

import {
  AIR, GRASS, DIRT, STONE, SAND, LOG, LEAVES, WATER, SNOW, COBBLE, BEDROCK, GRAVEL,
  BLOCK_COUNT, isOpaque, blocks,
} from './blocks.js';
import { fbm2, noise2, buildPermutation, makeRng, clamp, smoothstep, lerp } from './noise.js';

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const CHUNK_Y = 96;
export const SEA_LEVEL = 26;
const CHUNK_VOL = CHUNK_X * CHUNK_Y * CHUNK_Z;

export const chunkKey = (cx, cz) => `${cx},${cz}`;

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, MOUNTAIN: 4, DESERT: 5, TUNDRA: 6,
};
export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Mountains', 'Desert', 'Tundra'];

export const idx = (x, y, z) => x + z * CHUNK_X + y * CHUNK_X * CHUNK_Z;

export class World {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    buildPermutation(this.seed);
    this.chunks = new Map();
    this.edits = new Map();     // global edit log so meshing neighbours stay correct
    this.generated = new Set();
    this.pending = [];
  }

  // ------------------------------------------------------------ generation

  heightAt(wx, wz) {
    const c = fbm2(wx * 0.0016, wz * 0.0016, 4) * 1.0;          // continents
    const h = fbm2(wx * 0.008, wz * 0.008, 4) * 0.55;           // hills
    const d = fbm2(wx * 0.03, wz * 0.03, 2) * 0.16;             // detail
    const ridge = Math.pow(Math.abs(fbm2(wx * 0.0034, wz * 0.0034, 4)), 2.3);
    const mountainMask = smoothstep(0.2, 0.5, fbm2(wx * 0.0009 + 91.3, wz * 0.0009 - 44.1, 2));
    const rough = fbm2(wx * 0.021, wz * 0.021, 3) * 2.6;   // breaks up flat plateaus
    let base = SEA_LEVEL + 2 + c * 14 + h * 9 + d * 3 + rough;
    // Ridges: add a sharpened crest term so summits stay pointed. The old hard
    // `min(30, ...)` cap flattened every tall peak into the same mesa, because
    // anything over the cap landed on exactly the same height.
    const crest = ridge * ridge * (0.55 + 0.45 * Math.abs(rough) / 2.6);
    base += mountainMask * (ridge * 96 + crest * 54);
    // Soft ceiling: squash asymptotically below the world height so peaks stay
    // pointy instead of clipping flat against the top of the world.
    if (base > 52) base = 52 + (CHUNK_Y - 8 - 52) * (1 - Math.exp(-(base - 52) / 16));
    return Math.min(base, CHUNK_Y - 4);
  }

  temperatureAt(wx, wz) {
    return fbm2(wx * 0.00055 + 311.7, wz * 0.00055 - 88.2, 3);
  }

  humidityAt(wx, wz) {
    return fbm2(wx * 0.00085 - 512.4, wz * 0.00085 + 233.9, 3);
  }

  biomeAt(wx, wz, h = null) {
    const height = h === null ? this.heightAt(wx, wz) : h;
    if (height < SEA_LEVEL - 1.5) return BIOME.OCEAN;
    if (height < SEA_LEVEL + 1.6) return BIOME.BEACH;
    if (height > SEA_LEVEL + 20) return BIOME.MOUNTAIN;
    const temp = this.temperatureAt(wx, wz);
    const hum = this.humidityAt(wx, wz);
    if (temp > 0.28 && hum < -0.02) return BIOME.DESERT;
    if (temp < -0.26) return BIOME.TUNDRA;
    if (hum > 0.08) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  caveAt(wx, wy, wz) {
    if (wy < 2 || wy > CHUNK_Y - 10) return false;
    const a = noise2(wx * 0.055 + 5.5, (wy * 0.09) + wz * 0.055 - 2.2);
    const b = noise2(wx * 0.055 - 17.1, (wy * 0.09) - wz * 0.055 + 9.4);
    const tunnel = a * a + b * b;
    const depthBias = smoothstep(4, 18, wy);       // fewer caves near the surface
    return tunnel < 0.0135 + 0.016 * (1 - depthBias);
  }

  oreAt(wx, wy, wz) {
    if (wy < 2) return AIR;
    if (noise2(wx * 0.14, (wy * 0.5 + wz) * 0.14) > 0.78) return COBBLE;
    if (wy < 24 && noise2(wx * 0.19 + 700, (wy * 0.6 - wz) * 0.19) > 0.86) return GRAVEL;
    return AIR;
  }

  /** Deterministic 0..1 hash for a column, used to place trees / cacti. */
  columnRnd(wx, wz, salt) {
    let h = (wx * 374761393 + wz * 668265263 + salt * 2147483647 + this.seed) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
  }

  treeAt(wx, wz) {
    const h = this.heightAt(wx, wz);
    if (h < SEA_LEVEL + 1.4 || h > SEA_LEVEL + 20) return null;
    const biome = this.biomeAt(wx, wz, h);
    const density = biome === BIOME.FOREST ? 0.062
      : biome === BIOME.PLAINS ? 0.014
        : biome === BIOME.TUNDRA ? 0.04 : 0;
    if (this.columnRnd(wx, wz, 7) > density) return null;
    if (fbm2(wx * 0.021, wz * 0.021, 2) > 0.34) return null;          // clearings
    const r = this.columnRnd(wx, wz, 11);
    return { trunk: 4 + Math.floor(r * 3), spruce: biome === BIOME.TUNDRA || biome === BIOME.MOUNTAIN };
  }

  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (c) return c;
    c = { cx, cz, blocks: new Uint8Array(CHUNK_VOL), mesh: null, waterMesh: null, dirty: true };
    this.chunks.set(key, c);
    if (!this.generated.has(key)) {
      this.generate(c);
      this.generated.add(key);
      this.flushPending();
    }
    return c;
  }

  /**
   * Cross-chunk writes (tree canopies) are queued while a neighbour is still
   * being generated, then replayed once that neighbour finishes its own pass.
   */
  routeWrite(wx, wy, wz, id) {
    if (wy < 0 || wy >= CHUNK_Y) return;
    const cx = Math.floor(wx / CHUNK_X), cz = Math.floor(wz / CHUNK_Z);
    const key = chunkKey(cx, cz);
    const target = this.chunks.get(key);
    if (target && this.generated.has(key)) {
      const i = idx(wx - cx * CHUNK_X, wy, wz - cz * CHUNK_Z);
      if (target.blocks[i] === AIR) target.blocks[i] = id;
      target.dirty = true;
    } else if (this.pending.length < 400000) {
      this.pending.push(wx, wy, wz, id);
    }
  }

  flushPending() {
    if (!this.pending.length) return;
    const q = this.pending;
    this.pending = [];
    for (let i = 0; i < q.length; i += 4) this.routeWrite(q[i], q[i + 1], q[i + 2], q[i + 3]);
  }

  generate(c) {
    const { cx, cz, blocks: data } = c;
    const ox = cx * CHUNK_X, oz = cz * CHUNK_Z;
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = ox + x, wz = oz + z;
        const h = Math.floor(this.heightAt(wx, wz));
        const biome = this.biomeAt(wx, wz, h);
        for (let y = 0; y < CHUNK_Y; y++) {
          let id = AIR;
          if (y === 0) id = BEDROCK;
          else if (y <= h) {
            if (this.caveAt(wx, y, wz) && y > 1 && y < h - 3) {
              id = AIR;
            } else if (y === h) {
              id = this.surfaceBlock(biome, h);
            } else if (y > h - 4) {
              id = this.subsurfaceBlock(biome, h);
            } else {
              id = this.oreAt(wx, y, wz) || STONE;
            }
          } else if (y <= SEA_LEVEL) {
            id = WATER;
          }
          data[idx(x, y, z)] = id;
        }
      }
    }
    this.decorate(c);
    this.applyEdits(c);
  }

  surfaceBlock(biome, h) {
    switch (biome) {
      case BIOME.OCEAN: return h < SEA_LEVEL - 4 ? GRAVEL : SAND;
      case BIOME.BEACH: return SAND;
      case BIOME.DESERT: return SAND;
      case BIOME.MOUNTAIN: return h > SEA_LEVEL + 30 ? SNOW : h > SEA_LEVEL + 24 ? STONE : COBBLE;
      case BIOME.TUNDRA: return h > SEA_LEVEL + 20 ? SNOW : GRASS;
      default: return GRASS;
    }
  }

  subsurfaceBlock(biome, h) {
    if (biome === BIOME.DESERT || biome === BIOME.BEACH || biome === BIOME.OCEAN) return SAND;
    if (biome === BIOME.MOUNTAIN && h > SEA_LEVEL + 24) return STONE;
    return DIRT;
  }

  /** Trees / boulders that may spill into neighbouring chunks. */
  decorate(c) {
    const { cx, cz, blocks: data } = c;
    const ox = cx * CHUNK_X, oz = cz * CHUNK_Z;
    const put = (x, y, z, id) => {
      if (x < 0 || z < 0 || x >= CHUNK_X || z >= CHUNK_Z || y < 0 || y >= CHUNK_Y) return;
      const i = idx(x, y, z);
      if (data[i] === AIR) data[i] = id;
    };
    const spill = (x, y, z, id) => {
      if (x < -4 || z < -4 || x > CHUNK_X + 3 || z > CHUNK_Z + 3 || y < 0 || y >= CHUNK_Y) return;
      if (x >= 0 && z >= 0 && x < CHUNK_X && z < CHUNK_Z) return;   // already written locally
      this.routeWrite(cx * CHUNK_X + x, y, cz * CHUNK_Z + z, id);
    };
    const putFn = (x, y, z, id) => { put(x, y, z, id); spill(x, y, z, id); };
    for (let z = -3; z < CHUNK_Z + 3; z++) {
      for (let x = -3; x < CHUNK_X + 3; x++) {
        const wx = ox + x, wz = oz + z;
        const tree = this.treeAt(wx, wz);
        if (!tree) continue;
        const h = Math.floor(this.heightAt(wx, wz));
        if (h < SEA_LEVEL + 1 || h >= CHUNK_Y - 12) continue;
        this.stampTree(x, h + 1, z, tree, putFn);
      }
    }
  }

  stampTree(x, y, z, tree, putFn) {
    const { trunk, spruce } = tree;
    for (let i = 0; i < trunk; i++) putFn(x, y + i, z, LOG);
    if (spruce) {
      for (let layer = 0; layer < 3; layer++) {
        const r = 2 - layer;
        const ly = y + trunk - 2 + layer;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && (layer !== 1 || r < 2)) continue;
          putFn(x + dx, ly, z + dz, LEAVES);
          putFn(x + dx, ly + 1, z + dz, LEAVES);
        }
      }
      putFn(x, y + trunk + 1, z, LEAVES);
    } else {
      // broadleaf: two 5x5 layers, a 3x3 cap and a plus-shaped tip
      const top = y + trunk - 1;
      for (const [dy, r, cut] of [[-2, 2, true], [-1, 2, true], [0, 1, false], [1, 0, false]]) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (cut && Math.abs(dx) === r && Math.abs(dz) === r) continue;
            if (r === 0) {
              if (Math.abs(dx) + Math.abs(dz) > 1) continue;
            }
            if (dx === 0 && dz === 0 && dy < 1) continue;
            putFn(x + dx, top + dy, z + dz, LEAVES);
          }
        }
      }
    }
  }

  // ----------------------------------------------------------- edit replay

  setBlock(wx, wy, wz, id) {
    const key = `${Math.floor(wx / CHUNK_X)},${Math.floor(wz / CHUNK_Z)}`;
    const c = this.ensureChunk(Math.floor(wx / CHUNK_X), Math.floor(wz / CHUNK_Z));
    const lx = wx - c.cx * CHUNK_X, lz = wz - c.cz * CHUNK_Z;
    if (wy < 0 || wy >= CHUNK_Y) return false;
    const i = idx(lx, wy, lz);
    if (c.blocks[i] === id) return false;
    c.blocks[i] = id;
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(i, id);
    this.markDirtyAround(wx, wy, wz);
    return true;
  }

  applyEdits(c) {
    const e = this.edits.get(chunkKey(c.cx, c.cz));
    if (!e) return;
    for (const [i, id] of e) c.blocks[i] = id;
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_Y) return AIR;
    const cx = Math.floor(wx / CHUNK_X), cz = Math.floor(wz / CHUNK_Z);
    const c = this.ensureChunk(cx, cz);
    return c.blocks[idx(wx - cx * CHUNK_X, wy, wz - cz * CHUNK_Z)];
  }

  /** True when the column is unloaded. */
  isLoaded(wx, wz) {
    return this.chunks.has(chunkKey(Math.floor(wx / CHUNK_X), Math.floor(wz / CHUNK_Z)));
  }

  isTransparentTo(wx, wy, wz) {
    const id = this.getBlock(wx, wy, wz);
    if (id === AIR) return true;
    return !isOpaque(id);
  }

  markDirtyAround(wx, wy, wz) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) continue;
          const cx = Math.floor((wx + dx) / CHUNK_X), cz = Math.floor((wz + dz) / CHUNK_Z);
          const c = this.chunks.get(chunkKey(cx, cz));
          if (c) c.dirty = true;
        }
      }
    }
  }

  /** Highest non-air block y at a column (or -1). */
  surfaceY(wx, wz) {
    for (let y = CHUNK_Y - 1; y >= 0; y--) {
      const id = this.getBlock(wx, y, wz);
      if (id !== AIR && id !== WATER) return y;
    }
    return -1;
  }

  biomeNameAt(wx, wz) {
    return BIOME_NAMES[this.biomeAt(wx, wz)];
  }
}

export { BLOCK_COUNT, isOpaque, blocks, CHUNK_VOL };
