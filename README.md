# VoxelCraft — a browser Minecraft-like voxel sandbox

Built by **space-bunny-free**. An infinite, seeded, procedurally generated voxel
world that runs in the browser on WebGL2 via three.js — no build step, no bundler,
no external assets. Every block texture is painted pixel-by-pixel into a WebGL2
texture array at boot.

![Spawn panorama](docs/screenshots/02-spawn-panorama.jpg)

---

## Quick start

ES modules need a real HTTP origin, so open it through any static server:

```bash
cd minecraft-web-space-bunny-free
python3 -m http.server 8137        # or: npx serve -l 8137
# then open http://127.0.0.1:8137/
```

Click **Click to play** to capture the mouse, then walk around.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows | walk |
| `Space` | jump (swim up in water) |
| `Shift` | sprint |
| `F` | toggle flight (`Space` / `C` to change altitude) |
| Left click (hold) | mine the targeted block, speed depends on hardness |
| Right click | place the selected block |
| Middle click | pick the targeted block into the hotbar |
| `1`–`9`, `0`, `-`, `=` | select a hotbar slot |
| Mouse wheel | cycle hotbar |
| `F3` | toggle the debug readout |
| `F1` | hide the HUD |

## Screenshots

All images below are captured from the running game by `tools/verify.mjs` and
committed under [`docs/screenshots/`](docs/screenshots); the machine-readable run
record is [`docs/screenshots/report.json`](docs/screenshots/report.json).

### First person

| | |
| --- | --- |
| ![First person](docs/screenshots/03-first-person.jpg) | ![After walking](docs/screenshots/04-after-walk.jpg) |
| Standing on the shoreline, HUD + hotbar visible | After holding `W` for a second and a half |
| ![Intro](docs/screenshots/01-intro-overlay.jpg) | ![Hotbar](docs/screenshots/07-hotbar.jpg) |
| Boot screen with the intro overlay | Hotbar selection (isometric block icons) |

### Building and mining

| | |
| --- | --- |
| ![Built hut](docs/screenshots/05-blocks-placed.jpg) | ![Mining](docs/screenshots/06a-mining-progress.jpg) |
| 226-block brick / plank / glass hut placed one `setBlock` at a time | Mid-mining: the break-progress overlay on the target |
| ![Mined hole](docs/screenshots/06-blocks-broken.jpg) | |
| The hole left in a cobblestone wall after a real mouse press | |

### Biomes

| | |
| --- | --- |
| ![Mountains](docs/screenshots/08-biome-mountains.jpg) | ![Woodland](docs/screenshots/09-biome-woodland.jpg) |
| Mountains: stone, cobble and snow caps | Woodland at ground level |
| ![Desert](docs/screenshots/10-biome-desert.jpg) | ![Beach](docs/screenshots/11-biome-beach.jpg) |
| Desert dunes and shallow oases | Beach biome and open ocean |

### Day cycle, aerial view, underwater

| | |
| --- | --- |
| ![Noon](docs/screenshots/12-noon.jpg) | ![Sunset](docs/screenshots/13-sunset.jpg) |
| Noon (`?t=0.5`) | Sunset (`?t=0.755`) |
| ![Night](docs/screenshots/14-night.jpg) | ![Aerial](docs/screenshots/15-aerial.jpg) |
| Night with stars and a moonlit sea | Aerial overview from 74 blocks up |
| ![Underwater](docs/screenshots/16-water.jpg) | |
| Submerged: dense blue fog and a screen tint | |

## What's in the world

- **Terrain** — 4-octave simplex fBm for continents, hills, ridged mountains and
  a high-frequency roughness term; peaks are soft-clamped below the world ceiling
  so mountains stay pointy instead of collapsing into a mesa.
- **Biomes** — ocean, beach, plains, forest, mountains, desert, tundra, chosen from
  temperature/humidity noise; each biome picks its own surface, subsurface and
  tree species (broadleaf / spruce).
- **Caves & ores** — 3D noise tunnels that stop 3 blocks below the surface, plus
  cobblestone and gravel pockets.
- **Water** — sea-level fill with a lowered surface, swimming, and a submerged
  fog + screen tint.
- **Day/night cycle** — 300 s full day, animated sun and moon discs, star field,
  dawn/dusk colour grading, and matching sun/sky light colours.
- **Building** — mine and place any of 12 hotbar blocks; edits are kept in a
  per-chunk edit log so a chunk can be unloaded and regenerated without losing
  your changes.

## Architecture

```
index.html            markup + HUD/overlay DOM
css/style.css         HUD, hotbar, overlays, underwater tint
src/noise.js          seeded simplex noise, fBm, hash helpers
src/blocks.js         block registry + procedurally painted 16x16 textures
src/world.js          chunked voxel storage, terrain gen, biomes, trees, edits
src/mesher.js         per-chunk meshing: face culling, AO, texture-array layers
src/player.js         pointer-lock look, AABB voxel collision, DDA raycast
src/hud.js            hotbar with isometric block icons, debug readout
src/main.js           renderer, sky, chunk streaming, input, game loop
vendor/three.module.js  three.js r180 (vendored so the app runs offline)
tools/                headless verification + geometry/terrain checks
docs/screenshots/     committed output of tools/verify.mjs
```

### Engine notes

- **Chunks** are 16 × 64 × 16. Generation, meshing and unloading are budgeted per
  frame (a ~9 ms slice) so streaming never stalls the render loop; chunks outside
  the render distance are disposed and dropped, and re-created on demand.
- **Meshing** is face-culled with per-vertex ambient occlusion. Each face is
  described by an origin plus two in-plane axes with `a × b = n`, which keeps the
  corner order a proper cycle and every triangle wound counter-clockwise from
  outside. The AO diagonal is flipped per quad (both variants keep the same
  winding) so contact shadows do not crease the wrong way.
- **Textures** live in a single `DataArrayTexture` (one 16 × 16 layer per block
  face type). A tiny `onBeforeCompile` patch swaps the `map` fetch for
  `texture(uAtlas, vec3(vMapUv, vLayer))`, which keeps mipmaps and anisotropy
  while giving every face its own tile with no UV bleeding.
- **Meshes** are split into three passes per chunk: solid, cutout (leaves, glass)
  and transparent water.
- **Tree canopies** may spill into neighbouring chunks. Writes to a chunk that is
  not generated yet are queued and replayed once that chunk finishes, so
  generation stays independent and order-free.
- **Spawning** uses the terrain height (not the block-column top) and skips
  columns under a canopy, so you never start buried in a tree.

### URL parameters

| Param | Meaning |
| --- | --- |
| `?seed=12345` | world seed (default `20260927`) |
| `?x=&z=` | spawn column |
| `?dist=8` | render distance in chunks (2–12) |
| `?t=0.5` | freeze time of day (0 = midnight, 0.5 = noon) |
| `?fog=0` | disable distance fog |
| `?overlay=0` | skip the intro overlay |
| `?spin=1` | slowly auto-rotate the camera |
| `?wire=1` / `?flat=1` | render chunks as wireframe / untextured |

`window.__game` exposes `teleport`, `look`, `lookAt`, `setTime`, `flatSpot`,
`highestWithin`, `stats()` and `setDebugMaterials()` for tooling.

## Verification

Everything below runs headless against the real page in Chrome (via
`playwright-core`, using the installed Chrome — no browser download needed).

```bash
npm run check     # node tools/check-geom.mjs   geometry assertions
npm run verify    # node tools/verify.mjs      drives the game, rewrites docs/screenshots/
node tools/check-terrain.mjs   # noise ranges, heightmap, cave ratios, biomes
node tools/find-spots.mjs      # finds photogenic coordinates per biome
```

`tools/check-geom.mjs` builds chunk geometries outside the browser and asserts
that every triangle is a flat axis-aligned unit-cube face, that every geometric
normal matches the stored vertex normal (winding), that no attribute contains a
non-finite value, and that no face is emitted twice across chunk seams. It is
what caught the two meshing bugs fixed during development (inverted AO-flip
winding, and a texture layer that resolved to `NaN` for blocks without an
explicit `faceLayers` entry).

`tools/verify.mjs` boots the page, waits for the world to stream in, then walks
through: cold boot, spawn panorama, pointer lock, walking with real key events,
building a 226-block hut, mining a block with a real mouse press, hotbar
selection, four biomes, noon/sunset/night, an aerial overview, and an underwater
view — capturing a screenshot at each step plus a 90-frame FPS probe. It exits
non-zero on any page error or console error/warning. Re-running it overwrites
`docs/screenshots/` and `docs/screenshots/report.json`.

Latest committed run: **0 page errors, 0 console errors/warnings, 60 fps**
(headless SwiftShader), 193 chunks resident, ~180k triangles, 87–150 draw calls.

## Known limitations

- Shadows are not cast; caves are lit by the ambient/hemisphere term only.
- The world is 64 blocks tall, so terrain is soft-clamped to stay inside it.
- Held blocks use a small unlit cube rather than a full animated arm.
- Chunks are re-generated from the seed when unloaded; edits survive via the
  per-chunk edit log, but the world is not persisted across page reloads.
