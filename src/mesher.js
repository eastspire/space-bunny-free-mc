// Per-chunk meshing: face culling, baked ambient occlusion, texture-array layers.
// Emits up to three geometries per chunk: solid, cutout (leaves/glass), water.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, WATER, LEAVES, GLASS, isOpaque, blocks, layerForBlockFace, tintForBlockFace,
  FACE_NAMES, TILE,
} from './blocks.js';
import { CHUNK_X, CHUNK_Y, CHUNK_Z, chunkKey, idx } from './world.js';

// Faces are described by an origin plus two in-plane axes chosen so that
// a x b === n. Corners then follow the cycle (0,0) -> (1,0) -> (1,1) -> (0,1),
// which keeps every triangle wound counter-clockwise seen from outside.
// faceIndex: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z
const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0], o: [1, 0, 1] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0], o: [0, 0, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1], o: [0, 1, 1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1], o: [0, 0, 0] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], o: [0, 0, 1] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0], o: [1, 0, 0] },
];

// unit-square coordinates of the four corners, in cycle order
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

function faceCorners(f) {
  return CORNER_UV.map(([u, v]) => [
    f.o[0] + f.a[0] * u + f.b[0] * v,
    f.o[1] + f.a[1] * u + f.b[1] * v,
    f.o[2] + f.a[2] * u + f.b[2] * v,
  ]);
}

// [normal, +a, -a, +b, -b]
function faceTaps(f) {
  const neg = (v) => [-v[0], -v[1], -v[2]];
  return [f.n, f.a, neg(f.a), f.b, neg(f.b)];
}

const FACE_CORNERS = FACES.map(faceCorners);
const FACE_TAPS = FACES.map(faceTaps);

const CUTOUT_IDS = new Set([LEAVES, GLASS]);

function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(0), 2));
  g.setAttribute('aLayer', new THREE.BufferAttribute(new Float32Array(0), 1));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
  return g;
}

class MeshBuffer {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.lay = []; this.col = []; this.idx = [];
    this.v = 0;
  }

  quad(p0, p1, p2, p3, n, uvs, layer, ao, tint) {
    const { pos, nor, uv, lay, col, idx: index } = this;
    const pts = [p0, p1, p2, p3];
    for (let i = 0; i < 4; i++) {
      pos.push(pts[i][0], pts[i][1], pts[i][2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(uvs[i][0], uvs[i][1]);
      lay.push(layer);
      const s = ao[i];
      col.push(s * tint[0], s * tint[1], s * tint[2]);
    }
    // Flip the quad diagonal when AO would otherwise crease the wrong way.
    // Both variants must keep the same winding, or the face turns inside out.
    if (ao[0] + ao[2] > ao[1] + ao[3]) {
      index.push(this.v + 1, this.v + 2, this.v + 3, this.v + 1, this.v + 3, this.v);
    } else {
      index.push(this.v, this.v + 1, this.v + 2, this.v, this.v + 2, this.v + 3);
    }
    this.v += 4;
  }

  isEmpty() { return this.idx.length === 0; }

  toGeometry() {
    if (this.isEmpty()) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aLayer', new THREE.BufferAttribute(new Float32Array(this.lay), 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Standard 3-neighbour vertex AO (0..1). */
function vertexAO(side1, side2, corner) {
  if (side1 && side2) return 0.38;
  return 1 - (0.22 * (3 - (side1 + side2 + corner)) / 3 + 0.22);
}

const AO_LEVELS = [0.58, 0.72, 0.87, 1.0];

/**
 * Build the three geometries for a chunk. Neighbour chunks are generated on
 * demand so seam faces are culled correctly.
 */
export function buildChunkGeometries(world, chunk) {
  const solid = new MeshBuffer();
  const cutout = new MeshBuffer();
  const water = new MeshBuffer();
  const ox = chunk.cx * CHUNK_X, oz = chunk.cz * CHUNK_Z;

  const solidAt = (x, y, z) => {
    if (y < 0) return true;              // treat below-world as solid: no bottom faces
    if (y >= CHUNK_Y) return false;
    return isOpaque(world.getBlock(ox + x, y, oz + z));
  };

  // per-vertex ambient occlusion from the three neighbours around each corner
  const T = 0, A_POS = 1, A_NEG = 2, B_POS = 3, B_NEG = 4;

  for (let y = 0; y < CHUNK_Y; y++) {
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const id = chunk.blocks[idx(x, y, z)];
        if (id === AIR) continue;
        const def = blocks[id];
        const target = def.liquid ? water : CUTOUT_IDS.has(id) ? cutout : solid;
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
          const nid = ny < 0 || ny >= CHUNK_Y ? (ny < 0 ? id : AIR) : world.getBlock(ox + nx, ny, oz + nz);
          if (def.liquid) {
            if (nid === id || isOpaque(nid)) continue;
            if (f === 3) continue;                       // no water undersides
          } else if (CUTOUT_IDS.has(id)) {
            if (nid === id) continue;                   // merge glass panes / leaf blobs
            if (isOpaque(nid)) continue;
          } else {
            if (isOpaque(nid)) continue;
          }
          const layer = layerForBlockFace(id, f);
          const tint = tintForBlockFace(id, FACE_NAMES[f]);
          const taps = FACE_TAPS[f];
          const ao = [0, 0, 0, 0];
          for (let v = 0; v < 4; v++) {
            const [cu, cv] = CORNER_UV[v];
            const ta = taps[cu ? A_NEG : A_POS];
            const tb = taps[cv ? B_NEG : B_POS];
            const corner = [ta[0] + tb[0], ta[1] + tb[1], ta[2] + tb[2]];
            const s1 = solidAt(x + ta[0], y + ta[1], z + ta[2]);
            const s2 = solidAt(x + tb[0], y + tb[1], z + tb[2]);
            const s3 = solidAt(x + corner[0], y + corner[1], z + corner[2]);
            const level = vertexAO(s1 ? 1 : 0, s2 ? 1 : 0, s3 ? 1 : 0);
            ao[v] = AO_LEVELS[Math.round((1 - level) * 3)];
          }
          const px = ox + x, pz = oz + z;
          const corners = FACE_CORNERS[f];
          const p = [null, null, null, null];
          for (let v = 0; v < 4; v++) {
            const c = corners[v];
            p[v] = [px + c[0], y + c[1], pz + c[2]];
          }
          const n = FACES[f].n;
          if (def.liquid) {
            // top face sits slightly lower for a liquid surface read
            for (let v = 0; v < 4; v++) if (corners[v][1] === 1) p[v][1] -= 0.12;
            target.quad(p[0], p[1], p[2], p[3], n, CORNER_UV, layer, [1, 1, 1, 1], [0.78, 0.92, 1.0]);
          } else {
            target.quad(p[0], p[1], p[2], p[3], n, CORNER_UV, layer, ao, tint);
          }
        }
      }
    }
  }

  return { solid, cutout, water };
}

export function makeAtlasMaterial(atlasTexture, params, key) {
  const mat = new THREE.MeshLambertMaterial(Object.assign({ map: atlasTexture, vertexColors: true }, params));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlasTexture };
    shader.vertexShader = `
attribute float aLayer;
varying float vLayer;
` + shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n  vLayer = aLayer;',
    );
    shader.fragmentShader = `
uniform sampler2DArray uAtlas;
varying float vLayer;
` + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
#ifdef USE_MAP
  diffuseColor *= texture( uAtlas, vec3( vMapUv, vLayer ) );
#endif
`,
    );
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export function makeChunkMaterials(atlasTexture) {
  const solid = makeAtlasMaterial(atlasTexture, {}, 'solid');
  const cutout = makeAtlasMaterial(atlasTexture, {
    alphaTest: 0.35, side: THREE.DoubleSide,
  }, 'cutout');
  const water = makeAtlasMaterial(atlasTexture, {
    transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
    emissive: 0x16324f, emissiveIntensity: 1,
  }, 'water');
  return { solid, cutout, water };
}

export { emptyGeometry, TILE };
