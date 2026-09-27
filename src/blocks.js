// Block registry + procedurally painted pixel-art textures (16x16 per layer).
// Textures are uploaded as a WebGL2 texture array, so every face gets its own
// layer index with zero UV bleeding and mipmaps still work.

import * as THREE from '../vendor/three.module.js';
import { makeRng } from './noise.js';

export const TILE = 16;

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const LOG = 5;
export const LEAVES = 6;
export const PLANKS = 7;
export const BRICK = 8;
export const GLASS = 9;
export const WATER = 10;
export const SNOW = 11;
export const COBBLE = 12;
export const BEDROCK = 13;
export const GRAVEL = 14;
export const BLOCK_COUNT = 15;

// face order: +X, -X, +Y, -Y, +Z, -Z
const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const layerOf = {};

function def(id, name, opts) {
  const o = Object.assign({
    name,
    solid: true,
    opaque: true,
    liquid: false,
    transparent: false,
    hardness: 1,
    tint: null,        // per-vertex colour multiplier applied to every face
    tintFaces: null,   // { face: [r,g,b] } overrides `tint` for single faces
    faceLayers: null,  // { face: layerName }; defaults to a single `all` layer
    sounds: true,
  }, opts);
  if (!o.faceLayers) o.faceLayers = { all: name };
  o.id = id;
  o.label = name.charAt(0).toUpperCase() + name.slice(1);
  blocks[id] = o;
  return o;
}

export const blocks = new Array(BLOCK_COUNT);

def(AIR, 'air', { solid: false, opaque: false, transparent: true });
def(GRASS, 'grass', {
  tintFaces: { py: [0.40, 0.80, 0.30] },
  faceLayers: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
});
def(DIRT, 'dirt', {});
def(STONE, 'stone', {});
def(SAND, 'sand', {});
def(LOG, 'log', { faceLayers: { top: 'log_top', bottom: 'log_top', side: 'log_side' } });
def(LEAVES, 'leaves', { opaque: false, transparent: true, tint: [0.82, 1.05, 0.66], faceLayers: { all: 'leaves' } });
def(PLANKS, 'planks', {});
def(BRICK, 'brick', {});
def(GLASS, 'glass', { opaque: false, transparent: true });
def(WATER, 'water', {
  solid: false, opaque: false, liquid: true, transparent: true, hardness: Infinity,
});
def(SNOW, 'snow', {});
def(COBBLE, 'cobblestone', {});
def(BEDROCK, 'bedrock', { hardness: Infinity });
def(GRAVEL, 'gravel', {});

export const WHITE = [1, 1, 1];
export const FACE_NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
export const isSolid = (id) => blocks[id].solid;
export const isOpaque = (id) => blocks[id].opaque;
export const isLiquid = (id) => blocks[id].liquid;
export const isTransparent = (id) => blocks[id].transparent;

// ---------------------------------------------------------------- textures

function newTile() {
  return { px: Array(TILE * TILE * 4), pxCount: 0 };
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function put(t, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
  const i = (y * TILE + x) * 4;
  t.px[i] = rgb[0]; t.px[i + 1] = rgb[1]; t.px[i + 2] = rgb[2]; t.px[i + 3] = a;
}

function get(t, x, y) {
  const i = (((y + TILE) % TILE) * TILE + ((x + TILE) % TILE)) * 4;
  return [t.px[i], t.px[i + 1], t.px[i + 2], t.px[i + 3]];
}

function fill(t, rgb) {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) put(t, x, y, rgb);
  return t;
}

/** speckled base: multiply each pixel by a random brightness in [min,max] */
function speckle(t, base, min, max, seed, density = 1) {
  const rnd = makeRng(seed);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (density < 1 && rnd() > density) { put(t, x, y, base); continue; }
      const k = min + rnd() * (max - min);
      put(t, x, y, [base[0] * k, base[1] * k, base[2] * k], 255);
    }
  }
  return t;
}

const painters = {
  // grass textures are painted greyscale: the per-block tint in the mesher
  // supplies the green, exactly like a biome-coloured vanilla grass block.
  grass_top(t) {
    speckle(t, [188, 188, 188], 0.86, 1.1, 11, 1);
    const rnd = makeRng(77);
    for (let i = 0; i < 30; i++) {
      const x = Math.floor(rnd() * TILE), y = Math.floor(rnd() * TILE);
      const c = get(t, x, y);
      const k = rnd() < 0.5 ? 0.86 : 1.06;
      put(t, x, y, [c[0] * k, c[1] * k, c[2] * k]);
    }
  },
  // painted in real colours: only the top face of a grass block is tinted,
  // so the dirt part of the side texture keeps its brown
  grass_side(t) {
    speckle(t, [134, 96, 67], 0.86, 1.1, 12);
    const rnd = makeRng(303);
    for (let x = 0; x < TILE; x++) {
      const h = 3 + Math.floor(rnd() * 3);
      for (let y = 0; y < h; y++) {
        const k = 0.8 + rnd() * 0.4;
        put(t, x, y, [75 * k, 150 * k, 56 * k]);
      }
      const c = get(t, x, h);
      put(t, x, h, [c[0] * 0.62, c[1] * 0.6, c[2] * 0.58]);
    }
  },
  dirt(t) { speckle(t, [134, 96, 67], 0.85, 1.12, 13); },
  stone(t) {
    speckle(t, [128, 128, 132], 0.85, 1.1, 14);
    const rnd = makeRng(414);
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rnd() * TILE), y = Math.floor(rnd() * TILE);
      const w = 2 + Math.floor(rnd() * 3), h = 1 + Math.floor(rnd() * 2);
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        const c = get(t, x + dx, y + dy);
        put(t, x + dx, y + dy, [c[0] * 0.9, c[1] * 0.9, c[2] * 0.92]);
      }
    }
  },
  cobblestone(t) {
    fill(t, [118, 118, 122]);
    const rnd = makeRng(515);
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(rnd() * TILE), y = Math.floor(rnd() * TILE);
      const w = 2 + Math.floor(rnd() * 3), h = 2 + Math.floor(rnd() * 3);
      const k = 0.78 + rnd() * 0.4;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        const c = get(t, x + dx, y + dy);
        put(t, x + dx, y + dy, [c[0] * k, c[1] * k, c[2] * k]);
      }
    }
  },
  sand(t) { speckle(t, [204, 188, 138], 0.9, 1.08, 15); },
  gravel(t) {
    speckle(t, [136, 132, 128], 0.7, 1.2, 16);
    const rnd = makeRng(616);
    for (let i = 0; i < 18; i++) {
      const x = Math.floor(rnd() * TILE), y = Math.floor(rnd() * TILE);
      const c = [100 + rnd() * 90, 96 + rnd() * 90, 92 + rnd() * 90];
      put(t, x, y, c); put(t, x + 1, y, c);
    }
  },
  log_side(t) {
    speckle(t, [104, 78, 46], 0.86, 1.12, 17);
    const rnd = makeRng(717);
    for (let x = 0; x < TILE; x += 2 + Math.floor(rnd() * 2)) {
      for (let y = 0; y < TILE; y++) {
        const c = get(t, x, y);
        put(t, x, y, [c[0] * 0.78, c[1] * 0.78, c[2] * 0.78]);
      }
    }
  },
  log_top(t) {
    speckle(t, [172, 138, 90], 0.92, 1.06, 18);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 7.5 || Math.floor(d) % 2 === 1) {
        const c = get(t, x, y);
        put(t, x, y, [c[0] * 0.78, c[1] * 0.74, c[2] * 0.68]);
      }
    }
    const rnd = makeRng(818);
    for (let i = 0; i < 6; i++) {
      const x = 1 + Math.floor(rnd() * 5), y = 1 + Math.floor(rnd() * 5);
      const c = get(t, x, y);
      put(t, x, y, [c[0] * 0.68, c[1] * 0.64, c[2] * 0.58]);
    }
  },
  leaves(t) {
    const rnd = makeRng(19);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const k = 0.68 + rnd() * 0.5;
      const hole = rnd() < 0.14;
      put(t, x, y, [104 * k, 168 * k, 78 * k], hole ? 0 : 255);
    }
  },
  planks(t) {
    const rnd = makeRng(20);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const k = 0.9 + rnd() * 0.18;
      put(t, x, y, [176 * k, 138 * k, 86 * k]);
    }
    for (const y of [0, 5, 10, 15]) for (let x = 0; x < TILE; x++) {
      const c = get(t, x, y);
      put(t, x, y, [c[0] * 0.72, c[1] * 0.7, c[2] * 0.66]);
    }
    const knots = [[3, 3], [11, 8], [6, 13]];
    for (const [x, y] of knots) {
      const c = get(t, x, y);
      put(t, x, y, [c[0] * 0.75, c[1] * 0.7, c[2] * 0.62]);
      put(t, x + 1, y, [c[0] * 0.8, c[1] * 0.75, c[2] * 0.68]);
    }
  },
  brick(t) {
    fill(t, [178, 96, 76]);
    const rnd = makeRng(21);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const c = get(t, x, y);
      const k = 0.9 + rnd() * 0.18;
      put(t, x, y, [c[0] * k, c[1] * k, c[2] * k]);
    }
    const mortar = [214, 210, 202];
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = Math.floor(y / 4);
      const offset = (row % 2) * 4;
      if (y % 4 === 3 || (x + offset) % 8 === 7) put(t, x, y, mortar);
    }
  },
  // fully transparent pane with a frame: the cutout pass renders it, so you
  // really see through a window without paying for a sorting pass
  glass(t) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const edge = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
        const shine = (x + y === 7) || (x + y === 8) || (x === 4 && y === 9);
        if (edge) put(t, x, y, [198, 224, 232], 255);
        else if (shine) put(t, x, y, [240, 250, 252], 210);
        else put(t, x, y, [190, 216, 224], 0);
      }
    }
  },
  water(t) {
    // pure speckle: a regular pattern would moire badly across a large surface
    speckle(t, [78, 150, 224], 0.9, 1.08, 22);
    for (let i = 0; i < TILE * TILE; i++) {
      const j = i * 4;
      t.px[j + 3] = 205;
    }
  },
  snow(t) {
    speckle(t, [238, 242, 248], 0.94, 1.05, 23);
    const rnd = makeRng(2323);
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(rnd() * TILE), y = Math.floor(rnd() * TILE);
      const c = get(t, x, y);
      put(t, x, y, [c[0] * 0.95, c[1] * 0.96, c[2] * 1]);
    }
  },
  bedrock(t) {
    const rnd = makeRng(24);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const k = 0.35 + rnd() * 0.5;
      put(t, x, y, [80 * k, 80 * k, 86 * k]);
    }
  },
};

/** Build the array texture + layer index table. */
export function buildBlockAtlas() {
  const names = Object.keys(painters);
  const depth = names.length;
  names.forEach((n, i) => { layerOf[n] = i; });

  const data = new Uint8Array(TILE * TILE * 4 * depth);
  names.forEach((n, i) => {
    const tile = newTile();
    painters[n](tile);
    data.set(tile.px, i * TILE * TILE * 4);
  });

  const tex = new THREE.DataArrayTexture(data, TILE, TILE, depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  return { texture: tex, layerOf, names, data };
}

export const HOTBAR_BLOCKS = [
  GRASS, DIRT, STONE, COBBLE, SAND, LOG, PLANKS, LEAVES, GLASS, BRICK, SNOW, GRAVEL,
];

/** Resolve a face to its atlas layer index. */
export function layerForBlockFace(id, faceIndex) {
  return layerForBlockFaceName(id, faces[faceIndex]);
}

export function layerForBlockFaceName(id, face) {
  const b = blocks[id];
  const f = b.faceLayers;
  let key;
  if (face === 'py') key = f.top || f.all || b.name;
  else if (face === 'ny') key = f.bottom || f.top || f.all || b.name;
  else key = f[face] || f.side || f.all || b.name;
  const layer = layerOf[key];
  if (layer === undefined) throw new Error(`block ${b.name} face ${face}: no atlas layer "${key}"`);
  return layer;
}

/** Per-face vertex-colour multiplier. */
export function tintForBlockFace(id, face) {
  const b = blocks[id];
  if (b.tintFaces && b.tintFaces[face]) return b.tintFaces[face];
  return b.tint || WHITE;
}
