// Entry point: renderer, sky, chunk streaming, input, interaction, game loop.

import * as THREE from '../vendor/three.module.js';
import {
  buildBlockAtlas, blocks, HOTBAR_BLOCKS, AIR, WATER, TILE, isSolid, layerForBlockFace,
  tintForBlockFace, FACE_NAMES,
} from './blocks.js';
import { World, CHUNK_X, CHUNK_Y, CHUNK_Z, SEA_LEVEL, chunkKey } from './world.js';
import { buildChunkGeometries, makeChunkMaterials, makeAtlasMaterial } from './mesher.js';
import { Player } from './player.js';
import { Hud, tintedTile } from './hud.js';
import { clamp, lerp, smoothstep } from './noise.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);

const SEED = num('seed', 20260927) | 0;
const RENDER_DIST = clamp(num('dist', 6), 2, 12);
const SPAWN_X = num('x', 1128);
const SPAWN_Z = num('z', 3672);
let FIXED_TIME = params.has('t') ? num('t', 0.3) : null;   // 0..1 day fraction
const AUTOROTATE = num('spin', 0) !== 0;
const NO_FOG = params.get('fog') === '0';
const NO_OVERLAY = params.get('overlay') === '0';

const DAY_LENGTH = 300;     // seconds for a full day/night cycle

// ---------------------------------------------------------------- renderer

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x88bbee);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, 1400);
scene.fog = NO_FOG ? null : new THREE.Fog(0x9cc7ee, RENDER_DIST * CHUNK_X * 0.72, RENDER_DIST * CHUNK_X * 1.15);

const atlas = buildBlockAtlas();
const materials = makeChunkMaterials(atlas.texture);

const world = new World(SEED);
const player = new Player(world, camera);

const hud = new Hud(document.getElementById('hud'), atlas, atlas.layerOf);
hud.selected = 0;

// ------------------------------------------------------------------- sky

const skyUniforms = {
  uTop: { value: new THREE.Color(0x3a76c8) },
  uMid: { value: new THREE.Color(0x9cc7ee) },
  uHorizon: { value: new THREE.Color(0xd9ecf7) },
  uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
  uNight: { value: 0 },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 20),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
    fragmentShader: `
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform float uNight;
varying vec3 vDir;
void main() {
  float h = clamp( vDir.y * 0.5 + 0.5, 0.0, 1.0 );
  vec3 col = mix( uHorizon, uMid, smoothstep( 0.42, 0.56, h ) );
  col = mix( col, uTop, smoothstep( 0.52, 0.95, h ) );
  // sun glow
  float d = max( dot( normalize( vDir ), normalize( uSunDir ) ), 0.0 );
  col += vec3( 1.0, 0.9, 0.7 ) * pow( d, 4200.0 ) * 3.0 * ( 1.0 - uNight );
  col += vec3( 1.0, 0.78, 0.5 ) * pow( d, 10.0 ) * 0.13 * ( 1.0 - uNight );
  // moon: opposite the sun, with a soft halo
  float m = max( dot( normalize( vDir ), -normalize( uSunDir ) ), 0.0 );
  col += vec3( 0.86, 0.9, 1.0 ) * pow( m, 5200.0 ) * 2.6 * uNight;
  col += vec3( 0.5, 0.6, 0.85 ) * pow( m, 26.0 ) * 0.10 * uNight;
  // stars
  vec3 cell = floor( vDir * 620.0 );
  float st = step( 0.9968, fract( sin( dot( cell, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) );
  col += vec3( 0.85, 0.9, 1.0 ) * st * uNight * smoothstep( 0.02, 0.35, vDir.y );
  gl_FragColor = vec4( col, 1.0 );
}`,
  }),
);
sky.frustumCulled = false;
scene.add(sky);

const sunLight = new THREE.DirectionalLight(0xfff3d6, 2.35);
scene.add(sunLight);
scene.add(sunLight.target);
const hemi = new THREE.HemisphereLight(0xc4dcff, 0x6a7a52, 1.25);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.2);
scene.add(ambient);

// drifting cloud layer
function cloudTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = Math.sin(x * 0.09) * Math.cos(y * 0.07) + Math.sin((x + y) * 0.05) * 0.8
        + Math.sin(x * 0.21 + y * 0.13) * 0.5;
      const a = clamp((n + 2.1) * 0.34, 0, 1);
      const edge = clamp(Math.min(Math.min(x, y), Math.min(S - 1 - x, S - 1 - y)) / 10, 0, 1);
      const i = (y * S + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(clamp(a, 0, 1) * 235 * edge);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
const cloudTex = new THREE.CanvasTexture(cloudTexture());
cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
cloudTex.repeat.set(9, 9);
const clouds = new THREE.Mesh(
  new THREE.PlaneGeometry(1600, 1600),
  new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.75, fog: false }),
);
clouds.rotation.x = -Math.PI / 2;
clouds.position.y = CHUNK_Y + 34;
clouds.frustumCulled = false;
scene.add(clouds);

// ------------------------------------------------------------ block hand

// The held block uses one small canvas texture per face: the shared
// texture-array material is only wired up for the chunk meshes.
const handMatCache = new Map();

// unlit so the held block stays readable in caves and at night; the face
// shading is baked straight into the little canvas textures instead
const HAND_FACE_SHADE = [0.72, 0.72, 1.0, 0.5, 0.86, 0.86];

function handMaterials(id) {
  if (handMatCache.has(id)) return handMatCache.get(id);
  const def = blocks[id];
  const mats = [];
  for (let f = 0; f < 6; f++) {
    const layer = layerForBlockFace(id, f);
    const k = HAND_FACE_SHADE[f];
    const tex = new THREE.CanvasTexture(tintedTile(atlas, layer, tintForBlockFace(id, FACE_NAMES[f]), k));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    mats.push(new THREE.MeshBasicMaterial({
      map: tex,
      alphaTest: def.transparent && !def.liquid ? 0.35 : 0,
      toneMapped: false,
    }));
  }
  handMatCache.set(id, mats);
  return mats;
}

function makeHandCube(id) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return geo;
}

function setHandBlock(id) {
  hand.geometry = makeHandCube(id);
  const mats = handMaterials(id);
  hand.material = mats;
  // a material array needs the box to keep its groups
  hand.geometry.clearGroups();
  for (let i = 0; i < 6; i++) hand.geometry.addGroup(i * 6, 6, i);
}

const hand = new THREE.Mesh(makeHandCube(HOTBAR_BLOCKS[0]), handMaterials(HOTBAR_BLOCKS[0]));
hand.scale.setScalar(0.14);
hand.position.set(0.56, -0.44, -0.76);
hand.rotation.set(0.16, -0.6, 0.08);
hand.frustumCulled = false;
hand.renderOrder = 999;
camera.add(hand);
scene.add(camera);

// selection box
const selection = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.55, depthTest: true }),
);
selection.visible = false;
scene.add(selection);

// break-progress overlay box
const crackBox = new THREE.Mesh(
  new THREE.BoxGeometry(1.04, 1.04, 1.04),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, wireframe: true, depthWrite: false }),
);
crackBox.visible = false;
scene.add(crackBox);

// ------------------------------------------------------------- particles

const PARTICLE_MAX = 320;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLE_MAX * 3), 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PARTICLE_MAX * 3), 3));
const pMat = new THREE.PointsMaterial({
  size: 0.14, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false,
});
const particles = new THREE.Points(pGeo, pMat);
particles.frustumCulled = false;
scene.add(particles);
const pState = Array.from({ length: PARTICLE_MAX }, () => ({ life: 0, vx: 0, vy: 0, vz: 0, x: 0, y: 0, z: 0 }));
let pCursor = 0;

function spawnParticles(x, y, z, id) {
  const def = blocks[id];
  const tint = def.tint || [1, 1, 1];
  const layer = layerForBlockFace(id, 2);
  const px = atlas.data.subarray(layer * TILE * TILE * 4, (layer + 1) * TILE * TILE * 4);
  for (let i = 0; i < 16; i++) {
    const j = pCursor;
    pCursor = (pCursor + 1) % PARTICLE_MAX;
    const s = pState[j];
    s.x = x + 0.12 + Math.random() * 0.76;
    s.y = y + 0.12 + Math.random() * 0.76;
    s.z = z + 0.12 + Math.random() * 0.76;
    s.vx = (Math.random() - 0.5) * 3.4;
    s.vy = 1.4 + Math.random() * 3.2;
    s.vz = (Math.random() - 0.5) * 3.4;
    s.life = 0.5 + Math.random() * 0.5;
    const o = (Math.random() * 255 | 0) * 4;
    pGeo.attributes.color.setXYZ(j,
      (px[o] / 255) * tint[0], (px[o + 1] / 255) * tint[1], (px[o + 2] / 255) * tint[2]);
  }
}

function updateParticles(dt) {
  const pa = pGeo.attributes.position.array;
  for (let i = 0; i < PARTICLE_MAX; i++) {
    const s = pState[i];
    if (s.life <= 0) { pa[i * 3 + 1] = -9999; continue; }
    s.life -= dt;
    s.vy -= 20 * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    pa[i * 3] = s.x; pa[i * 3 + 1] = s.y; pa[i * 3 + 2] = s.z;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------- chunk stream

const chunkGroup = new THREE.Group();
scene.add(chunkGroup);
let meshCount = 0, triCount = 0;

function disposeChunkMeshes(c) {
  for (const key of ['mesh', 'cutoutMesh', 'waterMesh']) {
    const m = c[key];
    if (m) {
      chunkGroup.remove(m);
      m.geometry.dispose();
      c[key] = null;
    }
  }
  c.dirty = false;
}

function meshChunk(c) {
  const built = buildChunkGeometries(world, c);
  disposeChunkMeshes(c);
  const g1 = built.solid.toGeometry();
  const g2 = built.cutout.toGeometry();
  const g3 = built.water.toGeometry();
  if (g1) { const m = new THREE.Mesh(g1, materials.solid); m.renderOrder = 0; chunkGroup.add(m); c.mesh = m; }
  if (g2) { const m = new THREE.Mesh(g2, materials.cutout); m.renderOrder = 1; chunkGroup.add(m); c.cutoutMesh = m; }
  if (g3) { const m = new THREE.Mesh(g3, materials.water); m.renderOrder = 2; chunkGroup.add(m); c.waterMesh = m; }
  c.dirty = false;
}

const wanted = new Set();
let genQueue = [];

function refreshWanted() {
  const pcx = Math.floor(player.pos.x / CHUNK_X);
  const pcz = Math.floor(player.pos.z / CHUNK_Z);
  wanted.clear();
  for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
    for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
      if (dx * dx + dz * dz > RENDER_DIST * RENDER_DIST + RENDER_DIST) continue;
      wanted.add(chunkKey(pcx + dx, pcz + dz));
    }
  }
  // unload far chunks
  const limit = (RENDER_DIST + 1.5) * (RENDER_DIST + 1.5);
  for (const [key, c] of world.chunks) {
    const dx = c.cx - pcx, dz = c.cz - pcz;
    if (dx * dx + dz * dz > limit) {
      disposeChunkMeshes(c);
      world.chunks.delete(key);
      world.generated.delete(key);
    }
  }
  genQueue = [];
  const missing = [];
  for (const key of wanted) {
    if (world.chunks.has(key)) continue;
    const [cx, cz] = key.split(',').map(Number);
    missing.push({ key, cx, cz, d: dx2(cx, cz, pcx, pcz) });
  }
  missing.sort((a, b) => a.d - b.d);
  genQueue = missing.map((m) => m.key);
}

const dx2 = (x, z, px, pz) => (x - px) ** 2 + (z - pz) ** 2;

function streamChunks(budgetMs) {
  const pcx = Math.floor(player.pos.x / CHUNK_X);
  const pcz = Math.floor(player.pos.z / CHUNK_Z);
  const t0 = performance.now();
  let generated = 0;
  while (genQueue.length && performance.now() - t0 < budgetMs) {
    const key = genQueue.shift();
    const [cx, cz] = key.split(',').map(Number);
    world.ensureChunk(cx, cz);
    generated++;
    if (generated >= 4) break;
  }
  // mesh the closest dirty chunks
  const dirty = [];
  for (const key of wanted) {
    const c = world.chunks.get(key);
    if (c && c.dirty) dirty.push(c);
  }
  dirty.sort((a, b) => dx2(a.cx, a.cz, pcx, pcz) - dx2(b.cx, b.cz, pcx, pcz));
  let meshed = 0;
  for (const c of dirty) {
    if (performance.now() - t0 > budgetMs) break;
    meshChunk(c);
    meshed++;
    if (meshed >= 3) break;
  }
  return { generated, meshed, pending: genQueue.length };
}

// ------------------------------------------------------------------ input

const keysDown = new Set();
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
let started = false;
let pointerLocked = false;
let breakTarget = null;
let breakProgress = 0;
let placeCooldown = 0;

function isTypingTarget(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
}

addEventListener('keydown', (e) => {
  if (isTypingTarget(e)) return;
  const code = e.code.toLowerCase();          // the movement set uses lower-case codes
  keysDown.add(code);
  player.keys = keysDown;
  if (code === 'keyf') {
    player.flying = !player.flying;
    player.vel.y = 0;
    toast(player.flying ? 'Flight enabled' : 'Flight disabled');
  }
  if (code === 'f3') { debugVisible = !debugVisible; e.preventDefault(); }
  if (code === 'f1') { document.getElementById('hud').classList.toggle('compact'); }
  const digits = ['digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9', 'digit0', 'minus', 'equal'];
  const n = digits.indexOf(code);
  if (n >= 0 && n < HOTBAR_BLOCKS.length) {
    hud.selected = n;
    hud.updateSelection();
    setHandBlock(HOTBAR_BLOCKS[n]);
  }
});
addEventListener('keyup', (e) => { keysDown.delete(e.code.toLowerCase()); player.keys = keysDown; });
addEventListener('blur', () => { keysDown.clear(); player.keys = keysDown; });

// Pointer lock is the intended control scheme, but it can be denied (embedded
// webviews, iframes without allow="pointer-lock", a user who dismissed the
// prompt). Track whether we are in "fallback" mode so the game stays playable:
// the overlay clears on start, look is driven by dragging, and the crosshair
// still aims via a plain screen-centred raycast.
let pointerLockUnavailable = false;
let dragging = false;

function enterGame() {
  started = true;
  requestLock();
  // If the lock has not engaged shortly after the click, fall back to
  // drag-to-look rather than leaving the player stuck behind the overlay.
  setTimeout(() => {
    if (!pointerLocked) {
      pointerLockUnavailable = true;
      overlay.classList.add('hidden');
    }
  }, 350);
}

addEventListener('mousemove', (e) => {
  if (pointerLocked) { player.look(e.movementX || 0, e.movementY || 0); return; }
  if (dragging) player.look(e.movementX || 0, e.movementY || 0);
});

canvas.addEventListener('mousedown', (e) => {
  if (!pointerLocked && !pointerLockUnavailable) { requestLock(); return; }
  if (!started) return;
  if (e.button === 0) {
    if (pointerLockUnavailable) dragging = true;
    breakTarget = player.raycast();
    breakProgress = 0;
  }
  if (e.button === 2 && placeCooldown <= 0) placeBlock();
  if (e.button === 1) {
    const hit = player.raycast(6);
    if (hit) hud.selected = Math.max(0, HOTBAR_BLOCKS.indexOf(hit.id));
    if (hud.selected >= 0) { hud.updateSelection(); setHandBlock(HOTBAR_BLOCKS[hud.selected]); }
  }
});
addEventListener('mouseup', (e) => {
  dragging = false;
  if (e.button === 0) { breakTarget = null; breakProgress = 0; }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

addEventListener('wheel', (e) => {
  if (!started) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  hud.selected = (hud.selected + dir + HOTBAR_BLOCKS.length) % HOTBAR_BLOCKS.length;
  hud.updateSelection();
  setHandBlock(HOTBAR_BLOCKS[hud.selected]);
}, { passive: true });

function lockFailed() {
  // The browser refused the lock: switch to the drag-to-look fallback instead
  // of leaving the player stuck on the overlay.
  pointerLockUnavailable = true;
  if (started) {
    overlay.classList.add('hidden');
    toast('Pointer lock unavailable — drag to look');
  }
}
function requestLock() {
  const retry = () => {
    try {
      const p2 = canvas.requestPointerLock();
      if (p2 && p2.catch) p2.catch(lockFailed);
    } catch { lockFailed(); }
  };
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(retry);
  } catch { retry(); }
}
document.addEventListener('pointerlockerror', lockFailed);
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (pointerLocked) { pointerLockUnavailable = false; overlay.classList.add('hidden'); }
  else if (started && !pointerLockUnavailable) overlay.classList.add('hidden');
  else overlay.classList.remove('hidden');
  if (!pointerLocked) { keysDown.clear(); player.keys = keysDown; }
});
startBtn.addEventListener('click', enterGame);
overlay.addEventListener('click', (e) => { if (e.target === overlay) enterGame(); });

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1000);
}

function placeBlock() {
  placeCooldown = 0.16;
  const hit = player.raycast();
  if (!hit) return;
  const [px, py, pz] = hit.place;
  if (!player.canPlaceAt(px, py, pz)) return;
  const id = HOTBAR_BLOCKS[hud.selected];
  if (world.setBlock(px, py, pz, id)) swing = 1;
}
let swing = 0;

function updateBreaking(dt) {
  if (!breakTarget) return;
  const hit = player.raycast();
  if (!hit || hit.x !== breakTarget.x || hit.y !== breakTarget.y || hit.z !== breakTarget.z) {
    breakTarget = null; breakProgress = 0; crackBox.visible = false; return;
  }
  const def = blocks[hit.id];
  const hard = isSolid(hit.id) ? clamp(def.hardness, 0.15, 2.2) : 0.12;
  breakProgress += dt / hard;
  crackBox.visible = true;
  crackBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  crackBox.material.opacity = clamp(breakProgress, 0, 1) * 0.55;
  if (breakProgress >= 1) {
    spawnParticles(hit.x, hit.y, hit.z, hit.id);
    world.setBlock(hit.x, hit.y, hit.z, AIR);
    breakTarget = null; breakProgress = 0; crackBox.visible = false;
    swing = 1;
  }
}

// ------------------------------------------------------------------ sky

const dayState = { frac: FIXED_TIME !== null ? FIXED_TIME : 0.28, sunDir: new THREE.Vector3() };
let debugVisible = true;
let submerged = false;
const waterOverlay = document.getElementById('water-overlay');

function updateSky(dt) {
  if (FIXED_TIME === null) dayState.frac = (dayState.frac + dt / DAY_LENGTH) % 1;
  const ang = dayState.frac * Math.PI * 2 - Math.PI / 2;   // 0.25 = sunrise, 0.5 = noon
  const elev = Math.sin(ang);
  const azim = Math.cos(ang);
  dayState.sunDir.set(azim * 0.35, elev, azim * 0.94).normalize();
  const day = smoothstep(-0.12, 0.22, elev);
  const night = 1 - day;
  const dusk = clamp(1 - Math.abs(elev) * 4, 0, 1) * (elev > -0.35 ? 1 : 0);

  skyUniforms.uSunDir.value.copy(dayState.sunDir);
  skyUniforms.uNight.value = night;
  skyUniforms.uTop.value.setRGB(...nightMix([0.22, 0.46, 0.78], [0.035, 0.055, 0.15], night));
  skyUniforms.uMid.value.setRGB(...nightMix([0.60, 0.78, 0.93], [0.08, 0.11, 0.24], night));
  skyUniforms.uHorizon.value.setRGB(...nightMix([0.85, 0.93, 0.97], [0.16, 0.20, 0.33], night)
    .map((c, i) => lerp(c, [0.98, 0.55, 0.32][i], dusk * 0.55)));

  sunLight.position.copy(dayState.sunDir).multiplyScalar(120);
  sunLight.position.add(camera.position);
  sunLight.target.position.copy(camera.position);
  sunLight.intensity = 0.18 + day * 2.25;
  sunLight.color.setRGB(...nightMix([1, 0.96, 0.86], [0.5, 0.6, 1], night).map((c, i) => lerp(c, [1, 0.62, 0.35][i], dusk * 0.6)));
  hemi.intensity = 0.36 + day * 1.02;
  hemi.color.setRGB(...nightMix([0.74, 0.85, 1], [0.20, 0.26, 0.45], night));

  // submerged: swap to a dense blue fog so the underwater view reads properly
  const eye = world.getBlock(Math.floor(camera.position.x), Math.floor(camera.position.y), Math.floor(camera.position.z));
  submerged = eye === WATER;
  waterOverlay.classList.toggle('on', submerged);
  if (scene.fog) {
    if (submerged) {
      scene.fog.color.setRGB(0.055, 0.19, 0.36);
      scene.fog.near = 0.5;
      scene.fog.far = 26;
    } else {
      scene.fog.color.copy(skyUniforms.uHorizon.value).lerp(skyUniforms.uMid.value, 0.62);
      scene.fog.near = RENDER_DIST * CHUNK_X * 0.72;
      scene.fog.far = RENDER_DIST * CHUNK_X * 1.15;
    }
    renderer.setClearColor(scene.fog.color);
  }
  clouds.material.opacity = 0.2 + day * 0.6;
  clouds.position.x = camera.position.x;
  clouds.position.z = camera.position.z;
  cloudTex.offset.x = (cloudTex.offset.x + dt * 0.004) % 1;
}

const nightMix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// --------------------------------------------------------------- resizing

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// -------------------------------------------------------------- game loop

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 0, elapsed = 0;
let firstFill = true;

function frame(now) {
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 0.1);
  elapsed += dt;
  fpsAcc += dtRaw; fpsFrames++;
  if (fpsAcc > 0.4) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  if (AUTOROTATE) player.yaw += dt * 0.25;

  // physics substeps keep collision stable at high speed
  const steps = Math.min(4, Math.max(1, Math.ceil(dt / 0.02)));
  for (let i = 0; i < steps; i++) player.update(dt / steps);

  // hand bob + swing
  swing = Math.max(0, swing - dt * 4.2);
  const speed = Math.hypot(player.vel.x, player.vel.z);
  const bobX = Math.cos(player.bob) * 0.02 * Math.min(1, speed / 5);
  const bobY = Math.abs(Math.sin(player.bob)) * 0.024 * Math.min(1, speed / 5);
  const swingA = Math.sin(swing * Math.PI) * 0.9;
  hand.position.set(0.56 + bobX - swingA * 0.08, -0.44 - bobY - swingA * 0.2, -0.76 + swingA * 0.1);
  hand.rotation.set(0.16 - swingA * 1.15, -0.6, 0.08);

  placeCooldown = Math.max(0, placeCooldown - dt);
  updateBreaking(dt);
  updateParticles(dt);
  updateSky(dt);

  const cx = Math.floor(player.pos.x / CHUNK_X);
  const cz = Math.floor(player.pos.z / CHUNK_Z);
  if (lastCX !== cx || lastCZ !== cz) { lastCX = cx; lastCZ = cz; refreshWanted(); }
  const stat = streamChunks(9);

  // selection highlight
  const hit = player.raycast();
  selection.visible = !!hit;
  if (hit) selection.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

  sky.position.copy(camera.position);
  clouds.position.y = CHUNK_Y + 34;

  if (debugVisible) {
    const bx = Math.floor(player.pos.x), by = Math.floor(player.pos.y), bz = Math.floor(player.pos.z);
    const dayH = dayState.frac * 24;
    const hh = String(Math.floor(dayH) % 24).padStart(2, '0');
    const mm = String(Math.floor((dayH % 1) * 60)).padStart(2, '0');
    hud.setDebug([
      `<b>space-bunny-free</b> &middot; voxelcraft ${WORLD_VERSION}`,
      `xyz ${bx} / ${by} / ${bz}`,
      `chunk ${cx} ${cz} &middot; facing ${facingName(player.yaw)}`,
      `biome <b>${world.biomeNameAt(bx, bz)}</b> &middot; light sky`,
      `time ${hh}:${mm} &middot; chunks ${world.chunks.size} loaded / ${wanted.size} near`,
      `draws ${renderer.info.render.calls} &middot; tris ${(renderer.info.render.triangles / 1000).toFixed(1)}k &middot; ${fps.toFixed(0)} fps`,
      `queue ${stat.pending} &middot; ${player.flying ? 'flying' : player.onGround ? 'grounded' : 'airborne'}`,
      hit ? `target ${blocks[hit.id].label} @ ${hit.x} ${hit.y} ${hit.z}` : 'target —',
    ]);
  }

  renderer.render(scene, camera);

  if (firstFill) {
    const pct = clamp(1 - genQueue.length / Math.max(1, wanted.size), 0, 1);
    hud.setProgress(pct, `Generating terrain — ${Math.round(pct * 100)}%`);
    if (genQueue.length === 0 && world.chunks.size >= wanted.size) {
      firstFill = false;
      document.getElementById('loading').classList.add('hidden');
    }
  }
  requestAnimationFrame(frame);
}

let lastCX = null, lastCZ = null;
const WORLD_VERSION = '1.0.0';
const facingOf = (yaw) => {
  const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
  if (deg < 45 || deg >= 315) return 'north (-Z)';
  if (deg < 135) return 'east (+X)';
  if (deg < 225) return 'south (+Z)';
  return 'west (-X)';
};
const facingName = facingOf;

// ------------------------------------------------------------------ boot

player.spawnAt(SPAWN_X, SPAWN_Z);
refreshWanted();
// prime the world synchronously so the first frame is not empty
const bootStart = performance.now();
while (genQueue.length && performance.now() - bootStart < 2500) {
  const key = genQueue.shift();
  const [cx, cz] = key.split(',').map(Number);
  world.ensureChunk(cx, cz);
}
for (const key of wanted) {
  const c = world.chunks.get(key);
  if (c && c.dirty) meshChunk(c);
}
document.getElementById('loading').classList.add('hidden');
if (NO_OVERLAY) overlay.classList.add('hidden');
setHandBlock(HOTBAR_BLOCKS[0]);
if (params.get('wire') === '1' || params.get('flat') === '1') {
  setDebugMaterials(params.get('wire') === '1' ? 'wire' : 'flat');
}
requestAnimationFrame(frame);

/** Debug renderer swaps used by tools/dbg-geom.mjs. */
function setDebugMaterials(mode) {
  const plain = new THREE.MeshLambertMaterial({ color: 0xbbbbbb });
  const flat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  flat.wireframe = mode === 'wire';
  for (const c of world.chunks.values()) {
    for (const key of ['mesh', 'cutoutMesh', 'waterMesh']) {
      if (!c[key]) continue;
      c[key].material = mode === 'wire' || mode === 'flat' ? flat
        : mode === 'white' ? plain : materials[key === 'mesh' ? 'solid' : key === 'cutoutMesh' ? 'cutout' : 'water'];
    }
  }
}

// expose a tiny API for automated verification
window.__game = {
  setDebugMaterials,
  atlas,
  materials,
  sceneGroup: () => chunkGroup,
  world, player, camera, renderer, scene, hud,
  stats: () => ({
    chunks: world.chunks.size, meshes: chunkGroup.children.length,
    calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
    fps, pos: player.pos.toArray(), biome: world.biomeNameAt(
      Math.floor(player.pos.x), Math.floor(player.pos.z)),
  }),
  teleport: (x, y, z) => {
    player.pos.set(x, y, z);
    player.vel.set(0, 0, 0);
    player.syncCamera();
    refreshWanted();
  },
  setTime: (f) => { dayState.frac = f; FIXED_TIME = f; },
  look: (yaw, pitch) => { player.yaw = yaw; player.pitch = pitch; player.syncCamera(); },
  lookAt: (x, y, z) => {
    const dx = x - player.pos.x;
    const dy = y - (player.pos.y + 1.62);
    const dz = z - player.pos.z;
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    player.syncCamera();
  },
  /** Nearest reasonably flat 9x9 patch of land, for demos and screenshots. */
  flatSpot: (cx, cz, r = 48, need = 9) => {
    let best = null;
    for (let z = -r; z <= r; z += 4) {
      for (let x = -r; x <= r; x += 4) {
        const px = cx + x, pz = cz + z;
        const h = world.heightAt(px, pz);
        if (h < SEA_LEVEL + 2 || h > SEA_LEVEL + 18) continue;
        let min = Infinity, max = -Infinity;
        for (let dz = -4; dz <= 4; dz += 4) {
          for (let dx = -4; dx <= 4; dx += 4) {
            const hh = world.heightAt(px + dx, pz + dz);
            min = Math.min(min, hh); max = Math.max(max, hh);
          }
        }
        const flat = max - min;
        if (flat > need) continue;
        const score = flat * 10 - Math.hypot(x, z) * 0.01;
        if (!best || score < best.score) best = { x: px, z: pz, h, flat, score };
      }
    }
    return best;
  },
  highestWithin: (cx, cz, r) => {
    let best = null;
    for (let z = -r; z <= r; z += 4) for (let x = -r; x <= r; x += 4) {
      const h = world.heightAt(cx + x, cz + z);
      if (!best || h > best.h) best = { x: cx + x, z: cz + z, h };
    }
    return best;
  },
  ready: () => genQueue.length === 0,
};
