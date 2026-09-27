// DOM HUD: crosshair, hotbar with isometric block icons, debug readout, overlays.

import { blocks, HOTBAR_BLOCKS, TILE, layerForBlockFaceName, tintForBlockFace } from './blocks.js';

const ICON_SIZE = 44;
export const tileCache = new Map();

export function tintedTile(atlas, layer, tint, shade = 1) {
  const key = `${layer}:${tint ? tint.join(',') : '1'}:${shade}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(TILE, TILE);
  img.data.set(atlas.data.subarray(layer * TILE * TILE * 4, (layer + 1) * TILE * TILE * 4));
  if (tint || shade !== 1) {
    const k = [tint ? tint[0] : 1, tint ? tint[1] : 1, tint ? tint[2] : 1].map((v) => v * shade);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] *= k[0]; img.data[i + 1] *= k[1]; img.data[i + 2] *= k[2];
    }
  }
  ctx.putImageData(img, 0, 0);
  tileCache.set(key, c);
  return c;
}

/** Draws a shaded isometric cube for a block id. */
export function blockIcon(atlas, layerOf, id, size = ICON_SIZE) {
  const b = blocks[id];
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const S = size;

  const faces = [
    { face: 'py', o: [0, S / 4], u: [S / 2, -S / 4], v: [S / 2, S / 4], shade: 0 },
    { face: 'px', o: [0, S / 4], u: [S / 2, S / 4], v: [0, S / 2], shade: 0.26 },
    { face: 'pz', o: [S / 2, S / 2], u: [S / 2, -S / 4], v: [0, S / 2], shade: 0.45 },
  ];

  for (const f of faces) {
    const tint = tintForBlockFace(id, f.face);
    const tile = tintedTile(atlas, layerForBlockFaceName(id, f.face), tint);
    ctx.save();
    ctx.setTransform(f.u[0] / TILE, f.u[1] / TILE, f.v[0] / TILE, f.v[1] / TILE, f.o[0], f.o[1]);
    ctx.drawImage(tile, 0, 0);
    ctx.restore();
    if (f.shade > 0) {
      ctx.beginPath();
      ctx.moveTo(f.o[0], f.o[1]);
      ctx.lineTo(f.o[0] + f.u[0], f.o[1] + f.u[1]);
      ctx.lineTo(f.o[0] + f.u[0] + f.v[0], f.o[1] + f.u[1] + f.v[1]);
      ctx.lineTo(f.o[0] + f.v[0], f.o[1] + f.v[1]);
      ctx.closePath();
      ctx.fillStyle = `rgba(0,0,0,${f.shade})`;
      ctx.fill();
    }
  }
  return c;
}

export class Hud {
  constructor(root, atlas, layerOf) {
    this.root = root;
    this.atlas = atlas;
    this.layerOf = layerOf;
    this.selected = 0;
    this.hotbarEl = root.querySelector('#hotbar');
    this.debugEl = root.querySelector('#debug');
    this.toastEl = root.querySelector('#toast');
    this.slots = [];
    HOTBAR_BLOCKS.forEach((id, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const icon = blockIcon(atlas, layerOf, id);
      icon.className = 'icon';
      slot.appendChild(icon);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i < 9 ? String(i + 1) : '-';
      slot.appendChild(num);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = blocks[id].label;
      slot.appendChild(name);
      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    });
    this.updateSelection();
  }

  updateSelection() {
    this.slots.forEach((s, i) => s.classList.toggle('active', i === this.selected));
    const id = HOTBAR_BLOCKS[this.selected];
    this.toastEl.textContent = blocks[id].label;
    this.toastEl.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.toastEl.classList.remove('show'), 1200);
  }

  setDebug(lines) {
    this.debugEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }

  setProgress(frac, label) {
    const bar = document.getElementById('bar');
    const text = document.getElementById('progress-text');
    bar.style.width = `${Math.round(frac * 100)}%`;
    text.textContent = label;
  }
}

export { HOTBAR_BLOCKS, ICON_SIZE };
